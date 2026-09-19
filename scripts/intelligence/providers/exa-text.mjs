/**
 * Phase 5G.1c — the DEDICATED, BOUNDED parser for MCPorter / Exa TEXT output.
 * (PAPER ONLY, READ-ONLY, SHADOW ONLY.)
 *
 * WHY THIS EXISTS
 * ---------------
 * The V2 contract (`--output raw`) was proven at runtime against
 * `mcporter 0.13.13` + `exa.web_search_exa`: status 0, 37422 bytes, genuine
 * results. MCPorter's `raw` mode, however, renders a Node/JavaScript INSPECTION
 * representation — `{ content: [ { type: 'text', text: 'Title: …' } ] }` — not
 * strict JSON, so no JSON parser can read it.
 *
 * This module therefore reads the OTHER boundary: MCPorter's `--output text`,
 * which carries Exa's own deterministic textual search-result representation.
 *
 * DELIBERATELY NARROW
 * -------------------
 *   * It is NOT a general `util.inspect` / JavaScript object-dump parser.
 *   * It NEVER evaluates anything: no `eval`, no `Function`, no `vm`, no dynamic
 *     import, no AST execution — the input is treated as opaque TEXT.
 *   * It NEVER fetches, resolves or follows a URL (no network primitive exists
 *     here); a URL is kept only as bounded DATA.
 *   * It recognizes exactly five fixed headings and never creates an object key
 *     from an arbitrary field name.
 *
 * The canonical normalization layer still runs afterwards, so the fields here are
 * only the bounded RAW projection (`title` / `url` / `publishedAt` / `author` /
 * `text`) the existing normalizer already understands.
 */

import { REACH_EXA_TEXT_PARSE_FORMAT } from "../agent-reach.mjs";

/** The parser's frozen format identifier (see `call.parse.format`). */
export const EXA_TEXT_PARSE_FORMAT = REACH_EXA_TEXT_PARSE_FORMAT;

/** Hard bounds. Every one of them is explicit and deterministic. */
export const EXA_TEXT_MAX_RESULT_BLOCKS = 25;
export const EXA_TEXT_MAX_TITLE_CHARS = 500;
export const EXA_TEXT_MAX_URL_CHARS = 2_048;
export const EXA_TEXT_MAX_AUTHOR_CHARS = 500;
export const EXA_TEXT_MAX_PUBLISHED_CHARS = 200;
export const EXA_TEXT_MAX_HIGHLIGHTS_CHARS = 8_000;
/** Bound on how many split blocks are ever EXAMINED (defence in depth). */
export const EXA_TEXT_MAX_SCAN_BLOCKS = 256;

/** A result block separator is a line that is exactly `---` after trimming. */
export const EXA_TEXT_RESULT_SEPARATOR = "---";

/** The ONLY headings the parser recognizes; anything else is ignored. */
export const EXA_TEXT_HEADINGS = Object.freeze(["Title", "URL", "Published", "Author", "Highlights"]);

/** `Title:` / `URL:` / `Published:` / `Author:` / `Highlights:` at line start. */
const EXA_TEXT_HEADING_PATTERN = /^[ \t]*(Title|URL|Published|Author|Highlights):[ \t]?([\s\S]*)$/;

/** The literal Exa uses for "no value". Never invented, never coerced. */
const EXA_TEXT_NULL_LITERAL = "n/a";

/** Trim + bound a heading value, mapping the explicit `N/A` literal to null. */
function boundedHeadingValue(value, maxChars) {
  const text = String(value ?? "").trim();
  if (text.length === 0) return null;
  if (text.toLowerCase() === EXA_TEXT_NULL_LITERAL) return null;
  return text.length <= maxChars ? text : text.slice(0, maxChars);
}

/**
 * A URL is kept ONLY when it is an absolute `https:` URL inside the bound.
 * Anything else (relative, `http:`, `N/A`, whitespace-bearing, oversized) is
 * mapped to null — the parser never repairs, upgrades or guesses a URL.
 *
 * Parsing a URL string is pure: nothing is resolved, requested or followed.
 */
function boundedHttpsUrl(value, maxChars) {
  const text = String(value ?? "").trim();
  if (text.length === 0 || text.length > maxChars) return null;
  if (text.toLowerCase() === EXA_TEXT_NULL_LITERAL) return null;
  if (/\s/.test(text)) return null;
  try {
    return new URL(text).protocol === "https:" ? text : null;
  } catch {
    return null;
  }
}

/** Join the highlight lines deterministically, preserving order, then bound. */
function boundedHighlights(lines, maxChars) {
  if (lines.length === 0) return null;
  const joined = lines
    .join("\n")
    .replace(/[ \t]+$/gm, "")
    .trim();
  if (joined.length === 0) return null;
  return joined.length <= maxChars ? joined : joined.slice(0, maxChars);
}

