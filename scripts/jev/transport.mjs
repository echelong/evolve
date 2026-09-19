/**
 * EVOLVE Phase 5F.1 — RESILIENT JEV TRANSPORT.
 *
 * Jev is a shared, rate-limited HTTPS decision API. Phase 5D/5F.0 deliberately
 * sent `maxRetries: 0` to the AI SDK and made exactly ONE physical attempt per
 * EVOLVE call, which correctly prevented hidden retry storms — and which also
 * meant a single transient HTTP 429 ended a whole shadow experiment.
 *
 * This module adds an EXPLICIT, EVOLVE-OWNED resilience layer that sits
 * strictly BELOW one logical Jev decision:
 *
 *   ONE logical Jev decision
 *     └── 1..N physical transport attempts (bounded)
 *           attempt 1 → 429   → backoff → retry
 *           attempt 2 → 503   → backoff → retry
 *           attempt 3 → 200   → JEV_OK
 *
 * That is still ONE shadow decision and still ONE entry in
 * `EVOLVE_JEV_MAX_CALLS`; it is N records in `providerAttempts`. Counting a
 * retried call as several Jev decisions would corrupt every calibration and
 * provenance number EVOLVE produces, so the two budgets are kept strictly
 * separate:
 *
 *   EVOLVE_JEV_MAX_CALLS     maximum LOGICAL Jev decisions per run
 *   EVOLVE_JEV_MAX_ATTEMPTS  maximum PHYSICAL transport attempts per decision
 *
 * What this module deliberately does NOT do:
 *
 *   * it never retries a non-transient failure (400/401/402/403/404/422,
 *     malformed typed response, invalid question schema, config/auth error,
 *     unknown provider/model, packet-audit failure) — sleeping cannot fix a
 *     typo, a revoked key, or a rejected request;
 *   * it never retries forever: `maxAttempts` is bounded to [1, 5];
 *   * it never enables SDK-level retries (each individual request still sends
 *     `maxRetries: 0`), so attempt accounting stays exact and observable;
 *   * it never hides a failure: every physical attempt is recorded, including
 *     the failed ones that preceded a success;
 *   * it never persists raw headers, cookies, credentials, raw state, raw
 *     questions or raw responses — only bounded scalars and the single bounded
 *     `retryAfterMs` number derived from a standard `Retry-After` header;
 *   * it never substitutes a different decision model. The optional transport
 *     chain is Jev → Jev only (`vercel-jev` → `typesafe-jev`), and the offline
 *     mock can never appear in it.
 *
 * PAPER ONLY. SHADOW ONLY. READ-ONLY with respect to every other EVOLVE system.
 */

import { JEV_STATUS } from "./config.mjs";
import {
  applyNonTransientFailure,
  applySuccess,
  applyTransientExhaustion,
  emptyProviderHealth,
  isCooldownActive,
  providerHealthPath,
  readProviderHealth,
  writeProviderHealth,
} from "./provider-health.mjs";

export const JEV_TRANSPORT_VERSION = 1;

/** Bounded jitter: ±25% of the computed exponential delay. */
export const JEV_JITTER_RATIO = 0.25;

/** Hard ceiling for a server-supplied `Retry-After`, in milliseconds (60s). */
export const JEV_RETRY_AFTER_MAX_MS = 60_000;

/** How deep a `RetryError`-style wrapper may be unwrapped while looking for a header. */
const RETRY_AFTER_UNWRAP_DEPTH = 2;

/**
 * HTTP statuses that are worth retrying.
 *
 * 429 is the rate limit; 5xx is an upstream/gateway availability problem. The
 * rest of the 4xx family never improves by sleeping, so it is NOT retried.
 */
export const RETRYABLE_HTTP_STATUSES = Object.freeze([429, 500, 502, 503, 504]);

/** HTTP statuses explicitly classified as NON-retryable (documented, not exclusive). */
export const NON_RETRYABLE_HTTP_STATUSES = Object.freeze([400, 401, 402, 403, 404, 422]);

/** Jev statuses that are transient by themselves (no HTTP status needed). */
export const RETRYABLE_JEV_STATUSES = Object.freeze([
  JEV_STATUS.RATE_LIMIT,
  JEV_STATUS.TIMEOUT,
  JEV_STATUS.UNAVAILABLE,
]);

