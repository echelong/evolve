/**
 * Phase 5E — versioned, DETERMINISTIC query sets (PAPER ONLY).
 *
 * Canonical Phase 5E never lets an LLM invent web queries. Queries are rendered
 * from a fixed, versioned template set over WHITELISTED token metadata:
 *
 *   symbol · name · domain/project · mint address · official handle
 *
 * The templates are pure functions of that metadata, so the same candidate
 * always yields byte-identical queries (and therefore a reproducible capture).
 * Arbitrary free-text queries are REJECTED in canonical mode.
 *
 * PAPER ONLY, READ-ONLY. Nothing here touches the network.
 */

export const REACH_QUERY_SET_ID = "reach-query-set-v1";
export const REACH_QUERY_SET_VERSION = 1;

/** Candidate metadata fields a query template may read. Anything else is ignored. */
export const QUERY_METADATA_FIELDS = Object.freeze([
  "symbol",
  "name",
  "domain",
  "mint",
  "handle",
]);

/**
 * The deterministic templates. `{field}` placeholders are filled from the
 * metadata, and every template names the READ-ONLY operation it maps to:
 *
 *   search   a keyword search over the channel (x, exa, web, github, reddit)
 *   read     a bounded fetch of ONE deterministic URL (rss, web, reddit)
 *
 * `rss` is a read-only channel: it has no search capability, so its template
 * renders the project's conventional feed URL from the whitelisted `domain`
 * field. A feed that does not exist is recorded as a FAILURE — never as
 * invented evidence.
 */
export const REACH_QUERY_TEMPLATES_V1 = Object.freeze([
  Object.freeze({ id: "symbol-mentions", op: "search", channel: "x", template: "\"{symbol}\" (memecoin OR token)", requires: Object.freeze(["symbol"]) }),
  Object.freeze({ id: "symbol-search", op: "search", channel: "exa", template: "\"{symbol}\" token project", requires: Object.freeze(["symbol"]) }),
  Object.freeze({ id: "name-web", op: "search", channel: "web", template: "\"{name}\" token", requires: Object.freeze(["name"]) }),
  Object.freeze({ id: "domain-web", op: "search", channel: "web", template: "\"{domain}\"", requires: Object.freeze(["domain"]) }),
  Object.freeze({ id: "mint-github", op: "search", channel: "github", template: "\"{mint}\"", requires: Object.freeze(["mint"]) }),
  Object.freeze({ id: "handle-reddit", op: "search", channel: "reddit", template: "\"{handle}\"", requires: Object.freeze(["handle"]) }),
  Object.freeze({ id: "domain-feed", op: "read", channel: "rss", template: "https://{domain}/feed", requires: Object.freeze(["domain"]) }),
]);

/** Every template operation the plan may carry (read-only, by construction). */
export const QUERY_TEMPLATE_OPS = Object.freeze(["search", "read"]);

/** The published query set: fixed definitions + a deterministic digest. */
export const REACH_QUERY_SET_V1 = Object.freeze({
  querySetId: REACH_QUERY_SET_ID,
  version: REACH_QUERY_SET_VERSION,
  phase: "5E",
  paperOnly: true,
  readOnly: true,
  deterministic: true,
  templates: REACH_QUERY_TEMPLATES_V1,
  note: "Fixed templates over whitelisted token metadata. No LLM-generated queries are accepted in canonical Phase 5E.",
});

export class QuerySetError extends Error {
  constructor(message) {
    super(message);
    this.name = "QuerySetError";
  }
}

export class ArbitraryQueryError extends Error {
  constructor(query) {
    super(
      `arbitrary query '${String(query).slice(0, 80)}' is REJECTED in canonical Phase 5E: queries are rendered only from the ` +
        `versioned query set '${REACH_QUERY_SET_ID}'. Pass token metadata instead of free text.`,
    );
    this.name = "ArbitraryQueryError";
    this.query = query;
  }
}

/** Look up a registered query set (null when unknown). */
export function querySetFor(querySetId) {
  return querySetId === REACH_QUERY_SET_ID ? REACH_QUERY_SET_V1 : null;
}

/** Whitelist the metadata a query template may use (unknown fields are dropped). */
export function whitelistCandidateMetadata(candidate = {}) {
  const out = {};
  for (const field of QUERY_METADATA_FIELDS) {
    const value = candidate?.[field];
    if (typeof value === "string" && value.trim().length > 0) out[field] = value.trim();
  }
  return out;
}

/** Render one template for one candidate, or null when a required field is missing. */
export function renderQuery(template, candidate = {}) {
  for (const field of template?.requires ?? []) {
    if (!candidate?.[field]) return null;
  }
  const query = String(template.template).replace(/\{(\w+)\}/g, (_match, field) => candidate[field] ?? "");
  return {
    queryId: `${template.id}`,
    op: QUERY_TEMPLATE_OPS.includes(template.op) ? template.op : "search",
    channel: template.channel,
    templateId: template.id,
    query,
  };
}

/**
 * Build the deterministic query plan for a capture.
 *
 * @param {{ candidates?: object[], querySetId?: string, channels?: string[] }} [options]
 * @returns {{ querySetId: string, version: number, channels: string[], queries: object[] }}
 */
export function buildQueryPlan({ candidates = [], querySetId = REACH_QUERY_SET_ID, channels = null } = {}) {
  const set = querySetFor(querySetId);
  if (!set) throw new QuerySetError(`unknown query set '${querySetId}' (registered: ${REACH_QUERY_SET_ID})`);
  const allowed = Array.isArray(channels) && channels.length > 0 ? channels : null;
  const queries = [];
  for (const candidate of candidates) {
    const metadata = whitelistCandidateMetadata(candidate);
    const candidateId = metadata.mint ?? metadata.symbol ?? metadata.name ?? metadata.domain ?? metadata.handle ?? null;
    for (const template of set.templates) {
      const rendered = renderQuery(template, metadata);
      if (!rendered) continue;
      if (allowed && !allowed.includes(rendered.channel)) continue;
      queries.push({ ...rendered, candidateId });
    }
  }
  // Stable order, independent of the input order of candidates.
  queries.sort((a, b) => `${a.channel}:${a.queryId}:${a.query}`.localeCompare(`${b.channel}:${b.queryId}:${b.query}`));
  return {
    querySetId: set.querySetId,
    version: set.version,
    channels: [...new Set(queries.map((row) => row.channel))].sort(),
    queries,
  };
}

/**
 * Canonical captures accept ONLY rendered queries. A caller that tries to pass a
 * free-form query is refused instead of being quietly ignored.
 */
export function assertCanonicalQueryPlan(plan, { requestedQuery = null } = {}) {
  if (requestedQuery !== null && requestedQuery !== undefined && String(requestedQuery).trim().length > 0) {
    throw new ArbitraryQueryError(requestedQuery);
  }
  if (!plan || !Array.isArray(plan.queries)) throw new QuerySetError("no query plan was built");
  for (const row of plan.queries) {
    if (typeof row.query !== "string" || row.query.trim().length === 0) {
      throw new QuerySetError(`a rendered query is empty (${row.queryId ?? "unknown"})`);
    }
  }
  return plan;
}
