/**
 * Phase 5E — bounded, deterministic external-intelligence features (PAPER ONLY).
 *
 * Raw social text NEVER reaches a strategy, the compiler, Jev or the Arena. A
 * capture's records are reduced to a fixed, bounded feature vector, computed
 * deterministically from the frozen records alone:
 *
 *   mentionCount            records in the capture
 *   uniqueAuthors           distinct authorIds
 *   postsPerMinute          record rate over the observed publication span
 *   engagementTotal         sum of engagement values that the backend exposed
 *   engagementMedian        median of those values
 *   duplicateTextRatio      share of records whose (bounded) text repeats
 *   repeatedAuthorRatio     1 - uniqueAuthors/mentionCount
 *   linkDomainConcentration largest share of one link domain
 *   accountConcentration    largest share of one author (herfindahl-style max share)
 *   sourceCount             distinct channels/backends that produced records
 *   sourceDiversity         distinct link domains / records
 *   queryCoverage           share of the query plan that produced >= 1 record
 *   captureAge              age of the capture relative to an explicit `asOf`
 *   fetchFailureRate        failures / (failures + successful calls)
 *
 * COORDINATION, NOT BOT DETECTION: a suspicious pattern is reported as
 * `coordinationIndicators` — a documented, deterministic statement about the
 * captured bytes (e.g. "almost every record repeats the same text"). EVOLVE makes
 * NO bot-probability claim, because it has no validated method for one.
 *
 * VERSIONED TRANSFORMS (Phase 5E.2)
 * ---------------------------------
 * A capture freezes BYTES. The transform that turns those bytes into a feature
 * vector is versioned SEPARATELY, because otherwise a future edit to this file
 * would silently reinterpret an immutable capture and move its `featuresDigest`,
 * `replayDigest` and `packetDigest` without a single frozen byte changing.
 *
 *   external-intelligence-features-v1   the original Phase 5E algorithm, FROZEN.
 *                                       Never "corrected": historical captures
 *                                       must keep replaying to the same digest.
 *   external-intelligence-features-v2   distinguishes RECORD COUNT, OBSERVED-FIELD
 *                                       COUNT and DISTINCT-VALUE COUNT, and never
 *                                       treats missing data as concentration.
 *
 * A schema-v1 manifest with no pin resolves to V1 by an explicit
 * BACKWARDS-COMPATIBILITY rule (see `./replay.mjs`). An unknown version FAILS
 * CLOSED: nothing is ever silently mapped to "latest".
 *
 * PAPER ONLY, READ-ONLY. No network, no clock except an explicitly passed `asOf`.
 */

import { digestOf } from "../lib/hash.mjs";
import { linkDomain } from "./records.mjs";

/** The FROZEN V1 transform. Its output must never change. */
export const INTELLIGENCE_FEATURE_VERSION = "external-intelligence-features-v1";

/** The V1 transform, named for its ROLE as the legacy compatibility transform. */
export const LEGACY_INTELLIGENCE_FEATURE_VERSION = INTELLIGENCE_FEATURE_VERSION;

/** The V2 transform: observation-aware, never treats missing data as signal. */
export const INTELLIGENCE_FEATURE_VERSION_V2 = "external-intelligence-features-v2";

/** The transform a NEW capture explicitly pins. Never implicit. */
export const DEFAULT_FEATURE_VERSION = INTELLIGENCE_FEATURE_VERSION_V2;

/** Every registered feature transform, oldest first. */
export const REGISTERED_FEATURE_VERSIONS = Object.freeze([
  INTELLIGENCE_FEATURE_VERSION,
  INTELLIGENCE_FEATURE_VERSION_V2,
]);

/**
 * The minimum number of RELEVANTLY OBSERVED records before any coordination
 * indicator may fire. A semantic validity requirement, NOT a tuned threshold:
 * one record can never be described as coordination evidence.
 */
export const COORDINATION_MIN_OBSERVATIONS = 5;

/**
 * The documented indicator thresholds. These are DEFINITIONS of the observation,
 * deliberately not tuned against any live capture.
 */
export const COORDINATION_THRESHOLDS = Object.freeze({
  repeatedText: 0.5,
  fewAuthors: 0.7,
  singleLinkDomain: 0.6,
  burstRate: 30,
});

/**
 * Raised when a feature version is unregistered, or when a manifest is required
 * to pin one but does not. FAIL-CLOSED: there is no fallback to the latest
 * transform.
 */
