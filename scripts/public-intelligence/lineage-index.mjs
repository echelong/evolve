// Phase 5K.8 - CONTENT LINEAGE INDEX (PURE).
//
// PURE AND OFFLINE BY CONSTRUCTION. No filesystem, no socket, no clock, no
// environment, no provider SDK, no LLM, no embedding, no vector store. It reads
// an already-verified 5K.5 temporal index plus the authenticated raw/normalized
// text fingerprints those records were derived from, and produces the lineage
// layer.
//
// WHAT IT MATCHES, AND WHAT IT REFUSES TO MATCH
//
// Two content versions are joined ONLY by one of three governed, reproducible
// mechanisms:
//
//   RAW_TEXT           identical 5K.1 `rawTextFingerprint` (exact characters)
//   CANONICAL_TEXT     identical 5K.1 `canonicalTextFingerprint`
//   EXPLICIT_REFERENCE a governed provider permalink carried by authenticated
//                      evidence that resolves to another post in the corpus
//
// Nothing else - not semantic similarity, not embeddings, not fuzzy distance,
// not a shared author, not a shared timestamp, not a shared handle or display
// name - may create an edge. Lineage is CONTENT lineage, not identity
// resolution.
//
// Content versions are 5K.5's own identity: one upstream identity plus one
// distinct authenticated content fingerprint. Every version is retained, and
// nothing is merged across providers or across identities.
import { canonical, digest, PUBLIC_INTELLIGENCE_CLASSIFICATION } from './definition.mjs';
import { failClosed } from './observation.mjs';
import { providerFamilyOf, providerNamespaceScopeOf } from './corroboration-definition.mjs';
import { rawTextFingerprint as rawTextFingerprint5K1, rawObservationFingerprint as rawObservationFingerprint5K1 } from './provenance.mjs';
import {
  PUBLIC_INTELLIGENCE_5K8_SCHEMA_VERSION, PUBLIC_INTELLIGENCE_5K8_RECORD_TYPES,
  PUBLIC_INTELLIGENCE_5K8_POLICY_VERSION, PUBLIC_INTELLIGENCE_5K8_LINEAGE_CLASS,
  PUBLIC_INTELLIGENCE_5K8_LINEAGE_CLASS_VALUES, PUBLIC_INTELLIGENCE_5K8_REFERENCE_STATUS,
  PUBLIC_INTELLIGENCE_5K8_REFERENCE_STATUS_VALUES, lineageClassFor,
} from './lineage-definition.mjs';

export const PUBLIC_INTELLIGENCE_5K8_CONTENT_VERSION_RECORD_TYPE = PUBLIC_INTELLIGENCE_5K8_RECORD_TYPES.CONTENT_VERSION;
export const PUBLIC_INTELLIGENCE_5K8_LINEAGE_RECORD_TYPE = PUBLIC_INTELLIGENCE_5K8_RECORD_TYPES.LINEAGE;

