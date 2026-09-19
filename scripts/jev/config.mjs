/**
 * Jev provider configuration (Phase 5D).
 *
 * Jev ("TypeSafe AI"'s System One model, `typesafe-jev`) is a SHADOW DECISION
 * SUPERVISOR: it observes bounded TRAIN-safe state and returns typed
 * probabilities/choices/scores. It has ZERO authority over trading, genome
 * construction, research compilation, evolution, Arena scoring, gates, species
 * matching, DeepSeek calls, deployment eligibility, or replication.
 *
 * This is a DEDICATED, SEPARATE provider subsystem from the existing research
 * provider abstraction (`scripts/research/provider*.mjs`). It never reuses
 * `EVOLVE_RESEARCH_PROVIDER` — Jev is not a research proposal provider, it is a
 * fast typed-judgment API client.
 *
 * Selection is by NAME only, and it is FAIL-CLOSED, matching the Phase 5B
 * research-provider precedent:
 *
 *   EVOLVE_JEV_PROVIDER unset/empty   -> DISABLED (the default). No provider is
 *                                        constructed, no network call is ever
 *                                        possible, every evaluation records
 *                                        JEV_DISABLED / NO_JEV_DECISION.
 *   explicit `mock-jev`               -> the deterministic offline mock
 *   explicit `typesafe-jev`           -> the real TypeSafe AI HTTP provider
 *   any other explicit name           -> CONFIGURATION ERROR: nothing is
 *                                        resolved, no call is ever attempted
 *
 * A typo can never silently fall back to the mock, and it can never silently
 * run "disabled" behaviour that looks like a deliberate choice — both are
 * reported as an explicit configuration error.
 *
 * `EVOLVE_JEV_MODE` must be `shadow` (the only supported operational mode in
 * Phase 5D). Any other explicit value is a configuration error. There is no
 * `active`/`enforce`/`trade`/`route` mode yet — routing on Jev's answers is
 * future work, not Phase 5D.
 *
 * The API key (`EVOLVE_JEV_API_KEY`) is read once, passed to the SDK client at
 * call time, and NEVER persisted, logged, or echoed back — see
 * `scripts/jev/runtime.mjs` and `scripts/lib/sanitize.mjs`.
 *
 * PAPER ONLY. No wallet, no signing, no RPC, no order execution — Jev is only
 * an HTTPS decision-API client.
 */

export const JEV_CONFIG_FORMAT_VERSION = 1;

export const JEV_PROVIDER = Object.freeze({
  MOCK: "mock-jev",
  TYPESAFE: "typesafe-jev",
});

/** Every name the registry can resolve to a real implementation. */
export const REGISTERED_JEV_PROVIDERS = Object.freeze([JEV_PROVIDER.MOCK, JEV_PROVIDER.TYPESAFE]);

/** Phase 5D supports exactly one operational mode. */
export const JEV_MODE = Object.freeze({
  SHADOW: "shadow",
});

export const REGISTERED_JEV_MODES = Object.freeze([JEV_MODE.SHADOW]);
export const DEFAULT_JEV_MODE = JEV_MODE.SHADOW;

/**
 * The pinned Jev model version used for reproducible Phase 5D evidence.
 *
 * Verified against the published TypeSafe AI docs (`docs.typesafe.ai/models`):
 * `jev-latest` and `jev-preview` are ALIASES that currently point at
 * `jev-1.13.0`, but aliases move when a new release ships — the docs
 * themselves recommend pinning the versioned id for reproducible evaluation.
 * Canonical Phase 5D evidence therefore requests `jev-1.13.0` explicitly and
 * never the moving `jev-latest` alias.
 */
export const DEFAULT_JEV_MODEL = "jev-1.13.0";

export const JEV_STATUS = Object.freeze({
  OK: "JEV_OK",
  DISABLED: "JEV_DISABLED",
  UNAVAILABLE: "JEV_UNAVAILABLE",
  TIMEOUT: "JEV_TIMEOUT",
  HTTP_ERROR: "JEV_HTTP_ERROR",
  INVALID_RESPONSE: "JEV_INVALID_RESPONSE",
  BUDGET_EXCEEDED: "JEV_BUDGET_EXCEEDED",
  CONFIG_ERROR: "JEV_CONFIG_ERROR",
});

export const JEV_FAILURE_STATUSES = Object.freeze([
  JEV_STATUS.DISABLED,
  JEV_STATUS.UNAVAILABLE,
  JEV_STATUS.TIMEOUT,
  JEV_STATUS.HTTP_ERROR,
  JEV_STATUS.INVALID_RESPONSE,
  JEV_STATUS.BUDGET_EXCEEDED,
  JEV_STATUS.CONFIG_ERROR,
]);

