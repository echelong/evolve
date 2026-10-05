// Phase 5K.6 - BLUESKY / AT PROTOCOL provider-common helpers.
//
// PURE AND OFFLINE BY CONSTRUCTION. No socket, no clock, no environment, no
// credential, no filesystem. Shared vocabulary and validators for the Bluesky
// transport and mapper.
//
// EVERYTHING HERE IS GROUNDED IN THE OFFICIAL SOURCES, verified before coding:
//
//   Lexicon app.bsky.feed.defs#postView
//     uri, cid, author, record, indexedAt, likeCount, repostCount, replyCount,
//     quoteCount, bookmarkCount, embed, embeds, labels, viewer, reply, via, threadgate
//   Lexicon app.bsky.feed.post (record)
//     $type, text, createdAt, langs, facets, entities, tags, labels, embed, reply
//   Lexicon app.bsky.feed.searchPosts (query)
//     q (required), sort, since, until, mentions, author, lang, domain, tag,
//     url, limit, cursor
//   AT Protocol repository spec
//     Repo paths are `<collection>/<record-key>`; a record's identity at a path
//     is its CID. UPDATING a record changes its CID while the path - and hence
//     the AT URI - stays the same.
//
// PROVIDER NAMESPACE: `bluesky:public-appview`. Deliberately carries no DID, no
// handle and no host, because upstream identity must stay stable when an account
// changes its handle or moves between AppViews. The DID is retained inside the
// observation as `providerAuthorId` and inside `providerObservationId` (the AT
// URI), where it belongs.

/** Stable, explicit provider namespace. Never derived from a mutable handle. */
export const BLUESKY_PROVIDER_NAMESPACE = 'bluesky:public-appview';

/** The documented public read host. The ONLY host this adapter will contact. */
export const BLUESKY_APPVIEW_HOST = 'public.api.bsky.app';

/** The governed XRPC query method. Never operator-selectable. */
export const BLUESKY_SEARCH_METHOD = 'app.bsky.feed.searchPosts';

export const BLUESKY_PROVIDER_ERROR_CODES = Object.freeze({
  BOUNDS_INVALID: 'BLUESKY_BOUNDS_INVALID',
  HOST_INVALID: 'BLUESKY_HOST_INVALID',
  QUERY_INVALID: 'BLUESKY_QUERY_INVALID',
  METHOD_FORBIDDEN: 'BLUESKY_METHOD_FORBIDDEN',
  TIMEOUT: 'BLUESKY_TIMEOUT',
  NETWORK_ERROR: 'BLUESKY_NETWORK_ERROR',
  RATE_LIMITED: 'BLUESKY_RATE_LIMITED',
  SERVER_ERROR_5XX: 'BLUESKY_SERVER_ERROR_5XX',
  /** The official lexicon warns searchPosts "may require authentication". */
  AUTH_REQUIRED: 'BLUESKY_AUTH_REQUIRED',
  CLIENT_ERROR_4XX: 'BLUESKY_CLIENT_ERROR_4XX',
  UNEXPECTED_CONTENT_TYPE: 'BLUESKY_UNEXPECTED_CONTENT_TYPE',
  RESPONSE_TOO_LARGE: 'BLUESKY_RESPONSE_TOO_LARGE',
  MALFORMED_RESPONSE: 'BLUESKY_MALFORMED_RESPONSE',
  RECORD_REFUSED: 'BLUESKY_RECORD_REFUSED',
});

export class BlueskyAdapterError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = 'BlueskyAdapterError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

export const blueskyFail = (code, details) => { throw new BlueskyAdapterError(code, details); };

/**
 * Bounds. No greater in spirit than the 5K.2 Mastodon ceilings, and explicitly
 * tightened: Bluesky search is a keyword endpoint, so a smaller record ceiling
 * is appropriate and nothing here can be disabled or made unlimited.
 */
export const BLUESKY_HARD_CEILINGS = Object.freeze({
  maxPages: 3,
  maxRecords: 100,
  maxResponseBytes: 2 * 1024 * 1024,
  timeoutMs: 20_000,
  lookbackMs: 7 * 24 * 60 * 60 * 1000,
  maxRetries: 1,
});

export const BLUESKY_DEFAULT_BOUNDS = Object.freeze({
  maxPages: 1,
  maxRecords: 5,
  maxResponseBytes: 512 * 1024,
  timeoutMs: 10_000,
  lookbackMs: 24 * 60 * 60 * 1000,
  maxRetries: 0,
});

const BOUND_KEYS = Object.freeze(Object.keys(BLUESKY_HARD_CEILINGS));

export function resolveBlueskyBounds(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    blueskyFail(BLUESKY_PROVIDER_ERROR_CODES.BOUNDS_INVALID, { reason: 'not-an-object' });
  }
  for (const key of Object.keys(input)) {
    if (!BOUND_KEYS.includes(key)) blueskyFail(BLUESKY_PROVIDER_ERROR_CODES.BOUNDS_INVALID, { reason: 'unknown-key', key });
  }
  const bounds = {};
  for (const key of BOUND_KEYS) {
    const value = input[key] ?? BLUESKY_DEFAULT_BOUNDS[key];
    const min = key === 'maxRetries' ? 0 : 1;
    if (!Number.isInteger(value) || value < min || value > BLUESKY_HARD_CEILINGS[key]) {
      blueskyFail(BLUESKY_PROVIDER_ERROR_CODES.BOUNDS_INVALID, { reason: 'out-of-range', key });
    }
    bounds[key] = value;
  }
  return Object.freeze(bounds);
}

