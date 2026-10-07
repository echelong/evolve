// Phase 5K.5 - REVISION CHAINS: provider-declared edits vs. unverified divergence.
//
// PURE AND OFFLINE BY CONSTRUCTION. No filesystem, no socket, no clock, no
// environment, no provider SDK.
//
// THE CENTRAL RULE: AN EDIT IS NOT INFERRED FROM A TEXT DIFFERENCE.
//
// Two different texts under one providerObservationId are, on their own, an
// UNVERIFIED_CONTENT_DIVERGENCE. That is the conservative reading and it is the
// DEFAULT. Two texts are not evidence of an edit: a provider can silently
// re-render, truncate, renumber, delete-and-repost under a reused id, or serve
// inconsistent replicas. Inferring "the author edited it" from "the text
// differs" would manufacture a benign story out of an unexplained one.
//
// A revision is recognized ONLY when the PROVIDER declares revision semantics.
// Mastodon exposes exactly that: `Status.edited_at` (added in Mastodon 3.5.0)
// is the provider's own "when this status was last edited" declaration, and
// `GET /api/v1/statuses/:id/history` returns the StatusEdit revision records.
// 5K.5 therefore requires a provider-declared edit timestamp on the later
// observation before any content divergence may be called a revision.
//
// THE PROOF MUST ALSO BE ORDERED. A declared edit timestamp is accepted as
// proof only when it is strictly later than the EARLIER observation's fetch
// instant. An `edited_at` that precedes the previous fetch would mean the edit
// was already visible then, so the earlier evidence would be the anomaly, not
// this one. Such a record is refused rather than accepted.
//
// HISTORICAL VERSIONS ARE NEVER OVERWRITTEN. A revision chain retains every
// authenticated version. There is no "latest wins" and no "oldest wins"; the
// only permitted "latest" is an explicit, deterministic temporal query.
import { canonical, digest, PUBLIC_INTELLIGENCE_CLASSIFICATION } from './definition.mjs';
import { failClosed } from './observation.mjs';
import { PUBLIC_INTELLIGENCE_5K5_SCHEMA_VERSION } from './temporal-projection.mjs';

export const PUBLIC_INTELLIGENCE_5K5_REVISION_RECORD_TYPE = 'public_content_revision';

/** The closed temporal classification enum. There is no fallback value. */
export const PUBLIC_INTELLIGENCE_5K5_TEMPORAL_CLASSIFICATION = Object.freeze({
  FIRST_OBSERVATION: 'FIRST_OBSERVATION',
  SAME_CONTENT_SAME_STATE: 'SAME_CONTENT_SAME_STATE',
  SAME_CONTENT_UPDATED_STATE: 'SAME_CONTENT_UPDATED_STATE',
  PROVIDER_DECLARED_CONTENT_REVISION: 'PROVIDER_DECLARED_CONTENT_REVISION',
  UNVERIFIED_CONTENT_DIVERGENCE: 'UNVERIFIED_CONTENT_DIVERGENCE',
});
export const PUBLIC_INTELLIGENCE_5K5_TEMPORAL_CLASSIFICATIONS = Object.freeze(
  Object.values(PUBLIC_INTELLIGENCE_5K5_TEMPORAL_CLASSIFICATION),
);

/** Classifies ONE authenticated acquisition against the previous one. */
export function classifyTemporal(previous, current) {
  if (!previous) return PUBLIC_INTELLIGENCE_5K5_TEMPORAL_CLASSIFICATION.FIRST_OBSERVATION;
  if (current.contentFingerprint === previous.contentFingerprint) {
    return current.observationStateFingerprint === previous.observationStateFingerprint
      ? PUBLIC_INTELLIGENCE_5K5_TEMPORAL_CLASSIFICATION.SAME_CONTENT_SAME_STATE
      : PUBLIC_INTELLIGENCE_5K5_TEMPORAL_CLASSIFICATION.SAME_CONTENT_UPDATED_STATE;
  }
  // Content differs. Only a provider declaration can call this a revision.
  if (current.providerRevisionTimestamp !== null
    && current.providerRevisionTimestamp > previous.fetchedAt) {
    return PUBLIC_INTELLIGENCE_5K5_TEMPORAL_CLASSIFICATION.PROVIDER_DECLARED_CONTENT_REVISION;
  }
  return PUBLIC_INTELLIGENCE_5K5_TEMPORAL_CLASSIFICATION.UNVERIFIED_CONTENT_DIVERGENCE;
}

