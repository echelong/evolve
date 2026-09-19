/**
 * Phase 5G.0 — classifier.dev PROVIDER (PAPER ONLY, EXTERNAL BOUNDARY).
 *
 * A dedicated, minimal client for the versioned REST endpoint
 *
 *   POST https://classifier.dev/v1/classify
 *
 * FAST tier only, single-label only, fixed frozen taxonomy only. It is NOT a
 * Jev provider, it imports nothing from `scripts/jev/`, and it is never a
 * fallback for the Jev supervisor.
 *
 * WHAT CROSSES THE BOUNDARY: the `inputs` (bounded public text projected by
 * `classifier-definition.mjs`), the frozen labels, `tier: "fast"`, the frozen
 * instructions and `multi: false`. Nothing else. No credential of any kind is
 * attached: no `Authorization` header, no API key, no cookie.
 *
 * WHAT COMES BACK: whitelisted and validated field by field. The raw HTTP
 * response is never returned, persisted or logged. A partial, reordered or
 * out-of-taxonomy answer is REJECTED, never repaired.
 *
 * RESILIENCE: bounded, EVOLVE-owned transport recovery (429/502/503/504,
 * timeout, network reset) with bounded exponential backoff, bounded jitter and a
 * clamped `Retry-After`. 400/404/malformed responses are never retried.
 *
 * Injectable `fetchImpl` / `sleepImpl` / `randomImpl` / `now` keep every test
 * offline, deterministic and zero-delay.
 */

import { digestOf } from "../lib/hash.mjs";
import {
  CLASSIFIER_DEFINITION,
  CLASSIFIER_ID,
  CLASSIFIER_INSTRUCTIONS,
  CLASSIFIER_LABELS,
} from "./classifier-definition.mjs";

/* ============================================================================
 * Identity
 * ==========================================================================*/

export const CLASSIFIER_DEV_PROVIDER = "classifier-dev";
export const CLASSIFIER_DEV_API_VERSION = "v1";
export const CLASSIFIER_DEV_ENDPOINT = "https://classifier.dev/v1/classify";
export const CLASSIFIER_DEV_TIER = "fast";

/** Provider names the classify CLI knows. `disabled` is the default and never calls anything. */
export const CLASSIFIER_PROVIDER = Object.freeze({ DISABLED: "disabled", CLASSIFIER_DEV: CLASSIFIER_DEV_PROVIDER });
export const REGISTERED_CLASSIFIER_PROVIDERS = Object.freeze([CLASSIFIER_PROVIDER.DISABLED, CLASSIFIER_PROVIDER.CLASSIFIER_DEV]);
export const DEFAULT_CLASSIFIER_PROVIDER = CLASSIFIER_PROVIDER.DISABLED;

/** Phase 5G.0 sends at most this many inputs in ONE request; more fails closed. */
export const CLASSIFIER_MAX_INPUTS_PER_REQUEST = 1_000;

/** The exact keys a request body may contain. `max_labels` is deliberately absent (single-label only). */
export const CLASSIFY_REQUEST_FIELDS = Object.freeze(["inputs", "labels", "tier", "instructions", "multi"]);

/** The exact top-level response concepts read from the wire. Anything else is ignored. */
export const CLASSIFY_RESPONSE_FIELDS = Object.freeze(["tier", "model", "results", "usage"]);

/** The exact keys of one persisted classification result (transport-level). */
export const CLASSIFY_RESULT_FIELDS = Object.freeze(["label", "confidence", "scores"]);

/** Upper bound on the response body the client will read. */
export const CLASSIFIER_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

const LABEL_SET = new Set(CLASSIFIER_LABELS);

