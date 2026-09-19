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
 *   `typesafe-jev`           -> the real TypeSafe AI HTTP provider (DIRECT,
 *                              credential `EVOLVE_JEV_API_KEY`)
 *   `vercel-jev`             -> the Vercel AI Gateway route to the same model
 *                              (credential `AI_GATEWAY_API_KEY`, AI SDK
 *                              `experimental_evaluate`)
 *   anything else            -> throws `UnknownJevProviderError` — FAIL CLOSED,
 *                              no provider is constructed, no call is possible
 *
 * The two REAL routes are never interchangeable. There is no fallback from one
 * to the other (and none to the mock): each provider is resolved ONLY by its
 * own name and ONLY with its OWN credential. A missing credential yields a
 * `JEV_CONFIG_ERROR` provider that cannot make a call — it does NOT silently
 * switch routes.
 *
 * Credentials never leave this module as plain constructor arguments by
 * accident: when `EVOLVE_JEV_API_KEY` is not configured, `typesafe-jev`
 * resolves to a provider whose `evaluate()` returns `JEV_CONFIG_ERROR`
 * WITHOUT ever constructing the SDK client — this sidesteps the SDK's own
 * `TYPESAFE_API_KEY` environment fallback entirely, so an unrelated key
 * sitting in the shell environment can never silently authenticate a call
 * EVOLVE's own configuration did not authorize. The same fail-closed rule
 * applies to `AI_GATEWAY_API_KEY` for `vercel-jev`, which is checked BEFORE any
 * AI SDK/gateway client is touched.
 *
 * PAPER ONLY.
 */

import {
  JEV_PROVIDER,
  JEV_STATUS,
  UnknownJevProviderError,
  requireJevProviderName,
  resolveJevModelName,
} from "./config.mjs";
import { createMockJevProvider } from "./providers/mock-jev.mjs";
import { createTypeSafeJevProvider } from "./providers/typesafe-jev.mjs";
import { createVercelJevProvider } from "./providers/vercel-jev.mjs";
import { JEV_PROVIDER_HEALTH_DIR } from "./provider-health.mjs";
import { createResilientJevTransport, resolveJevTransportSettings } from "./transport.mjs";

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

/**
 * A provider that reports a configuration error on every call, without ever
 * touching the network. `name` is preserved so a failure is never attributed to
 * a DIFFERENT provider than the one that was requested.
 */