/**
 * The closed revision-evidence record schema.
 *
 * `providerRevisionTimestamp` is the provider's own `Status.edited_at`. It is
 * retained only in FUTURE captures and only as a single timestamp: 5K.5 adds no
 * new body, no media, no poll and no edit-history payload. Records captured
 * before 5K.5 carry no such field and remain fully valid - they simply cannot
 * ever classify as a provider-declared revision, which is the correct
 * conservative outcome for evidence that predates the field.
 */
export const PUBLIC_INTELLIGENCE_5K5_REVISION_SCHEMA = Object.freeze({
  closed: true,
  fields: Object.freeze([
    'schemaVersion', 'recordType', 'upstreamIdentity', 'provider', 'providerObservationId',
    'versionIndex', 'contentFingerprint', 'rawObservationFingerprint',
    'providerRevisionTimestamp', 'runId', 'runManifestFingerprint', 'fetchedAt',
    'supersedesContentFingerprint', 'evidenceSource', 'classification', 'revisionFingerprint',
  ]),
});

/** Where the revision claim came from. Never anything but provider-declared. */
export const PUBLIC_INTELLIGENCE_5K5_REVISION_EVIDENCE_SOURCES = Object.freeze([
  'MASTODON_STATUS_EDITED_AT',
]);

const plain = value => JSON.parse(canonical(value));
const FINGERPRINT = /^[0-9a-f]{64}$/;

/**
 * WHY REVISION EVIDENCE IS A SIDECAR AND NOT A RAW FIELD
 *
 * 5K.1's raw observation schema is FROZEN and CLOSED: an unknown field is a
 * hard refusal, which is exactly what protects a research number from silently
 * changing because an upstream rename. Adding `providerRevision` to it would
 * therefore mean editing a schema 5K.0/5K.1 froze, and would also force a
 * change to the 5K.2 mapper and to the 5K.2 validator's field assertions.
 *
 * 5K.5 instead introduces a GOVERNED ADDITIVE SCHEMA VERSION: a separate,
 * closed, independently fingerprinted record bound to the UNCHANGED 5K.1
 * `rawObservationFingerprint`. Nothing inside the 5K.1 raw record moves, no
 * historical artifact is rewritten, and a future adapter can supply the
 * timestamp without ever weakening the frozen schema.
 *
 * The binding is what makes this safe: a sidecar asserts a fact about ONE
 * specific authenticated raw observation, identified by that observation's own
 * fingerprint. It cannot be replayed onto different evidence, and an observation
 * with no sidecar simply has no proof.
 */
export const PUBLIC_INTELLIGENCE_5K5_REVISION_EVIDENCE_SCHEMA = Object.freeze({
  closed: true,
  fields: Object.freeze([
    'schemaVersion', 'recordType', 'provider', 'providerObservationId',
    'rawObservationFingerprint', 'providerRevisionTimestamp', 'evidenceSource',
    'classification', 'revisionEvidenceFingerprint',
  ]),
});

export const PUBLIC_INTELLIGENCE_5K5_REVISION_EVIDENCE_RECORD_TYPE = 'public_provider_revision_evidence';

/**
 * Builds the additive revision-evidence sidecar for ONE authenticated raw
 * observation. `editedAt` is the provider's own declaration - Mastodon's
 * `Status.edited_at`, added in Mastodon 3.5.0.
 */
