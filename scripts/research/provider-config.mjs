/**
 * Research-provider configuration (Phase 5B).
 *
 * One place decides *which* research-provider implementation is selected and
 * *how* an external provider is allowed to be called. Everything is explicit:
 *
 *   mock            deterministic, offline, no subprocess, no network — the
 *                   default and the baseline for every offline test
 *   deepseek-cline  DeepSeek V4.1 Flash through the locally installed Cline
 *                   CLI (one bounded subprocess call per requested proposal)
 *
 * Selection is by NAME only, and it is **fail-closed** (Phase 5B.1):
 *
 *   EVOLVE_RESEARCH_PROVIDER unset/empty  → `mock`  (the deterministic default)
 *   explicit `mock`                       → `mock`
 *   explicit `deepseek-cline`             → DeepSeek via Cline
 *   any other explicit name               → CONFIGURATION ERROR: no provider is
 *                                           resolved, no calls are made, no
 *                                           proposals are produced, and the CLI
 *                                           exits non-zero
 *
 * There is NO provider fallback during an experiment. In particular a typo such
 * as `EVOLVE_RESEARCH_PROVIDER=deepseek-clnie` must never silently run the mock
 * provider — that would produce an artifact that looks like a valid experiment
 * while measuring something else entirely. A recognized external provider never
 * falls back either: if `deepseek-cline` fails, the failure is recorded as a
 * provider-failure status and the experiment reports it.
 *
 * No credentials are read, stored, or surfaced here. PAPER ONLY.
 */

export const RESEARCH_PROVIDER_FORMAT_VERSION = 1;

export const RESEARCH_PROVIDER = Object.freeze({
  MOCK: "mock",
  DEEPSEEK_CLINE: "deepseek-cline",
});

/** Every name the registry can resolve to a real implementation. */
export const REGISTERED_PROVIDERS = Object.freeze([
  RESEARCH_PROVIDER.MOCK,
  RESEARCH_PROVIDER.DEEPSEEK_CLINE,
]);

export const DEFAULT_RESEARCH_PROVIDER = RESEARCH_PROVIDER.MOCK;

/** The one model Phase 5B is allowed to request. */
export const DEEPSEEK_CLINE_MODEL = "deepseek/deepseek-v4.1-flash";
export const DEEPSEEK_CLINE_REASONING = "xhigh";
export const DEEPSEEK_CLINE_PROFILE = "cline";

/** Reasoning levels the installed Cline CLI actually accepts. */
export const CLINE_REASONING_LEVELS = Object.freeze(["none", "low", "medium", "high", "xhigh"]);

export const PROVIDER_STATUS = Object.freeze({
  OK: "PROVIDER_OK",
  TIMEOUT: "PROVIDER_TIMEOUT",
  UNAVAILABLE: "PROVIDER_UNAVAILABLE",
  PROCESS_ERROR: "PROVIDER_PROCESS_ERROR",
  INVALID_OUTPUT: "PROVIDER_INVALID_OUTPUT",
  SCHEMA_REJECTED: "PROVIDER_SCHEMA_REJECTED",
  BUDGET_EXCEEDED: "PROVIDER_BUDGET_EXCEEDED",
  DISABLED: "PROVIDER_DISABLED",
  // Phase 5B.1: the requested provider NAME is not registered. This is a
  // configuration error, not a runtime provider failure: nothing is called.
  CONFIG_ERROR: "PROVIDER_CONFIG_ERROR",
});

export const PROVIDER_FAILURE_STATUSES = Object.freeze([
  PROVIDER_STATUS.TIMEOUT,
  PROVIDER_STATUS.UNAVAILABLE,
  PROVIDER_STATUS.PROCESS_ERROR,
  PROVIDER_STATUS.INVALID_OUTPUT,
  PROVIDER_STATUS.SCHEMA_REJECTED,
  PROVIDER_STATUS.BUDGET_EXCEEDED,
  PROVIDER_STATUS.DISABLED,
  PROVIDER_STATUS.CONFIG_ERROR,
]);

/**
 * The one message every fail-closed path emits (CLI, probe, engine, cohort
 * runner), so an operator sees the same words wherever the typo surfaces.
 */
export function unknownProviderMessage(name) {
  return `Unknown research provider: ${String(name ?? "").trim()}`;
}