export const CLASSIFIER_STATUS = Object.freeze({
  OK: "CLASSIFIER_OK",
  DISABLED: "CLASSIFIER_DISABLED",
  RATE_LIMIT: "CLASSIFIER_RATE_LIMIT",
  UNAVAILABLE: "CLASSIFIER_UNAVAILABLE",
  TIMEOUT: "CLASSIFIER_TIMEOUT",
  NETWORK_ERROR: "CLASSIFIER_NETWORK_ERROR",
  BAD_REQUEST: "CLASSIFIER_BAD_REQUEST",
  NOT_FOUND: "CLASSIFIER_NOT_FOUND",
  HTTP_ERROR: "CLASSIFIER_HTTP_ERROR",
  INVALID_RESPONSE: "CLASSIFIER_INVALID_RESPONSE",
  INVALID_REQUEST: "CLASSIFIER_INVALID_REQUEST",
});

/* ============================================================================
 * Errors
 * ==========================================================================*/

export class ClassifierRequestError extends Error {
  constructor(message) {
    super(message);
    this.name = "ClassifierRequestError";
  }
}

export class ClassifierResponseError extends Error {
  constructor(message) {
    super(message);
    this.name = "ClassifierResponseError";
  }
}

/* ============================================================================
 * Request
 * ==========================================================================*/

/** Refuse anything but the pinned versioned endpoint (never the bare `/`). */
export function assertClassifierEndpoint(url) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    throw new ClassifierRequestError(`invalid classifier endpoint '${url}'`);
  }
  if (parsed.origin !== "https://classifier.dev" || parsed.pathname !== "/v1/classify" || parsed.search !== "" || parsed.hash !== "") {
    throw new ClassifierRequestError(
      `classifier endpoint must be exactly ${CLASSIFIER_DEV_ENDPOINT} (the versioned /v1/classify route) — got '${url}'`,
    );
  }
  return parsed.toString();
}

/**
 * Validate a request body BEFORE it is sent. Rejects a smart tier, multi-label,
 * `max_labels`, dynamic labels, altered instructions, unknown keys, and
 * non-string / empty / oversized inputs.
 */
export function assertClassifyRequestBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ClassifierRequestError("request body must be an object");
  for (const key of Object.keys(body)) {
    if (!CLASSIFY_REQUEST_FIELDS.includes(key)) throw new ClassifierRequestError(`request field '${key}' is not allowed in Phase 5G.0`);
  }
  if (body.tier !== CLASSIFIER_DEV_TIER) {
    throw new ClassifierRequestError(
      `tier '${body.tier}' refused — Phase 5G.0 is FAST tier only (the smart tier can involve another reasoning model and is out of scope)`,
    );
  }
  if (body.multi !== false) throw new ClassifierRequestError("multi-label classification is disabled — `multi` must be false");
  if (
    !Array.isArray(body.labels) ||
    body.labels.length !== CLASSIFIER_LABELS.length ||
    body.labels.some((label, index) => label !== CLASSIFIER_LABELS[index])
  ) {
    throw new ClassifierRequestError("labels must be EXACTLY the frozen reach-signal-type-v1 taxonomy — dynamic labels are refused");
  }
  if (body.instructions !== CLASSIFIER_INSTRUCTIONS) {
    throw new ClassifierRequestError("instructions must be EXACTLY the frozen classifier instructions");
  }
  if (!Array.isArray(body.inputs) || body.inputs.length === 0) throw new ClassifierRequestError("inputs must be a non-empty array");
  if (body.inputs.length > CLASSIFIER_MAX_INPUTS_PER_REQUEST) {
    throw new ClassifierRequestError(
      `${body.inputs.length} inputs exceed the Phase 5G.0 limit of ${CLASSIFIER_MAX_INPUTS_PER_REQUEST} per request (multi-batch is not implemented; nothing is truncated)`,
    );
  }
  for (const [index, input] of body.inputs.entries()) {
    if (typeof input !== "string" || input.length === 0) throw new ClassifierRequestError(`input ${index} must be a non-empty string`);
  }
  return body;
}