export function buildRevisionEvidence({ provider, providerObservationId, rawObservationFingerprint, editedAt }) {
  if (typeof editedAt !== 'number' || !Number.isSafeInteger(editedAt) || editedAt < 0) {
    failClosed('PUBLIC_INTELLIGENCE_5K5_REVISION_TIMESTAMP_INVALID');
  }
  if (!FINGERPRINT.test(String(rawObservationFingerprint))) failClosed('PUBLIC_INTELLIGENCE_5K5_REVISION_EVIDENCE_BINDING_INVALID');
  const body = {
    schemaVersion: PUBLIC_INTELLIGENCE_5K5_SCHEMA_VERSION,
    recordType: PUBLIC_INTELLIGENCE_5K5_REVISION_EVIDENCE_RECORD_TYPE,
    provider,
    providerObservationId,
    // Binds the declaration to exactly one immutable piece of raw evidence.
    rawObservationFingerprint,
    providerRevisionTimestamp: editedAt,
    evidenceSource: 'MASTODON_STATUS_EDITED_AT',
    classification: PUBLIC_INTELLIGENCE_CLASSIFICATION,
  };
  return plain({ ...body, revisionEvidenceFingerprint: digest(body) });
}

/** Closed-schema + binding + fingerprint validation of a revision-evidence sidecar. */
export function validateRevisionEvidence(record) {
  const S = PUBLIC_INTELLIGENCE_5K5_REVISION_EVIDENCE_SCHEMA;
  if (!record || typeof record !== 'object' || Array.isArray(record)) failClosed('PUBLIC_INTELLIGENCE_5K5_REV_EVIDENCE_NOT_AN_OBJECT');
  for (const key of Object.keys(record)) if (!S.fields.includes(key)) failClosed(`PUBLIC_INTELLIGENCE_5K5_REV_EVIDENCE_UNKNOWN_FIELD:${String(key).slice(0, 40)}`);
  for (const key of S.fields) if (!Object.hasOwn(record, key)) failClosed(`PUBLIC_INTELLIGENCE_5K5_REV_EVIDENCE_FIELD_MISSING:${key}`);
  if (record.schemaVersion !== PUBLIC_INTELLIGENCE_5K5_SCHEMA_VERSION || record.recordType !== PUBLIC_INTELLIGENCE_5K5_REVISION_EVIDENCE_RECORD_TYPE) {
    failClosed('PUBLIC_INTELLIGENCE_5K5_REV_EVIDENCE_TYPE_INVALID');
  }
  for (const key of ['rawObservationFingerprint', 'revisionEvidenceFingerprint']) if (!FINGERPRINT.test(record[key])) failClosed(`PUBLIC_INTELLIGENCE_5K5_REV_EVIDENCE_FINGERPRINT_INVALID:${key}`);
  if (!PUBLIC_INTELLIGENCE_5K5_REVISION_EVIDENCE_SOURCES.includes(record.evidenceSource)) failClosed('PUBLIC_INTELLIGENCE_5K5_REV_EVIDENCE_SOURCE_INVALID');
  if (canonical(record.classification) !== canonical(PUBLIC_INTELLIGENCE_CLASSIFICATION)) failClosed('PUBLIC_INTELLIGENCE_5K5_REV_EVIDENCE_CLASSIFICATION_OVERRIDE_REFUSED');
  const expected = digest((() => { const b = { ...record }; delete b.revisionEvidenceFingerprint; return b; })());
  if (record.revisionEvidenceFingerprint !== expected) failClosed('PUBLIC_INTELLIGENCE_5K5_REV_EVIDENCE_FINGERPRINT_MISMATCH');
  return record;
}

/**
 * CANONICAL EVIDENCE ORDER (5K.5.1).
 *
 * The persisted sidecar and its digest must be a pure function of the evidence
 * SET, never of the order a caller happened to collect it in. Sorting by the raw
 * fingerprint each record is bound to - the same key the index uses - makes the
 * stored file and its digest identical for identical evidence, so a snapshot's
 * reproducibility cannot depend on caller order.
 *
 * The records themselves are validated here, so no unvalidated record can reach
 * a persisted artifact even if a caller assembled the array by hand.
 */
