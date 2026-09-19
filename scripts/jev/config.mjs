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
 *                                        (DIRECT, `EVOLVE_JEV_API_KEY`)
 *   explicit `vercel-jev`             -> the Vercel AI Gateway route to the
 *                                        same model (`AI_GATEWAY_API_KEY`),
 *                                        through the AI SDK's
 *                                        `experimental_evaluate`
 *   any other explicit name           -> CONFIGURATION ERROR: nothing is
 *                                        resolved, no call is ever attempted
 *
 * A typo can never silently fall back to the mock, and it can never silently
 * run "disabled" behaviour that looks like a deliberate choice — both are
 * reported as an explicit configuration error. There is also NO fallback
 * BETWEEN the two real providers: `typesafe-jev` and `vercel-jev` are distinct
 * routes with DISTINCT credentials, and one is never silently substituted for
 * the other. A Vercel AI Gateway key must never be sent to `api.typesafe.ai`,
 * and a direct TypeSafe key must never be sent to the AI Gateway.
 *
 * `EVOLVE_JEV_MODE` must be `shadow` (the only supported operational mode in
 * Phase 5D). Any other explicit value is a configuration error. There is no
 * `active`/`enforce`/`trade`/`route` mode yet — routing on Jev's answers is
 * future work, not Phase 5D.
 *
 * Credentials are provider-specific and are NEVER cross-assigned:
 *   `EVOLVE_JEV_API_KEY`  — direct TypeSafe AI key (`typesafe-jev` only)
 *   `AI_GATEWAY_API_KEY`  — Vercel AI Gateway key (`vercel-jev` only)
 * Each is read once into its own field, is NEVER copied into the other's
 * field, and is NEVER persisted, logged, or echoed back — see
 * `scripts/jev/runtime.mjs` and `scripts/lib/sanitize.mjs`.
 *
 * PAPER ONLY. No wallet, no signing, no RPC, no order execution — Jev is only
 * an HTTPS decision-API client.
 */

export const JEV_CONFIG_FORMAT_VERSION = 1;

export const JEV_PROVIDER = Object.freeze({
  MOCK: "mock-jev",
  TYPESAFE: "typesafe-jev",
  VERCEL: "vercel-jev",
});

/** Every name the registry can resolve to a real implementation. */
export const REGISTERED_JEV_PROVIDERS = Object.freeze([
  JEV_PROVIDER.MOCK,
  JEV_PROVIDER.TYPESAFE,
  JEV_PROVIDER.VERCEL,
]);

/**
 * The provider names that reach a real (external, network) Jev route. These are
 * NOT interchangeable: each has its own credential and its own transport.
 */
export const EXTERNAL_JEV_PROVIDERS = Object.freeze([JEV_PROVIDER.TYPESAFE, JEV_PROVIDER.VERCEL]);

/** Environment variable name holding each external provider's own credential. */
export const JEV_PROVIDER_CREDENTIAL_ENV = Object.freeze({
  [JEV_PROVIDER.TYPESAFE]: "EVOLVE_JEV_API_KEY",
  [JEV_PROVIDER.VERCEL]: "AI_GATEWAY_API_KEY",
});

/** Human-readable upstream identity for each provider (never a secret). */
export const JEV_PROVIDER_UPSTREAM = Object.freeze({
  [JEV_PROVIDER.MOCK]: "evolve-mock",
  [JEV_PROVIDER.TYPESAFE]: "typesafe-ai",
  [JEV_PROVIDER.VERCEL]: "typesafe-ai",
});

/** How each provider reaches upstream. Recorded as bounded, non-authoritative metadata. */
export const JEV_PROVIDER_TRANSPORT = Object.freeze({
  [JEV_PROVIDER.MOCK]: "offline",
  [JEV_PROVIDER.TYPESAFE]: "typesafe-sdk",
  [JEV_PROVIDER.VERCEL]: "vercel-ai-gateway",
});

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

/**
 * The canonical model id for the Vercel AI Gateway route (`vercel-jev`).
 *
 * This is the GATEWAY-qualified id the AI SDK resolves through the AI Gateway:
 * `<upstream-provider>/<model>`, i.e. `typesafe-ai/jev`. It is deliberately
 * distinct from the direct TypeSafe SDK's pinned version id (`jev-1.13.0`):
 * the two transports address the same upstream model through different
 * catalogues, and each provider defaults to ITS OWN canonical id.
 *
 * `jev-latest` is never used for this route unless explicitly requested.
 */
export const DEFAULT_VERCEL_JEV_MODEL = "typesafe-ai/jev";