function createConfigErrorProvider(reason, name = null) {
  return {
    name,
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
 *   apiKey?: string,            // EVOLVE_JEV_API_KEY (typesafe-jev only)
 *   gatewayApiKey?: string,     // AI_GATEWAY_API_KEY (vercel-jev only)
 *   model?: string,
 *   baseURL?: string,
 *   timeoutMs?: number,
 *   fetchImpl?: Function|null,
 *   evaluateImpl?: Function|null, // test-only injection for the AI SDK evaluation call
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
        JEV_PROVIDER.TYPESAFE,
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

  if (resolution.provider === JEV_PROVIDER.VERCEL) {
    // Checked BEFORE the AI SDK / gateway is touched: a missing gateway
    // credential is a configuration error, never an attempted request (and
    // never a silent fall-through to another provider).
    if (!options.gatewayApiKey || String(options.gatewayApiKey).trim().length === 0) {
      return createConfigErrorProvider(
        "the Vercel AI Gateway credential (AI_GATEWAY_API_KEY) is not set; vercel-jev was requested but no gateway credential is configured",
        JEV_PROVIDER.VERCEL,
      );
    }
    return createVercelJevProvider({
      gatewayApiKey: options.gatewayApiKey,
      model: options.model,
      timeoutMs: options.timeoutMs,
      evaluateImpl: options.evaluateImpl ?? null,
    });
  }

  // Unreachable given `requireJevProviderName`'s contract, but keeps this
  // function fail-closed even if the registry grows without this switch
  // being updated.
  throw new UnknownJevProviderError(name);
}

/* ============================================================================
 * Phase 5F.1 — optional same-Jev transport chain
 * ==========================================================================*/

function hasCredential(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Resolve an OPTIONAL high-availability chain of SAME-JEV routes.
 *
 * The selected provider is always first and is resolved with EXACTLY the
 * existing fail-closed rules (a missing credential is a `JEV_CONFIG_ERROR`
 * provider, never a silent substitution). Additional chain entries
 * (`EVOLVE_JEV_TRANSPORT_CHAIN=vercel-jev,typesafe-jev`) are honoured ONLY when
 * that route's OWN real credential exists:
 *
 *   * `vercel-jev`   requires `AI_GATEWAY_API_KEY`
 *   * `typesafe-jev` requires `EVOLVE_JEV_API_KEY`
 *
 * A route without its own credential is SKIPPED, never borrowed: the gateway key
 * is never sent to `api.typesafe.ai`, and the direct TypeSafe key is never sent
 * to the AI Gateway. There is no mock entry, and no non-Jev model can ever be
 * added — the chain vocabulary is `vercel-jev` / `typesafe-jev` only.
 *
 * @returns {{
 *   providers: object[],                 // ordered, credential-filtered
 *   primary: object,
 *   chainNames: string[],
 *   requestedChain: string[],
 *   skipped: Array<{ provider: string, reason: string }>,
 * }}
 */
export function resolveJevProviderChain({
  selectedProvider = "",
  chain = [],
  config = {},
  modelOverride = null,
  timeoutMs = undefined,
  fetchImpl = null,
  evaluateImpl = null,
} = {}) {
  const primary = requireJevProviderName(selectedProvider);

  if (primary.provider === null) {
    return {
      providers: [createDisabledJevProvider()],
      primary: null,
      chainNames: [],
      requestedChain: [],
      skipped: [],
    };
  }

  const primaryProvider = resolveJevProvider(primary.provider, {
    apiKey: config.apiKey,
    gatewayApiKey: config.gatewayApiKey,
    model: resolveJevModelName(config, { provider: primary.provider, override: modelOverride }),
    baseURL: config.baseURL,
    timeoutMs,
    fetchImpl,
    evaluateImpl,
  });

  const requestedChain = (Array.isArray(chain) ? chain : [])
    .map((name) => String(name ?? "").trim().toLowerCase())
    .filter((name) => name.length > 0);

  const providers = [primaryProvider];
  const chainNames = [primary.provider];
  const skipped = [];

  for (const name of requestedChain) {
    if (name === primary.provider) continue;
    if (chainNames.includes(name)) continue;

    if (name === JEV_PROVIDER.TYPESAFE) {
      if (!hasCredential(config.apiKey)) {
        skipped.push({
          provider: name,
          reason: "EVOLVE_JEV_API_KEY is not configured; the direct TypeSafe route was NOT attempted",
        });
        continue;
      }
      providers.push(
        createTypeSafeJevProvider({
          // ONLY the direct route's OWN credential is ever handed to it.
          apiKey: config.apiKey,
          model: resolveJevModelName(config, { provider: name, override: null }),
          baseURL: config.baseURL,
          timeoutMs,
          fetchImpl,
        }),
      );
      chainNames.push(name);
      continue;
    }

    if (name === JEV_PROVIDER.VERCEL) {
      if (!hasCredential(config.gatewayApiKey)) {
        skipped.push({
          provider: name,
          reason: "AI_GATEWAY_API_KEY is not configured; the Vercel AI Gateway route was NOT attempted",
        });
        continue;
      }
      providers.push(
        createVercelJevProvider({
          // ONLY the gateway route's OWN credential is ever handed to it.
          gatewayApiKey: config.gatewayApiKey,
          model: resolveJevModelName(config, { provider: name, override: null }),
          timeoutMs,
          evaluateImpl,
        }),
      );
      chainNames.push(name);
      continue;
    }

    // Unreachable: `parseJevTransportChain` only ever yields same-Jev routes.
    skipped.push({ provider: name, reason: `'${name}' is not a registered same-Jev route` });
  }

  return { providers, primary: primaryProvider, chainNames, requestedChain, skipped };
}

/**
 * Resolve the selected provider (plus any credential-satisfied same-Jev chain
 * entries) and wrap it in EVOLVE's bounded transport resilience policy.
 *
 * The offline mock and any fail-closed `JEV_CONFIG_ERROR`/disabled provider are
 * returned UNWRAPPED: there is no network to protect, no retry could help, and
 * no transient cooldown semantics apply. Their behaviour is byte-for-byte the
 * Phase 5D/5F.0 behaviour.
 *
 * @returns {{ provider: object, wrapped: boolean, chain: object, settings: object }}
 */
export function createResilientJevProvider({
  selectedProvider = "",
  config = {},
  modelOverride = null,
  timeoutMs = undefined,
  healthRoot = undefined,
  overrideCooldown = false,
  fetchImpl = null,
  evaluateImpl = null,
  sleepImpl = undefined,
  randomImpl = undefined,
  now = undefined,
} = {}) {
  const chain = resolveJevProviderChain({ selectedProvider, chain: config.transportChain, config, modelOverride, timeoutMs, fetchImpl, evaluateImpl });
  const primary = chain.providers[0] ?? null;
  const settings = resolveJevTransportSettings(config);

  const external = primary !== null && primary.disabled !== true && primary.external === true;
  if (!external) {
    return { provider: primary, wrapped: false, chain, settings };
  }

  const root = healthRoot ?? (String(process.env.EVOLVE_JEV_HEALTH_DIR ?? "").trim() || JEV_PROVIDER_HEALTH_DIR);
  const provider = createResilientJevTransport({
    providers: chain.providers,
    settings,
    healthRoot: root,
    overrideCooldown: overrideCooldown === true,
    ...(typeof sleepImpl === "function" ? { sleepImpl } : {}),
    ...(typeof randomImpl === "function" ? { randomImpl } : {}),
    ...(typeof now === "function" ? { now } : {}),
  });
  provider.credentialsSkipped = chain.skipped;
  return { provider, wrapped: true, chain, settings, healthRoot: root };
}