export function canonicalRevisionEvidence(records) {
  if (!Array.isArray(records)) failClosed('PUBLIC_INTELLIGENCE_5K5_REV_EVIDENCE_LIST_REQUIRED');
  const validated = records.map(record => {
    validateRevisionEvidence(record);
    return record;
  });
  validated.sort((a, b) => (a.rawObservationFingerprint < b.rawObservationFingerprint ? -1
    : a.rawObservationFingerprint > b.rawObservationFingerprint ? 1 : 0));
  for (let index = 1; index < validated.length; index += 1) {
    if (validated[index].rawObservationFingerprint === validated[index - 1].rawObservationFingerprint) {
      failClosed('PUBLIC_INTELLIGENCE_5K5_REV_EVIDENCE_DUPLICATE_BINDING');
    }
  }
  return validated;
}

/**
 * Indexes revision evidence by the raw fingerprint it is bound to.
 *
 * A sidecar bound to a raw fingerprint that no authenticated observation
 * actually carries is a hard refusal: evidence may not be invented for
 * evidence that does not exist.
 */
export function indexRevisionEvidence(records, knownRawFingerprints) {
  const index = new Map();
  for (const record of records) {
    validateRevisionEvidence(record);
    if (knownRawFingerprints && !knownRawFingerprints.has(record.rawObservationFingerprint)) {
      failClosed(`PUBLIC_INTELLIGENCE_5K5_REV_EVIDENCE_BOUND_TO_UNKNOWN_EVIDENCE:${record.rawObservationFingerprint.slice(0, 16)}`);
    }
    if (index.has(record.rawObservationFingerprint)) failClosed('PUBLIC_INTELLIGENCE_5K5_REV_EVIDENCE_DUPLICATE_BINDING');
    index.set(record.rawObservationFingerprint, record.providerRevisionTimestamp);
  }
  return index;
}

/**
 * The provider-declared revision timestamp bound to one raw observation, or null.
 *
 * Returns null for every observation with no sidecar - which includes EVERY
 * observation captured before 5K.5, and every observation whose provider
 * declared no edit. Absence is never read as "unedited evidence about a changed
 * post"; it is simply no proof, which routes the observation to
 * UNVERIFIED_CONTENT_DIVERGENCE.
 */
export function providerRevisionTimestampOf(revisionIndex, rawObservationFingerprint) {
  const declared = revisionIndex.get(rawObservationFingerprint) ?? null;
  if (declared === null) return null;
  if (typeof declared !== 'number' || !Number.isSafeInteger(declared) || declared < 0) {
    failClosed('PUBLIC_INTELLIGENCE_5K5_REVISION_TIMESTAMP_INVALID');
  }
  return declared;
}

/**
 * Builds the revision record for one version in a chain.
 *
 * This is an ADDITIVE record. It references the untouched 5K.1 raw
 * fingerprint and the 5K.5 content fingerprint; it never restates or replaces
 * either, and it never carries post text.
 */
export function buildRevisionRecord({
  upstreamIdentity, provider, providerObservationId, versionIndex, contentFingerprint,
  rawObservationFingerprint, providerRevisionTimestamp, runId, runManifestFingerprint,
  fetchedAt, supersedesContentFingerprint,
}) {
  const body = {
    schemaVersion: PUBLIC_INTELLIGENCE_5K5_SCHEMA_VERSION,
    recordType: PUBLIC_INTELLIGENCE_5K5_REVISION_RECORD_TYPE,
    upstreamIdentity,
    provider,
    providerObservationId,
    versionIndex,
    contentFingerprint,
    // 5K.1's fingerprint, carried forward unchanged as a pointer.
    rawObservationFingerprint,
    providerRevisionTimestamp: providerRevisionTimestamp ?? null,
    runId,
    runManifestFingerprint,
    fetchedAt,
    // null for the first version; otherwise the content it replaces. The chain
    // is explicit, so no version is ever silently dropped.
    supersedesContentFingerprint: supersedesContentFingerprint ?? null,
    evidenceSource: providerRevisionTimestamp === null || providerRevisionTimestamp === undefined
      ? null
      : 'MASTODON_STATUS_EDITED_AT',
    classification: PUBLIC_INTELLIGENCE_CLASSIFICATION,
  };
  return plain({ ...body, revisionFingerprint: digest(body) });
}