/** The upstream provider the Vercel AI Gateway route resolves to. */
export const DEFAULT_VERCEL_JEV_UPSTREAM_PROVIDER = "typesafe-ai";

export const JEV_STATUS = Object.freeze({
  OK: "JEV_OK",
  DISABLED: "JEV_DISABLED",
  UNAVAILABLE: "JEV_UNAVAILABLE",
  TIMEOUT: "JEV_TIMEOUT",
  HTTP_ERROR: "JEV_HTTP_ERROR",
  INVALID_RESPONSE: "JEV_INVALID_RESPONSE",
  BUDGET_EXCEEDED: "JEV_BUDGET_EXCEEDED",
  CONFIG_ERROR: "JEV_CONFIG_ERROR",
  // Added for the Vercel AI Gateway route (Phase 5D): a single HTTP_ERROR
  // bucket could not distinguish an authentication problem from a rate limit
  // from an upstream 5xx. Both real providers may use these; existing
  // `typesafe-jev` behaviour is unchanged.
  AUTH_ERROR: "JEV_AUTH_ERROR",
  RATE_LIMIT: "JEV_RATE_LIMIT",
  INTERNAL_ERROR: "JEV_INTERNAL_ERROR",
  // Added for the Phase 5F.1 resilience layer: the provider was not called at
  // all because a bounded provider-health cooldown was still active (and the
  // caller did not explicitly override it). This is a deliberate fail-safe, not
  // a provider failure — zero network attempts were made.
  COOLDOWN: "JEV_COOLDOWN",
});

export const JEV_FAILURE_STATUSES = Object.freeze([
  JEV_STATUS.DISABLED,
  JEV_STATUS.UNAVAILABLE,
  JEV_STATUS.TIMEOUT,
  JEV_STATUS.HTTP_ERROR,
  JEV_STATUS.INVALID_RESPONSE,
  JEV_STATUS.BUDGET_EXCEEDED,
  JEV_STATUS.CONFIG_ERROR,
  JEV_STATUS.AUTH_ERROR,
  JEV_STATUS.RATE_LIMIT,
  JEV_STATUS.INTERNAL_ERROR,
  JEV_STATUS.COOLDOWN,
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
});

/**
 * Resolve the model id a given provider should use.
 *
 * Precedence: an explicit `--model` override wins; then an explicit
 * `EVOLVE_JEV_MODEL`; then the provider's OWN canonical default. The two real
 * providers have different canonical defaults (`jev-1.13.0` for the direct
 * TypeSafe SDK, `typesafe-ai/jev` for the Vercel AI Gateway), so a
 * `vercel-jev` run never accidentally requests the direct route's pinned id
 * and vice versa.
 */
export function resolveJevModelName(config = {}, { provider = config.provider, override = null } = {}) {
  const explicit = override === null || override === undefined ? "" : String(override).trim();
  if (explicit.length > 0) return explicit;
  if (config.modelConfigured === true) return config.model;
  if (provider === JEV_PROVIDER.VERCEL) return config.vercelModel ?? DEFAULT_VERCEL_JEV_MODEL;
  if (provider === JEV_PROVIDER.TYPESAFE) return DEFAULT_JEV_MODEL;
  return config.model ?? DEFAULT_JEV_MODEL;
}

export const JEV_TIMEOUT_BOUNDS = Object.freeze({ min: 1_000, max: 120_000 });
export const JEV_MAX_CALLS_BOUNDS = Object.freeze({ min: 1, max: 500 });

/* ============================================================================
 * Phase 5F.1 — transport resilience configuration
 * ==========================================================================*/

/**
 * LOGICAL vs PHYSICAL budgets, deliberately separate:
 *
 *   `EVOLVE_JEV_MAX_CALLS`    maximum LOGICAL Jev decisions in one run
 *                             (unchanged Phase 5D semantics)
 *   `EVOLVE_JEV_MAX_ATTEMPTS` maximum PHYSICAL transport attempts used to obtain
 *                             ONE logical decision
 *
 * Neither is ever unbounded. A logical decision is still ONE shadow decision no
 * matter how many transport attempts it took to obtain it.
 */
export const JEV_MAX_ATTEMPTS_BOUNDS = Object.freeze({ min: 1, max: 5 });
export const JEV_BACKOFF_MS_BOUNDS = Object.freeze({ min: 0, max: 600_000 });
export const JEV_COOLDOWN_MS_BOUNDS = Object.freeze({ min: 0, max: 3_600_000 });

export const JEV_TRANSPORT_DEFAULTS = Object.freeze({
  maxAttempts: 3,
  backoffBaseMs: 1_000,
  backoffMaxMs: 30_000,
  cooldownMs: 60_000,
  // Bounded escalation ceiling: the breaker is never indefinite.
  cooldownMaxMs: 900_000,
});

