/**
 * Phase 5E — fail-closed intelligence provider registry (PAPER ONLY).
 *
 *   disabled      nothing may be called at all (the default)
 *   mock          deterministic offline fixture provider
 *   agent-reach   the bounded, read-only subprocess adapter
 *
 * There is NO automatic fallback: a provider that fails at runtime is reported
 * as a failure, never silently replaced by the mock (the same rule the research
 * providers follow). A disabled provider refuses every call.
 *
 * Phase 5G.1b: the Agent-Reach provider is bounded by the EXPLICIT, versioned
 * successor capability contract (`reach-capability-map-v2`) and parses a raw MCP
 * tool response with a bounded, envelope-aware parser. A successful call whose
 * MCP CallResult envelope cannot be understood FAILS CLOSED
 * (`ReachResponseParseError`) instead of quietly reporting `records: 0` — a
 * genuine structured empty result array stays a valid zero-record call.
 *
 * PAPER ONLY, READ-ONLY. No provider here can write, post, sign or transact.
 */

import {
  DEFAULT_INTELLIGENCE_PROVIDER,
  DisabledIntelligenceProviderError,
  INTELLIGENCE_PROVIDER,
  REGISTERED_INTELLIGENCE_PROVIDERS,
  requireIntelligenceProvider,
} from "./config.mjs";
import { MOCK_INTELLIGENCE } from "./providers/mock-intelligence.mjs";
import { REACH_ACTIVE_CAPABILITY_MAP, runReachCall } from "./agent-reach.mjs";

/**
 * The capability contract NEW Agent-Reach captures are bounded by (Phase 5G.1b).
 * `reach-capability-map-v1` stays frozen for historical captures.
 */
export const REACH_ACTIVE_CAPABILITY_MAP_VERSION = REACH_ACTIVE_CAPABILITY_MAP.version;

export const DISABLED_INTELLIGENCE_PROVIDER = Object.freeze({
  name: INTELLIGENCE_PROVIDER.DISABLED,
  deterministic: true,
  external: false,
  subprocess: false,
  network: false,
  syntheticIntelligence: false,
  execute() {
    throw new DisabledIntelligenceProviderError(
      "the intelligence provider is DISABLED (EVOLVE_INTELLIGENCE_PROVIDER=disabled). " +
        "Pass `--provider mock` for an offline fixture capture or `--provider agent-reach` to enable the read-only adapter explicitly.",
    );
  },
});

/**
 * The Agent-Reach provider: one bounded, read-only subprocess call per query.
 * Its records are always marked non-synthetic (they come from the real world)
 * but they are still only OBSERVATIONS until captured and frozen.
 */