/**
 * Jev statuses that are NEVER retried regardless of anything else. An auth or
 * configuration error will not improve by sleeping, and a malformed typed
 * response is a schema problem, not an outage.
 */
export const NON_RETRYABLE_JEV_STATUSES = Object.freeze([
  JEV_STATUS.DISABLED,
  JEV_STATUS.INVALID_RESPONSE,
  JEV_STATUS.BUDGET_EXCEEDED,
  JEV_STATUS.CONFIG_ERROR,
  JEV_STATUS.AUTH_ERROR,
  JEV_STATUS.INTERNAL_ERROR,
  JEV_STATUS.COOLDOWN,
]);

const NON_RETRYABLE_STATUS_SET = new Set(NON_RETRYABLE_JEV_STATUSES);

/**
 * Decide whether one physical attempt may be retried.
 *
 * Precedence:
 *   1. a categorically non-retryable Jev status wins (config/auth/invalid/…);
 *   2. an explicit HTTP status decides (429/5xx retry, other 4xx do not);
 *   3. otherwise the Jev status decides (rate limit / timeout / unavailable).
 *
 * The HTTP-status rule is what keeps the DIRECT TypeSafe route honest: it
 * classifies 429/5xx as `JEV_HTTP_ERROR` (an existing, pinned behaviour this
 * module does not change), so retryability must be readable from the status
 * code rather than from the label alone.
 */
export function isRetryableFailure({ status = null, httpStatus = null } = {}) {
  if (typeof status !== "string" || status.length === 0) return false;
  if (NON_RETRYABLE_STATUS_SET.has(status)) return false;
  if (Number.isFinite(httpStatus)) {
    if (httpStatus === 429) return true;
    if (httpStatus >= 500 && httpStatus <= 599) return true;
    if (httpStatus >= 400 && httpStatus < 500) return false;
  }
  return RETRYABLE_JEV_STATUSES.includes(status);
}

/* ============================================================================
 * Retry-After (bounded, header-shape tolerant, NEVER persisted raw)
 * ==========================================================================*/

/** Case-insensitive lookup over a plain header bag. */
function headerFromBag(bag, name) {
  if (!bag || typeof bag !== "object") return null;
  if (typeof bag.get === "function") {
    try {
      const value = bag.get(name);
      return value === undefined ? null : value;
    } catch {
      return null;
    }
  }
  const wanted = String(name).toLowerCase();
  for (const [key, value] of Object.entries(bag)) {
    if (String(key).toLowerCase() === wanted) return value;
  }
  return null;
}

/** Standard `Retry-After` value: integer seconds, or an HTTP-date. */
function parseRetryAfterValue(raw, nowMs) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return null;
    return Math.max(0, Math.round(raw * 1_000));
  }
  const text = String(raw).trim();
  if (text.length === 0) return null;
  if (/^\d+$/.test(text)) return Math.max(0, Number(text) * 1_000);
  const parsed = Date.parse(text);
  if (Number.isFinite(parsed)) return Math.max(0, parsed - nowMs);
  return null;
}

/**
 * Extract a bounded `retryAfterMs` from the standard error/header shapes an AI
 * SDK / Gateway error can actually expose.
 *
 * Recognized (bounded, depth-limited): `retryAfterMs`, `retryAfter`,
 * `responseHeaders`, `headers`, `response.headers`, plus one unwrap level of
 * `lastError`/`cause` (a retry wrapper can hide the real cause, and the AI SDK's
 * `APICallError` carries `responseHeaders` while its `RetryError` carries
 * `lastError`).
 *
 * Returns `null` when nothing usable is present, and `null` for a malformed
 * value. The result is ALWAYS clamped to `[0, maxMs]`, so a hostile or buggy
 * upstream header can never park EVOLVE for an unbounded time. Raw headers are
 * never returned, stored, or forwarded — only this single number.
 *
 * @param {object|null} error an error object or a classified provider outcome
 * @param {{ maxMs?: number, now?: () => number }} [options]
 * @returns {number|null}
 */
