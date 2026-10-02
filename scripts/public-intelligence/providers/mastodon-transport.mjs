// Phase 5K.2 - MASTODON TRANSPORT: the ONLY network-capable layer in 5K.2.
//
// Responsibilities, and nothing else:
//   build a permitted request -> enforce timeout / size / page / record /
//   lookback bounds -> classify provider errors -> return provider-native
//   records plus the acquisition instant.
//
// It performs NO mapping, NO ingestion and NO storage. It sends NO credential:
// there is no Authorization header, no cookie, and no token parameter anywhere
// in this module. Only the public, unauthenticated hashtag timeline endpoint
// (GET /api/v1/timelines/tag/:hashtag) is ever requested.
//
// RETRY POLICY: zero retries, fixed. A rate limit, timeout or 5xx stops the run
// with a typed error. The module never sleeps and never loops on failure.
import {
  PROVIDER_ERROR_CODES, ProviderAdapterError, providerFail, resolveBounds, parseProviderTimestamp,
} from './common.mjs';

export const MASTODON_TRANSPORT = Object.freeze({
  endpointTemplate: 'https://{host}/api/v1/timelines/tag/{hashtag}',
  method: 'GET',
  authenticated: false,
  credentialsSent: false,
  redirects: 'error',
  maxRetries: 0,
  sleeps: false,
  pageSizeCeiling: 40, // Mastodon's documented maximum for `limit`
  userAgent: 'evolve-public-intelligence/5k2 (read-only research observer)',
});

const HOST_PATTERN = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/;
const REFUSED_HOST_SUFFIXES = Object.freeze(['.local', '.localhost', '.internal', '.lan', '.home', '.corp', '.onion']);
const HASHTAG_PATTERN = /^[A-Za-z0-9_]{1,64}$/;

/** Public DNS hostnames only: no IP literal, port, userinfo, or private suffix. */
export function assertPublicHost(host) {
  if (typeof host !== 'string') providerFail(PROVIDER_ERROR_CODES.HOST_INVALID);
  const lowered = host.toLowerCase();
  if (!HOST_PATTERN.test(lowered) || REFUSED_HOST_SUFFIXES.some(suffix => lowered.endsWith(suffix))) {
    providerFail(PROVIDER_ERROR_CODES.HOST_INVALID);
  }
  return lowered;
}

export function assertHashtag(hashtag) {
  if (typeof hashtag !== 'string' || !HASHTAG_PATTERN.test(hashtag)) providerFail(PROVIDER_ERROR_CODES.QUERY_INVALID);
  return hashtag;
}