export function createAgentReachIntelligenceProvider({ config, env = process.env, projectRoot = process.cwd(), spawn = null } = {}) {
  return {
    name: INTELLIGENCE_PROVIDER.AGENT_REACH,
    deterministic: false,
    external: true,
    subprocess: true,
    network: true,
    syntheticIntelligence: false,
    agentReachVersion: config?.agentReach?.release ?? null,
    // The capability CONTRACT this provider is bounded by, so a capture can
    // persist which argv/argument contract produced its evidence.
    capabilityMapVersion: REACH_ACTIVE_CAPABILITY_MAP.version,
    execute(call = {}) {
      const result = runReachCall({
        op: call.op,
        channel: call.channel ?? null,
        values: {
          query: call.query ?? undefined,
          url: call.url ?? undefined,
          limit: call.limit ?? config?.maxResults ?? 10,
          timeoutSeconds: Math.max(1, Math.floor((config?.timeoutMs ?? 20_000) / 1000)),
        },
        config,
        budget: call.budget ?? null,
        env,
        projectRoot,
        // NEW captures use the explicit, versioned successor contract. The
        // frozen V1 map stays the default of the low-level helpers (historical
        // identity), so this opt-in is never implicit.
        capabilityMap: REACH_ACTIVE_CAPABILITY_MAP,
        ...(spawn ? { spawn } : {}),
      });
      const parsed = result.ok
        ? parseReachStdout(result.stdout)
        : { records: [], format: "not-run", mcp: false, explicitEmpty: false, contentBlocks: 0, blocksIgnored: 0 };
      // FAIL CLOSED: a successful call whose MCP CallResult envelope could not be
      // understood is a PARSE FAILURE, never a silent `records: 0`.
      const parseError = result.ok ? reachParseFailure(parsed) : null;
      const parseFailed = parseError !== null;
      return {
        ok: result.ok && !parseFailed,
        provider: INTELLIGENCE_PROVIDER.AGENT_REACH,
        syntheticIntelligence: false,
        backendVersion: config?.agentReach?.release ?? null,
        capabilityMapVersion: REACH_ACTIVE_CAPABILITY_MAP.version,
        records: result.ok && !parseFailed ? parsed.records : [],
        error: result.ok ? (parseFailed ? parseError.message : null) : result.error,
        errorName: result.ok ? (parseFailed ? parseError.name : null) : (result.errorName ?? null),
        parseFailed,
        call: {
          commandPreview: result.commandPreview,
          capabilityMapVersion: result.capabilityMapVersion ?? null,
          boundedArguments: result.boundedArguments ?? [],
          parse: {
            format: parsed.format,
            mcpCallResult: parsed.mcp === true,
            extractedRecords: parsed.records.length,
            explicitEmptyResult: parsed.explicitEmpty === true,
            contentBlocks: parsed.contentBlocks ?? 0,
            blocksIgnored: parsed.blocksIgnored ?? 0,
          },
          // Which executable this bounded read actually ran, and where it came
          // from: the pinned Agent-Reach CLI for health, or the frozen
          // capability map's upstream tool resolved on the sanitized PATH.
          executable: {
            basename: result.executable.basename,
            role: result.executable.role,
            source: result.executable.source,
            path: result.executable.path,
            available: result.executable.available,
          },
          spawned: result.spawned === true,
          unavailable: result.unavailable === true,
          durationMs: result.durationMs,
          bytes: result.bytes,
          timedOut: result.timedOut,
          overflowed: result.overflowed,
          envKeys: result.envKeys,
          walletEnvPresent: result.walletEnvPresent,
          tokensInEnv: result.tokensInEnv,
        },
      };
    },
  };
}

/**
 * Raised when a raw MCP tool response was RECOGNISED as a CallResult envelope
 * but no supported structured record could be extracted from it.
 *
 * It exists so EVOLVE can tell the two apart:
 *
 *   a genuine structured EMPTY result  -> zero evidence (status ok, 0 records)
 *   an envelope EVOLVE cannot parse    -> a bounded PARSE FAILURE (never a
 *                                         silent `records: 0`)
 */
export class ReachResponseParseError extends Error {
  constructor(message) {
    super(message);
    this.name = "ReachResponseParseError";
  }
}

/** Bound: how many `content[]` blocks a raw MCP response may contribute. */
export const MCP_CONTENT_BLOCK_LIMIT = 64;
/** Bound: how many records may be extracted from ONE raw MCP response. */
export const MCP_RECORD_LIMIT = 512;
/** Bound: how deep an embedded (text-block) CallResult envelope is followed. */
export const MCP_CALLRESULT_DEPTH_LIMIT = 1;

/**
 * Fields that make a parsed JSON object recognisable as search-result EVIDENCE.
 * A bare object that carries none of them is not treated as a record.
 */
export const MCP_EVIDENCE_FIELDS = Object.freeze([
  "canonicalId",
  "id",
  "cid",
  "uid",
  "canonicalUrl",
  "url",
  "link",
  "permalink",
  "publishedAt",
  "publishedDate",
  "createdAt",
  "created_at",
  "date",
  "authorId",
  "author",
  "user",
  "username",
  "handle",
  "title",
  "text",
  "content",
  "description",
  "excerpt",
  "engagement",
  "score",
  "likes",
]);

/** A plain (non-array, non-null) object. */
function isRecordObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The plain objects of an array, bounded. */
function objectsOf(value, limit) {
  if (!Array.isArray(value) || limit <= 0) return [];
  const out = [];
  for (const entry of value) {
    if (isRecordObject(entry)) out.push(entry);
    if (out.length >= limit) break;
  }
  return out;
}

/** Does a parsed object carry at least one recognised evidence field? */
function isEvidenceLike(value) {
  if (!isRecordObject(value)) return false;
  return MCP_EVIDENCE_FIELDS.some((field) => value[field] !== undefined && value[field] !== null);
}

/**
 * Recognise an MCP CallResult envelope: `content[]`, `structuredContent`,
 * `isError` or a top-level `result` array. Anything else is ordinary JSON.
 */