const FINGERPRINT = /^[0-9a-f]{64}$/;
const plain = value => JSON.parse(canonical(value));
const byKey = key => (a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0);
const uniqueSorted = values => [...new Set(values)].sort();
const sortedObject = map => Object.fromEntries(Object.entries(map).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
const fingerprintOf = (record, field) => { const body = { ...record }; delete body[field]; return digest(body); };

/** The CLOSED content-version record schema. Unknown fields are refused. */
export const PUBLIC_INTELLIGENCE_5K8_CONTENT_VERSION_SCHEMA = Object.freeze({
  closed: true,
  fields: Object.freeze([
    'schemaVersion', 'recordType', 'contentVersionFingerprint', 'upstreamIdentity',
    'providerNamespace', 'providerFamily', 'contentFingerprint', 'rawObservationFingerprint',
    'rawTextFingerprint', 'canonicalTextFingerprint', 'firstFetchedAt', 'lastFetchedAt', 'observedAt', 'runId',
    'exactMintSubject', 'referenceStatus', 'referenceResolvedTo', 'classification', 'recordFingerprint',
  ]),
  nullableFields: Object.freeze(['observedAt', 'runId', 'exactMintSubject']),
});

/** The CLOSED lineage record schema. Unknown fields are refused. */
export const PUBLIC_INTELLIGENCE_5K8_LINEAGE_SCHEMA = Object.freeze({
  closed: true,
  fields: Object.freeze([
    'schemaVersion', 'recordType', 'lineageId', 'lineageClass',
    'memberContentVersions', 'memberUpstreamIdentities',
    'providerFamilies', 'providerNamespaces',
    'rawTextFingerprints', 'canonicalTextFingerprints',
    'exactMintSubjects', 'firstObservedAt', 'lastObservedAt',
    'sourceSnapshotFingerprints', 'classification', 'recordFingerprint',
  ]),
});

// ---------------------------------------------------------------------------
// GOVERNED PERMALINK RESOLUTION (declared evidence only; nothing is fetched)
// ---------------------------------------------------------------------------

const BLUESKY_PERMALINK = /^https:\/\/bsky\.app\/profile\/([^/?#]+)\/post\/([^/?#]+)$/;
const MASTODON_PERMALINK = /^https:\/\/([^/?#]+)\/@([^/?#]+)\/([A-Za-z0-9_-]+)$/;

const decode = value => { try { return decodeURIComponent(value); } catch { return null; } };

/**
 * Resolves an authenticated URL to a GOVERNED post reference, or null.
 *
 * Only the two governed permalink shapes resolve. Every other URL stays ordinary
 * evidence: it is never turned into a content identity and nothing is crawled.
 */
export function governedPermalinkRefOf(sourceUrl) {
  if (typeof sourceUrl !== 'string' || !sourceUrl) return null;
  const bluesky = BLUESKY_PERMALINK.exec(sourceUrl);
  if (bluesky) {
    const did = decode(bluesky[1]);
    const rkey = decode(bluesky[2]);
    if (!did || !rkey) return null;
    return `bluesky|at://${did}/app.bsky.feed.post/${rkey}`;
  }
  const mastodon = MASTODON_PERMALINK.exec(sourceUrl);
  if (mastodon) return `mastodon|${mastodon[1]}|${mastodon[3]}`;
  return null;
}

/** The governed reference of a post's OWN identity, derived from its namespace and id. */
export function canonicalPostRefOf(providerNamespace, providerObservationId) {
  const family = providerFamilyOf(providerNamespace);
  if (family === 'bluesky') return `bluesky|${providerObservationId}`;
  return `mastodon|${providerNamespaceScopeOf(providerNamespace)}|${providerObservationId}`;
}

// ---------------------------------------------------------------------------
// BUILD
// ---------------------------------------------------------------------------

const versionKeyOf = (upstreamIdentity, contentFingerprint) => `${upstreamIdentity}\u0000${contentFingerprint}`;

/** The deterministic identity of one content version. No clock, no path. */
export function deriveContentVersionFingerprint(upstreamIdentity, contentFingerprint) {
  return digest({
    kind: 'publicLineageContentVersionId',
    lineagePolicyVersion: PUBLIC_INTELLIGENCE_5K8_POLICY_VERSION,
    upstreamIdentity,
    contentFingerprint,
  });
}

/** The deterministic identity of one lineage. No clock, no path, no order. */
export function deriveLineageId(lineageClass, memberContentVersions) {
  if (!PUBLIC_INTELLIGENCE_5K8_LINEAGE_CLASS_VALUES.includes(lineageClass)) {
    failClosed('PUBLIC_INTELLIGENCE_5K8_LINEAGE_CLASS_INVALID');
  }
  const members = [...memberContentVersions].sort();
  if (members.length === 0) failClosed('PUBLIC_INTELLIGENCE_5K8_LINEAGE_EMPTY');
  if (new Set(members).size !== members.length) failClosed('PUBLIC_INTELLIGENCE_5K8_LINEAGE_DUPLICATE_MEMBER');
  for (const member of members) if (!FINGERPRINT.test(member)) failClosed('PUBLIC_INTELLIGENCE_5K8_LINEAGE_MEMBER_FINGERPRINT_INVALID');
  return `lin-${digest({
    kind: 'publicLineageIdentity',
    lineagePolicyVersion: PUBLIC_INTELLIGENCE_5K8_POLICY_VERSION,
    lineageClass,
    memberContentVersions: members,
  }).slice(0, 32)}`;
}

/**
 * Builds the content-version records from the verified temporal observation
 * records, anchored to the authenticated text fingerprints of the raw and
 * normalized records they came from.
 *
 * The post body itself is NEVER retained: only 5K.1's `rawTextFingerprint` and
 * `canonicalTextFingerprint` are carried forward.
 */
export function buildContentVersions({ observationRecords = [], envelopes = [] }) {
  const textByRawFingerprint = new Map();
  for (const envelope of envelopes) {
    const raw = envelope?.raw;
    const normalized = envelope?.normalized;
    if (!raw || !normalized) failClosed('PUBLIC_INTELLIGENCE_5K8_ENVELOPE_INVALID');
    const key = rawObservationFingerprint5K1(raw);
    const entry = {
      rawTextFingerprint: rawTextFingerprint5K1(raw),
      canonicalTextFingerprint: normalized.canonicalTextFingerprint,
      sourceUrl: raw.sourceUrl ?? null,
    };
    if (!FINGERPRINT.test(entry.rawTextFingerprint)) failClosed('PUBLIC_INTELLIGENCE_5K8_RAW_TEXT_FINGERPRINT_INVALID');
    if (!FINGERPRINT.test(entry.canonicalTextFingerprint)) failClosed('PUBLIC_INTELLIGENCE_5K8_CANONICAL_TEXT_FINGERPRINT_INVALID');
    const previous = textByRawFingerprint.get(key);
    if (previous && (previous.rawTextFingerprint !== entry.rawTextFingerprint
      || previous.canonicalTextFingerprint !== entry.canonicalTextFingerprint)) {
      failClosed('PUBLIC_INTELLIGENCE_5K8_ENVELOPE_FINGERPRINT_INCONSISTENT');
    }
    textByRawFingerprint.set(key, entry);
  }

  const groups = new Map();
  for (const record of observationRecords) {
    if (!record || typeof record !== 'object') failClosed('PUBLIC_INTELLIGENCE_5K8_OBSERVATION_INVALID');
    const upstreamIdentity = record.upstreamIdentity;
    if (typeof upstreamIdentity !== 'string' || !upstreamIdentity) failClosed('PUBLIC_INTELLIGENCE_5K8_OBSERVATION_IDENTITY_MISSING');
    if (typeof record.contentFingerprint !== 'string' || !FINGERPRINT.test(record.contentFingerprint)) {
      failClosed('PUBLIC_INTELLIGENCE_5K8_OBSERVATION_CONTENT_FINGERPRINT_INVALID');
    }
    if (typeof record.provider !== 'string' || !record.provider) failClosed('PUBLIC_INTELLIGENCE_5K8_OBSERVATION_PROVIDER_MISSING');
    if (typeof record.rawObservationFingerprint !== 'string' || !FINGERPRINT.test(record.rawObservationFingerprint)) {
      failClosed('PUBLIC_INTELLIGENCE_5K8_OBSERVATION_RAW_FINGERPRINT_INVALID');
    }
    if (!Number.isSafeInteger(record.fetchedAt) || record.fetchedAt < 0) failClosed('PUBLIC_INTELLIGENCE_5K8_OBSERVATION_FETCHED_AT_INVALID');
    const key = versionKeyOf(upstreamIdentity, record.contentFingerprint);
    if (!groups.has(key)) groups.set(key, { upstreamIdentity, contentFingerprint: record.contentFingerprint, records: [] });
    groups.get(key).records.push(record);
  }

  const versions = [];
  const internal = [];
  const corpusRefs = new Map();
  for (const key of [...groups.keys()].sort()) {
    const group = groups.get(key);
    const ordered = [...group.records].sort((a, b) => (a.fetchedAt - b.fetchedAt
      || (a.runId ?? '') < (b.runId ?? '') ? -1 : (a.runId ?? '') > (b.runId ?? '') ? 1 : 0));
    const head = ordered[0];
    const providerNamespace = head.provider;
    const providerFamily = providerFamilyOf(providerNamespace);
    for (const record of ordered) {
      if (record.provider !== providerNamespace) failClosed('PUBLIC_INTELLIGENCE_5K8_VERSION_PROVIDER_DRIFT');
    }
    const text = textByRawFingerprint.get(head.rawObservationFingerprint);
    if (!text) failClosed(`PUBLIC_INTELLIGENCE_5K8_VERSION_TEXT_UNAVAILABLE:${group.upstreamIdentity.slice(0, 64)}`);
    const mintSubjects = uniqueSorted(ordered
      .map(record => (record.assetAssociation?.status === 'EXACT_MINT' ? record.assetAssociation.mint : null))
      .filter(mint => typeof mint === 'string' && mint));
    if (ordered.some(record => record.assetAssociation?.status === 'EXACT_MINT' && mintSubjects.length === 0)) {
      failClosed('PUBLIC_INTELLIGENCE_5K8_VERSION_EXACT_WITHOUT_MINT');
    }
    if (mintSubjects.length > 1) failClosed('PUBLIC_INTELLIGENCE_5K8_VERSION_MULTIPLE_MINTS');
    const observedValues = ordered.map(record => record.observedAt).filter(value => Number.isSafeInteger(value));
    const version = {
      schemaVersion: PUBLIC_INTELLIGENCE_5K8_SCHEMA_VERSION,
      recordType: PUBLIC_INTELLIGENCE_5K8_CONTENT_VERSION_RECORD_TYPE,
      contentVersionFingerprint: deriveContentVersionFingerprint(group.upstreamIdentity, group.contentFingerprint),
      upstreamIdentity: group.upstreamIdentity,
      providerNamespace,
      providerFamily,
      contentFingerprint: group.contentFingerprint,
      rawObservationFingerprint: head.rawObservationFingerprint,
      rawTextFingerprint: text.rawTextFingerprint,
      canonicalTextFingerprint: text.canonicalTextFingerprint,
      firstFetchedAt: Math.min(...ordered.map(record => record.fetchedAt)),
      lastFetchedAt: Math.max(...ordered.map(record => record.fetchedAt)),
      observedAt: observedValues.length ? Math.min(...observedValues) : null,
      runId: head.runId ?? null,
      exactMintSubject: mintSubjects.length === 1 ? mintSubjects[0] : null,
      referenceStatus: PUBLIC_INTELLIGENCE_5K8_REFERENCE_STATUS.NO_REFERENCE,
      referenceResolvedTo: [],
      classification: PUBLIC_INTELLIGENCE_CLASSIFICATION,
    };
    const ownRef = canonicalPostRefOf(providerNamespace, head.providerObservationId);
    if (!corpusRefs.has(ownRef)) corpusRefs.set(ownRef, []);
    corpusRefs.get(ownRef).push(version.upstreamIdentity);
    versions.push(version);
    internal.push({ version, declaredRef: governedPermalinkRefOf(text.sourceUrl), ownRef });
  }

  // Resolve references against the authenticated corpus. A self permalink is not
  // a reference, and an unresolvable governed permalink stays ordinary evidence.
  const resolved = [];
  for (const { version, declaredRef, ownRef } of internal) {
    if (declaredRef && declaredRef !== ownRef) {
      const targets = corpusRefs.get(declaredRef);
      if (targets && targets.length > 0) {
        version.referenceStatus = PUBLIC_INTELLIGENCE_5K8_REFERENCE_STATUS.REFERENCE_RESOLVED;
        version.referenceResolvedTo = uniqueSorted(targets);
      } else {
        version.referenceStatus = PUBLIC_INTELLIGENCE_5K8_REFERENCE_STATUS.REFERENCE_UNRESOLVED;
      }
    }
    const body = { ...version };
    const record = plain({ ...body, recordFingerprint: digest(body) });
    validateLineageContentVersion(record);
    resolved.push(record);
  }
  resolved.sort(byKey('contentVersionFingerprint'));
  return Object.freeze(resolved);
}

/** Union-find over content versions, so a lineage is one connected component. */
function buildComponents(versions, crossFamilyEdges) {
  const parent = new Map(versions.map(version => [version.contentVersionFingerprint, version.contentVersionFingerprint]));
  const find = node => {
    let root = node;
    while (parent.get(root) !== root) root = parent.get(root);
    while (parent.get(node) !== root) { const next = parent.get(node); parent.set(node, root); node = next; }
    return root;
  };
  const union = (a, b) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb); };
  for (const edge of crossFamilyEdges) union(edge.from, edge.to);
  const components = new Map();
  for (const version of versions) {
    const root = find(version.contentVersionFingerprint);
    if (!components.has(root)) components.set(root, []);
    components.get(root).push(version);
  }
  return [...components.values()];
}

/**
 * Builds the whole lineage layer.
 *
 * Inputs:
 *   contentVersions          - the content-version records (5K.5-anchored)
 *   sourceSnapshotFingerprints - the authenticated sources this layer derives from
 */
export function buildLineages({ contentVersions = [] }, sourceSnapshotFingerprints = []) {
  const snapshots = uniqueSorted(sourceSnapshotFingerprints);
  const versions = [...contentVersions];
  versions.sort(byKey('contentVersionFingerprint'));

  const byRawText = new Map();
  const byCanonicalText = new Map();
  for (const version of versions) {
    if (!byRawText.has(version.rawTextFingerprint)) byRawText.set(version.rawTextFingerprint, []);
    byRawText.get(version.rawTextFingerprint).push(version);
    if (!byCanonicalText.has(version.canonicalTextFingerprint)) byCanonicalText.set(version.canonicalTextFingerprint, []);
    byCanonicalText.get(version.canonicalTextFingerprint).push(version);
  }

  const referenceEdges = [];
  const byUpstreamIdentity = new Map();
  for (const version of versions) {
    if (!byUpstreamIdentity.has(version.upstreamIdentity)) byUpstreamIdentity.set(version.upstreamIdentity, []);
    byUpstreamIdentity.get(version.upstreamIdentity).push(version);
  }
  for (const version of versions) {
    if (version.referenceStatus !== PUBLIC_INTELLIGENCE_5K8_REFERENCE_STATUS.REFERENCE_RESOLVED) continue;
    for (const target of version.referenceResolvedTo) {
      for (const candidate of byUpstreamIdentity.get(target) ?? []) {
        // Cross-provider reference only: same-family duplication is corpus
        // structure, never cross-provider corroboration.
        if (candidate.providerFamily === version.providerFamily) continue;
        referenceEdges.push({ from: version.contentVersionFingerprint, to: candidate.contentVersionFingerprint });
      }
    }
  }

  const edges = [];
  const pairUp = group => {
    const members = uniqueSorted(group.map(version => version.contentVersionFingerprint));
    for (let index = 1; index < members.length; index += 1) edges.push({ from: members[0], to: members[index] });
  };
  for (const group of byRawText.values()) if (group.length > 1) pairUp(group);
  for (const group of byCanonicalText.values()) if (group.length > 1) pairUp(group);
  edges.push(...referenceEdges);

  const components = buildComponents(versions, edges);
  const referenceEdgeKeys = new Set(referenceEdges.map(edge => `${edge.from}|${edge.to}`));

  const lineages = [];
  for (const component of components) {
    const members = [...component].sort(byKey('contentVersionFingerprint'));
    const memberFingerprints = members.map(version => version.contentVersionFingerprint);
    const providerFamilies = uniqueSorted(members.map(version => version.providerFamily));
    const providerNamespaces = uniqueSorted(members.map(version => version.providerNamespace));
    const rawTextFingerprints = uniqueSorted(members.map(version => version.rawTextFingerprint));
    const canonicalTextFingerprints = uniqueSorted(members.map(version => version.canonicalTextFingerprint));
    const exactMintSubjects = uniqueSorted(members.map(version => version.exactMintSubject).filter(mint => typeof mint === 'string' && mint));
    let hasExplicitReference = false;
    for (const member of members) {
      for (const other of members) {
        if (member === other) continue;
        if (referenceEdgeKeys.has(`${member.contentVersionFingerprint}|${other.contentVersionFingerprint}`)
          || referenceEdgeKeys.has(`${other.contentVersionFingerprint}|${member.contentVersionFingerprint}`)) hasExplicitReference = true;
      }
    }
    const lineageClass = lineageClassFor({
      memberCount: members.length, hasExplicitReference, rawTextFingerprints, canonicalTextFingerprints,
    });
    const body = {
      schemaVersion: PUBLIC_INTELLIGENCE_5K8_SCHEMA_VERSION,
      recordType: PUBLIC_INTELLIGENCE_5K8_LINEAGE_RECORD_TYPE,
      lineageId: deriveLineageId(lineageClass, memberFingerprints),
      lineageClass,
      memberContentVersions: memberFingerprints,
      memberUpstreamIdentities: uniqueSorted(members.map(version => version.upstreamIdentity)),
      providerFamilies,
      providerNamespaces,
      rawTextFingerprints,
      canonicalTextFingerprints,
      exactMintSubjects,
      firstObservedAt: Math.min(...members.map(version => version.firstFetchedAt)),
      lastObservedAt: Math.max(...members.map(version => version.lastFetchedAt)),
      sourceSnapshotFingerprints: snapshots,
      classification: PUBLIC_INTELLIGENCE_CLASSIFICATION,
    };
    const record = plain({ ...body, recordFingerprint: digest(body) });
    validateLineageRecord(record);
    lineages.push(record);
  }
  lineages.sort(byKey('lineageId'));
  return Object.freeze(lineages);
}

/** The lineage accounting. Counts describe STRUCTURE, never strength or quality. */
export function computeLineageAggregate({ contentVersions = [], lineages = [] }) {
  const countClass = name => lineages.filter(lineage => lineage.lineageClass === name).length;
  const providerFamilyCounts = {};
  for (const lineage of lineages) {
    for (const family of lineage.providerFamilies) providerFamilyCounts[family] = (providerFamilyCounts[family] ?? 0) + 1;
  }
  let earliest = null;
  let latest = null;
  for (const lineage of lineages) {
    earliest = earliest === null ? lineage.firstObservedAt : Math.min(earliest, lineage.firstObservedAt);
    latest = latest === null ? lineage.lastObservedAt : Math.max(latest, lineage.lastObservedAt);
  }
  const singleProviderLineageCount = lineages.filter(lineage => lineage.providerFamilies.length === 1).length;
  const multiProviderLineageCount = lineages.filter(lineage => lineage.providerFamilies.length >= 2).length;
  return plain({
    contentVersionCount: contentVersions.length,
    upstreamIdentityCount: uniqueSorted(contentVersions.map(version => version.upstreamIdentity)).length,
    lineageCount: lineages.length,
    singleProviderLineageCount,
    multiProviderLineageCount,
    crossProviderLineageCount: multiProviderLineageCount,
    sameProviderDuplicateLineageCount: lineages.filter(lineage => lineage.providerFamilies.length === 1 && lineage.memberContentVersions.length >= 2).length,
    exactRawMatchLineageCount: countClass(PUBLIC_INTELLIGENCE_5K8_LINEAGE_CLASS.EXACT_RAW_TEXT_MATCH),
    canonicalMatchLineageCount: countClass(PUBLIC_INTELLIGENCE_5K8_LINEAGE_CLASS.CANONICAL_TEXT_MATCH),
    explicitReferenceLineageCount: countClass(PUBLIC_INTELLIGENCE_5K8_LINEAGE_CLASS.EXPLICIT_CROSS_POST_REFERENCE),
    distinctLineageCount: countClass(PUBLIC_INTELLIGENCE_5K8_LINEAGE_CLASS.DISTINCT_CONTENT),
    unresolvedLineageCount: countClass(PUBLIC_INTELLIGENCE_5K8_LINEAGE_CLASS.UNRESOLVED),
    referenceResolvedVersionCount: contentVersions.filter(version => version.referenceStatus === PUBLIC_INTELLIGENCE_5K8_REFERENCE_STATUS.REFERENCE_RESOLVED).length,
    referenceUnresolvedVersionCount: contentVersions.filter(version => version.referenceStatus === PUBLIC_INTELLIGENCE_5K8_REFERENCE_STATUS.REFERENCE_UNRESOLVED).length,
    textAvailableVersionCount: contentVersions.length,
    textUnavailableVersionCount: 0,
    providerFamilyCounts: sortedObject(providerFamilyCounts),
    earliestObservedAt: earliest,
    latestObservedAt: latest,
  });
}

/** The accounting identities. Any drift between records and summary is fatal. */
export function checkLineageAggregate(aggregate, { contentVersions = [], lineages = [] } = {}) {
  const problems = [];
  const check = (condition, code) => { if (!condition) problems.push(code); };
  const A = aggregate;
  check(A.contentVersionCount === contentVersions.length, 'LINEAGE_AGGREGATE_VERSION_DRIFT');
  check(A.lineageCount === lineages.length, 'LINEAGE_AGGREGATE_LINEAGE_DRIFT');
  check(A.distinctLineageCount + A.exactRawMatchLineageCount + A.canonicalMatchLineageCount
    + A.explicitReferenceLineageCount + A.unresolvedLineageCount === A.lineageCount, 'LINEAGE_AGGREGATE_CLASS_PARTITION');
  check(A.singleProviderLineageCount + A.multiProviderLineageCount === A.lineageCount, 'LINEAGE_AGGREGATE_PROVIDER_PARTITION');
  check(A.crossProviderLineageCount === A.multiProviderLineageCount, 'LINEAGE_AGGREGATE_CROSS_PROVIDER_DRIFT');
  check(A.textAvailableVersionCount + A.textUnavailableVersionCount === A.contentVersionCount, 'LINEAGE_AGGREGATE_TEXT_PARTITION');
  check(lineages.reduce((sum, lineage) => sum + lineage.memberContentVersions.length, 0) === A.contentVersionCount, 'LINEAGE_AGGREGATE_MEMBERSHIP_DRIFT');
  check((A.earliestObservedAt === null) === (A.lineageCount === 0), 'LINEAGE_AGGREGATE_EARLIEST_NULLABILITY');
  check((A.latestObservedAt === null) === (A.lineageCount === 0), 'LINEAGE_AGGREGATE_LATEST_NULLABILITY');
  for (const lineage of lineages) {
    if (lineage.memberContentVersions.length === 1 && lineage.lineageClass !== PUBLIC_INTELLIGENCE_5K8_LINEAGE_CLASS.DISTINCT_CONTENT) {
      problems.push('LINEAGE_AGGREGATE_SINGLETON_NOT_DISTINCT');
    }
    if (lineage.memberContentVersions.length >= 2 && lineage.lineageClass === PUBLIC_INTELLIGENCE_5K8_LINEAGE_CLASS.DISTINCT_CONTENT) {
      problems.push('LINEAGE_AGGREGATE_MULTI_MEMBER_DISTINCT');
    }
  }
  return Object.freeze({ ok: problems.length === 0, problems: Object.freeze(problems) });
}

/**
 * The content-diversity view for one exact mint. It returns DISCRETE STRUCTURAL
 * FACTS only: no ratio interpreted as quality and no scalar score.
 */
export function computeDistinctnessForMint(mint, { lineages = [], coverageRecord = null } = {}) {
  if (typeof mint !== 'string' || !mint) failClosed('PUBLIC_INTELLIGENCE_5K8_DIVERSITY_MINT_REQUIRED');
  const membership = lineages.filter(lineage => lineage.exactMintSubjects.includes(mint));
  const countClass = name => membership.filter(lineage => lineage.lineageClass === name).length;
  return plain({
    mint,
    providerFamilyCount: coverageRecord ? coverageRecord.providerFamilyCount : uniqueSorted(membership.flatMap(lineage => lineage.providerFamilies)).length,
    providerNamespaceCount: coverageRecord ? coverageRecord.providerNamespaceCount : uniqueSorted(membership.flatMap(lineage => lineage.providerNamespaces)).length,
    upstreamObservationCount: coverageRecord ? coverageRecord.upstreamObservationCount : uniqueSorted(membership.flatMap(lineage => lineage.memberUpstreamIdentities)).length,
    contentVersionCount: membership.reduce((sum, lineage) => sum + lineage.memberContentVersions.length, 0),
    lineageCount: membership.length,
    exactDuplicateLineageCount: countClass(PUBLIC_INTELLIGENCE_5K8_LINEAGE_CLASS.EXACT_RAW_TEXT_MATCH),
    canonicalDuplicateLineageCount: countClass(PUBLIC_INTELLIGENCE_5K8_LINEAGE_CLASS.CANONICAL_TEXT_MATCH),
    explicitReferenceLineageCount: countClass(PUBLIC_INTELLIGENCE_5K8_LINEAGE_CLASS.EXPLICIT_CROSS_POST_REFERENCE),
    distinctLineageCount: countClass(PUBLIC_INTELLIGENCE_5K8_LINEAGE_CLASS.DISTINCT_CONTENT),
    unresolvedLineageCount: countClass(PUBLIC_INTELLIGENCE_5K8_LINEAGE_CLASS.UNRESOLVED),
    scoreComputed: false,
    ratioInterpretedAsQuality: false,
    dimensionsCollapsed: false,
  });
}

// ---------------------------------------------------------------------------
// VALIDATION
// ---------------------------------------------------------------------------

/** Closed-schema + fingerprint validation of one content-version record. */
export function validateLineageContentVersion(record) {
  const S = PUBLIC_INTELLIGENCE_5K8_CONTENT_VERSION_SCHEMA;
  if (!record || typeof record !== 'object' || Array.isArray(record)) failClosed('PUBLIC_INTELLIGENCE_5K8_VERSION_NOT_AN_OBJECT');
  for (const key of Object.keys(record)) {
    if (!S.fields.includes(key)) failClosed(`PUBLIC_INTELLIGENCE_5K8_VERSION_UNKNOWN_FIELD:${String(key).slice(0, 48)}`);
  }
  for (const key of S.fields) if (!Object.hasOwn(record, key)) failClosed(`PUBLIC_INTELLIGENCE_5K8_VERSION_FIELD_MISSING:${key}`);
  if (record.schemaVersion !== PUBLIC_INTELLIGENCE_5K8_SCHEMA_VERSION || record.recordType !== PUBLIC_INTELLIGENCE_5K8_CONTENT_VERSION_RECORD_TYPE) {
    failClosed('PUBLIC_INTELLIGENCE_5K8_VERSION_TYPE_INVALID');
  }
  for (const key of ['contentVersionFingerprint', 'contentFingerprint', 'rawObservationFingerprint', 'rawTextFingerprint', 'canonicalTextFingerprint', 'recordFingerprint']) {
    if (!FINGERPRINT.test(record[key])) failClosed(`PUBLIC_INTELLIGENCE_5K8_VERSION_FINGERPRINT_INVALID:${key}`);
  }
  if (record.contentVersionFingerprint !== deriveContentVersionFingerprint(record.upstreamIdentity, record.contentFingerprint)) {
    failClosed('PUBLIC_INTELLIGENCE_5K8_VERSION_ID_MISMATCH');
  }
  if (providerFamilyOf(record.providerNamespace) !== record.providerFamily) failClosed('PUBLIC_INTELLIGENCE_5K8_VERSION_FAMILY_DRIFT');
  if (!PUBLIC_INTELLIGENCE_5K8_REFERENCE_STATUS_VALUES.includes(record.referenceStatus)) failClosed('PUBLIC_INTELLIGENCE_5K8_VERSION_REFERENCE_STATUS_INVALID');
  if (!Array.isArray(record.referenceResolvedTo)) failClosed('PUBLIC_INTELLIGENCE_5K8_VERSION_REFERENCE_TARGETS_INVALID');
  if (record.referenceStatus !== PUBLIC_INTELLIGENCE_5K8_REFERENCE_STATUS.REFERENCE_RESOLVED && record.referenceResolvedTo.length > 0) {
    failClosed('PUBLIC_INTELLIGENCE_5K8_VERSION_UNRESOLVED_WITH_TARGETS');
  }
  if (record.referenceStatus === PUBLIC_INTELLIGENCE_5K8_REFERENCE_STATUS.REFERENCE_RESOLVED && record.referenceResolvedTo.length === 0) {
    failClosed('PUBLIC_INTELLIGENCE_5K8_VERSION_RESOLVED_WITHOUT_TARGETS');
  }
  if (record.exactMintSubject !== null && (typeof record.exactMintSubject !== 'string' || !record.exactMintSubject)) {
    failClosed('PUBLIC_INTELLIGENCE_5K8_VERSION_MINT_INVALID');
  }
  for (const key of ['firstFetchedAt', 'lastFetchedAt']) {
    if (!Number.isSafeInteger(record[key]) || record[key] < 0) failClosed(`PUBLIC_INTELLIGENCE_5K8_VERSION_FETCHED_AT_INVALID:${key}`);
  }
  if (record.firstFetchedAt > record.lastFetchedAt) failClosed('PUBLIC_INTELLIGENCE_5K8_VERSION_TIME_INVERTED');
  if (record.observedAt !== null && (!Number.isSafeInteger(record.observedAt) || record.observedAt < 0)) failClosed('PUBLIC_INTELLIGENCE_5K8_VERSION_OBSERVED_AT_INVALID');
  if (canonical(record.classification) !== canonical(PUBLIC_INTELLIGENCE_CLASSIFICATION)) failClosed('PUBLIC_INTELLIGENCE_5K8_VERSION_CLASSIFICATION_OVERRIDE_REFUSED');
  if (record.recordFingerprint !== fingerprintOf(record, 'recordFingerprint')) failClosed('PUBLIC_INTELLIGENCE_5K8_VERSION_FINGERPRINT_MISMATCH');
  return record;
}

/** Closed-schema + fingerprint validation of one lineage record. */
export function validateLineageRecord(record) {
  const S = PUBLIC_INTELLIGENCE_5K8_LINEAGE_SCHEMA;
  if (!record || typeof record !== 'object' || Array.isArray(record)) failClosed('PUBLIC_INTELLIGENCE_5K8_LINEAGE_NOT_AN_OBJECT');
  for (const key of Object.keys(record)) {
    if (!S.fields.includes(key)) failClosed(`PUBLIC_INTELLIGENCE_5K8_LINEAGE_UNKNOWN_FIELD:${String(key).slice(0, 48)}`);
  }
  for (const key of S.fields) if (!Object.hasOwn(record, key)) failClosed(`PUBLIC_INTELLIGENCE_5K8_LINEAGE_FIELD_MISSING:${key}`);
  if (record.schemaVersion !== PUBLIC_INTELLIGENCE_5K8_SCHEMA_VERSION || record.recordType !== PUBLIC_INTELLIGENCE_5K8_LINEAGE_RECORD_TYPE) {
    failClosed('PUBLIC_INTELLIGENCE_5K8_LINEAGE_TYPE_INVALID');
  }
  if (!PUBLIC_INTELLIGENCE_5K8_LINEAGE_CLASS_VALUES.includes(record.lineageClass)) failClosed('PUBLIC_INTELLIGENCE_5K8_LINEAGE_CLASS_INVALID');
  if (!/^lin-[0-9a-f]{32}$/.test(record.lineageId)) failClosed('PUBLIC_INTELLIGENCE_5K8_LINEAGE_ID_INVALID');
  if (record.lineageId !== deriveLineageId(record.lineageClass, record.memberContentVersions)) failClosed('PUBLIC_INTELLIGENCE_5K8_LINEAGE_ID_MISMATCH');
  if (!Array.isArray(record.memberContentVersions) || record.memberContentVersions.length === 0) failClosed('PUBLIC_INTELLIGENCE_5K8_LINEAGE_MEMBERS_INVALID');
  for (const key of ['memberContentVersions', 'memberUpstreamIdentities', 'providerFamilies', 'providerNamespaces', 'rawTextFingerprints', 'canonicalTextFingerprints', 'exactMintSubjects', 'sourceSnapshotFingerprints']) {
    if (!Array.isArray(record[key])) failClosed(`PUBLIC_INTELLIGENCE_5K8_LINEAGE_LIST_INVALID:${key}`);
    if (new Set(record[key]).size !== record[key].length) failClosed(`PUBLIC_INTELLIGENCE_5K8_LINEAGE_LIST_NOT_UNIQUE:${key}`);
    if (canonical([...record[key]].sort()) !== canonical(record[key])) failClosed(`PUBLIC_INTELLIGENCE_5K8_LINEAGE_LIST_NOT_SORTED:${key}`);
  }
  for (const fingerprint of [...record.memberContentVersions, ...record.rawTextFingerprints, ...record.canonicalTextFingerprints, ...record.sourceSnapshotFingerprints]) {
    if (!FINGERPRINT.test(fingerprint)) failClosed('PUBLIC_INTELLIGENCE_5K8_LINEAGE_FINGERPRINT_INVALID');
  }
  for (const family of record.providerFamilies) {
    if (record.providerNamespaces.every(namespace => providerFamilyOf(namespace) !== family)) {
      failClosed('PUBLIC_INTELLIGENCE_5K8_LINEAGE_FAMILY_WITHOUT_NAMESPACE');
    }
  }
  if (record.providerFamilies.length === 0 || record.providerNamespaces.length === 0) failClosed('PUBLIC_INTELLIGENCE_5K8_LINEAGE_PROVIDER_EMPTY');
  if (record.lineageClass === PUBLIC_INTELLIGENCE_5K8_LINEAGE_CLASS.DISTINCT_CONTENT && record.memberContentVersions.length !== 1) {
    failClosed('PUBLIC_INTELLIGENCE_5K8_LINEAGE_DISTINCT_MEMBER_COUNT');
  }
  if (record.lineageClass === PUBLIC_INTELLIGENCE_5K8_LINEAGE_CLASS.EXACT_RAW_TEXT_MATCH && record.rawTextFingerprints.length !== 1) {
    failClosed('PUBLIC_INTELLIGENCE_5K8_LINEAGE_RAW_MATCH_SPAN');
  }
  if (record.lineageClass === PUBLIC_INTELLIGENCE_5K8_LINEAGE_CLASS.CANONICAL_TEXT_MATCH && record.canonicalTextFingerprints.length !== 1) {
    failClosed('PUBLIC_INTELLIGENCE_5K8_LINEAGE_CANONICAL_MATCH_SPAN');
  }
  if (!Number.isSafeInteger(record.firstObservedAt) || record.firstObservedAt < 0) failClosed('PUBLIC_INTELLIGENCE_5K8_LINEAGE_FIRST_OBSERVED_AT_INVALID');
  if (!Number.isSafeInteger(record.lastObservedAt) || record.lastObservedAt < 0) failClosed('PUBLIC_INTELLIGENCE_5K8_LINEAGE_LAST_OBSERVED_AT_INVALID');
  if (record.firstObservedAt > record.lastObservedAt) failClosed('PUBLIC_INTELLIGENCE_5K8_LINEAGE_TIME_INVERTED');
  if (canonical(record.classification) !== canonical(PUBLIC_INTELLIGENCE_CLASSIFICATION)) failClosed('PUBLIC_INTELLIGENCE_5K8_LINEAGE_CLASSIFICATION_OVERRIDE_REFUSED');
  if (record.recordFingerprint !== fingerprintOf(record, 'recordFingerprint')) failClosed('PUBLIC_INTELLIGENCE_5K8_LINEAGE_FINGERPRINT_MISMATCH');
  return record;
}
