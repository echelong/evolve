/**
 * Phase 5I-PS.2 — supervisor run settings + FAIL-CLOSED provider enforcement.
 *
 * The provider/model/transport requirement is enforced BEFORE a single
 * observation is taken or a provider is constructed:
 *
 *   provider     = `typesafe-jev` (direct TypeSafe only)
 *   upstream     = `typesafe-ai`
 *   model        = `jev-1.13.0` (the pinned version, never a moving alias)
 *   gatewayUsed  = false
 *   mode         = shadow
 *   cache        = disabled
 *
 * There is NO fallback: `mock-jev`, `vercel-jev`, the Vercel AI Gateway, a
 * failover transport chain, a cached answer, and any other model are all
 * refused outright, and a missing direct-TypeSafe credential refuses to start.
 *
 * PAPER ONLY / DEVELOPMENT EVIDENCE ONLY.
 */

import {
  FORBIDDEN_MODEL_ALIASES,
  REQUIRED_PROVIDER,
  REQUIRED_UPSTREAM_PROVIDER,
} from "../direction/definition.mjs";
import {
  JEV_PROVIDER,
  jevIdentity,
  requireJevProviderName,
  resolveJevModelName,
} from "../config.mjs";
import {
  SUPERVISOR_BOOLEAN_FLAGS,
  SUPERVISOR_CACHE_ENABLED,
  SUPERVISOR_DEFAULT_DURATION_MINUTES,
  SUPERVISOR_DURATION_BOUNDS,
  SUPERVISOR_FORBIDDEN_FLAGS,
  SUPERVISOR_FORBIDDEN_PROVIDERS,
  SUPERVISOR_MARKET_ID,
  SUPERVISOR_MODE,
  SUPERVISOR_REQUIRED_MODEL,
  SUPERVISOR_SUPPORTED_MARKET_IDS,
  SUPERVISOR_VALUE_FLAGS,
  isValidSupervisorSessionId,
} from "./definition.mjs";
import { PS2D_CLI_PROFILES } from "./cross-asset-protocol.mjs";

export const SUPERVISOR_SETTINGS_VERSION = 1;