export class UnknownFeatureVersionError extends Error {
  constructor(version, detail = null) {
    super(
      `unknown external-intelligence feature version ${JSON.stringify(version ?? null)}. ` +
        `Registered versions: ${REGISTERED_FEATURE_VERSIONS.join(", ")}. ` +
        "Feature-version resolution is FAIL-CLOSED: an unknown version is never mapped to the latest transform." +
        (detail ? ` ${detail}` : ""),
    );
    this.name = "UnknownFeatureVersionError";
    this.featureVersion = version ?? null;
  }
}

function median(values) {
  const usable = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (usable.length === 0) return null;
  const mid = Math.floor(usable.length / 2);
  return usable.length % 2 === 0 ? (usable[mid - 1] + usable[mid]) / 2 : usable[mid];
}

function shareOfLargest(counts) {
  const values = Object.values(counts);
  if (values.length === 0) return null;
  const total = values.reduce((sum, value) => sum + value, 0);
  if (total === 0) return null;
  return Math.max(...values) / total;
}

function round6(value) {
  return Number.isFinite(value) ? Number(value.toFixed(6)) : null;
}

/**
 * Extract the feature vector.
 *
 * @param {{
 *   records?: object[],
 *   capturedAt?: string|null,
 *   asOf?: number|null,
 *   queryPlanCount?: number|null,
 *   failureCount?: number|null,
 * }} options
 */
export function extractIntelligenceFeatures({
  records = [],
  capturedAt = null,
  asOf = null,
  queryPlanCount = null,
  failureCount = null,
} = {}) {
  const mentionCount = records.length;
  const authors = new Map();
  const texts = new Map();
  const domains = new Map();
  const channels = new Set();
  const backends = new Set();
  const queriesWithRecords = new Set();
  const engagements = [];
  const published = [];

  for (const record of records) {
    const author = record?.authorId ?? null;
    if (author) authors.set(author, (authors.get(author) ?? 0) + 1);
    const text = record?.textExcerpt ?? null;
    if (text) texts.set(text, (texts.get(text) ?? 0) + 1);
    const domain = linkDomain(record?.canonicalUrl);
    if (domain) domains.set(domain, (domains.get(domain) ?? 0) + 1);
    if (record?.channel) channels.add(record.channel);
    if (record?.backend) backends.add(record.backend);
    if (record?.queryId) queriesWithRecords.add(record.queryId);
    if (Number.isFinite(record?.engagement)) engagements.push(record.engagement);
    const publishedMs = record?.publishedAt ? Date.parse(record.publishedAt) : Number.NaN;
    if (Number.isFinite(publishedMs)) published.push(publishedMs);
  }

  const spanMinutes =
    published.length >= 2 ? Math.max(1, (Math.max(...published) - Math.min(...published)) / 60_000) : null;
  const duplicateTextCount = [...texts.values()].filter((count) => count > 1).reduce((sum, count) => sum + count, 0);
  const duplicateTextRatio = mentionCount > 0 ? duplicateTextCount / mentionCount : null;
  const repeatedAuthorRatio =
    mentionCount > 0 ? round6(1 - authors.size / mentionCount) : null;
  const captureAgeMs =
    capturedAt && Number.isFinite(asOf) ? Math.max(0, asOf - Date.parse(capturedAt)) : null;

  const features = {
    featureVersion: INTELLIGENCE_FEATURE_VERSION,
    mentionCount,
    uniqueAuthors: authors.size,
    postsPerMinute: spanMinutes ? round6(mentionCount / spanMinutes) : null,
    engagementTotal: engagements.length > 0 ? round6(engagements.reduce((sum, value) => sum + value, 0)) : null,
    engagementMedian: round6(median(engagements)),
    duplicateTextRatio: round6(duplicateTextRatio),
    repeatedAuthorRatio,
    linkDomainConcentration: round6(shareOfLargest(Object.fromEntries(domains))),
    accountConcentration: round6(shareOfLargest(Object.fromEntries(authors))),
    sourceCount: channels.size,
    backendCount: backends.size,
    sourceDiversity: mentionCount > 0 ? round6(domains.size / mentionCount) : null,
    queryCoverage:
      Number.isFinite(queryPlanCount) && queryPlanCount > 0 ? round6(queriesWithRecords.size / queryPlanCount) : null,
    captureAgeMs,
    fetchFailureRate: null,
  };
  features.fetchFailureRate = computeFetchFailureRate({ calls: queryPlanCount ?? null, failures: failureCount ?? 0 });
  features.coordinationIndicators = coordinationIndicators(features);
  features.note =
    "Bounded deterministic features over the frozen capture. `coordinationIndicators` describe the captured bytes only — " +
    "they are NOT a bot probability and are never a gate.";
  return features;
}

