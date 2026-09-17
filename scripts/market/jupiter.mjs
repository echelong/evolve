/**
 * Read-only Jupiter Tokens V2 observation client.
 *
 * This client can only perform `GET` requests against the Tokens V2
 * market-information endpoints. There is deliberately no code path that can
 * build a trade, sign anything, or submit a transaction: EVOLVE Phase 2 is a
 * market *observer*, not an executor.
 *
 * Behaviour:
 *   - the API key travels server-side only, as an `x-api-key` header
 *   - every failure is classified (auth / rate limit / server / timeout /
 *     network / parse) and backed off with exponential delay + jitter
 *   - the last good snapshot is retained while requests fail
 *   - secrets are removed from every error string before it is surfaced
 */

import { redactSecrets } from "../lib/sanitize.mjs";
import { MARKET_SOURCE_JUPITER, normalizeJupiterToken } from "./normalize.mjs";

export const FAILURE_KIND = Object.freeze({
  AUTH: "auth",
  RATE_LIMIT: "rate-limit",
  SERVER: "server",
  REQUEST: "request",
  TIMEOUT: "timeout",
  NETWORK: "network",
  PARSE: "parse",
  CONFIG: "config",
});

export const FAILURE_LABELS = Object.freeze({
  [FAILURE_KIND.AUTH]: "API key rejected",
  [FAILURE_KIND.RATE_LIMIT]: "rate limited",
  [FAILURE_KIND.SERVER]: "provider error",
  [FAILURE_KIND.REQUEST]: "bad request",
  [FAILURE_KIND.TIMEOUT]: "request timed out",
  [FAILURE_KIND.NETWORK]: "network error",
  [FAILURE_KIND.PARSE]: "unreadable payload",
  [FAILURE_KIND.CONFIG]: "provider unavailable",
});

const MAX_BACKOFF_EXPONENT = 6;

