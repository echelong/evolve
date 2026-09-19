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
 * PAPER ONLY, READ-ONLY. No network, no clock except an explicitly passed `asOf`.
 */

import { digestOf } from "../lib/hash.mjs";
import { linkDomain } from "./records.mjs";

export const INTELLIGENCE_FEATURE_VERSION = "external-intelligence-features-v1";

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