/**
 * A transport chain may only ever name SAME-JEV routes. The offline mock is not
 * a transport, and no other decision model (`gpt`, `claude`, `gemini`, …) can
 * ever appear in a chain — `parseJevTransportChain` refuses anything else.
 */
export const JEV_TRANSPORT_CHAIN_PROVIDERS = Object.freeze([JEV_PROVIDER.VERCEL, JEV_PROVIDER.TYPESAFE]);
export const JEV_TRANSPORT_CHAIN_MAX = 3;

/**
 * Parse `EVOLVE_JEV_TRANSPORT_CHAIN` (e.g. `vercel-jev,typesafe-jev`).
 *
 * An absent/empty value means "single selected provider only" — the default.
 * Any name that is not a same-Jev route is a configuration error, never a
 * silent substitution.
 *
 * @returns {{ chain: string[], error: string|null }}
 */
export function parseJevTransportChain(raw) {
  const text = String(raw ?? "").trim();
  if (text.length === 0) return { chain: [], error: null };
  const names = text
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  if (names.length === 0) return { chain: [], error: null };
  if (names.length > JEV_TRANSPORT_CHAIN_MAX) {
    return { chain: [], error: `EVOLVE_JEV_TRANSPORT_CHAIN lists ${names.length} routes (max ${JEV_TRANSPORT_CHAIN_MAX})` };
  }
  const unique = [...new Set(names)];
  for (const name of unique) {
    if (!JEV_TRANSPORT_CHAIN_PROVIDERS.includes(name)) {
      return {
        chain: [],
        error:
          `EVOLVE_JEV_TRANSPORT_CHAIN may only name same-Jev routes ` +
          `(${JEV_TRANSPORT_CHAIN_PROVIDERS.join(", ")}); got '${name}'`,
      };
    }
  }
  return { chain: unique, error: null };
}

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
  const transportChainParse = parseJevTransportChain(readStringEnv(env, "EVOLVE_JEV_TRANSPORT_CHAIN", ""));
  const transportChainError = transportChainParse.error;
  const configError = providerConfigError ?? modeConfigError ?? transportChainError ?? null;

  const provider = !specified ? null : providerValidation.recognized ? providerValidation.name : null;

  const timeoutRaw = readIntEnv(env, "EVOLVE_JEV_TIMEOUT_MS", JEV_DEFAULTS.timeoutMs, {
    min: JEV_TIMEOUT_BOUNDS.min,
    max: JEV_TIMEOUT_BOUNDS.max,
  });

  const maxCallsRaw = readIntEnv(env, "EVOLVE_JEV_MAX_CALLS", JEV_DEFAULTS.maxCallsPerRun, {
    min: JEV_MAX_CALLS_BOUNDS.min,
    max: JEV_MAX_CALLS_BOUNDS.max,
  });


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
    // Which environment variable holds the SELECTED provider's own credential,
    // and whether that credential is present. This is what lets the probe and
    // the CLI report "set X" without ever touching or printing the value.
    credentialEnvVar: provider ? JEV_PROVIDER_CREDENTIAL_ENV[provider] ?? null : null,
    credentialConfigured:
      provider === JEV_PROVIDER.TYPESAFE
        ? readStringEnv(env, "EVOLVE_JEV_API_KEY", "").length > 0
        : provider === JEV_PROVIDER.VERCEL
          ? readStringEnv(env, "AI_GATEWAY_API_KEY", "").length > 0
          : true,
    upstreamProvider: provider ? JEV_PROVIDER_UPSTREAM[provider] ?? null : null,
    transport: provider ? JEV_PROVIDER_TRANSPORT[provider] ?? null : null,
    model: readStringEnv(env, "EVOLVE_JEV_MODEL", DEFAULT_JEV_MODEL),
    modelConfigured: readStringEnv(env, "EVOLVE_JEV_MODEL", "").length > 0,
    // The Vercel AI Gateway route's own model id / override. Kept SEPARATE from
    // `model` so a gateway run can never accidentally reuse the direct route's
    // pinned TypeSafe version id (or vice versa).
    vercelModel: readStringEnv(env, "EVOLVE_VERCEL_JEV_MODEL", DEFAULT_VERCEL_JEV_MODEL),
    vercelModelConfigured: readStringEnv(env, "EVOLVE_VERCEL_JEV_MODEL", "").length > 0,
    baseURL: readStringEnv(env, "EVOLVE_JEV_BASE_URL", JEV_DEFAULTS.baseURL),
    apiKey: readStringEnv(env, "EVOLVE_JEV_API_KEY", ""),
    apiKeyConfigured: readStringEnv(env, "EVOLVE_JEV_API_KEY", "").length > 0,
    // The Vercel AI Gateway credential. Deliberately a DIFFERENT field from
    // `apiKey`: it is never copied into `apiKey`, never copied out of it, and
    // is only ever read by the `vercel-jev` provider.
    gatewayApiKey: readStringEnv(env, "AI_GATEWAY_API_KEY", ""),
    gatewayApiKeyConfigured: readStringEnv(env, "AI_GATEWAY_API_KEY", "").length > 0,
    timeoutMs: timeoutRaw,
    maxCallsPerRun: maxCallsRaw,
    cacheEnabled: readBoolEnv(env, "EVOLVE_JEV_CACHE", JEV_DEFAULTS.cacheEnabled),
    // ---- Phase 5F.1 transport resilience ---------------------------------
    // PHYSICAL attempts per LOGICAL decision. Bounded, never unbounded.
    maxAttemptsPerCall: readIntEnv(env, "EVOLVE_JEV_MAX_ATTEMPTS", JEV_TRANSPORT_DEFAULTS.maxAttempts, {
      min: JEV_MAX_ATTEMPTS_BOUNDS.min,
      max: JEV_MAX_ATTEMPTS_BOUNDS.max,
    }),
    backoffBaseMs: readIntEnv(env, "EVOLVE_JEV_BACKOFF_BASE_MS", JEV_TRANSPORT_DEFAULTS.backoffBaseMs, {
      min: JEV_BACKOFF_MS_BOUNDS.min,
      max: JEV_BACKOFF_MS_BOUNDS.max,
    }),
    backoffMaxMs: readIntEnv(env, "EVOLVE_JEV_BACKOFF_MAX_MS", JEV_TRANSPORT_DEFAULTS.backoffMaxMs, {
      min: JEV_BACKOFF_MS_BOUNDS.min,
      max: JEV_BACKOFF_MS_BOUNDS.max,
    }),
    cooldownMs: readIntEnv(env, "EVOLVE_JEV_COOLDOWN_MS", JEV_TRANSPORT_DEFAULTS.cooldownMs, {
      min: JEV_COOLDOWN_MS_BOUNDS.min,
      max: JEV_COOLDOWN_MS_BOUNDS.max,
    }),
    cooldownMaxMs: readIntEnv(env, "EVOLVE_JEV_COOLDOWN_MAX_MS", JEV_TRANSPORT_DEFAULTS.cooldownMaxMs, {
      min: JEV_COOLDOWN_MS_BOUNDS.min,
      max: JEV_COOLDOWN_MS_BOUNDS.max,
    }),
    // Empty by default: a single, explicitly selected provider. An opt-in chain
    // is only ever honoured when every named route has its OWN real credential.
    transportChain: transportChainParse.chain,
    transportChainConfigured: transportChainParse.chain.length > 0,
    transportChainError,
  };
}