/** Recorded, documented failures / attempts (null when nothing was attempted). */
export function computeFetchFailureRate({ calls = null, failures = 0 } = {}) {
  if (!Number.isFinite(calls) || calls <= 0) return null;
  return round6(Math.min(1, failures / calls));
}

/**
 * Deterministic coordination indicators. Each entry states what was observed and
 * the exact rule — no learned score, no claimed probability.
 */
export function coordinationIndicators(features) {
  const indicators = [];
  const add = (id, observed, rule) => indicators.push({ id, observed, rule, kind: "coordination" });
  if (Number.isFinite(features.duplicateTextRatio) && features.duplicateTextRatio >= 0.5) {
    add(
      "repeatedText",
      { duplicateTextRatio: features.duplicateTextRatio },
      "duplicateTextRatio >= 0.5 (at least half of the records repeat another record's bounded text)",
    );
  }
  if (Number.isFinite(features.repeatedAuthorRatio) && features.repeatedAuthorRatio >= 0.7) {
    add(
      "fewAuthors",
      { uniqueAuthors: features.uniqueAuthors, mentionCount: features.mentionCount },
      "repeatedAuthorRatio >= 0.7 (>= 70% of records would be duplicates by author alone)",
    );
  }
  if (Number.isFinite(features.linkDomainConcentration) && features.linkDomainConcentration >= 0.6) {
    add(
      "singleLinkDomain",
      { linkDomainConcentration: features.linkDomainConcentration },
      "linkDomainConcentration >= 0.6 (one link domain dominates the records)",
    );
  }
  if (Number.isFinite(features.postsPerMinute) && features.postsPerMinute >= 30) {
    add(
      "burstRate",
      { postsPerMinute: features.postsPerMinute },
      "postsPerMinute >= 30 over the observed publication span",
    );
  }
  return {
    kind: "coordinationIndicators",
    claim: "deterministic observations over the frozen capture — NOT a bot probability",
    count: indicators.length,
    indicators,
  };
}

/**
 * Feature fields that depend on the REPLAY CLOCK rather than on the frozen
 * capture. `captureAgeMs` legitimately changes between two replays of the same
 * snapshot, so it is a presentation-only field and NEVER participates in
 * `featuresDigest` — otherwise "byte-equivalent replay" would be a lie.
 */
export const FEATURE_CLOCK_FIELDS = Object.freeze(["captureAgeMs"]);

/** The exact subject of `featuresDigest` (frozen evidence only). */
export function featuresDigestSubject(features) {
  if (features === null || typeof features !== "object") return null;
  const subject = { ...features };
  for (const field of FEATURE_CLOCK_FIELDS) delete subject[field];
  return subject;
}

/**
 * Deterministic digest of a feature vector.
 *
 * Replay-stable: two replays of the same frozen capture produce the same digest
 * because clock-derived fields are excluded (see `FEATURE_CLOCK_FIELDS`).
 */
export function featuresDigest(features) {
  return digestOf(featuresDigestSubject(features));
}

/* ============================================================================
 * V2 — observation-aware features
 *
 * V2 exists because V1 conflated three different things:
 *
 *   record count            mentionCount
 *   observed-field count    how many records actually CARRIED the field
 *   distinct-value count    how many distinct values those observations held
 *
 * V1 divided by `mentionCount` unconditionally, so a record with NO author made
 * `repeatedAuthorRatio` read 1.0 ("everyone repeats") when the truth was "no
 * author was observed at all". Missing data is UNKNOWN, never concentration, and
 * a sample of one is never coordination evidence.
 * ==========================================================================*/

/** Observed/denominator counts for one capture's records (bounded, deterministic). */
export function observationCounts(records = []) {
  const authors = new Map();
  const texts = new Map();
  const domains = new Map();
  const published = [];
  const engagements = [];
  for (const record of records) {
    const author = record?.authorId ?? null;
    if (author) authors.set(author, (authors.get(author) ?? 0) + 1);
    const text = record?.textExcerpt ?? null;
    if (text) texts.set(text, (texts.get(text) ?? 0) + 1);
    const domain = linkDomain(record?.canonicalUrl);
    if (domain) domains.set(domain, (domains.get(domain) ?? 0) + 1);
    const publishedMs = record?.publishedAt ? Date.parse(record.publishedAt) : Number.NaN;
    if (Number.isFinite(publishedMs)) published.push(publishedMs);
    if (Number.isFinite(record?.engagement)) engagements.push(record.engagement);
  }
  const sum = (map) => [...map.values()].reduce((total, count) => total + count, 0);
  return {
    authors,
    texts,
    domains,
    published,
    engagements,
    authorObservedCount: sum(authors),
    textObservedCount: sum(texts),
    linkObservedCount: sum(domains),
    publishedAtObservedCount: published.length,
    engagementObservedCount: engagements.length,
  };
}