function mcpEnvelopeOf(value) {
  if (!isRecordObject(value)) return null;
  const hasContent = Array.isArray(value.content);
  const hasStructuredContent = isRecordObject(value.structuredContent);
  const hasStructuredResult = Array.isArray(value.result);
  const hasIsError = typeof value.isError === "boolean";
  if (!hasContent && !hasStructuredContent && !hasStructuredResult && !hasIsError) return null;
  return value;
}

/**
 * Extract bounded structured records from ONE MCP CallResult envelope.
 *
 * ORDER OF PRECEDENCE
 *   1. `structuredContent.result` / `.results` / `.items` — ONLY when those
 *      fields are ARRAYS (a clear result array always wins).
 *   2. `content[]` TEXT blocks — a block is parsed as JSON ONLY when the text is
 *      valid JSON; a JSON array contributes its objects, a JSON object with
 *      `results`/`items` arrays contributes those, an embedded CallResult is
 *      followed exactly ONE level, and an evidence-like object contributes one
 *      raw record. Non-JSON PROSE is IGNORED (never treated as structured
 *      evidence).
 *
 * Bound: `MCP_CONTENT_BLOCK_LIMIT` blocks, `MCP_RECORD_LIMIT` records, and the
 * whole response is already bounded by `maxBytes` upstream. Nothing is executed,
 * no URL is followed, and no secondary fetch happens.
 */
function parseMcpCallResult(envelope, { depth = 0 } = {}) {
  const structured = isRecordObject(envelope.structuredContent) ? envelope.structuredContent : null;
  const out = {
    records: [],
    explicitEmpty: false,
    structuredFound: false,
    contentBlocks: Array.isArray(envelope.content) ? envelope.content.length : 0,
    blocksIgnored: 0,
    parsedBlocks: 0,
    isError: envelope.isError === true,
  };

  if (structured) {
    for (const field of ["result", "results", "items"]) {
      if (!Array.isArray(structured[field])) continue;
      out.structuredFound = true;
      if (structured[field].length === 0) out.explicitEmpty = true;
      else out.records.push(...objectsOf(structured[field], MCP_RECORD_LIMIT));
      return out;
    }
  }

  const blocks = Array.isArray(envelope.content) ? envelope.content.slice(0, MCP_CONTENT_BLOCK_LIMIT) : [];
  for (const block of blocks) {
    if (out.records.length >= MCP_RECORD_LIMIT) break;
    if (!isRecordObject(block)) {
      out.blocksIgnored += 1;
      continue;
    }
    // TEXT blocks only: a typed non-text block is never evidence.
    const declaresText = block.type === undefined || block.type === "text";
    const text = typeof block.text === "string" ? block.text.trim() : null;
    if (!declaresText || text === null || text.length === 0) {
      out.blocksIgnored += 1;
      continue;
    }
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      // Non-JSON prose is IGNORED, not treated as structured evidence.
      out.blocksIgnored += 1;
      continue;
    }
    out.parsedBlocks += 1;
    if (Array.isArray(value)) {
      if (value.length === 0) out.explicitEmpty = true;
      else out.records.push(...objectsOf(value, MCP_RECORD_LIMIT - out.records.length));
      continue;
    }
    if (isRecordObject(value)) {
      const nested = mcpEnvelopeOf(value);
      if (nested && depth < MCP_CALLRESULT_DEPTH_LIMIT) {
        const inner = parseMcpCallResult(nested, { depth: depth + 1 });
        if (inner.explicitEmpty) out.explicitEmpty = true;
        if (inner.isError) out.isError = true;
        out.records.push(...inner.records.slice(0, Math.max(0, MCP_RECORD_LIMIT - out.records.length)));
        continue;
      }
      const field = ["results", "items"].find((name) => Array.isArray(value[name]));
      if (field) {
        if (value[field].length === 0) out.explicitEmpty = true;
        else out.records.push(...objectsOf(value[field], MCP_RECORD_LIMIT - out.records.length));
        continue;
      }
      if (isEvidenceLike(value)) {
        out.records.push(value);
        continue;
      }
      out.blocksIgnored += 1;
      continue;
    }
    // A JSON scalar (string/number/bool/null) is never structured evidence.
    out.blocksIgnored += 1;
  }

  return out;
}

/**
 * Parse a read tool's stdout into raw records.
 *
 * SUPPORTED SHAPES
 *   1. a raw top-level JSON ARRAY
 *   2. a JSON object with a `results` / `items` array
 *   3. an MCP CallResult with structured content
 *   4. an MCP CallResult whose `content[]` text blocks carry JSON
 *   5. newline-delimited JSON (every JSON line contributes)
 *
 * `mcp: true` means an MCP CallResult ENVELOPE was recognised; in that case
 * `explicitEmpty` distinguishes a genuine structured empty result array from a
 * response EVOLVE simply failed to understand (see `reachParseFailure`).
 *
 * Nothing here executes, fetches, follows a URL or resolves a hostname.
 */
