/**
 * Phase 5G.0 — FROZEN classifier definition + input projection (PAPER ONLY).
 *
 * classifier.dev is a bounded, EXTERNAL classification layer over ALREADY-FROZEN
 * Agent-Reach observations:
 *
 *   Agent-Reach → immutable capture → deterministic normalized records
 *     → classifier.dev FAST tier → frozen classification artifact → STOP
 *
 * This module owns the two things that must never be dynamic:
 *
 *   1. the taxonomy (`reach-signal-type-v1`, version 1, exactly nine labels) and
 *      the instruction text that is sent with every request; and
 *   2. the deterministic input projection (`classifier-input-projection-v1`) that
 *      turns ONE normalized record into the ONLY text that may cross the external
 *      boundary.
 *
 * The labels are DESCRIPTIVE. `promotion_or_marketing` does not mean scam,
 * manipulation, malicious, pump or fraud; `security_or_risk` means the text is
 * principally ABOUT a security/risk topic, not that EVOLVE verified any claim.
 * No label has authority over the Arena, evolution, gates, replication or
 * deployment.
 *
 * Nothing here touches the network, Jev, DeepSeek, Agent-Reach or the Arena.
 */

import { digestOf } from "../lib/hash.mjs";
import { redactSecrets } from "../lib/sanitize.mjs";

/* ============================================================================
 * Taxonomy
 * ==========================================================================*/

export const CLASSIFIER_ID = "reach-signal-type-v1";
export const CLASSIFIER_VERSION = 1;

/** EXACTLY nine labels, in this order. Never extended dynamically. */
export const CLASSIFIER_LABELS = Object.freeze([
  "technical_activity",
  "project_announcement",
  "exchange_or_listing",
  "liquidity_or_market_structure",
  "security_or_risk",
  "governance_or_admin",
  "community_attention",
  "promotion_or_marketing",
  "unrelated_or_noise",
]);

/**
 * The fixed instruction text sent with every request. Versioned with the
 * classifier: changing one character changes `CLASSIFIER_INSTRUCTIONS_DIGEST` and
 * therefore requires a new classifier version.
 */
export const CLASSIFIER_INSTRUCTIONS =
  "Classify the primary research-relevant type of this public external observation. " +
  "Describe what kind of observation it is, not whether an asset should be bought or sold. " +
  "Do not infer price direction, profitability, legitimacy, coordinated manipulation, identity, or intent. " +
  "Choose unrelated_or_noise when none of the other categories clearly applies.";

export const CLASSIFIER_INSTRUCTIONS_DIGEST = digestOf(CLASSIFIER_INSTRUCTIONS);

/** The one classifier this phase knows. Callers cannot bring their own labels. */
export const REGISTERED_CLASSIFIERS = Object.freeze([CLASSIFIER_ID]);

export class UnknownClassifierError extends Error {
  constructor(classifierId) {
    super(
      `unknown classifier '${classifierId}' — Phase 5G.0 has exactly one frozen classifier ` +
        `('${CLASSIFIER_ID}'); labels are never supplied by the caller.`,
    );
    this.name = "UnknownClassifierError";
    this.classifierId = classifierId;
  }
}

/** The frozen definition of a classifier, by id. Throws on anything unregistered. */
export function classifierDefinitionFor(classifierId) {
  if (classifierId !== CLASSIFIER_ID) throw new UnknownClassifierError(classifierId);
  return CLASSIFIER_DEFINITION;
}

/* ============================================================================
 * Input projection
 * ==========================================================================*/

export const INPUT_PROJECTION_VERSION = "classifier-input-projection-v1";

/** The ONLY record fields that may contribute to the classifier input. */
export const CLASSIFIER_INPUT_FIELDS = Object.freeze(["title", "textExcerpt"]);

/**
 * Record fields that may be used LOCALLY for provenance but must never reach the
 * classifier text. Kept as data so a test can assert the exact exclusion list.
 */
export const CLASSIFIER_EXCLUDED_FIELDS = Object.freeze([
  "query",
  "queryId",
  "canonicalId",
  "canonicalUrl",
  "authorId",
  "rawDigest",
  "captureId",
  "backend",
  "engagement",
  "publishedAt",
]);

/** The final classifier input never exceeds this many characters. */
export const CLASSIFIER_INPUT_MAX_CHARS = 800;

/** Fixed replacement tokens. */
export const URL_TOKEN = "[URL]";

/** Fixed separator between title and excerpt (a single newline survives normalization). */
const PART_SEPARATOR = "\n";