function readInt(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Build settings from parsed CLI args. Values are clamped into documented
 * bounds, and every option this phase deliberately does NOT have is a hard
 * error rather than a silently ignored flag.
 */
export function buildSupervisorSettings(args = {}) {
  const problems = [];

  const known = new Set([...SUPERVISOR_BOOLEAN_FLAGS, ...SUPERVISOR_VALUE_FLAGS]);
  for (const key of Object.keys(args)) {
    if (key === "_") continue;
    if (SUPERVISOR_FORBIDDEN_FLAGS.includes(key)) {
      problems.push(
        `--${key} is not a supervisor observer option: this subsystem observes completed decisions and has NO trading, ` +
          "sizing, threshold, routing or PnL surface",
      );
      continue;
    }
    if (!known.has(key)) problems.push(`unknown option '--${key}'`);
  }

  const positionals = Array.isArray(args._) ? args._.filter((entry) => String(entry).trim().length > 0) : [];
  if (positionals.length > 0) problems.push(`unexpected positional argument(s): ${positionals.join(" ")}`);

  const marketId =
    args.market !== undefined ? String(args.market).trim().toUpperCase() : SUPERVISOR_MARKET_ID;
  if (!SUPERVISOR_SUPPORTED_MARKET_IDS.includes(marketId)) {
    problems.push(
      `unsupported market '${marketId}'; the supervisor observer observes exactly: ${SUPERVISOR_SUPPORTED_MARKET_IDS.join(", ")}`,
    );
  }

  const durationMinutes = clamp(
    readInt(args.minutes, SUPERVISOR_DEFAULT_DURATION_MINUTES),
    SUPERVISOR_DURATION_BOUNDS.min,
    SUPERVISOR_DURATION_BOUNDS.max,
  );

  const requestedSessionId = args.session !== undefined ? String(args.session).trim() : "";
  if (requestedSessionId.length > 0 && !isValidSupervisorSessionId(requestedSessionId)) {
    problems.push(`invalid --session '${requestedSessionId}'; session ids look like 'jsup-<UTC timestamp>-<digest>'`);
  }

  // PS.2d: a frozen profile NAME only. Absent = disabled (pre-PS.2d behaviour).
  let crossAssetProfile = null;
  if (args["cross-asset"] !== undefined) {
    const requested = String(args["cross-asset"]).trim().toLowerCase();
    if (PS2D_CLI_PROFILES.includes(requested)) crossAssetProfile = requested;
    else {
      problems.push(
        `invalid --cross-asset '${requested}'; the frozen PS.2d profiles are: ${PS2D_CLI_PROFILES.join(", ")}`,
      );
    }
  }

  return {
    version: SUPERVISOR_SETTINGS_VERSION,
    marketId,
    durationMinutes,
    durationMs: durationMinutes * 60_000,
    sessionId: requestedSessionId.length > 0 ? requestedSessionId : null,
    crossAssetProfile,
    problems,
  };
}

/**
 * FAIL-CLOSED enforcement of the direct-TypeSafe pins against the resolved Jev
 * environment configuration. Never throws, never falls back.
 *
 * @returns {{ ok: boolean, problems: string[], provider: string|null, model: string|null, identity: object|null, envConfig: object }}
 */
export function enforceSupervisorProviderPins({ envConfig, modelOverride = null } = {}) {
  const problems = [];

  let resolution = null;
  try {
    resolution = requireJevProviderName(envConfig?.requestedProvider ?? "");
  } catch (error) {
    problems.push(`${error.message}; providers are resolved by name only and there is no fallback`);
    return { ok: false, problems, provider: null, model: null, identity: null, envConfig };
  }

  if (resolution.provider === null) {
    problems.push(
      `Jev is disabled (EVOLVE_JEV_PROVIDER is not set). The supervisor observer requires direct ${REQUIRED_PROVIDER}.`,
    );
    return { ok: false, problems, provider: null, model: null, identity: null, envConfig };
  }

  if (resolution.provider !== JEV_PROVIDER.TYPESAFE) {
    problems.push(
      `provider '${resolution.provider}' is refused: the supervisor observer requires direct ${REQUIRED_PROVIDER} ` +
        `with gatewayUsed=false. Forbidden routes: ${SUPERVISOR_FORBIDDEN_PROVIDERS.join(", ")}.`,
    );
  }

  if (envConfig?.configError) problems.push(`Jev configuration error: ${envConfig.configError}`);
  if (envConfig?.modeValid !== true || envConfig?.mode !== SUPERVISOR_MODE) {
    problems.push(`Jev mode must be '${SUPERVISOR_MODE}'`);
  }

  // ---- transport chain: direct route only, and only as a single entry ------
  const chain = Array.isArray(envConfig?.transportChain) ? envConfig.transportChain : [];
  if (envConfig?.transportChainError) {
    problems.push(`EVOLVE_JEV_TRANSPORT_CHAIN is invalid: ${envConfig.transportChainError}`);
  } else if (chain.length > 1) {
    problems.push(
      `EVOLVE_JEV_TRANSPORT_CHAIN names ${chain.length} routes (${chain.join(", ")}): a failover chain could answer ` +
        "through the Vercel AI Gateway, which is never allowed for the supervisor observer.",
    );
  } else if (chain.length === 1 && chain[0] !== REQUIRED_PROVIDER) {
    problems.push(`EVOLVE_JEV_TRANSPORT_CHAIN names '${chain[0]}'; only direct '${REQUIRED_PROVIDER}' is allowed.`);
  }

  const model =
    resolution.provider === JEV_PROVIDER.TYPESAFE
      ? resolveJevModelName(envConfig ?? {}, { provider: resolution.provider, override: modelOverride || null })
      : null;

  if (resolution.provider === JEV_PROVIDER.TYPESAFE) {
    if (FORBIDDEN_MODEL_ALIASES.includes(String(model))) {
      problems.push(`model alias '${model}' is a moving alias; pin '${SUPERVISOR_REQUIRED_MODEL}'`);
    }
    if (model !== SUPERVISOR_REQUIRED_MODEL) {
      problems.push(`model '${model}' is refused: the supervisor observer pins '${SUPERVISOR_REQUIRED_MODEL}'`);
    }
    if (envConfig?.credentialConfigured !== true) {
      problems.push("the direct TypeSafe credential (EVOLVE_JEV_API_KEY) is not configured; refusing to start");
    }
  }

  const identity =
    resolution.provider === null
      ? null
      : jevIdentity({ ...(envConfig ?? {}), provider: resolution.provider, mode: SUPERVISOR_MODE });

  if (identity !== null) {
    if (identity.gatewayUsed !== false) problems.push("provider identity reports gatewayUsed=true; the gateway is refused");
    if (identity.upstreamProvider !== REQUIRED_UPSTREAM_PROVIDER) {
      problems.push(`provider identity reports upstream '${identity.upstreamProvider}'; expected '${REQUIRED_UPSTREAM_PROVIDER}'`);
    }
    if (identity.model !== SUPERVISOR_REQUIRED_MODEL && resolution.provider === JEV_PROVIDER.TYPESAFE) {
      problems.push(`provider identity reports model '${identity.model}'; expected '${SUPERVISOR_REQUIRED_MODEL}'`);
    }
  }

  return {
    ok: problems.length === 0,
    problems,
    provider: resolution.provider,
    model,
    identity,
    envConfig,
    cacheEnabled: SUPERVISOR_CACHE_ENABLED,
  };
}
