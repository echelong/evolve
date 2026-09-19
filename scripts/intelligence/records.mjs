/**
 * Phase 5E — normalized intelligence records (PAPER ONLY).
 *
 * Every capture stores ONE canonical record shape, whatever the backend was. A
 * record is a bounded, deterministic projection of what the read tool returned:
 * identity, provenance, and a BOUNDED text excerpt — never a raw payload, never
 * a cookie, never a token.
 *
 * DIGESTS
 * -------
 *   rawDigest        digest of the backend's raw record (canonical JSON), so the
 *                    exact upstream bytes that produced the evidence are pinned.
 *   normalizedDigest digest of the NORMALIZED, replay-relevant fields only:
 *                    capture id / capture clock are excluded on purpose, so a
 *                    replay of the same frozen capture reproduces the same
 *                    digest deterministically.
 *
 * Nothing here touches the network. PAPER ONLY.
 */

import { canonicalJson, digestOf } from "../lib/hash.mjs";

export const INTELLIGENCE_RECORD_SCHEMA_VERSION = 1;
export const DEFAULT_MAX_EXCERPT_CHARS = 600;
/** Health records are never evidence; they are reported separately. */
export const HEALTH_RECORD_KIND = "health";

/** Fields a normalized evidence record always carries (schema, not prose). */
export const NORMALIZED_RECORD_FIELDS = Object.freeze([
  "schemaVersion",
  "captureId",
  "capturedAt",
  "channel",
  "backend",
  "queryId",
  "query",
  "canonicalId",
  "canonicalUrl",
  "publishedAt",
  "authorId",
  "title",
  "textExcerpt",
  "engagement",
  "sourceVersion",
  "agentReachVersion",
  "backendVersion",
  "syntheticIntelligence",
  "rawDigest",
  "normalizedDigest",
]);

/** Fields that never participate in `normalizedDigest` (capture bookkeeping). */
export const NORMALIZED_DIGEST_EXCLUDED_FIELDS = Object.freeze([
  "captureId",
  "capturedAt",
  "rawDigest",
  "normalizedDigest",
  "syntheticIntelligence",
]);

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

function boundedNumber(value) {
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  if (!Number.isFinite(parsed)) return null;
  return Math.max(-1e12, Math.min(1e12, parsed));
}

function isoOrNull(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  const text = String(value).trim();
  if (text.length === 0) return null;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

/** Bound text to a fixed character budget (deterministic: first N characters). */
export function boundExcerpt(text, maxChars = DEFAULT_MAX_EXCERPT_CHARS) {
  if (typeof text !== "string") return null;
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) return null;
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars)}…`;
}

/** Hostname of a URL, or null (used by the concentration features). */
export function linkDomain(url) {
  if (typeof url !== "string" || url.trim().length === 0) return null;
  try {
    return new URL(url.trim()).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * The raw record projection a `rawDigest` is computed over: canonical and stable
 * (sorted keys via `canonicalJson`), so the same upstream answer always digests
 * identically regardless of key order.
 */
export function rawDigestSubject(raw) {
  if (raw === null || raw === undefined) return null;
  return raw;
}

export function rawDigestOf(raw) {
  return digestOf(rawDigestSubject(raw));
}

/** The exact subject of `normalizedDigest`. */
export function normalizedDigestSubject(record) {
  const subject = {};
  for (const field of NORMALIZED_RECORD_FIELDS) {
    if (NORMALIZED_DIGEST_EXCLUDED_FIELDS.includes(field)) continue;
    subject[field] = record?.[field] ?? null;
  }
  return subject;
}

export function normalizedDigestOf(record) {
  return digestOf(normalizedDigestSubject(record));
}

/**
 * Normalize ONE backend record into the canonical evidence shape.
 *
 * @param {{
 *   raw: object,
 *   context: {
 *     captureId: string, capturedAt: string, channel: string, backend: string,
 *     queryId: string|null, query: string|null, sourceVersion: string|null,
 *     agentReachVersion: string|null, backendVersion?: string|null,
 *     syntheticIntelligence?: boolean,
 *   },
 *   maxExcerptChars?: number,
 * }} options
 */
export function normalizeRecord({ raw, context, maxExcerptChars = DEFAULT_MAX_EXCERPT_CHARS } = {}) {
  if (!context?.captureId) throw new Error("normalizeRecord requires a capture context");
  const canonicalUrl = firstString(raw?.canonicalUrl, raw?.url, raw?.link, raw?.permalink);
  const record = {
    schemaVersion: INTELLIGENCE_RECORD_SCHEMA_VERSION,
    captureId: context.captureId,
    capturedAt: context.capturedAt,
    channel: context.channel,
    backend: context.backend,
    queryId: context.queryId ?? null,
    query: context.query ?? null,
    canonicalId: firstString(raw?.canonicalId, raw?.id, raw?.cid, raw?.uid, canonicalUrl),
    canonicalUrl,
    publishedAt: isoOrNull(raw?.publishedAt ?? raw?.createdAt ?? raw?.created_at ?? raw?.date),
    authorId: firstString(raw?.authorId, raw?.author, raw?.user, raw?.username, raw?.handle),
    title: boundExcerpt(raw?.title ?? null, 200),
    textExcerpt: boundExcerpt(raw?.text ?? raw?.content ?? raw?.description ?? raw?.excerpt ?? null, maxExcerptChars),
    // Bounded numeric engagement as the backend exposed it (null when absent).
    // Never inferred, never scaled: a missing value stays missing.
    engagement: boundedNumber(raw?.engagement ?? raw?.score ?? raw?.likes ?? null),
    sourceVersion: context.sourceVersion ?? null,
    agentReachVersion: context.agentReachVersion ?? null,
    backendVersion: context.backendVersion ?? null,
    syntheticIntelligence: context.syntheticIntelligence === true,
    rawDigest: rawDigestOf(raw),
  };
  record.normalizedDigest = normalizedDigestOf(record);
  return record;
}

/** Compact, secret-free view of a record (for reports and the dashboard). */
export function describeRecord(record) {
  return {
    channel: record?.channel ?? null,
    canonicalId: record?.canonicalId ?? null,
    publishedAt: record?.publishedAt ?? null,
    authorId: record?.authorId ?? null,
    normalizedDigest: record?.normalizedDigest ?? null,
    syntheticIntelligence: record?.syntheticIntelligence === true,
  };
}

/** Verify a stored record is internally consistent (read-only). */
export function verifyRecord(record) {
  const recomputed = normalizedDigestOf(record);
  return {
    ok: recomputed === record?.normalizedDigest,
    canonicalId: record?.canonicalId ?? null,
    recomputedDigest: recomputed,
    storedDigest: record?.normalizedDigest ?? null,
    canonical: canonicalJson(record) === canonicalJson(record),
  };
}