/** Recorded in place of a decision whenever Jev did not produce one. */
export const NO_JEV_DECISION = "NO_JEV_DECISION";

export function unknownJevProviderMessage(name) {
  return `Unknown Jev provider: ${String(name ?? "").trim()}`;
}

export function unsupportedJevModeMessage(mode) {
  return `Unsupported Jev mode: ${String(mode ?? "").trim()} (only '${DEFAULT_JEV_MODE}' is supported in Phase 5D)`;
}

/** Thrown instead of resolving anything when an explicit provider name is invalid. */
export class UnknownJevProviderError extends Error {
  constructor(requestedProvider) {
    const requested = String(requestedProvider ?? "").trim();
    super(unknownJevProviderMessage(requested));
    this.name = "UnknownJevProviderError";
    this.requestedProvider = requested;
    this.code = "UNKNOWN_JEV_PROVIDER";
    this.registeredProviders = [...REGISTERED_JEV_PROVIDERS];
  }
}

/** Thrown when `EVOLVE_JEV_MODE` names an unsupported operational mode. */
export class UnsupportedJevModeError extends Error {
  constructor(requestedMode) {
    const requested = String(requestedMode ?? "").trim();
    super(unsupportedJevModeMessage(requested));
    this.name = "UnsupportedJevModeError";
    this.requestedMode = requested;
    this.code = "UNSUPPORTED_JEV_MODE";
  }
}

/** Conservative defaults. Jev is a shared/paid HTTPS resource: bounded calls, bounded time. */
export const JEV_DEFAULTS = Object.freeze({
  baseURL: "https://api.typesafe.ai",
  timeoutMs: 20_000,
  maxCallsPerRun: 20,
  cacheEnabled: true,
  minConfidence: null,
});

export const JEV_TIMEOUT_BOUNDS = Object.freeze({ min: 1_000, max: 120_000 });
export const JEV_MAX_CALLS_BOUNDS = Object.freeze({ min: 1, max: 500 });

export function readStringEnv(env, key, fallback = "") {
  const raw = env?.[key];
  if (raw === undefined || raw === null) return fallback;
  const text = String(raw).trim();
  return text.length > 0 ? text : fallback;
}

export function readIntEnv(env, key, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = env?.[key];
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
  const parsed = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export function readFloatEnv(env, key, fallback) {
  const raw = env?.[key];
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
  const parsed = Number.parseFloat(String(raw));
  if (!Number.isFinite(parsed)) return fallback;
  return parsed;
}

export function readBoolEnv(env, key, fallback) {
  const raw = env?.[key];
  if (raw === undefined || raw === null || raw === "") return fallback;
  const text = String(raw).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(text)) return true;
  if (["0", "false", "no", "off"].includes(text)) return false;
  return fallback;
}

/** Validate a provider NAME. Never throws: callers decide how loud to be. */
export function validateJevProviderName(name) {
  const normalized = String(name ?? "").trim().toLowerCase();
  if (normalized.length === 0) {
    return { ok: false, name: normalized, recognized: false, empty: true, reason: "provider name is empty" };
  }
  if (REGISTERED_JEV_PROVIDERS.includes(normalized)) {
    return { ok: true, name: normalized, recognized: true, empty: false, reason: null };
  }
  return {
    ok: false,
    name: normalized,
    recognized: false,
    empty: false,
    reason: `unknown Jev provider '${normalized}' (registered: ${REGISTERED_JEV_PROVIDERS.join(", ")})`,
  };
}

/**
 * Fail-closed resolution of a REQUESTED provider name (mirrors
 * `research/provider-config.mjs#requireProviderName`).
 *
 * Absent/empty means "not specified" and yields `provider: null` (disabled) —
 * that is the supported default, not an error. Anything else must be
 * registered; there is no fallback branch at all.
 *
 * @returns {{ specified: boolean, provider: string|null, requestedProvider: string, defaulted: boolean }}
 * @throws {UnknownJevProviderError} when an explicit name is not registered
 */
export function requireJevProviderName(requested) {
  const raw = requested === undefined || requested === null ? "" : String(requested).trim();
  if (raw.length === 0) {
    return { specified: false, provider: null, requestedProvider: "", defaulted: true };
  }
  const validation = validateJevProviderName(raw);
  if (!validation.recognized) throw new UnknownJevProviderError(raw);
  return { specified: true, provider: validation.name, requestedProvider: validation.name, defaulted: false };
}