export function parseReachStdout(stdout) {
  const text = String(stdout ?? "").trim();
  if (text.length === 0) return { records: [], format: "empty", mcp: false, explicitEmpty: false, contentBlocks: 0, blocksIgnored: 0 };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    const records = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        records.push(JSON.parse(trimmed));
      } catch {
        // A non-JSON line is not evidence; it is ignored (and the caller's health
        // report still records the call as having produced no records).
      }
    }
    return { records, format: "ndjson", mcp: false, explicitEmpty: false, contentBlocks: 0, blocksIgnored: 0 };
  }
  if (Array.isArray(parsed)) {
    return { records: parsed, format: "json-array", mcp: false, explicitEmpty: false, contentBlocks: 0, blocksIgnored: 0 };
  }
  const envelope = mcpEnvelopeOf(parsed);
  if (envelope) {
    const result = parseMcpCallResult(envelope);
    return {
      records: result.records,
      format: result.structuredFound ? "mcp-structured" : "mcp-content",
      mcp: true,
      explicitEmpty: result.explicitEmpty,
      contentBlocks: result.contentBlocks,
      blocksIgnored: result.blocksIgnored,
      parsedBlocks: result.parsedBlocks,
      isError: result.isError,
    };
  }
  if (Array.isArray(parsed?.results)) {
    return { records: parsed.results, format: "json-results", mcp: false, explicitEmpty: false, contentBlocks: 0, blocksIgnored: 0 };
  }
  if (Array.isArray(parsed?.items)) {
    return { records: parsed.items, format: "json-items", mcp: false, explicitEmpty: false, contentBlocks: 0, blocksIgnored: 0 };
  }
  if (isRecordObject(parsed)) {
    return { records: [parsed], format: "json-object", mcp: false, explicitEmpty: false, contentBlocks: 0, blocksIgnored: 0 };
  }
  return { records: [], format: "json-scalar", mcp: false, explicitEmpty: false, contentBlocks: 0, blocksIgnored: 0 };
}

/**
 * Decide whether a parsed response must FAIL CLOSED.
 *
 * Returns a `ReachResponseParseError` when an MCP CallResult envelope was
 * recognised but produced neither a record nor an EXPLICIT structured empty
 * result array — otherwise null. A `status: 0`, non-empty stdout that EVOLVE
 * cannot understand is never reported as `records: 0`.
 */
export function reachParseFailure(parsed) {
  if (parsed?.mcp !== true) return null;
  if (Array.isArray(parsed.records) && parsed.records.length > 0) return null;
  if (parsed.explicitEmpty === true) return null;
  return new ReachResponseParseError(
    "the upstream MCP response was recognised as a CallResult envelope but no supported structured record could be " +
      `extracted from it (format=${parsed.format ?? "unknown"}, isError=${parsed.isError === true}, contentBlocks=${parsed.contentBlocks ?? 0}, ` +
      `blocksIgnored=${parsed.blocksIgnored ?? 0}) — EVOLVE reports a bounded PARSE FAILURE instead of claiming zero evidence. ` +
      "Nothing was executed and no result URL was followed.",
  );
}

/** Resolve the provider implementation (pure; never falls back). */
export function resolveIntelligenceProvider({ provider, config, env = process.env, projectRoot = process.cwd(), spawn = null } = {}) {
  const name = requireIntelligenceProvider(provider ?? DEFAULT_INTELLIGENCE_PROVIDER);
  if (name === INTELLIGENCE_PROVIDER.DISABLED) return DISABLED_INTELLIGENCE_PROVIDER;
  if (name === INTELLIGENCE_PROVIDER.MOCK) return MOCK_INTELLIGENCE;
  if (name === INTELLIGENCE_PROVIDER.AGENT_REACH) {
    return createAgentReachIntelligenceProvider({ config, env, projectRoot, spawn });
  }
  // Unreachable: `requireIntelligenceProvider` is fail-closed.
  throw new Error(`provider '${name}' is registered but has no implementation (registered: ${REGISTERED_INTELLIGENCE_PROVIDERS.join(", ")})`);
}

export default resolveIntelligenceProvider;