export function retryAfterMsOf(error, { maxMs = JEV_RETRY_AFTER_MAX_MS, now = () => Date.now() } = {}) {
  const ceiling = Number.isFinite(maxMs) ? Math.max(0, Math.round(maxMs)) : JEV_RETRY_AFTER_MAX_MS;
  const nowMs = Number.isFinite(now()) ? now() : Date.now();

  const clamp = (value) => (value === null ? null : Math.min(ceiling, Math.max(0, Math.round(value))));

  const inspect = (candidate, depth) => {
    if (!candidate || typeof candidate !== "object" || depth > RETRY_AFTER_UNWRAP_DEPTH) return null;

    if (Number.isFinite(candidate.retryAfterMs)) return clamp(candidate.retryAfterMs);
    if (candidate.retryAfter !== undefined && candidate.retryAfter !== null) {
      const parsed = parseRetryAfterValue(candidate.retryAfter, nowMs);
      if (parsed !== null) return clamp(parsed);
    }

    for (const bag of [candidate.headers, candidate.responseHeaders, candidate.response?.headers]) {
      const raw = headerFromBag(bag, "retry-after");
      if (raw !== undefined && raw !== null) {
        const parsed = parseRetryAfterValue(raw, nowMs);
        if (parsed !== null) return clamp(parsed);
        // A malformed Retry-After is ignored — the backoff schedule is used
        // instead — but it must not stop us from still checking the wrapper.
      }
    }

    for (const nested of [candidate.lastError, candidate.cause, candidate.error]) {
      const found = inspect(nested, depth + 1);
      if (found !== null) return found;
    }
    return null;
  };

  return inspect(error, 0);
}

/* ============================================================================
 * Backoff
 * ==========================================================================*/

/**
 * Bounded exponential backoff with bounded jitter.
 *
 * `baseMs * 2^(attemptNumber - 1)`, clamped to `maxMs`, then multiplied by a
 * factor drawn uniformly from `[1 - jitterRatio, 1 + jitterRatio)` and clamped
 * again. With the defaults that is ~1s after the first failure and ~2s after
 * the second, as documented — never an identical, synchronized delay across
 * many simultaneous agents.
 *
 * `randomImpl` is injectable so offline tests can be fully deterministic.
 */
export function backoffDelayMs(
  attemptNumber,
  { baseMs = 1_000, maxMs = 30_000, jitterRatio = JEV_JITTER_RATIO, randomImpl = Math.random } = {},
) {
  const attempt = Number.isFinite(attemptNumber) ? Math.max(1, Math.round(attemptNumber)) : 1;
  const base = Number.isFinite(baseMs) ? Math.max(0, baseMs) : 0;
  const ceiling = Number.isFinite(maxMs) ? Math.max(0, maxMs) : 30_000;
  const ratio = Number.isFinite(jitterRatio) ? Math.min(1, Math.max(0, jitterRatio)) : JEV_JITTER_RATIO;

  const exponential = Math.min(ceiling, base * 2 ** (attempt - 1));
  const sample = Number.isFinite(randomImpl()) ? Math.min(1, Math.max(0, randomImpl())) : 0.5;
  const factor = 1 - ratio + 2 * ratio * sample;
  return Math.min(ceiling, Math.max(0, Math.round(exponential * factor)));
}

/** Production delay. Tests inject a zero-time implementation. */
export function defaultSleepImpl(ms) {
  const wait = Math.max(0, Math.round(Number(ms) || 0));
  return new Promise((resolve) => setTimeout(resolve, wait));
}

/* ============================================================================
 * Attempt provenance
 * ==========================================================================*/

/**
 * The EXACT field set a persisted attempt record may contain. Nothing else —
 * no API key, no Authorization header, no raw state, raw questions, raw
 * response, headers, or cookies.
 */
export const PROVIDER_ATTEMPT_FIELDS = Object.freeze([
  "attemptNumber",
  "provider",
  "model",
  "transport",
  "startedAt",
  "completedAt",
  "latencyMs",
  "status",
  "httpStatus",
  "retryable",
  "retryAfterMs",
  "backoffMs",
  "generationId",
  "successful",
]);