/**
 * Resolve the whole Jev configuration from an environment bag.
 *
 * Fail-closed:
 *   - an unset/empty `EVOLVE_JEV_PROVIDER` yields `enabled: false, provider: null,
 *     defaulted: true, configError: null` — this is the supported default, not
 *     an error.
 *   - an EXPLICIT but unregistered provider name yields `provider: null` plus a
 *     `configError` naming the typo. Callers must refuse to call any provider in
 *     that state.
 *   - an explicit `EVOLVE_JEV_MODE` other than `shadow` is ALSO a `configError`,
 *     independent of the provider name.
 *
 * No credentials are read into the returned object under a name that could be
 * accidentally serialized — the raw key lives only in `apiKey`, and callers
 * (`runtime.mjs`) are responsible for never persisting it.
 */
export function resolveJevConfig(env = process.env) {
  const rawProvider = readStringEnv(env, "EVOLVE_JEV_PROVIDER", "").toLowerCase();
  const specified = rawProvider.length > 0;
  const providerValidation = validateJevProviderName(rawProvider);

  const rawMode = readStringEnv(env, "EVOLVE_JEV_MODE", DEFAULT_JEV_MODE).toLowerCase();
  const modeValid = REGISTERED_JEV_MODES.includes(rawMode);

  const providerConfigError =
    specified && !providerValidation.recognized ? unknownJevProviderMessage(rawProvider) : null;
  const modeConfigError = !modeValid ? unsupportedJevModeMessage(rawMode) : null;
  const configError = providerConfigError ?? modeConfigError ?? null;

  const provider = !specified ? null : providerValidation.recognized ? providerValidation.name : null;

  const timeoutRaw = readIntEnv(env, "EVOLVE_JEV_TIMEOUT_MS", JEV_DEFAULTS.timeoutMs, {
    min: JEV_TIMEOUT_BOUNDS.min,
    max: JEV_TIMEOUT_BOUNDS.max,
  });

  const maxCallsRaw = readIntEnv(env, "EVOLVE_JEV_MAX_CALLS", JEV_DEFAULTS.maxCallsPerRun, {
    min: JEV_MAX_CALLS_BOUNDS.min,
    max: JEV_MAX_CALLS_BOUNDS.max,
  });

  const minConfidenceRaw = readFloatEnv(env, "EVOLVE_JEV_MIN_CONFIDENCE", JEV_DEFAULTS.minConfidence);
  const minConfidence =
    Number.isFinite(minConfidenceRaw) ? Math.min(1, Math.max(0, minConfidenceRaw)) : null;

  return {
    formatVersion: JEV_CONFIG_FORMAT_VERSION,
    // `enabled` is true only when a REGISTERED provider name was explicitly
    // requested AND the mode is the supported `shadow` mode. Disabled-by-default
    // and disabled-by-typo look different (`configError` distinguishes them),
    // but neither one is ever `enabled`.
    enabled: provider !== null && configError === null,
    specified,
    defaulted: !specified,
    provider,
    requestedProvider: rawProvider,
    recognized: !specified || providerValidation.recognized,
    unknownProvider: providerConfigError ? rawProvider : null,
    mode: rawMode,
    modeValid,
    configError,
    configValid: configError === null,
    // Never `true`: a recognized Jev provider must never be silently replaced.
    allowFallback: false,
    model: readStringEnv(env, "EVOLVE_JEV_MODEL", DEFAULT_JEV_MODEL),
    baseURL: readStringEnv(env, "EVOLVE_JEV_BASE_URL", JEV_DEFAULTS.baseURL),
    apiKey: readStringEnv(env, "EVOLVE_JEV_API_KEY", ""),
    apiKeyConfigured: readStringEnv(env, "EVOLVE_JEV_API_KEY", "").length > 0,
    timeoutMs: timeoutRaw,
    maxCallsPerRun: maxCallsRaw,
    minConfidence,
    cacheEnabled: readBoolEnv(env, "EVOLVE_JEV_CACHE", JEV_DEFAULTS.cacheEnabled),
  };
}

/** The identity a provider reports, never including the API key. */
export function jevIdentity(config = {}) {
  if (config.provider === JEV_PROVIDER.TYPESAFE) {
    return {
      provider: JEV_PROVIDER.TYPESAFE,
      model: config.model ?? DEFAULT_JEV_MODEL,
      offline: false,
      external: true,
      mode: config.mode ?? DEFAULT_JEV_MODE,
    };
  }
  if (config.provider === JEV_PROVIDER.MOCK) {
    return {
      provider: JEV_PROVIDER.MOCK,
      model: null,
      offline: true,
      external: false,
      mode: config.mode ?? DEFAULT_JEV_MODE,
    };
  }
  return { provider: null, model: null, offline: true, external: false, mode: config.mode ?? DEFAULT_JEV_MODE };
}