/** Thrown instead of resolving anything when an explicit provider name is invalid. */
export class UnknownResearchProviderError extends Error {
  constructor(requestedProvider) {
    const requested = String(requestedProvider ?? "").trim();
    super(unknownProviderMessage(requested));
    this.name = "UnknownResearchProviderError";
    this.requestedProvider = requested;
    this.code = "UNKNOWN_RESEARCH_PROVIDER";
    this.registeredProviders = [...REGISTERED_PROVIDERS];
  }
}

/**
 * Fail-closed resolution of a REQUESTED provider name.
 *
 * Absent/empty means "not specified" and yields the deterministic mock default.
 * Anything else must be registered — there is no fallback branch at all.
 *
 * @param {string|undefined|null} requested
 * @returns {{ specified: boolean, provider: string, requestedProvider: string, defaulted: boolean }}
 * @throws {UnknownResearchProviderError} when an explicit name is not registered
 */
export function requireProviderName(requested) {
  const raw = requested === undefined || requested === null ? "" : String(requested).trim();
  if (raw.length === 0) {
    return {
      specified: false,
      provider: DEFAULT_RESEARCH_PROVIDER,
      requestedProvider: "",
      defaulted: true,
    };
  }
  const validation = validateProviderName(raw);
  if (!validation.recognized) throw new UnknownResearchProviderError(raw);
  return { specified: true, provider: validation.name, requestedProvider: validation.name, defaulted: false };
}

/**
 * Conservative defaults. An external provider is a shared/free resource: one
 * attempt, a bounded wall-clock timeout, and a small context budget.
 */
export const PROVIDER_DEFAULTS = Object.freeze({
  executable: "cline",
  timeoutMs: 180_000,
  probeTimeoutMs: 180_000,
  maxAttempts: 1,
  maxContextChars: 12_000,
  maxMemoryRecords: 24,
  maxCallsPerRun: 12,
  maxResponseChars: 200_000,
  // The raw NDJSON event stream is much larger than the answer when the model
  // is asked for high reasoning effort (reasoning content is streamed as
  // events). This bounds the STREAM; `maxResponseChars` bounds the ANSWER.
  maxStreamChars: 5_000_000,
  cacheEnabled: false,
});

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);

export function readBoolEnv(env, key, fallback) {
  const raw = env?.[key];
  if (raw === undefined || raw === null || raw === "") return fallback;
  const text = String(raw).trim().toLowerCase();
  if (TRUE_VALUES.has(text)) return true;
  if (FALSE_VALUES.has(text)) return false;
  return fallback;
}