/** Closed-schema + fingerprint validation of a stored revision record. */
export function validateRevisionRecord(record) {
  const S = PUBLIC_INTELLIGENCE_5K5_REVISION_SCHEMA;
  if (!record || typeof record !== 'object' || Array.isArray(record)) failClosed('PUBLIC_INTELLIGENCE_5K5_REVISION_NOT_AN_OBJECT');
  for (const key of Object.keys(record)) if (!S.fields.includes(key)) failClosed(`PUBLIC_INTELLIGENCE_5K5_REVISION_UNKNOWN_FIELD:${String(key).slice(0, 40)}`);
  for (const key of S.fields) if (!Object.hasOwn(record, key)) failClosed(`PUBLIC_INTELLIGENCE_5K5_REVISION_FIELD_MISSING:${key}`);
  if (record.schemaVersion !== PUBLIC_INTELLIGENCE_5K5_SCHEMA_VERSION || record.recordType !== PUBLIC_INTELLIGENCE_5K5_REVISION_RECORD_TYPE) {
    failClosed('PUBLIC_INTELLIGENCE_5K5_REVISION_TYPE_INVALID');
  }
  for (const key of ['contentFingerprint', 'rawObservationFingerprint', 'revisionFingerprint']) {
    if (!FINGERPRINT.test(record[key])) failClosed(`PUBLIC_INTELLIGENCE_5K5_REVISION_FINGERPRINT_INVALID:${key}`);
  }
  if (!Number.isSafeInteger(record.versionIndex) || record.versionIndex < 0) failClosed('PUBLIC_INTELLIGENCE_5K5_REVISION_VERSION_INDEX_INVALID');
  if (record.versionIndex === 0 && record.supersedesContentFingerprint !== null) failClosed('PUBLIC_INTELLIGENCE_5K5_REVISION_FIRST_VERSION_SUPERSEDES');
  if (record.versionIndex > 0 && !FINGERPRINT.test(String(record.supersedesContentFingerprint))) failClosed('PUBLIC_INTELLIGENCE_5K5_REVISION_SUPERSEDES_MISSING');
  if (record.providerRevisionTimestamp !== null) {
    if (typeof record.providerRevisionTimestamp !== 'number' || !Number.isSafeInteger(record.providerRevisionTimestamp) || record.providerRevisionTimestamp < 0) {
      failClosed('PUBLIC_INTELLIGENCE_5K5_REVISION_TIMESTAMP_INVALID');
    }
    if (!PUBLIC_INTELLIGENCE_5K5_REVISION_EVIDENCE_SOURCES.includes(record.evidenceSource)) {
      failClosed('PUBLIC_INTELLIGENCE_5K5_REVISION_EVIDENCE_SOURCE_INVALID');
    }
  } else if (record.evidenceSource !== null) {
    failClosed('PUBLIC_INTELLIGENCE_5K5_REVISION_EVIDENCE_SOURCE_WITHOUT_TIMESTAMP');
  }
  if (canonical(record.classification) !== canonical(PUBLIC_INTELLIGENCE_CLASSIFICATION)) failClosed('PUBLIC_INTELLIGENCE_5K5_REVISION_CLASSIFICATION_OVERRIDE_REFUSED');
  const expected = digest((() => { const b = { ...record }; delete b.revisionFingerprint; return b; })());
  if (record.revisionFingerprint !== expected) failClosed('PUBLIC_INTELLIGENCE_5K5_REVISION_FINGERPRINT_MISMATCH');
  return record;
}