/** Build the ONE request body a classification sends. Labels/instructions/tier are frozen. */
export function buildClassifyRequestBody({ inputs, tier = CLASSIFIER_DEV_TIER } = {}) {
  const body = {
    inputs: Array.isArray(inputs) ? [...inputs] : inputs,
    labels: [...CLASSIFIER_DEFINITION.labels],
    tier,
    instructions: CLASSIFIER_DEFINITION.instructions,
    multi: false,
  };
  return assertClassifyRequestBody(body);
}

/** The exact headers of every request. No Authorization, no key, no cookie. */
export function classifyRequestHeaders() {
  return { "content-type": "application/json", accept: "application/json" };
}

/* ============================================================================
 * Response validation (whitelist, fail closed)
 * ==========================================================================*/

function boundedString(value, max = 200) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim().slice(0, max) : null;
}

function boundedInt(value) {
  return Number.isFinite(value) && value >= 0 ? Math.min(Math.round(value), 1e12) : null;
}

/**
 * Validate a parsed response body against the request that produced it and
 * return ONLY whitelisted fields. Throws `ClassifierResponseError` on anything
 * malformed, partial, reordered, out of taxonomy, or smart-tier.
 *
 * @param {unknown} payload parsed JSON body
 * @param {{ inputCount: number }} context
 */
export function validateClassifyResponse(payload, { inputCount } = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new ClassifierResponseError("response is not a JSON object");

  const tier = boundedString(payload.tier, 40);
  if (tier === null || tier.toLowerCase() !== CLASSIFIER_DEV_TIER) {
    throw new ClassifierResponseError(`response tier '${payload.tier ?? null}' is not '${CLASSIFIER_DEV_TIER}' — a non-fast tier is refused`);
  }

  if (!Array.isArray(payload.results)) throw new ClassifierResponseError("response.results is not an array");
  if (!Number.isInteger(inputCount) || payload.results.length !== inputCount) {
    throw new ClassifierResponseError(`response returned ${payload.results.length} result(s) for ${inputCount} input(s) — partial/extra responses are refused`);
  }

  const results = payload.results.map((row, index) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new ClassifierResponseError(`result ${index} is not an object`);
    if (typeof row.label !== "string" || !LABEL_SET.has(row.label)) {
      throw new ClassifierResponseError(`result ${index} label '${String(row.label).slice(0, 60)}' is not in the frozen taxonomy`);
    }
    if (typeof row.confidence !== "number" || !Number.isFinite(row.confidence) || row.confidence < 0 || row.confidence > 1) {
      throw new ClassifierResponseError(`result ${index} confidence is not a finite number in [0, 1]`);
    }
    const scores = row.scores;
    if (!scores || typeof scores !== "object" || Array.isArray(scores)) throw new ClassifierResponseError(`result ${index} scores is not an object`);
    const keys = Object.keys(scores);
    for (const key of keys) {
      if (!LABEL_SET.has(key)) throw new ClassifierResponseError(`result ${index} score key '${key.slice(0, 60)}' is not a frozen taxonomy label`);
      const value = scores[key];
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
        throw new ClassifierResponseError(`result ${index} score '${key}' is not a finite number in [0, 1]`);
      }
    }
    // Canonical key order = taxonomy order, so the persisted bytes are stable.
    const ordered = {};
    for (const label of CLASSIFIER_LABELS) if (keys.includes(label)) ordered[label] = scores[label];
    return { label: row.label, confidence: row.confidence, scores: ordered };
  });

  const usage = payload.usage && typeof payload.usage === "object" && !Array.isArray(payload.usage) ? payload.usage : {};
  const escalated = boundedInt(usage.escalated) ?? 0;
  if (escalated > 0) {
    throw new ClassifierResponseError("response reports smart-tier escalation (usage.escalated > 0) — refused: only the fast tier is allowed");
  }

  return {
    tier: CLASSIFIER_DEV_TIER,
    model: boundedString(payload.model, 200),
    results,
    usage: { classifications: boundedInt(usage.classifications), escalated, ms: boundedInt(usage.ms) },
  };
}

