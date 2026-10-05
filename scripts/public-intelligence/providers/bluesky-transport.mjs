// Phase 5K.6 - BLUESKY TRANSPORT: the ONLY network-capable 5K.6 layer.
//
// Responsibilities, and nothing else:
//   build the ONE permitted request -> enforce timeout / size / page / record /
//   lookback bounds -> classify provider errors -> return provider-native
//   postView records plus the acquisition instant.
//
// It performs NO mapping, NO ingestion and NO storage.
//
// NO CREDENTIALS, AT ALL. There is no Authorization header, no cookie, no
// bearer token, no OAuth, no app password and no session anywhere in this
// module, and `credentials: 'omit'` is set explicitly. The request is a plain
// unauthenticated GET against the documented public AppView.
//
// OFFICIAL SEMANTICS, VERIFIED BEFORE CODING (see bluesky-common.mjs header):
//   - `app.bsky.feed.searchPosts` is a QUERY, i.e. it is requested with GET.
//     A POST body returns "Incorrect HTTP method (POST) expected GET".
//   - Its own lexicon states it "may require authentication (eg, not public)
//     for some service providers and implementations". The public AppView
//     serves it without credentials, but an implementation that does not MUST
//     fail closed with AUTH_REQUIRED. This adapter never adapts by adding a
//     credential: if the endpoint demands auth, the run fails and stops.
//
// RETRY POLICY: at most ONE fixed retry, and only for a transient 5xx or a
// network error. A 429 rate limit is NEVER retried and never slept on. The
// module contains no sleep and no unbounded loop.
import {
  BLUESKY_SEARCH_METHOD, BLUESKY_HARD_CEILINGS,
  BLUESKY_PROVIDER_ERROR_CODES, BlueskyAdapterError, blueskyFail,
  resolveBlueskyBounds, assertBlueskyHost, assertBlueskyMethod, assertBlueskySearchTerm,
  parseBlueskyTimestamp,
} from './bluesky-common.mjs';

export { assertBlueskyHost, assertBlueskyMethod, assertBlueskySearchTerm };

/** The complete, auditable transport contract. */
export const BLUESKY_TRANSPORT = Object.freeze({
  endpointTemplate: 'https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts',
  method: 'GET',
  authenticated: false,
  credentialsSent: false,
  cookiesUsed: false,
  oauthUsed: false,
  redirects: 'error',
  maxRetries: BLUESKY_HARD_CEILINGS.maxRetries,
  sleeps: false,
  // Bluesky's documented maximum `limit` for searchPosts.
  pageSizeCeiling: 100,
  userAgent: 'evolve-public-intelligence/5k6 (read-only research observer)',
  governedMethods: Object.freeze([BLUESKY_SEARCH_METHOD]),
});

function numberHeader(headers, name) {
  const raw = headers.get(name);
  if (raw === null || raw === '') return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Rate-limit metadata, reported structurally.
 *
 * The public AppView does not document Mastodon-style rate-limit headers, so
 * absent values are recorded as explicitly null rather than invented. The
 * transport never acts on them.
 */
function rateLimitMetadata(headers) {
  const reset = headers.get('ratelimit-reset');
  return {
    retryAfterSeconds: numberHeader(headers, 'retry-after'),
    rateLimitLimit: numberHeader(headers, 'ratelimit-limit'),
    rateLimitRemaining: numberHeader(headers, 'ratelimit-remaining'),
    rateLimitReset: typeof reset === 'string' && reset ? reset.slice(0, 40) : null,
  };
}

async function readBoundedBody(response, maxBytes) {
  const declared = numberHeader(response.headers, 'content-length');
  if (declared !== null && declared > maxBytes) {
    blueskyFail(BLUESKY_PROVIDER_ERROR_CODES.RESPONSE_TOO_LARGE, { declared });
  }
  if (!response.body || typeof response.body.getReader !== 'function') {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) blueskyFail(BLUESKY_PROVIDER_ERROR_CODES.RESPONSE_TOO_LARGE);
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buffer), bytes: buffer.byteLength };
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch { /* already closed */ }
      blueskyFail(BLUESKY_PROVIDER_ERROR_CODES.RESPONSE_TOO_LARGE);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), bytes: total };
}