/**
 * Whitelist-by-shape normalizer for one physical transport attempt. Applied both
 * when an attempt is built and again before it is persisted, so a provider can
 * never smuggle an extra field into provenance.
 */
export function boundedProviderAttempt(attempt) {
  if (!attempt || typeof attempt !== "object") return null;
  const out = {};
  for (const field of PROVIDER_ATTEMPT_FIELDS) {
    if (!(field in attempt)) continue;
    const value = attempt[field];
    if (field === "attemptNumber") out[field] = Number.isFinite(value) ? Math.max(1, Math.round(value)) : null;
    else if (field === "httpStatus") out[field] = Number.isFinite(value) ? value : null;
    else if (field === "latencyMs" || field === "retryAfterMs" || field === "backoffMs") {
      out[field] = Number.isFinite(value) ? Math.max(0, Math.round(value)) : null;
    } else if (field === "retryable" || field === "successful") out[field] = value === true;
    else if (field === "generationId") out[field] = typeof value === "string" && value.length > 0 ? value.slice(0, 200) : null;
    else out[field] = value === null || value === undefined ? null : String(value).slice(0, 200);
  }
  return out;
}

/** Normalize a whole attempts array (bounded). */
export function boundedProviderAttempts(attempts) {
  if (!Array.isArray(attempts)) return [];
  return attempts.map((attempt) => boundedProviderAttempt(attempt)).filter((attempt) => attempt !== null);
}

/* ============================================================================
 * Transport settings
 * ==========================================================================*/

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/**
 * Normalize a Jev config (or an explicit override bag) into transport settings.
 * Every value is clamped, so an environment variable can never make the
 * resilience layer unbounded.
 */
export function resolveJevTransportSettings(config = {}, overrides = {}) {
  const pick = (key, fallback) => (overrides[key] === undefined || overrides[key] === null ? config[key] ?? fallback : overrides[key]);
  return {
    maxAttempts: clampInt(pick("maxAttemptsPerCall", pick("maxAttempts", 3)), 3, 1, 5),
    backoffBaseMs: clampInt(pick("backoffBaseMs", 1_000), 1_000, 0, 600_000),
    backoffMaxMs: clampInt(pick("backoffMaxMs", 30_000), 30_000, 0, 600_000),
    cooldownMs: clampInt(pick("cooldownMs", 60_000), 60_000, 0, 3_600_000),
    cooldownMaxMs: clampInt(pick("cooldownMaxMs", 900_000), 900_000, 0, 3_600_000),
    jitterRatio: JEV_JITTER_RATIO,
    retryAfterMaxMs: JEV_RETRY_AFTER_MAX_MS,
  };
}

/* ============================================================================
 * The resilient transport wrapper
 * ==========================================================================*/

/** Bounded, non-secret metadata block for a call that never left the machine. */
function blockedMetadata({ provider, model, transport, status, cooldownUntil = null }) {
  return {
    provider: provider ?? null,
    model: model ?? null,
    transport: transport ?? null,
    providerAttemptCount: 0,
    providerStatus: status,
    cooldownUntil,
    formatVersion: JEV_TRANSPORT_VERSION,
  };
}

/** Overwrite the attempt count in a provider metadata block (bounded passthrough). */
function withTotalAttemptCount(outcome, total) {
  const metadata = outcome?.providerMetadata;
  if (!metadata || typeof metadata !== "object") return outcome;
  return { ...outcome, providerMetadata: { ...metadata, providerAttemptCount: total } };
}

/**
 * Wrap one or more resolved Jev providers in EVOLVE's bounded transport
 * resilience policy.
 *
 * The returned object honours the SAME narrow provider contract as every other
 * Jev provider (`evaluate({ state, questions, context })`), which is what keeps
 * `jevDecide`, the experiment layer, the decision store, calibration and the
 * dashboard completely unaware that a retry policy exists. The ONLY additions
 * are provenance: `providerAttempts` (every physical attempt, in order) and
 * `providerAttemptCount`.
 *
 * @param {{
 *   providers: object[],                 // chain, first entry = selected provider
 *   settings?: object,                   // resolveJevTransportSettings() shape
 *   healthRoot?: string|null,            // provider-health root, null = in-memory only
 *   overrideCooldown?: boolean,          // CLI opt-in (`--override-cooldown`)
 *   now?: () => number,
 *   sleepImpl?: (ms: number) => Promise<void>,
 *   randomImpl?: () => number,
 * }} options
 */