/**
 * Verifies a whole revision chain for one upstream identity.
 *
 * Returns named failure codes; never throws on a merely inconsistent chain, so
 * a verifier can report every problem instead of the first one.
 *
 *   - indexes are contiguous from 0
 *   - each version supersedes exactly its predecessor's content fingerprint
 *   - each declared revision timestamp is strictly later than the FETCH of the
 *     version it supersedes (an edit visible before we looked is an anomaly)
 *   - declared timestamps are non-decreasing along the chain
 *   - a chain that contains any UNVERIFIED_CONTENT_DIVERGENCE is not a revision
 *     chain at all: it is a conflict, and no version is ever discarded
 */
export function verifyRevisionChain(records) {
  const failures = [];
  const push = code => failures.push(code);
  const ordered = [...records].sort((a, b) => a.versionIndex - b.versionIndex);
  ordered.forEach((record, position) => {
    if (record.versionIndex !== position) push(`REVISION_INDEX_NOT_CONTIGUOUS:${record.versionIndex}`);
    if (position === 0) return;
    const previous = ordered[position - 1];
    if (record.supersedesContentFingerprint !== previous.contentFingerprint) push(`REVISION_CHAIN_BREAK:${record.versionIndex}`);
    if (record.providerRevisionTimestamp === null) { push(`REVISION_TIMESTAMP_MISSING:${record.versionIndex}`); return; }
    if (record.providerRevisionTimestamp <= previous.fetchedAt) push(`REVISION_TIMESTAMP_NOT_AFTER_PRIOR_FETCH:${record.versionIndex}`);
    if (previous.providerRevisionTimestamp !== null && record.providerRevisionTimestamp < previous.providerRevisionTimestamp) {
      push(`REVISION_TIMESTAMP_OUT_OF_ORDER:${record.versionIndex}`);
    }
  });
  return Object.freeze({ ok: failures.length === 0, failures: Object.freeze(failures) });
}

/**
 * THE STRUCTURE A CONFLICTED CHAIN MUST STILL SATISFY (5K.5.1).
 *
 * An identity whose content changed without a provider declaration that is
 * strictly later than the fetch it supersedes is a conflict, and its unproven
 * link IS that conflict: the content record reports it as
 * UNVERIFIED_CONTENT_DIVERGENCE and `conflicted: true`, and no winner is ever
 * selected. `verifyRevisionChain` demands a declaration on every non-first
 * version, so running it over a conflict would demand the very proof whose
 * absence defines the outcome - and would report a faithfully built, faithfully
 * stored conflict as corrupt.
 *
 * What a conflict is still required to satisfy is its STRUCTURE, because that is
 * what the corpus guarantees by construction regardless of the proof:
 *
 *   - indexes are contiguous from 0;
 *   - each version supersedes exactly its predecessor's content fingerprint.
 *
 * Proof-order rules are deliberately NOT asserted here. Where they cannot be
 * satisfied, that is the conflict itself, and where they could be, the identity is
 * a revision chain and must be verified with `verifyRevisionChain`. Every version
 * is retained either way; nothing is discarded, merged or repaired.
 */
export function verifyConflictedChainStructure(records) {
  const failures = [];
  const ordered = [...records].sort((a, b) => a.versionIndex - b.versionIndex);
  ordered.forEach((record, position) => {
    if (record.versionIndex !== position) failures.push(`CONFLICT_INDEX_NOT_CONTIGUOUS:${record.versionIndex}`);
    if (position === 0) return;
    const previous = ordered[position - 1];
    if (record.supersedesContentFingerprint !== previous.contentFingerprint) failures.push(`CONFLICT_CHAIN_BREAK:${record.versionIndex}`);
  });
  return Object.freeze({ ok: failures.length === 0, failures: Object.freeze(failures) });
}