/* ============================================================================
 * Rate-limit metadata + Retry-After (bounded, never raw headers)
 * ==========================================================================*/

/** Hard ceiling for a server-supplied `Retry-After`, in milliseconds (60s). */
export const CLASSIFIER_RETRY_AFTER_MAX_MS = 60_000;
/** Bounded jitter: ±25% of the computed exponential delay. */
export const CLASSIFIER_JITTER_RATIO = 0.25;

export const CLASSIFIER_RETRYABLE_HTTP_STATUSES = Object.freeze([429, 502, 503, 504]);
export const CLASSIFIER_NON_RETRYABLE_HTTP_STATUSES = Object.freeze([400, 404]);

function headerValue(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === "function") {
    try {
      const value = headers.get(name);
      return value === undefined ? null : value;
    } catch {
      return null;
    }
  }
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === wanted) return value;
  return null;
}

/** `Retry-After`: integer seconds OR an HTTP-date. Returns clamped ms, or null. */
export function parseRetryAfterMs(raw, { now = () => Date.now(), maxMs = CLASSIFIER_RETRY_AFTER_MAX_MS } = {}) {
  if (raw === undefined || raw === null) return null;
  const text = String(raw).trim();
  if (text.length === 0) return null;
  let ms = null;
  if (/^\d+$/.test(text)) ms = Number(text) * 1_000;
  else if (/^[\d\s+.-]+$/.test(text)) return null; // "-5" / "1.5" are malformed, not dates
  else {
    const parsed = Date.parse(text);
    if (Number.isFinite(parsed)) ms = parsed - now();
  }
  if (ms === null || !Number.isFinite(ms)) return null;
  return Math.min(maxMs, Math.max(0, Math.round(ms)));
}

function headerInt(headers, ...names) {
  for (const name of names) {
    const raw = headerValue(headers, name);
    if (raw === null || raw === undefined) continue;
    const text = String(raw).trim();
    if (/^\d{1,15}$/.test(text)) return Number(text);
  }
  return null;
}