/**
 * Split the text into candidate blocks on SEPARATOR LINES only.
 *
 * A `---` that merely appears inside prose (e.g. `a --- b`, `----------`) does
 * NOT split: the line must trim to exactly `---`. Empty segments are dropped.
 */
function splitExaTextBlocks(text) {
  const blocks = [];
  let current = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === EXA_TEXT_RESULT_SEPARATOR) {
      blocks.push(current.join("\n").trim());
      current = [];
      continue;
    }
    current.push(line);
  }
  blocks.push(current.join("\n").trim());
  return blocks.filter((block) => block.length > 0);
}

/**
 * Recognize ONE block as an Exa result.
 *
 * A block is recognizable only when it carries a `Title:` or `URL:` heading AND
 * at least one USABLE evidence value (title, https URL or highlights). Arbitrary
 * prose is therefore never accepted as a record.
 *
 * `Highlights:` consumes everything after it (to the block boundary), so a
 * heading-looking line inside a highlight body stays part of the highlight text.
 */
function parseExaTextBlock(block) {
  let title = null;
  let url = null;
  let publishedAt = null;
  let author = null;
  let hasEvidenceHeading = false;
  let inHighlights = false;
  const highlightLines = [];

  for (const line of block.split("\n")) {
    if (inHighlights) {
      highlightLines.push(line);
      continue;
    }
    const match = EXA_TEXT_HEADING_PATTERN.exec(line);
    // Unknown headings and any other line are ignored: no dynamic key is ever
    // created from a field name.
    if (!match) continue;
    const [, heading, value] = match;
    if (heading === "Title") {
      hasEvidenceHeading = true;
      title = boundedHeadingValue(value, EXA_TEXT_MAX_TITLE_CHARS);
    } else if (heading === "URL") {
      hasEvidenceHeading = true;
      url = boundedHttpsUrl(value, EXA_TEXT_MAX_URL_CHARS);
    } else if (heading === "Published") {
      publishedAt = boundedHeadingValue(value, EXA_TEXT_MAX_PUBLISHED_CHARS);
    } else if (heading === "Author") {
      author = boundedHeadingValue(value, EXA_TEXT_MAX_AUTHOR_CHARS);
    } else if (heading === "Highlights") {
      inHighlights = true;
      if (String(value ?? "").trim().length > 0) highlightLines.push(value);
    }
  }

  const text = boundedHighlights(highlightLines, EXA_TEXT_MAX_HIGHLIGHTS_CHARS);
  const usable = title !== null || url !== null || text !== null;
  if (!hasEvidenceHeading || !usable) return null;
  return { title, url, publishedAt, author, text };
}

/**
 * Parse MCPorter `--output text` stdout into bounded raw records.
 *
 * THREE DISTINCT EMPTY/FAILURE SEMANTICS (the caller decides; this function only
 * reports what it saw — it never invents evidence):
 *
 *   1. truly empty stdout        → `explicitEmpty: true`, zero records
 *   2. non-empty, ZERO blocks    → zero records, `explicitEmpty: false`
 *      recognized                  (the caller FAILS CLOSED on this)
 *   3. valid result blocks       → the (bounded) records
 *
 * The returned diagnostics are counts only: no raw text, no URL, no title, no
 * author and no excerpt is ever placed in the metadata.
 *
 * @param {string} text the stdout produced by `mcporter … --output text`
 */
export function parseExaSearchText(text) {
  const source = String(text ?? "");
  const outputBytes = Buffer.byteLength(source, "utf8");
  if (source.trim().length === 0) {
    return {
      format: EXA_TEXT_PARSE_FORMAT,
      records: [],
      explicitEmpty: true,
      blocksSeen: 0,
      recordsExtracted: 0,
      blocksDiscarded: 0,
      outputBytes,
    };
  }

  const blocks = splitExaTextBlocks(source).slice(0, EXA_TEXT_MAX_SCAN_BLOCKS);
  const records = [];
  let blocksDiscarded = 0;
  for (const block of blocks) {
    const record = parseExaTextBlock(block);
    if (record === null) {
      blocksDiscarded += 1;
      continue;
    }
    // FIRST 25 deterministically — no randomness, no re-ordering, no scoring.
    if (records.length < EXA_TEXT_MAX_RESULT_BLOCKS) records.push(record);
  }

  return {
    format: EXA_TEXT_PARSE_FORMAT,
    records,
    explicitEmpty: false,
    blocksSeen: blocks.length,
    recordsExtracted: records.length,
    blocksDiscarded,
    outputBytes,
  };
}

export default parseExaSearchText;