/** The identity a provider reports, never including the API key. */
export function jevIdentity(config = {}) {
  if (config.provider === JEV_PROVIDER.TYPESAFE) {
    return {
      provider: JEV_PROVIDER.TYPESAFE,
      model: resolveJevModelName(config, { provider: JEV_PROVIDER.TYPESAFE }),
      upstreamProvider: DEFAULT_VERCEL_JEV_UPSTREAM_PROVIDER,
      gatewayUsed: false,
      offline: false,
      external: true,
      mode: config.mode ?? DEFAULT_JEV_MODE,
    };
  }
  if (config.provider === JEV_PROVIDER.VERCEL) {
    return {
      provider: JEV_PROVIDER.VERCEL,
      model: resolveJevModelName(config, { provider: JEV_PROVIDER.VERCEL }),
      upstreamProvider: DEFAULT_VERCEL_JEV_UPSTREAM_PROVIDER,
      gatewayUsed: true,
      offline: false,
      external: true,
      mode: config.mode ?? DEFAULT_JEV_MODE,
    };
  }
  if (config.provider === JEV_PROVIDER.MOCK) {
    return {
      provider: JEV_PROVIDER.MOCK,
      model: null,
      upstreamProvider: JEV_PROVIDER_UPSTREAM[JEV_PROVIDER.MOCK],
      gatewayUsed: false,
      offline: true,
      external: false,
      mode: config.mode ?? DEFAULT_JEV_MODE,
    };
  }
  return { provider: null, model: null, offline: true, external: false, mode: config.mode ?? DEFAULT_JEV_MODE };
}
