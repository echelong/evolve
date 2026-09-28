import { randomUUID } from 'node:crypto';
import { redact } from '../definition.mjs';

// No caller-controlled URL or method is ever accepted by the transport.
export function createObservationTransport({ config, origin, routes, fetchImpl = fetch, now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)), secrets = [] }) {
  const base = new URL(config.baseUrl);
  if (!['https://openapi.gmgn.ai', 'https://api.dexscreener.com'].includes(origin)) throw new Error('Observation origin not allowed');
  if (base.origin !== origin || base.pathname !== '/' || base.search || base.hash || base.username || base.password) throw new Error('Observation origin not allowed');
  const cache = new Map();
  let busy = false, nextAt = 0, backoffUntil = 0, failures = 0;
  const counters = { requests: 0, errors: 0, cacheHits: 0, throttled: 0, lastError: null, state: 'READY' };
  async function read(kind, identity, { query = {}, body = null, fresh = false } = {}) {
    const route = routes[kind];
    if (!route || !Object.hasOwn(routes, kind)) throw new Error('Observation route not allowed');
    // requestAttempted distinguishes a real provider call (success or bounded
    // failure) from a blocked non-attempt; scheduling uses it to advance cursors
    // only for actual service.
    if (busy) return { unavailable: 'BUSY', requestAttempted: false };
    const cacheKey = JSON.stringify([kind, identity, query, body]);
    const old = cache.get(cacheKey);
    if (!fresh && old && now() - old.receivedAt <= config.cacheMs) { counters.cacheHits++; return { ...structuredClone(old), requestAttempted: false, servedFromCache: true }; }
    if (now() < backoffUntil) return { unavailable: 'BACKOFF', requestAttempted: false };
    busy = true;
    let requestAttempted = false;
    try {
      const wait = Math.max(0, nextAt - now());
      if (wait) await sleep(wait);
      const url = new URL(typeof route.path === 'function' ? route.path(identity) : route.path, origin);
      const gmgnPaths = new Set(['/v1/token/info', '/v1/token/security', '/v1/token/pool_info', '/v1/market/token_top_holders', '/v1/market/token_top_traders']);
      const allowed = origin === 'https://openapi.gmgn.ai' ? (route.method === 'GET' && gmgnPaths.has(url.pathname) || route.method === 'POST' && url.pathname === '/v1/trenches') : route.method === 'GET' && /^\/token-pairs\/v1\/solana\/[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(url.pathname);
      if (url.origin !== origin || !allowed || url.username || url.password || url.hash || url.search) throw new Error('Observation route not allowed');
      for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
      const headers = { accept: 'application/json' };
      if (config.apiKey) {
        headers['X-APIKEY'] = config.apiKey;
        url.searchParams.set('timestamp', String(Math.floor(now() / 1000)));
        url.searchParams.set('client_id', randomUUID());
      }
      if (body) headers['Content-Type'] = 'application/json';
      counters.requests++;
      requestAttempted = true;
      nextAt = now() + config.spacingMs;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.timeoutMs);
      let response, payload;
      try {
        response = await fetchImpl(url, { method: route.method, headers, body: body ? JSON.stringify(body) : undefined, signal: controller.signal, redirect: 'error' });
        if (!response.ok) {
          const retry = response.headers.get('retry-after');
          const seconds = Number(retry);
          const retryMs = retry === null ? 0 : Number.isFinite(seconds) ? seconds * 1000 : Math.max(0, Date.parse(retry) - now());
          const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000;
          if (response.status === 429) {
            counters.throttled++;
            backoffUntil = Math.max(now() + 60000, now() + (Number.isFinite(retryMs) ? retryMs : 0), Number.isFinite(reset) ? reset : 0);
          }
          throw new Error(`HTTP_${response.status}`);
        }
        // Read through a bounded stream; do not buffer an unbounded remote response.
        const reader = response.body.getReader();
        const chunks = []; let bytes = 0;
        try {
          while (true) {
            const { value, done } = await reader.read(); if (done) break;
            bytes += value.byteLength;
            if (bytes > 256 * 1024) { await reader.cancel(); throw new Error('PAYLOAD_TOO_LARGE'); }
            chunks.push(Buffer.from(value));
          }
        } finally { reader.releaseLock(); }
        payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } finally { clearTimeout(timer); }
      if (config.apiKey && (!payload || ![0, '0'].includes(payload.code) || !Object.hasOwn(payload, 'data'))) throw new Error('PROVIDER_ENVELOPE');
      const result = { payload: redact(payload, secrets), receivedAt: now(), endpoint: typeof route.path === 'function' ? route.path(identity) : route.path, requestIdentity: identity, kind, requestAttempted: true };
      if (cache.size >= 256) cache.delete(cache.keys().next().value);
      cache.set(cacheKey, result); failures = 0; counters.state = 'HEALTHY'; counters.lastError = null;
      return structuredClone(result);
    } catch (error) {
      failures++; counters.errors++;
      counters.lastError = /^HTTP_\d+$|^PAYLOAD_TOO_LARGE$|^PROVIDER_ENVELOPE$/.test((error?.message ?? '')) ? error.message : 'OBSERVATION_FAILED';
      counters.state = 'DEGRADED';
      backoffUntil = Math.max(backoffUntil, now() + Math.min(300000, 1000 * 2 ** Math.min(failures, 8)));
      // An attempted-but-failed call still progressed through this endpoint.
      return { unavailable: counters.lastError, requestAttempted };
    } finally { busy = false; }
  }
  return Object.freeze({ read, health: () => ({ ...counters, backoffUntil, cacheEntries: cache.size, concurrencyLimit: 1 }) });
}