function sleep(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A slow, well-behaved Tokens V2 reader.
 */
export class JupiterTokensClient {
  #nextAllowedAt = 0;

  constructor({ config, fetchImpl = globalThis.fetch, now = () => Date.now(), random = Math.random }) {
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.random = random;

    this.cursor = 0;
    this.recentTokens = [];

    this.requestCount = 0;
    this.okCount = 0;
    this.errorCount = 0;
    this.rateLimitCount = 0;
    this.authErrorCount = 0;
    this.timeoutCount = 0;
    this.statusCodes = {};

    this.consecutiveFailures = 0;
    this.backoffMs = 0;
    this.nextAttemptAt = 0;
    this.lastAttemptAt = null;
    this.lastSuccessAt = null;
    this.lastLatencyMs = null;
    this.lastEndpoint = null;
    this.lastErrorKind = null;
    this.lastErrorSafe = null;
    this.lastResult = null;
  }

  /** Endpoint rotation cursor: one endpoint per poll keeps us polite. */
  nextEndpoint() {
    const endpoints = this.config.endpoints;
    const endpoint = endpoints[this.cursor % endpoints.length];
    this.cursor = (this.cursor + 1) % endpoints.length;
    return endpoint;
  }

  #headers() {
    const headers = { accept: "application/json" };
    const key = this.config.apiKey;
    if (key) headers["x-api-key"] = key;
    return headers;
  }

  #safe(text) {
    return redactSecrets(text, this.config.secretValues);
  }

  #registerFailure(kind, message, at) {
    this.consecutiveFailures += 1;
    this.errorCount += 1;
    this.lastErrorKind = kind;
    this.lastErrorSafe = this.#safe(message);

    const base =
      this.config.minBackoffMs *
      2 ** Math.min(this.consecutiveFailures - 1, MAX_BACKOFF_EXPONENT);
    const jitter = 1 + this.random() * this.config.retryJitter;
    const computed = Math.min(this.config.maxBackoffMs, base * jitter);

    if (kind === FAILURE_KIND.AUTH) {
      this.authErrorCount += 1;
      this.backoffMs = this.config.maxBackoffMs;
    } else if (kind === FAILURE_KIND.RATE_LIMIT) {
      this.rateLimitCount += 1;
      this.backoffMs = Math.min(this.config.maxBackoffMs, Math.max(computed, 5000));
    } else {
      this.backoffMs = computed;
    }

    this.nextAttemptAt = at + this.backoffMs;
  }

  #registerSuccess(at) {
    this.consecutiveFailures = 0;
    this.backoffMs = 0;
    this.okCount += 1;
    this.lastSuccessAt = at;
    this.lastErrorKind = null;
    this.lastErrorSafe = null;
    this.nextAttemptAt = at + this.config.pollMs;
  }

  /** True when the client may issue a request at `at`. */
  canRequest(at = this.now()) {
    return at >= this.nextAttemptAt && at >= this.#nextAllowedAt;
  }

  /**
   * Issue exactly one observation request to the next endpoint in rotation.
   * Never throws: failures are reported through the returned result and the
   * client's health counters.
   */
  async pollOnce(at = this.now()) {
    const endpoint = this.nextEndpoint();
    this.lastAttemptAt = at;
    this.lastEndpoint = endpoint.label;
    this.requestCount += 1;

    if (!this.canRequest(at)) {
      return {
        ok: false,
        skipped: true,
        kind: FAILURE_KIND.RATE_LIMIT,
        endpoint: endpoint.label,
        error: "waiting for backoff",
        tokens: [],
      };
    }

    if (typeof this.fetchImpl !== "function") {
      this.#registerFailure(FAILURE_KIND.CONFIG, "fetch is unavailable in this runtime", at);
      return {
        ok: false,
        skipped: false,
        kind: FAILURE_KIND.CONFIG,
        endpoint: endpoint.label,
        error: FAILURE_LABELS[FAILURE_KIND.CONFIG],
        tokens: [],
      };
    }

    const url = `${this.config.baseUrl}/${endpoint.url}`;
    const started = this.now();
    let response = null;
    let failure = null;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
      try {
        response = await this.fetchImpl(url, {
          method: "GET",
          headers: this.#headers(),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      const name = error?.name ?? "";
      const message = this.#safe(error?.message ?? "request failed");
      failure =
        name === "AbortError" || name === "TimeoutError"
          ? { kind: FAILURE_KIND.TIMEOUT, error: FAILURE_LABELS[FAILURE_KIND.TIMEOUT] }
          : { kind: FAILURE_KIND.NETWORK, error: `${FAILURE_LABELS[FAILURE_KIND.NETWORK]}: ${message}` };
    }

    if (!failure && response) {
      const status = Number(response.status);
      this.statusCodes[status] = (this.statusCodes[status] ?? 0) + 1;
      this.lastLatencyMs = Math.max(0, this.now() - started);

      if (status === 401 || status === 403) {
        failure = {
          kind: FAILURE_KIND.AUTH,
          error: `${FAILURE_LABELS[FAILURE_KIND.AUTH]} (HTTP ${status})`,
        };
      } else if (status === 429) {
        failure = {
          kind: FAILURE_KIND.RATE_LIMIT,
          error: `${FAILURE_LABELS[FAILURE_KIND.RATE_LIMIT]} (HTTP 429)`,
        };
      } else if (status >= 500) {
        failure = {
          kind: FAILURE_KIND.SERVER,
          error: `${FAILURE_LABELS[FAILURE_KIND.SERVER]} (HTTP ${status})`,
        };
      } else if (status < 200 || status >= 300) {
        failure = {
          kind: FAILURE_KIND.REQUEST,
          error: `${FAILURE_LABELS[FAILURE_KIND.REQUEST]} (HTTP ${status})`,
        };
      }
    }

    if (!failure && response) {
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        failure = { kind: FAILURE_KIND.PARSE, error: FAILURE_LABELS[FAILURE_KIND.PARSE] };
      }

      if (!failure && !Array.isArray(payload)) {
        failure = { kind: FAILURE_KIND.PARSE, error: "payload was not a token list" };
      }

      if (!failure) {
        const tokens = [];
        for (const raw of payload) {
          const token = normalizeJupiterToken(raw, { at, endpoint: endpoint.label });
          if (token) tokens.push(token);
        }

        this.recentTokens = tokens;
        this.#registerSuccess(at);
        this.#nextAllowedAt = this.now() + this.config.requestSpacingMs;

        const result = {
          ok: true,
          skipped: false,
          kind: null,
          endpoint: endpoint.label,
          category: endpoint.category,
          tokens,
          received: payload.length,
          at,
        };
        this.lastResult = result;
        return result;
      }
    }

    this.#registerFailure(failure.kind, failure.error, at);
    const result = {
      ok: false,
      skipped: false,
      kind: failure.kind,
      endpoint: endpoint.label,
      category: endpoint.category,
      error: failure.error,
      tokens: [],
      at,
    };
    this.lastResult = result;
    return result;
  }

  /**
   * Walk every configured endpoint once. Used by the CLI probe and tests.
   * Stops early on an auth failure so we never hammer a rejected key.
   */
  async pollAll(at = this.now(), { spacing = null } = {}) {
    const tokens = [];
    const results = [];
    // Never go faster than the configured spacing, whatever the caller asks for.
    const gap = Math.max(spacing ?? 0, this.config.requestSpacingMs);

    for (let index = 0; index < this.config.endpoints.length; index += 1) {
      // Refresh the attempt time: each request is a new attempt, so the
      // client's own rate-limit spacing must apply to the current clock.
      const raw = await this.pollOnce(Math.max(at, this.now()));
      // A skipped request is a politeness outcome, not a provider failure.
      const result = raw.skipped ? { ...raw, skipped: false, ok: false, deferred: true } : raw;
      results.push(result);
      tokens.push(...result.tokens);
      if (!result.ok && (result.kind === FAILURE_KIND.AUTH || result.kind === FAILURE_KIND.CONFIG)) {
        break;
      }
      if (index < this.config.endpoints.length - 1) await sleep(gap);
    }

    return { ok: results.some((result) => result.ok), results, tokens };
  }

  /** Secret-free health snapshot. */
  status(at = this.now()) {
    return {
      source: MARKET_SOURCE_JUPITER,
      requestCount: this.requestCount,
      okCount: this.okCount,
      errorCount: this.errorCount,
      rateLimitCount: this.rateLimitCount,
      authErrorCount: this.authErrorCount,
      timeoutCount: this.timeoutCount,
      statusCodes: { ...this.statusCodes },
      consecutiveFailures: this.consecutiveFailures,
      backoffMs: this.backoffMs,
      nextAttemptInMs: Math.max(0, this.nextAttemptAt - at),
      lastAttemptAt: this.lastAttemptAt,
      lastSuccessAt: this.lastSuccessAt,
      lastLatencyMs: this.lastLatencyMs,
      lastEndpoint: this.lastEndpoint,
      lastErrorKind: this.lastErrorKind,
      lastErrorSafe: this.lastErrorSafe,
    };
  }
}

export { MARKET_SOURCE_JUPITER };