/**
 * Host policy: EXACTLY the documented public AppView.
 *
 * A caller cannot supply another host, a URL, an endpoint, a port, or a path.
 * The XRPC method is likewise fixed, so an operator can never point this
 * adapter at an arbitrary endpoint.
 */
export function assertBlueskyHost(host) {
  if (host !== undefined && host !== null && host !== BLUESKY_APPVIEW_HOST) {
    blueskyFail(BLUESKY_PROVIDER_ERROR_CODES.HOST_INVALID, { reason: 'NOT_THE_PUBLIC_APPVIEW' });
  }
  return BLUESKY_APPVIEW_HOST;
}

export function assertBlueskyMethod(method) {
  if (method !== undefined && method !== null && method !== BLUESKY_SEARCH_METHOD) {
    blueskyFail(BLUESKY_PROVIDER_ERROR_CODES.METHOD_FORBIDDEN, { reason: 'NOT_THE_GOVERNED_METHOD' });
  }
  return BLUESKY_SEARCH_METHOD;
}

/**
 * The governed search term.
 *
 * Deliberately narrow: a short keyword phrase. No URL, no XRPC parameter
 * injection, no arbitrary filter syntax.
 */
const SEARCH_TERM = /^[\p{L}\p{N}]{1,64}$/u;

export function assertBlueskySearchTerm(value) {
  if (typeof value !== 'string' || !SEARCH_TERM.test(value)) {
    blueskyFail(BLUESKY_PROVIDER_ERROR_CODES.QUERY_INVALID, { reason: 'NOT_A_KEYWORD_TERM' });
  }
  return value;
}

/** Strict ISO-8601 parsing. Never falls back to the current clock. */
export function parseBlueskyTimestamp(value) {
  if (typeof value !== 'string' || !value) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  const ms = Math.floor(parsed);
  return Number.isSafeInteger(ms) && ms >= 0 ? ms : null;
}

/**
 * AT URI validation.
 *
 * Shape: `at://<authority>/<collection>/<record-key>`. For a Bluesky post the
 * authority is the author's DID and the collection is `app.bsky.feed.post`.
 * A handle is NOT accepted as an authority: handles are mutable and resolvable,
 * and identity must not depend on one.
 */
const AT_URI = /^at:\/\/(did:[a-z]+:[a-z0-9:%-]{1,128})\/([a-z0-9.-]+)\/([A-Za-z0-9._~:-]{1,512})$/;

/** The Bluesky post collection NSID. */
export const BLUESKY_POST_COLLECTION = 'app.bsky.feed.post';

export function parseAtUri(uri) {
  if (typeof uri !== 'string') return null;
  const match = AT_URI.exec(uri);
  if (!match) return null;
  const [, authority, collection, rkey] = match;
  // An at:// URI must be canonical: no trailing junk, no double slash.
  if (uri !== `at://${authority}/${collection}/${rkey}`) return null;
  return Object.freeze({ authority, collection, rkey, uri });
}

export function isBlueskyPostUri(uri) {
  const parsed = parseAtUri(uri);
  return parsed !== null && parsed.collection === BLUESKY_POST_COLLECTION;
}

/**
 * CID validation, restricted to the atproto "blessed" string form documented in
 * the data-model spec: CIDv1, base32 with a `b` multibase prefix.
 *
 * The provider's blessed form is lowercase base32 starting `bafy`. Case is
 * never folded: a differently cased CID is a different string and is refused
 * rather than silently normalized.
 */
const CID = /^bafy[a-z2-7]{20,}$/;

export function assertProviderCid(cid) {
  if (typeof cid !== 'string' || !CID.test(cid)) {
    blueskyFail(BLUESKY_PROVIDER_ERROR_CODES.RECORD_REFUSED, { reason: 'CID_MALFORMED' });
  }
  return cid;
}

/**
 * Provider-native privacy refusal keys.
 *
 * The Bluesky AppView returns a large author profile object. This adapter reads
 * ONLY `author.did`; everything else about the author is discarded by
 * construction and cannot reach the raw schema. These names are listed so the
 * refusal is auditable rather than implicit.
 */
export const BLUESKY_REFUSED_AUTHOR_FIELDS = Object.freeze([
  'displayName', 'handle', 'avatar', 'banner', 'description', 'followersCount',
  'followsCount', 'postsCount', 'associated', 'pinnedPost', 'verification',
  'labels', 'createdAt', 'indexedAt',
]);

/** The only author fields this adapter will ever read. */
export const BLUESKY_CONSUMED_AUTHOR_FIELDS = Object.freeze(['did']);

/** Post record types this adapter understands. Anything else fails closed. */
export const BLUESKY_SUPPORTED_RECORD_TYPES = Object.freeze(['app.bsky.feed.post']);

/**
 * Engagement counters exposed by app.bsky.feed.defs#postView.
 *
 * `bookmarkCount` is deliberately NOT retained: it is a viewer-scoped
 * engagement figure with no public meaning, so keeping it would widen the
 * personal-data surface for no evidentiary value.
 */
export const BLUESKY_ENGAGEMENT_COUNTERS = Object.freeze(['likeCount', 'replyCount', 'repostCount', 'quoteCount']);

/** Maps the provider counter names onto the frozen 5K.1 engagement vocabulary. */
export const BLUESKY_ENGAGEMENT_MAPPING = Object.freeze({
  likeCount: 'likes',
  replyCount: 'replies',
  repostCount: 'reposts',
  quoteCount: 'quotes',
});