/** Bounded, character-restricted policy string (e.g. `3000;w=60`), or null. */
function headerPolicy(headers) {
  const raw = headerValue(headers, "ratelimit-policy");
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim().slice(0, 100);
  return /^[A-Za-z0-9=;,.\s"-]+$/.test(text) && text.length > 0 ? text : null;
}

/** Only these bounded fields are ever taken from response headers. */
export function parseRateLimitMetadata(headers, { now = () => Date.now() } = {}) {
  return {
    retryAfterMs: parseRetryAfterMs(headerValue(headers, "retry-after"), { now }),
    rateLimitLimit: headerInt(headers, "ratelimit-limit", "x-ratelimit-limit"),
    rateLimitRemaining: headerInt(headers, "ratelimit-remaining", "x-ratelimit-remaining"),
    rateLimitPolicy: headerPolicy(headers),
  };
}

/* ============================================================================
 * Backoff
 * ==========================================================================*/

/** `base * 2^(attempt-1)` clamped to `maxMs`, then ±jitterRatio, then clamped again. */
export function backoffDelayMs(
  attemptNumber,
  { baseMs = 1_000, maxMs = 30_000, jitterRatio = CLASSIFIER_JITTER_RATIO, randomImpl = Math.random } = {},
) {
  const attempt = Number.isFinite(attemptNumber) ? Math.max(1, Math.round(attemptNumber)) : 1;
  const base = Number.isFinite(baseMs) ? Math.max(0, baseMs) : 0;
  const ceiling = Number.isFinite(maxMs) ? Math.max(0, maxMs) : 30_000;
  const ratio = Number.isFinite(jitterRatio) ? Math.min(1, Math.max(0, jitterRatio)) : CLASSIFIER_JITTER_RATIO;
  const exponential = Math.min(ceiling, base * 2 ** (attempt - 1));
  const draw = randomImpl();
  const sample = Number.isFinite(draw) ? Math.min(1, Math.max(0, draw)) : 0.5;
  return Math.min(ceiling, Math.max(0, Math.round(exponential * (1 - ratio + 2 * ratio * sample))));
}

/**
 * The wait before the next attempt. A server `Retry-After` is RESPECTED as a
 * floor (plus up to +10% jitter so clients do not re-synchronize) but is always
 * clamped to `CLASSIFIER_RETRY_AFTER_MAX_MS`; without one, the backoff applies.
 */
export function retryDelayMs(attemptNumber, retryAfterMs, { baseMs, maxMs, randomImpl = Math.random } = {}) {
  const backoff = backoffDelayMs(attemptNumber, { baseMs, maxMs, randomImpl });
  if (retryAfterMs === null || retryAfterMs === undefined) return backoff;
  const draw = randomImpl();
  const sample = Number.isFinite(draw) ? Math.min(1, Math.max(0, draw)) : 0.5;
  const padded = Math.round(retryAfterMs * (1 + 0.1 * sample));
  return Math.min(CLASSIFIER_RETRY_AFTER_MAX_MS, Math.max(backoff, padded));
}

export function defaultSleepImpl(ms) {
  const wait = Math.max(0, Math.round(Number(ms) || 0));
  return new Promise((resolve) => setTimeout(resolve, wait));
}

/* ============================================================================
 * Settings (only EVOLVE_CLASSIFIER_* is ever read from the environment)
 * ==========================================================================*/

export const CLASSIFIER_DEFAULT_MAX_ATTEMPTS = 3;
export const CLASSIFIER_DEFAULT_BACKOFF_BASE_MS = 1_000;
export const CLASSIFIER_DEFAULT_BACKOFF_MAX_MS = 30_000;
export const CLASSIFIER_DEFAULT_TIMEOUT_MS = 30_000;

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/** Every value is clamped, so an environment variable can never make the client unbounded. */
export function resolveClassifierSettings(env = process.env) {
  return {
    maxAttempts: clampInt(env.EVOLVE_CLASSIFIER_MAX_ATTEMPTS, CLASSIFIER_DEFAULT_MAX_ATTEMPTS, 1, 5),
    backoffBaseMs: clampInt(env.EVOLVE_CLASSIFIER_BACKOFF_BASE_MS, CLASSIFIER_DEFAULT_BACKOFF_BASE_MS, 0, 600_000),
    backoffMaxMs: clampInt(env.EVOLVE_CLASSIFIER_BACKOFF_MAX_MS, CLASSIFIER_DEFAULT_BACKOFF_MAX_MS, 0, 600_000),
    timeoutMs: clampInt(env.EVOLVE_CLASSIFIER_TIMEOUT_MS, CLASSIFIER_DEFAULT_TIMEOUT_MS, 1_000, 120_000),
  };
}

/* ============================================================================
 * Attempt provenance
 * ==========================================================================*/

/** The EXACT field set a persisted attempt may contain — no headers, no body. */
export const CLASSIFIER_ATTEMPT_FIELDS = Object.freeze([
  "attemptNumber",
  "status",
  "httpStatus",
  "retryable",
  "retryAfterMs",
  "backoffMs",
  "rateLimitLimit",
  "rateLimitRemaining",
  "rateLimitPolicy",
  "latencyMs",
  "successful",
]);

export function boundedClassifierAttempt(attempt) {
  const out = {};
  const num = (value) => (Number.isFinite(value) ? Math.max(0, Math.round(value)) : null);
  for (const field of CLASSIFIER_ATTEMPT_FIELDS) {
    const value = attempt?.[field];
    if (field === "attemptNumber") out[field] = Number.isFinite(value) ? Math.max(1, Math.round(value)) : null;
    else if (field === "httpStatus") out[field] = Number.isFinite(value) ? Math.round(value) : null;
    else if (field === "retryable" || field === "successful") out[field] = value === true;
    else if (field === "status") out[field] = typeof value === "string" ? value.slice(0, 60) : null;
    else if (field === "rateLimitPolicy") out[field] = typeof value === "string" && value.length > 0 ? value.slice(0, 100) : null;
    else out[field] = num(value);
  }
  return out;
}

/* ============================================================================
 * Transport
 * ==========================================================================*/

function statusForHttp(httpStatus) {
  if (httpStatus === 429) return CLASSIFIER_STATUS.RATE_LIMIT;
  if (httpStatus === 502 || httpStatus === 503 || httpStatus === 504) return CLASSIFIER_STATUS.UNAVAILABLE;
  if (httpStatus === 400) return CLASSIFIER_STATUS.BAD_REQUEST;
  if (httpStatus === 404) return CLASSIFIER_STATUS.NOT_FOUND;
  return CLASSIFIER_STATUS.HTTP_ERROR;
}

/** ONE physical attempt. Never throws: returns a bounded outcome. */
async function attemptOnce({ fetchImpl, body, timeoutMs, now }) {
  const startedAt = now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const latency = () => Math.max(0, now() - startedAt);
  try {
    let response;
    try {
      response = await fetchImpl(CLASSIFIER_DEV_ENDPOINT, {
        method: "POST",
        headers: classifyRequestHeaders(),
        body: JSON.stringify(body),
        signal: controller.signal,
        // A redirect could carry the inputs to another origin: never follow one.
        redirect: "manual",
      });
    } catch (error) {
      const aborted = controller.signal.aborted || error?.name === "AbortError" || error?.name === "TimeoutError";
      return {
        ok: false,
        status: aborted ? CLASSIFIER_STATUS.TIMEOUT : CLASSIFIER_STATUS.NETWORK_ERROR,
        httpStatus: null,
        retryable: true,
        rate: { retryAfterMs: null, rateLimitLimit: null, rateLimitRemaining: null, rateLimitPolicy: null },
        latencyMs: latency(),
      };
    }

    const httpStatus = Number.isFinite(response?.status) ? response.status : null;
    const rate = parseRateLimitMetadata(response?.headers, { now });

    if (httpStatus === null || httpStatus < 200 || httpStatus >= 300) {
      // The error body is never read or kept; release the connection best-effort.
      try {
        await response?.body?.cancel?.();
      } catch {
        // ignore
      }
      return {
        ok: false,
        status: statusForHttp(httpStatus),
        httpStatus,
        retryable: CLASSIFIER_RETRYABLE_HTTP_STATUSES.includes(httpStatus),
        rate,
        latencyMs: latency(),
      };
    }

    let payload;
    try {
      const text = await response.text();
      if (typeof text !== "string" || text.length > CLASSIFIER_MAX_RESPONSE_BYTES) throw new Error("response body missing or too large");
      payload = JSON.parse(text);
    } catch (error) {
      const aborted = controller.signal.aborted || error?.name === "AbortError";
      return {
        ok: false,
        status: aborted ? CLASSIFIER_STATUS.TIMEOUT : CLASSIFIER_STATUS.INVALID_RESPONSE,
        httpStatus,
        retryable: aborted,
        rate,
        latencyMs: latency(),
        reason: aborted ? "the response body timed out" : "the response body is not valid JSON",
      };
    }
    return { ok: true, payload, httpStatus, rate, latencyMs: latency() };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Create the classifier.dev provider.
 *
 * `classify({ inputs })` performs ONE logical batch request (1..maxAttempts
 * physical attempts) and returns EITHER
 *
 *   { ok: true,  tier, model, results, usage, attempts, attemptCount, latencyMs, requestDigest }
 *   { ok: false, status, reason, httpStatus, attempts, attemptCount }
 *
 * It never throws for a transport/response failure, and it never returns or
 * persists the raw HTTP response, raw headers or any credential.
 */
export function createClassifierDevProvider({
  fetchImpl = null,
  sleepImpl = defaultSleepImpl,
  randomImpl = Math.random,
  now = () => Date.now(),
  settings = resolveClassifierSettings({}),
  tier = CLASSIFIER_DEV_TIER,
} = {}) {
  if (tier !== CLASSIFIER_DEV_TIER) {
    throw new ClassifierRequestError(`tier '${tier}' refused — Phase 5G.0 is FAST tier only`);
  }
  const maxAttempts = clampInt(settings.maxAttempts, CLASSIFIER_DEFAULT_MAX_ATTEMPTS, 1, 5);

  return {
    name: CLASSIFIER_DEV_PROVIDER,
    endpoint: CLASSIFIER_DEV_ENDPOINT,
    apiVersion: CLASSIFIER_DEV_API_VERSION,
    tier: CLASSIFIER_DEV_TIER,
    classifierId: CLASSIFIER_ID,
    external: true,
    settings: { ...settings, maxAttempts },

    async classify({ inputs }) {
      const body = buildClassifyRequestBody({ inputs, tier });
      const doFetch = fetchImpl ?? globalThis.fetch;
      if (typeof doFetch !== "function") throw new ClassifierRequestError("no fetch implementation is available");

      const attempts = [];
      let last = null;
      for (let attemptNumber = 1; attemptNumber <= maxAttempts; attemptNumber += 1) {
        const outcome = await attemptOnce({ fetchImpl: doFetch, body, timeoutMs: settings.timeoutMs, now });
        last = outcome;

        if (outcome.ok) {
          let validated;
          try {
            validated = validateClassifyResponse(outcome.payload, { inputCount: body.inputs.length });
          } catch (error) {
            attempts.push(
              boundedClassifierAttempt({
                attemptNumber,
                status: CLASSIFIER_STATUS.INVALID_RESPONSE,
                httpStatus: outcome.httpStatus,
                retryable: false,
                ...outcome.rate,
                latencyMs: outcome.latencyMs,
                successful: false,
              }),
            );
            return {
              ok: false,
              status: CLASSIFIER_STATUS.INVALID_RESPONSE,
              reason: String(error?.message ?? error).slice(0, 300),
              httpStatus: outcome.httpStatus,
              attempts,
              attemptCount: attempts.length,
            };
          }
          attempts.push(
            boundedClassifierAttempt({
              attemptNumber,
              status: CLASSIFIER_STATUS.OK,
              httpStatus: outcome.httpStatus,
              retryable: false,
              ...outcome.rate,
              latencyMs: outcome.latencyMs,
              successful: true,
            }),
          );
          return {
            ok: true,
            ...validated,
            attempts,
            attemptCount: attempts.length,
            latencyMs: outcome.latencyMs,
            // A digest only: the raw request (which carries the input text) is never returned.
            requestDigest: digestOf(body),
          };
        }

        const willRetry = outcome.retryable === true && attemptNumber < maxAttempts;
        const backoffMs = willRetry
          ? retryDelayMs(attemptNumber, outcome.rate.retryAfterMs, {
              baseMs: settings.backoffBaseMs,
              maxMs: settings.backoffMaxMs,
              randomImpl,
            })
          : null;
        attempts.push(
          boundedClassifierAttempt({
            attemptNumber,
            status: outcome.status,
            httpStatus: outcome.httpStatus,
            retryable: outcome.retryable === true,
            ...outcome.rate,
            backoffMs,
            latencyMs: outcome.latencyMs,
            successful: false,
          }),
        );
        if (!willRetry) break;
        await sleepImpl(backoffMs);
      }

      return {
        ok: false,
        status: last?.status ?? CLASSIFIER_STATUS.NETWORK_ERROR,
        reason:
          last?.reason ??
          (last?.httpStatus
            ? `classifier.dev answered HTTP ${last.httpStatus}`
            : `classifier.dev was unreachable (${last?.status ?? "unknown"})`),
        httpStatus: last?.httpStatus ?? null,
        attempts,
        attemptCount: attempts.length,
      };
    },
  };
}