/** One bounded, credentialless request. Returns the parsed search payload. */
async function requestPage(url, bounds, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), bounds.timeoutMs);
  try {
    let response;
    try {
      response = await fetchImpl(url, {
        method: BLUESKY_TRANSPORT.method,
        // NO Authorization, NO Cookie. Only Accept and User-Agent.
        headers: { Accept: 'application/json', 'User-Agent': BLUESKY_TRANSPORT.userAgent },
        redirect: BLUESKY_TRANSPORT.redirects,
        credentials: 'omit',
        cache: 'no-store',
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted || error?.name === 'AbortError') blueskyFail(BLUESKY_PROVIDER_ERROR_CODES.TIMEOUT);
      blueskyFail(BLUESKY_PROVIDER_ERROR_CODES.NETWORK_ERROR);
    }

    if (response.status === 429) {
      blueskyFail(BLUESKY_PROVIDER_ERROR_CODES.RATE_LIMITED, { status: 429, ...rateLimitMetadata(response.headers) });
    }
    // A 401/403 means this implementation requires auth. We fail closed; we
    // never respond by supplying a credential.
    if (response.status === 401 || response.status === 403) {
      blueskyFail(BLUESKY_PROVIDER_ERROR_CODES.AUTH_REQUIRED, { status: response.status });
    }
    if (response.status >= 500) blueskyFail(BLUESKY_PROVIDER_ERROR_CODES.SERVER_ERROR_5XX, { status: response.status });
    if (response.status < 200 || response.status >= 300) {
      blueskyFail(BLUESKY_PROVIDER_ERROR_CODES.CLIENT_ERROR_4XX, { status: response.status });
    }

    const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
    if (!contentType.startsWith('application/json')) {
      blueskyFail(BLUESKY_PROVIDER_ERROR_CODES.UNEXPECTED_CONTENT_TYPE, { contentType: contentType.split(';')[0].slice(0, 64) });
    }

    let text;
    let responseBytes;
    try {
      ({ text, bytes: responseBytes } = await readBoundedBody(response, bounds.maxResponseBytes));
    } catch (error) {
      if (error instanceof BlueskyAdapterError) throw error;
      if (controller.signal.aborted || error?.name === 'AbortError') blueskyFail(BLUESKY_PROVIDER_ERROR_CODES.TIMEOUT);
      blueskyFail(BLUESKY_PROVIDER_ERROR_CODES.MALFORMED_RESPONSE, { reason: 'BODY_UNREADABLE' });
    }
    let parsed;
    try { parsed = JSON.parse(text); } catch { blueskyFail(BLUESKY_PROVIDER_ERROR_CODES.MALFORMED_RESPONSE, { reason: 'NOT_JSON' }); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      blueskyFail(BLUESKY_PROVIDER_ERROR_CODES.MALFORMED_RESPONSE, { reason: 'NOT_AN_OBJECT' });
    }
    // The lexicon requires `posts`; a `cursor` is optional and may be absent.
    if (!Array.isArray(parsed.posts)) {
      blueskyFail(BLUESKY_PROVIDER_ERROR_CODES.MALFORMED_RESPONSE, { reason: 'POSTS_NOT_AN_ARRAY' });
    }
    const cursor = parsed.cursor ?? null;
    if (cursor !== null && typeof cursor !== 'string') {
      blueskyFail(BLUESKY_PROVIDER_ERROR_CODES.MALFORMED_RESPONSE, { reason: 'CURSOR_NOT_A_STRING' });
    }
    return { records: parsed.posts, cursor, rateLimit: rateLimitMetadata(response.headers), httpStatus: response.status, responseBytes };
  } finally {
    clearTimeout(timer);
  }
}

/** True for the transient failures that may earn the single permitted retry. */
const isRetryable = error => error instanceof BlueskyAdapterError
  && (error.code === BLUESKY_PROVIDER_ERROR_CODES.SERVER_ERROR_5XX || error.code === BLUESKY_PROVIDER_ERROR_CODES.NETWORK_ERROR);

/**
 * Fetches bounded pages of public Bluesky search results.
 *
 * options:
 *   term       - required, a short keyword (e.g. "solana")
 *   host       - optional; must be the documented public AppView or omitted
 *   method     - optional; must be the governed search method or omitted
 *   bounds     - partial bounds, validated against hard ceilings
 *   fetchImpl, now - injectable for offline tests
 *
 * Returns { records, fetchedAt, pagesFetched, requestsMade, stopReason, rateLimit }.
 */
