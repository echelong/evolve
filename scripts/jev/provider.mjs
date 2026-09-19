/**
 * Jev provider registry (Phase 5D) — fail-closed resolution by NAME only.
 *
 * A DEDICATED, SEPARATE registry from `scripts/research/provider.mjs`. Jev is
 * not a research proposal provider; nothing here is reachable through
 * `EVOLVE_RESEARCH_PROVIDER`, and nothing in `scripts/research/` is reachable
 * through `EVOLVE_JEV_PROVIDER`.
 *
 *   name unset/empty        -> the DISABLED provider (default; `JEV_DISABLED` /
 *                              `NO_JEV_DECISION` for every call; zero network
 *                              calls are ever possible)
 *   `mock-jev`               -> the deterministic offline mock
 *   `typesafe-jev`           -> the real TypeSafe AI HTTP provider
 *   anything else            -> throws `UnknownJevProviderError` — FAIL CLOSED,
 *                              no provider is constructed, no call is possible
 *
 * The API key never leaves this module as a plain constructor argument by
 * accident: when `EVOLVE_JEV_API_KEY` is not configured, `typesafe-jev`
 * resolves to a provider whose `evaluate()` returns `JEV_CONFIG_ERROR`
 * WITHOUT ever constructing the SDK client — this sidesteps the SDK's own
 * `TYPESAFE_API_KEY` environment fallback entirely, so an unrelated key
 * sitting in the shell environment can never silently authenticate a call
 * EVOLVE's own configuration did not authorize.
 *
 * PAPER ONLY.
 */

import { JEV_PROVIDER, JEV_STATUS, UnknownJevProviderError, requireJevProviderName } from "./config.mjs";
import { createMockJevProvider } from "./providers/mock-jev.mjs";
import { createTypeSafeJevProvider } from "./providers/typesafe-jev.mjs";

export { UnknownJevProviderError } from "./config.mjs";

/** A provider that never calls anything: every evaluation is `JEV_DISABLED`. */
export function createDisabledJevProvider() {
  return {
    name: null,
    model: null,
    offline: true,
    external: false,
    disabled: true,
    syntheticDecision: false,
    async evaluate() {
      return { ok: false, status: JEV_STATUS.DISABLED, reason: "Jev is disabled (EVOLVE_JEV_PROVIDER is not set)" };
    },
  };
}

/** A provider that reports a configuration error on every call, without ever touching the network. */
function createConfigErrorProvider(reason) {
  return {
    name: JEV_PROVIDER.TYPESAFE,
    model: null,
    offline: true,
    external: false,
    disabled: true,
    syntheticDecision: false,
    async evaluate() {
      return { ok: false, status: JEV_STATUS.CONFIG_ERROR, reason };
    },
  };
}

/**
 * Resolve a Jev provider by NAME.
 *
 * @param {string} name
 * @param {{
 *   provider?: object,          // test injection; still validated by NAME
 *   apiKey?: string,
 *   model?: string,
 *   baseURL?: string,
 *   timeoutMs?: number,
 *   fetchImpl?: Function|null,
 * }} [options]
 * @returns {{ name: string|null, evaluate: Function, offline: boolean, [key: string]: unknown }}
 * @throws {UnknownJevProviderError}
 */
export function resolveJevProvider(name = "", options = {}) {
  if (options?.provider && typeof options.provider.evaluate === "function") {
    const requested = String(name ?? "").trim();
    if (requested.length > 0) requireJevProviderName(requested); // still fail-closed on a typo
    return options.provider;
  }

  const resolution = requireJevProviderName(name);

  if (resolution.provider === null) {
    // Unset/empty — the supported default, not an error.
    return createDisabledJevProvider();
  }

  if (resolution.provider === JEV_PROVIDER.MOCK) {
    return createMockJevProvider();
  }

  if (resolution.provider === JEV_PROVIDER.TYPESAFE) {
    if (!options.apiKey || String(options.apiKey).trim().length === 0) {
      return createConfigErrorProvider(
        "EVOLVE_JEV_API_KEY is not set; typesafe-jev was requested but no key is configured",
      );
    }
    return createTypeSafeJevProvider({
      apiKey: options.apiKey,
      model: options.model,
      baseURL: options.baseURL,
      timeoutMs: options.timeoutMs,
      fetchImpl: options.fetchImpl ?? null,
    });
  }

  // Unreachable given `requireJevProviderName`'s contract, but keeps this
  // function fail-closed even if the registry grows without this switch
  // being updated.
  throw new UnknownJevProviderError(name);
}