/**
 * V2 feature transform.
 *
 * Every ratio uses its OWN observed-field denominator, and every ratio is `null`
 * when nothing relevant was observed. No raw text, URL or author is ever exposed:
 * only counts, ratios and bounded deterministic labels.
 */
export function extractIntelligenceFeaturesV2({
  records = [],
  capturedAt = null,
  asOf = null,
  queryPlanCount = null,
  failureCount = null,
} = {}) {
  const mentionCount = records.length;
  const channels = new Set();
  const backends = new Set();
  const queriesWithRecords = new Set();
  for (const record of records) {
    if (record?.channel) channels.add(record.channel);
    if (record?.backend) backends.add(record.backend);
    if (record?.queryId) queriesWithRecords.add(record.queryId);
  }

  const counts = observationCounts(records);
  const {
    authors,
    texts,
    domains,
    published,
    engagements,
    authorObservedCount,
    textObservedCount,
    linkObservedCount,
    publishedAtObservedCount,
    engagementObservedCount,
  } = counts;

  const coverage = (observed) => (mentionCount > 0 ? round6(observed / mentionCount) : null);
  const spanMinutes =
    published.length >= 2 ? Math.max(1, (Math.max(...published) - Math.min(...published)) / 60_000) : null;
  const duplicateTextCount = [...texts.values()].filter((count) => count > 1).reduce((sum, count) => sum + count, 0);
  // A missing text is UNKNOWN: it is neither a unique text nor a repeated one.
  const duplicateTextRatio = textObservedCount > 0 ? duplicateTextCount / textObservedCount : null;
  // A missing author is UNKNOWN: the denominator is the observed author count.
  const repeatedAuthorRatio =
    authorObservedCount > 0 ? round6(1 - authors.size / authorObservedCount) : null;
  const captureAgeMs =
    capturedAt && Number.isFinite(asOf) ? Math.max(0, asOf - Date.parse(capturedAt)) : null;

  const features = {
    featureVersion: INTELLIGENCE_FEATURE_VERSION_V2,
    mentionCount,
    // Distinct-value counts.
    uniqueAuthors: authors.size,
    uniqueTexts: texts.size,
    uniqueLinkDomains: domains.size,
    // Observed-field counts: the honest denominators.
    authorObservedCount,
    textObservedCount,
    linkObservedCount,
    publishedAtObservedCount,
    engagementObservedCount,
    // Coverage ratios: how much of the capture actually carried each field.
    authorCoverage: coverage(authorObservedCount),
    textCoverage: coverage(textObservedCount),
    linkCoverage: coverage(linkObservedCount),
    publishedAtCoverage: coverage(publishedAtObservedCount),
    engagementCoverage: coverage(engagementObservedCount),
    // Only timestamps that EXIST participate; null when no span is defined.
    postsPerMinute: spanMinutes ? round6(publishedAtObservedCount / spanMinutes) : null,
    engagementTotal: engagements.length > 0 ? round6(engagements.reduce((sum, value) => sum + value, 0)) : null,
    engagementMedian: round6(median(engagements)),
    duplicateTextRatio: round6(duplicateTextRatio),
    repeatedAuthorRatio,
    linkDomainConcentration: round6(shareOfLargest(Object.fromEntries(domains))),
    accountConcentration: round6(shareOfLargest(Object.fromEntries(authors))),
    sourceCount: channels.size,
    backendCount: backends.size,
    sourceDiversity: linkObservedCount > 0 ? round6(domains.size / linkObservedCount) : null,
    queryCoverage:
      Number.isFinite(queryPlanCount) && queryPlanCount > 0 ? round6(queriesWithRecords.size / queryPlanCount) : null,
    captureAgeMs,
    fetchFailureRate: null,
  };
  features.fetchFailureRate = computeFetchFailureRate({ calls: queryPlanCount ?? null, failures: failureCount ?? 0 });
  features.coordinationIndicators = coordinationIndicatorsV2(features);
  features.note =
    "Bounded deterministic features over the frozen capture. Every ratio uses its OWN observed-field denominator and is null " +
    "when nothing relevant was observed: missing data is UNKNOWN, never concentration. `coordinationIndicators` describe the " +
    "captured bytes only — they are NOT a bot probability and are never a gate.";
  return features;
}