const URL_PATTERN = /\b(?:https?:\/\/|www\.)[^\s<>"'`]+/gi;

/**
 * Well-known credential SHAPES the generic key/value sanitizer cannot see
 * because they appear bare in prose (no `key=` prefix).
 */
const TOKEN_SHAPES = [
  // The generic sanitizer redacts the word after `Authorization:` — i.e. "Bearer" —
  // and would leave the token itself behind, so a bare bearer token is caught first.
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
];

/**
 * Normalize whitespace deterministically: runs of horizontal whitespace collapse
 * to one space; any run of whitespace that contains a line break collapses to a
 * single "\n"; the result is trimmed.
 */
export function normalizeClassifierWhitespace(text) {
  return String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ ?\n[\s]*/g, "\n")
    .trim();
}

/** Replace every embedded URL with `[URL]`, keeping surrounding punctuation. */
export function replaceEmbeddedUrls(text) {
  return String(text ?? "").replace(URL_PATTERN, (match) => {
    let core = match;
    let tail = "";
    for (;;) {
      const last = core.slice(-1);
      const trimmable =
        /[.,;:!?)}"']/.test(last) ||
        (last === "]" && (core.match(/\]/g) ?? []).length > (core.match(/\[/g) ?? []).length);
      if (!trimmable || core.length <= 1) break;
      tail = last + tail;
      core = core.slice(0, -1);
    }
    return `${URL_TOKEN}${tail}`;
  });
}

/** Redact secret-shaped strings with the existing EVOLVE sanitizer + bare token shapes. */
export function redactClassifierText(text) {
  let out = String(text ?? "");
  for (const shape of TOKEN_SHAPES) out = out.replace(shape, "[redacted]");
  return redactSecrets(out);
}

/** Bound to N characters without splitting a surrogate pair. */
export function boundClassifierInput(text, maxChars = CLASSIFIER_INPUT_MAX_CHARS) {
  if (text.length <= maxChars) return text;
  let cut = text.slice(0, maxChars);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut.trimEnd();
}

/**
 * Project ONE normalized record into the classifier input.
 *
 *   1. take `title` if present
 *   2. take `textExcerpt` if present
 *   3. join them deterministically
 *   4. normalize whitespace
 *   5. redact secret-shaped strings (existing EVOLVE sanitizer)
 *   6. replace embedded URLs with `[URL]`
 *   7. bound to 800 characters
 *   8. skip empty input
 *
 * ONLY `title` and `textExcerpt` are read. No context is invented: no symbol,
 * price, query, channel, author, URL, reputation or EVOLVE state is prepended.
 *
 * @returns {{ ok: true, input: string, inputDigest: string } | { ok: false, reason: string }}
 */
export function projectClassifierInput(record) {
  const parts = [];
  for (const field of CLASSIFIER_INPUT_FIELDS) {
    const value = record?.[field];
    if (typeof value === "string" && value.trim().length > 0) parts.push(value);
  }
  if (parts.length === 0) return { ok: false, reason: "empty_input" };

  let text = normalizeClassifierWhitespace(parts.join(PART_SEPARATOR));
  text = redactClassifierText(text);
  text = replaceEmbeddedUrls(text);
  text = boundClassifierInput(text);
  if (text.length === 0) return { ok: false, reason: "empty_input" };
  return { ok: true, input: text, inputDigest: digestOf(text) };
}

/**
 * Project a whole capture in record order. Returns the eligible items (each keeps
 * the source `recordDigest` and the `inputDigest`, plus the transient `input`)
 * and the skipped-empty count. The `input` text is for the request ONLY and must
 * never be persisted.
 */
export function projectClassifierInputs(records) {
  const items = [];
  let skippedEmptyCount = 0;
  for (const record of Array.isArray(records) ? records : []) {
    const projected = projectClassifierInput(record);
    if (!projected.ok) {
      skippedEmptyCount += 1;
      continue;
    }
    items.push({ recordDigest: record.normalizedDigest, inputDigest: projected.inputDigest, input: projected.input });
  }
  return { items, skippedEmptyCount };
}

/* ============================================================================
 * Frozen definition object
 * ==========================================================================*/

export const CLASSIFIER_DEFINITION = Object.freeze({
  classifierId: CLASSIFIER_ID,
  classifierVersion: CLASSIFIER_VERSION,
  labels: CLASSIFIER_LABELS,
  instructions: CLASSIFIER_INSTRUCTIONS,
  instructionsDigest: CLASSIFIER_INSTRUCTIONS_DIGEST,
  inputProjectionVersion: INPUT_PROJECTION_VERSION,
  tier: "fast",
  multi: false,
});

/** Digest of everything that defines the classification semantics. */
export const CLASSIFIER_DEFINITION_DIGEST = digestOf({
  classifierId: CLASSIFIER_ID,
  classifierVersion: CLASSIFIER_VERSION,
  labels: CLASSIFIER_LABELS,
  instructionsDigest: CLASSIFIER_INSTRUCTIONS_DIGEST,
  inputProjectionVersion: INPUT_PROJECTION_VERSION,
  inputFields: CLASSIFIER_INPUT_FIELDS,
  maxChars: CLASSIFIER_INPUT_MAX_CHARS,
  tier: "fast",
  multi: false,
});