export function readIntEnv(env, key, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = env?.[key];
  if (raw === undefined || raw === null || raw === "") return fallback;
  const parsed = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export function readStringEnv(env, key, fallback = "") {
  const raw = env?.[key];
  if (raw === undefined || raw === null) return fallback;
  const text = String(raw).trim();
  return text.length > 0 ? text : fallback;
}

/**
 * Validate a provider NAME. Never throws: callers decide how loud to be.
 *
 * @returns {{ ok: boolean, name: string, recognized: boolean, reason: string|null }}
 */
export function validateProviderName(name) {
  const normalized = String(name ?? "").trim().toLowerCase();
  if (normalized.length === 0) {
    return { ok: false, name: normalized, recognized: false, reason: "provider name is empty" };
  }
  if (REGISTERED_PROVIDERS.includes(normalized)) {
    return { ok: true, name: normalized, recognized: true, reason: null };
  }
  return {
    ok: false,
    name: normalized,
    recognized: false,
    reason: `unknown research provider '${normalized}' (registered: ${REGISTERED_PROVIDERS.join(", ")})`,
  };
}

/**
 * Resolve the whole provider configuration from an environment bag.
 *
 * Fail-closed: an EXPLICIT but unregistered provider name produces
 * `provider: null` plus a `configError` (and `unknownProvider` naming the typo).
 * Callers must refuse to run in that state — there is deliberately no fallback
 * value they could accidentally use. An ABSENT name yields the mock default.
 *
 * @param {Record<string, string|undefined>} [env]
 */
export function resolveProviderConfig(env = process.env) {
  const rawRequested = readStringEnv(env, "EVOLVE_RESEARCH_PROVIDER", "").toLowerCase();
  const validation = validateProviderName(rawRequested);
  const specified = rawRequested.length > 0;
  const configError = specified && !validation.recognized ? unknownProviderMessage(rawRequested) : null;
  const provider = !specified
    ? DEFAULT_RESEARCH_PROVIDER
    : validation.recognized
      ? validation.name
      : null;

  const executable = readStringEnv(env, "EVOLVE_RESEARCH_CLINE_BIN", PROVIDER_DEFAULTS.executable);
  const reasoningRaw = readStringEnv(env, "EVOLVE_RESEARCH_REASONING", DEEPSEEK_CLINE_REASONING).toLowerCase();

  return {
    provider,
    requestedProvider: rawRequested,
    specified,
    defaulted: !specified,
    recognized: !specified || validation.recognized,
    unknownProvider: configError ? rawRequested : null,
    configError,
    configValid: configError === null,
    model: readStringEnv(env, "EVOLVE_RESEARCH_MODEL", DEEPSEEK_CLINE_MODEL),
    reasoning: CLINE_REASONING_LEVELS.includes(reasoningRaw) ? reasoningRaw : DEEPSEEK_CLINE_REASONING,
    profile: readStringEnv(env, "EVOLVE_RESEARCH_CLINE_PROFILE", DEEPSEEK_CLINE_PROFILE),
    executable,
    executableIsScript: /\.(mjs|cjs|js)$/i.test(executable),
    timeoutMs: readIntEnv(env, "EVOLVE_RESEARCH_PROVIDER_TIMEOUT_MS", PROVIDER_DEFAULTS.timeoutMs, {
      min: 1_000,
      max: 3_600_000,
    }),
    maxAttempts: Math.max(
      1,
      readIntEnv(env, "EVOLVE_RESEARCH_PROVIDER_MAX_ATTEMPTS", PROVIDER_DEFAULTS.maxAttempts, { min: 1, max: 5 }),
    ),
    maxContextChars: readIntEnv(env, "EVOLVE_RESEARCH_MAX_CONTEXT_CHARS", PROVIDER_DEFAULTS.maxContextChars, {
      min: 512,
      max: 200_000,
    }),
    maxMemoryRecords: readIntEnv(env, "EVOLVE_RESEARCH_MAX_MEMORY_RECORDS", PROVIDER_DEFAULTS.maxMemoryRecords, {
      min: 0,
      max: 500,
    }),
    maxCallsPerRun: readIntEnv(env, "EVOLVE_RESEARCH_MAX_PROVIDER_CALLS", PROVIDER_DEFAULTS.maxCallsPerRun, {
      min: 1,
      max: 256,
    }),
    maxResponseChars: readIntEnv(env, "EVOLVE_RESEARCH_MAX_RESPONSE_CHARS", PROVIDER_DEFAULTS.maxResponseChars, {
      min: 1_000,
      max: 5_000_000,
    }),
    maxStreamChars: readIntEnv(env, "EVOLVE_RESEARCH_MAX_STREAM_CHARS", PROVIDER_DEFAULTS.maxStreamChars, {
      min: 10_000,
      max: 50_000_000,
    }),
    cacheEnabled: readBoolEnv(env, "EVOLVE_RESEARCH_PROVIDER_CACHE", PROVIDER_DEFAULTS.cacheEnabled),
    // Deliberately not configurable: a recognized external provider must never
    // be silently replaced by the deterministic mock inside an experiment.
    allowMockFallback: false,
    formatVersion: RESEARCH_PROVIDER_FORMAT_VERSION,
  };
}

/**
 * The model/reasoning identity a provider reports. The mock has none — it is not
 * a language model and must never pretend to be one.
 */
export function providerIdentity(config = {}) {
  if (config.provider === RESEARCH_PROVIDER.DEEPSEEK_CLINE) {
    return {
      provider: RESEARCH_PROVIDER.DEEPSEEK_CLINE,
      model: config.model ?? DEEPSEEK_CLINE_MODEL,
      reasoning: config.reasoning ?? DEEPSEEK_CLINE_REASONING,
      external: true,
    };
  }
  return { provider: RESEARCH_PROVIDER.MOCK, model: null, reasoning: null, external: false };
}