function numberHeader(headers, name) {
  const raw = headers.get(name);
  if (raw === null || raw === '') return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Retry metadata is reported to the caller; the transport never acts on it. */
function rateLimitMetadata(headers) {
  const reset = headers.get('x-ratelimit-reset');
  return {
    retryAfterSeconds: numberHeader(headers, 'retry-after'),
    rateLimitLimit: numberHeader(headers, 'x-ratelimit-limit'),
    rateLimitRemaining: numberHeader(headers, 'x-ratelimit-remaining'),
    rateLimitReset: typeof reset === 'string' && reset ? reset : null,
  };
}

async function readBoundedBody(response, maxBytes) {
  const declared = numberHeader(response.headers, 'content-length');
  if (declared !== null && declared > maxBytes) providerFail(PROVIDER_ERROR_CODES.RESPONSE_TOO_LARGE, { declared });
  if (!response.body || typeof response.body.getReader !== 'function') {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) providerFail(PROVIDER_ERROR_CODES.RESPONSE_TOO_LARGE);
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
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
      providerFail(PROVIDER_ERROR_CODES.RESPONSE_TOO_LARGE);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

/** One bounded request. Returns the parsed JSON array. */
async function requestPage(url, bounds, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), bounds.timeoutMs);
  try {
    let response;
    try {
      response = await fetchImpl(url, {
        method: MASTODON_TRANSPORT.method,
        headers: { Accept: 'application/json', 'User-Agent': MASTODON_TRANSPORT.userAgent },
        redirect: MASTODON_TRANSPORT.redirects,
        credentials: 'omit',
        cache: 'no-store',
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted || error?.name === 'AbortError') providerFail(PROVIDER_ERROR_CODES.TIMEOUT);
      providerFail(PROVIDER_ERROR_CODES.NETWORK_ERROR);
    }

    if (response.status === 429) {
      providerFail(PROVIDER_ERROR_CODES.RATE_LIMITED, { status: 429, ...rateLimitMetadata(response.headers) });
    }
    if (response.status === 401 || response.status === 403) {
      providerFail(PROVIDER_ERROR_CODES.AUTH_REQUIRED, { status: response.status });
    }
    if (response.status >= 500) providerFail(PROVIDER_ERROR_CODES.SERVER_ERROR_5XX, { status: response.status });
    if (response.status < 200 || response.status >= 300) {
      providerFail(PROVIDER_ERROR_CODES.CLIENT_ERROR_4XX, { status: response.status });
    }

    const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
    if (!contentType.startsWith('application/json')) {
      providerFail(PROVIDER_ERROR_CODES.UNEXPECTED_CONTENT_TYPE, { contentType: contentType.split(';')[0].slice(0, 64) });
    }

    let text;
    try {
      text = await readBoundedBody(response, bounds.maxResponseBytes);
    } catch (error) {
      if (error instanceof ProviderAdapterError) throw error;
      if (controller.signal.aborted || error?.name === 'AbortError') providerFail(PROVIDER_ERROR_CODES.TIMEOUT);
      providerFail(PROVIDER_ERROR_CODES.MALFORMED_RESPONSE, { reason: 'BODY_UNREADABLE' });
    }
    let parsed;
    try { parsed = JSON.parse(text); } catch { providerFail(PROVIDER_ERROR_CODES.MALFORMED_RESPONSE, { reason: 'NOT_JSON' }); }
    if (!Array.isArray(parsed)) providerFail(PROVIDER_ERROR_CODES.MALFORMED_RESPONSE, { reason: 'NOT_AN_ARRAY' });
    return { records: parsed, rateLimit: rateLimitMetadata(response.headers) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetches bounded pages of the public hashtag timeline.
 *
 * options:
 *   host, hashtag      - required
 *   bounds             - partial bounds, validated against hard ceilings
 *   fetchImpl, now     - injectable for offline tests; default to the global
 *                        fetch and Date.now (the ONLY clock read in 5K.2)
 *
 * Returns { records, fetchedAt, pagesFetched, stopReason, rateLimit } where
 * `fetchedAt` is the instant the LAST page was received.
 */
export async function fetchHashtagTimeline(options) {
  if (!options || typeof options !== 'object') providerFail(PROVIDER_ERROR_CODES.BOUNDS_INVALID);
  const host = assertPublicHost(options.host);
  const hashtag = assertHashtag(options.hashtag);
  const bounds = resolveBounds(options.bounds);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  if (typeof fetchImpl !== 'function' || typeof now !== 'function') providerFail(PROVIDER_ERROR_CODES.BOUNDS_INVALID);

  const startedAt = now();
  const earliest = startedAt - bounds.lookbackMs;
  const pageSize = Math.min(MASTODON_TRANSPORT.pageSizeCeiling, bounds.maxRecords);
  const records = [];
  let maxId = null;
  let pagesFetched = 0;
  let stopReason = 'MAX_PAGES';
  let fetchedAt = startedAt;
  let rateLimit = null;

  while (pagesFetched < bounds.maxPages) {
    const url = new URL(`https://${host}/api/v1/timelines/tag/${hashtag}`);
    url.searchParams.set('limit', String(pageSize));
    if (maxId !== null) url.searchParams.set('max_id', maxId);

    const page = await requestPage(url.toString(), bounds, fetchImpl);
    pagesFetched += 1;
    fetchedAt = now();
    rateLimit = page.rateLimit;

    if (page.records.length === 0) { stopReason = 'END_OF_TIMELINE'; break; }

    let reachedLookback = false;
    for (const record of page.records) {
      // Lookback only drops records whose timestamp parses AND is too old;
      // anything else flows to the mapper, which refuses malformed ones.
      let publishedAt = null;
      try { publishedAt = parseProviderTimestamp(record?.created_at); } catch { /* mapper decides */ }
      if (publishedAt !== null && publishedAt < earliest) { reachedLookback = true; continue; }
      if (records.length >= bounds.maxRecords) break;
      records.push(record);
    }
    if (records.length >= bounds.maxRecords) { stopReason = 'MAX_RECORDS'; break; }
    if (reachedLookback) { stopReason = 'LOOKBACK_REACHED'; break; }

    const lastId = page.records[page.records.length - 1]?.id;
    if (typeof lastId !== 'string' || !/^[0-9]{1,32}$/.test(lastId) || lastId === maxId) {
      stopReason = 'PAGINATION_CURSOR_UNUSABLE';
      break;
    }
    maxId = lastId;
  }

  return Object.freeze({ records, fetchedAt, pagesFetched, stopReason, rateLimit });
}