export function createResilientJevTransport({
  providers = [],
  settings = {},
  healthRoot = null,
  overrideCooldown = false,
  now = () => Date.now(),
  sleepImpl = defaultSleepImpl,
  randomImpl = Math.random,
} = {}) {
  const chain = (Array.isArray(providers) ? providers : []).filter(
    (provider) => provider && typeof provider.evaluate === "function",
  );
  const primary = chain[0] ?? null;
  const resolved = resolveJevTransportSettings(settings, settings);

  const loadHealth = async (provider) => {
    const stored = healthRoot ? await readProviderHealth(healthRoot, provider.name) : null;
    return stored ?? emptyProviderHealth({ provider: provider.name, model: provider.model ?? null });
  };

  const saveHealth = async (provider, health) => {
    if (!healthRoot) return health;
    return writeProviderHealth(healthRoot, health);
  };

  async function attemptProvider(provider, { state, questions, context, attempts }) {
    let lastOutcome = null;
    let exhaustedTransient = true;

    for (let attemptNumber = 1; attemptNumber <= resolved.maxAttempts; attemptNumber += 1) {
      const startedMs = now();
      let outcome;
      try {
        outcome = await provider.evaluate({ state, questions, context });
      } catch (error) {
        outcome = {
          ok: false,
          status: JEV_STATUS.UNAVAILABLE,
          reason: `provider threw: ${error?.message ?? error}`,
        };
      }
      const completedMs = now();
      const successful = outcome?.ok === true;
      const httpStatus = Number.isFinite(outcome?.httpStatus) ? outcome.httpStatus : null;
      const retryable = successful ? false : isRetryableFailure({ status: outcome?.status, httpStatus });
      const retryAfterMs = successful ? null : retryAfterMsOf(outcome, { maxMs: resolved.retryAfterMaxMs, now });
      const isLast = attemptNumber >= resolved.maxAttempts;
      const willRetry = !successful && retryable && !isLast;
      const backoffMs = willRetry ? retryAfterMs ?? backoffDelayMs(attemptNumber, { ...resolved, randomImpl }) : 0;

      attempts.push(
        boundedProviderAttempt({
          attemptNumber,
          provider: provider.name ?? null,
          model: outcome?.model ?? provider.model ?? null,
          transport: provider.transport ?? null,
          startedAt: new Date(startedMs).toISOString(),
          completedAt: new Date(completedMs).toISOString(),
          latencyMs: Math.max(0, completedMs - startedMs),
          status: successful ? JEV_STATUS.OK : outcome?.status ?? JEV_STATUS.UNAVAILABLE,
          httpStatus,
          retryable,
          retryAfterMs,
          backoffMs,
          generationId: outcome?.requestId ?? null,
          successful,
        }),
      );

      if (successful) return { outcome, exhaustedTransient: false };
      lastOutcome = outcome;
      if (!retryable) exhaustedTransient = false;
      if (!willRetry) break;
      if (backoffMs > 0) await sleepImpl(backoffMs);
    }

    return { outcome: lastOutcome, exhaustedTransient };
  }

  return {
    name: primary?.name ?? null,
    model: primary?.model ?? null,
    transport: primary?.transport ?? null,
    external: true,
    offline: false,
    syntheticDecision: false,
    // Provenance for the run record / CLI output: the exact ordered chain that
    // was CALLABLE for this decision (already credential-filtered upstream).
    providerChain: chain.map((provider) => provider.name ?? null),
    maxAttempts: resolved.maxAttempts,
    overrideCooldown: overrideCooldown === true,

    async evaluate({ state, questions, context = {} } = {}) {
      const attempts = [];
      const cooldownSkipped = [];
      let lastOutcome = null;
      let lastAttemptProvider = null;

      for (let index = 0; index < chain.length; index += 1) {
        const provider = chain[index];
        const health = await loadHealth(provider);
        const cooldownActive = isCooldownActive(health, now());

        if (cooldownActive && overrideCooldown !== true) {
          cooldownSkipped.push({ provider: provider.name ?? null, cooldownUntil: health.cooldownUntil ?? null });
          // The selected provider is cooling down: fail safely instead of
          // calling it purely to rediscover that it is still rate limited.
          if (index === 0) {
            return {
              ok: false,
              status: JEV_STATUS.COOLDOWN,
              reason:
                `provider '${provider.name}' is in an active transient-failure cooldown until ` +
                `${health.cooldownUntil ?? "unknown"}; no network call was made ` +
                `(pass --override-cooldown to force one)`,
              providerAttempts: [],
              providerAttemptCount: 0,
              providerChain: chain.map((entry) => entry.name ?? null),
              cooldownUntil: health.cooldownUntil ?? null,
              cooldownOverridden: false,
              cooldownSkipped,
              providerMetadata: blockedMetadata({
                provider: provider.name ?? null,
                model: provider.model ?? null,
                transport: provider.transport ?? null,
                status: JEV_STATUS.COOLDOWN,
                cooldownUntil: health.cooldownUntil ?? null,
              }),
            };
          }
          continue;
        }

        const result = await attemptProvider(provider, { state, questions, context, attempts });
        lastAttemptProvider = provider.name ?? null;

        if (result.outcome?.ok === true) {
          await saveHealth(provider, applySuccess(health, { now: now() }));
          return {
            ...withTotalAttemptCount(result.outcome, attempts.length),
            providerAttempts: attempts.slice(),
            providerAttemptCount: attempts.length,
            providerChain: chain.map((entry) => entry.name ?? null),
            succeededProvider: provider.name ?? null,
            cooldownOverridden: cooldownActive && overrideCooldown === true,
            cooldownSkipped,
          };
        }

        lastOutcome = result.outcome;

        if (result.exhaustedTransient) {
          await saveHealth(
            provider,
            applyTransientExhaustion(health, {
              now: now(),
              status: result.outcome?.status ?? JEV_STATUS.UNAVAILABLE,
              baseCooldownMs: resolved.cooldownMs,
              maxCooldownMs: resolved.cooldownMaxMs,
            }),
          );
          // Same-Jev transport failover: only a genuinely EXHAUSTED TRANSIENT
          // decision may move to the next Jev route, and only if one exists.
          if (index + 1 < chain.length) continue;
        } else {
          await saveHealth(
            provider,
            applyNonTransientFailure(health, { now: now(), status: result.outcome?.status ?? JEV_STATUS.UNAVAILABLE }),
          );
          // A non-transient failure will not improve on another route either:
          // it is a configuration/auth/schema problem, not an outage.
          break;
        }

        break;
      }

      if (attempts.length === 0) {
        const primaryHealth = chain[0] ? await loadHealth(chain[0]) : null;
        return {
          ok: false,
          status: JEV_STATUS.COOLDOWN,
          reason: "every provider in the Jev transport chain is in an active transient-failure cooldown; no network call was made",
          providerAttempts: [],
          providerAttemptCount: 0,
          providerChain: chain.map((entry) => entry.name ?? null),
          cooldownUntil: primaryHealth?.cooldownUntil ?? null,
          cooldownOverridden: false,
          cooldownSkipped,
          providerMetadata: blockedMetadata({
            provider: chain[0]?.name ?? null,
            model: chain[0]?.model ?? null,
            transport: chain[0]?.transport ?? null,
            status: JEV_STATUS.COOLDOWN,
            cooldownUntil: primaryHealth?.cooldownUntil ?? null,
          }),
        };
      }

      return {
        ...withTotalAttemptCount(lastOutcome ?? { ok: false, status: JEV_STATUS.UNAVAILABLE }, attempts.length),
        ok: false,
        providerAttempts: attempts.slice(),
        providerAttemptCount: attempts.length,
        providerChain: chain.map((entry) => entry.name ?? null),
        finalProvider: lastAttemptProvider,
        cooldownOverridden: overrideCooldown === true,
        cooldownSkipped,
      };
    },
  };
}

/** Path helper re-exported so callers/validators can point the health store at a tmp root. */
export { providerHealthPath };