export async function fetchBlueskySearch(options) {
  if (!options || typeof options !== 'object') blueskyFail(BLUESKY_PROVIDER_ERROR_CODES.BOUNDS_INVALID);
  assertBlueskyHost(options.host);
  assertBlueskyMethod(options.method);
  const term = assertBlueskySearchTerm(options.term);
  const bounds = resolveBlueskyBounds(options.bounds);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  if (typeof fetchImpl !== 'function' || typeof now !== 'function') blueskyFail(BLUESKY_PROVIDER_ERROR_CODES.BOUNDS_INVALID);

  const onRequest = typeof options.onRequest === 'function' ? options.onRequest : null;

  const startedAt = now();
  const earliest = startedAt - bounds.lookbackMs;
  const pageSize = Math.min(BLUESKY_TRANSPORT.pageSizeCeiling, bounds.maxRecords);
  const records = [];
  let cursor = null;
  let pagesFetched = 0;
  let requestsMade = 0;
  let retriesUsed = 0;
  let stopReason = 'MAX_PAGES';
  let fetchedAt = startedAt;
  let rateLimit = null;

  try {
    while (pagesFetched < bounds.maxPages) {
      const url = new URL(BLUESKY_TRANSPORT.endpointTemplate);
      url.searchParams.set('q', term);
      url.searchParams.set('limit', String(pageSize));
      if (cursor !== null) url.searchParams.set('cursor', cursor);

      const requestIndex = requestsMade;
      const requestedAt = now();
      requestsMade += 1;
      let page;
      let attempt = 0;
      for (;;) {
        try {
          page = await requestPage(url.toString(), bounds, fetchImpl);
          break;
        } catch (error) {
          // At most ONE retry, only for a transient failure. A 429 or an auth
          // requirement is terminal and is never retried.
          if (attempt < bounds.maxRetries && isRetryable(error)) {
            attempt += 1;
            retriesUsed += 1;
            continue;
          }
          if (onRequest) {
            onRequest({
              requestIndex, requestedAt, completedAt: now(), cursor, outcome: error.code,
              httpStatus: error.details.status ?? null, recordsReturned: null, responseBytes: null,
              rateLimit: error.code === BLUESKY_PROVIDER_ERROR_CODES.RATE_LIMITED
                ? {
                  retryAfterSeconds: error.details.retryAfterSeconds ?? null,
                  rateLimitLimit: error.details.rateLimitLimit ?? null,
                  rateLimitRemaining: error.details.rateLimitRemaining ?? null,
                  rateLimitReset: error.details.rateLimitReset ?? null,
                }
                : null,
              nextCursor: null,
            });
          }
          throw error;
        }
      }

      pagesFetched += 1;
      fetchedAt = now();
      rateLimit = page.rateLimit;
      // A cursor is only usable if it is a non-empty string AND it advanced.
      const nextCursor = page.cursor;
      const cursorUsable = typeof nextCursor === 'string' && nextCursor.length > 0 && nextCursor !== cursor;
      if (onRequest) {
        onRequest({
          requestIndex, requestedAt, completedAt: fetchedAt, cursor, outcome: 'OK',
          httpStatus: page.httpStatus, recordsReturned: page.records.length, responseBytes: page.responseBytes,
          rateLimit: page.rateLimit, nextCursor: cursorUsable ? nextCursor : null,
        });
      }

      if (page.records.length === 0) { stopReason = 'END_OF_RESULTS'; break; }

      let reachedLookback = false;
      for (const record of page.records) {
        // Lookback only drops records whose timestamp parses AND is too old.
        // Everything else flows to the mapper, which refuses malformed records.
        const publishedAt = parseBlueskyTimestamp(record?.record?.createdAt);
        if (publishedAt !== null && publishedAt < earliest) { reachedLookback = true; continue; }
        if (records.length >= bounds.maxRecords) break;
        records.push(record);
      }
      if (records.length >= bounds.maxRecords) { stopReason = 'MAX_RECORDS'; break; }
      if (reachedLookback) { stopReason = 'LOOKBACK_REACHED'; break; }

      // The page bound is EVOLVE's own limit, so it is reported as such rather
      // than as a provider cursor problem. Checked before the cursor because a
      // run that stopped because IT had seen enough pages should not be labelled
      // as if the provider had failed to paginate.
      if (pagesFetched >= bounds.maxPages) { stopReason = 'MAX_PAGES'; break; }

      if (!cursorUsable) { stopReason = 'PAGINATION_CURSOR_UNUSABLE'; break; }
      cursor = nextCursor;
    }
  } catch (error) {
    // A failed request must not silently discard evidence already acquired.
    if (error instanceof BlueskyAdapterError) {
      error.partial = Object.freeze({ records: Object.freeze([...records]), pagesFetched, fetchedAt });
    }
    throw error;
  }

  return Object.freeze({ records, fetchedAt, pagesFetched, requestsMade, retriesUsed, stopReason, rateLimit });
}