/**
 * V2 coordination indicators. Each indicator may fire ONLY when its RELEVANT
 * observed-field count reaches `COORDINATION_MIN_OBSERVATIONS`, so a one-record
 * sample can never be described as coordination. Descriptive observations only:
 * never a bot probability, never a risk score, never a gate, never a trading input.
 */
export function coordinationIndicatorsV2(features) {
  const indicators = [];
  const add = (id, observed, rule) => indicators.push({ id, observed, rule, kind: "coordination" });
  const minimum = COORDINATION_MIN_OBSERVATIONS;
  if (
    features.textObservedCount >= minimum &&
    Number.isFinite(features.duplicateTextRatio) &&
    features.duplicateTextRatio >= COORDINATION_THRESHOLDS.repeatedText
  ) {
    add(
      "repeatedText",
      { textObservedCount: features.textObservedCount, duplicateTextRatio: features.duplicateTextRatio },
      `textObservedCount >= ${minimum} AND duplicateTextRatio >= ${COORDINATION_THRESHOLDS.repeatedText} over the OBSERVED texts`,
    );
  }
  if (
    features.authorObservedCount >= minimum &&
    Number.isFinite(features.repeatedAuthorRatio) &&
    features.repeatedAuthorRatio >= COORDINATION_THRESHOLDS.fewAuthors
  ) {
    add(
      "fewAuthors",
      {
        authorObservedCount: features.authorObservedCount,
        uniqueAuthors: features.uniqueAuthors,
        repeatedAuthorRatio: features.repeatedAuthorRatio,
      },
      `authorObservedCount >= ${minimum} AND repeatedAuthorRatio >= ${COORDINATION_THRESHOLDS.fewAuthors} over the OBSERVED authors`,
    );
  }
  if (
    features.linkObservedCount >= minimum &&
    Number.isFinite(features.linkDomainConcentration) &&
    features.linkDomainConcentration >= COORDINATION_THRESHOLDS.singleLinkDomain
  ) {
    add(
      "singleLinkDomain",
      {
        linkObservedCount: features.linkObservedCount,
        linkDomainConcentration: features.linkDomainConcentration,
      },
      `linkObservedCount >= ${minimum} AND linkDomainConcentration >= ${COORDINATION_THRESHOLDS.singleLinkDomain} over the OBSERVED link domains`,
    );
  }
  if (
    features.publishedAtObservedCount >= minimum &&
    Number.isFinite(features.postsPerMinute) &&
    features.postsPerMinute >= COORDINATION_THRESHOLDS.burstRate
  ) {
    add(
      "burstRate",
      {
        publishedAtObservedCount: features.publishedAtObservedCount,
        postsPerMinute: features.postsPerMinute,
      },
      `publishedAtObservedCount >= ${minimum} AND postsPerMinute >= ${COORDINATION_THRESHOLDS.burstRate} over the OBSERVED publication timestamps`,
    );
  }
  return {
    kind: "coordinationIndicators",
    claim: "deterministic observations over the frozen capture — NOT a bot probability",
    minRelevantObservations: minimum,
    count: indicators.length,
    indicators,
  };
}

/* ============================================================================
 * Registry — the ONLY way a feature version becomes an extractor
 * ==========================================================================*/

/** version → transform. Frozen at module load; never edited at runtime. */
const FEATURE_EXTRACTORS = new Map([
  [INTELLIGENCE_FEATURE_VERSION, { version: INTELLIGENCE_FEATURE_VERSION, extract: extractIntelligenceFeatures }],
  [INTELLIGENCE_FEATURE_VERSION_V2, { version: INTELLIGENCE_FEATURE_VERSION_V2, extract: extractIntelligenceFeaturesV2 }],
]);

/** Is this an explicitly registered feature version? */
export function isRegisteredFeatureVersion(version) {
  return typeof version === "string" && FEATURE_EXTRACTORS.has(version.trim());
}

/**
 * Resolve a feature version to its extractor.
 *
 * FAIL-CLOSED: a missing, empty, whitespace or unknown version throws
 * `UnknownFeatureVersionError`. It is NEVER mapped to the latest transform.
 *
 * @param {string} version
 * @returns {{ version: string, extract: Function }}
 */
export function featureExtractorFor(version) {
  if (typeof version !== "string" || version.trim().length === 0) {
    throw new UnknownFeatureVersionError(version ?? null, "An explicit registered version is required.");
  }
  const normalized = version.trim();
  const entry = FEATURE_EXTRACTORS.get(normalized);
  if (!entry) throw new UnknownFeatureVersionError(version);
  return entry;
}
