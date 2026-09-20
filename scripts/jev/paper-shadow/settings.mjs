/**
 * Jev paper-shadow run settings + FAIL-CLOSED provider enforcement.
 *
 * The provider/model/transport requirement is enforced here, before a single
 * observation is taken or a provider is constructed:
 *
 *   provider = `typesafe-jev` (direct TypeSafe only)
 *   upstream = `typesafe-ai`
 *   model    = `jev-1.13.0` (the pinned version, never a moving alias)
 *   gatewayUsed = false
 *   cache    = disabled
 *
 * There is NO fallback: `mock-jev`, `vercel-jev`, a failover transport chain, a
 * cached answer, and any other model are all refused outright, and a missing
 * direct-TypeSafe credential refuses to start.
 *
 * PAPER ONLY / DEVELOPMENT DASHBOARD EXPERIMENT.
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
  PAPER_SHADOW_CADENCE_BOUNDS,
  PAPER_SHADOW_DEFAULT_CADENCE_MS,
  PAPER_SHADOW_DEFAULT_DURATION_MINUTES,
  PAPER_SHADOW_DURATION_BOUNDS,
  PAPER_SHADOW_FORBIDDEN_PROVIDERS,
  PAPER_SHADOW_INTENT_THRESHOLD,
  PAPER_SHADOW_MARKET_ID,
  PAPER_SHADOW_MODE,
  PAPER_SHADOW_POSITION_FRACTION,
  PAPER_SHADOW_REQUIRED_MODEL,
  PAPER_SHADOW_STARTING_CASH,
  PAPER_SHADOW_SUPPORTED_MARKET_IDS,
  isValidPaperShadowSessionId,
} from "./definition.mjs";

export const PAPER_SHADOW_SETTINGS_VERSION = 1;

function readInt(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** Build settings from parsed CLI args. Values are clamped into documented bounds. */
export function buildPaperShadowSettings(args = {}) {
  const problems = [];

  const marketId = args.market !== undefined ? String(args.market).trim().toUpperCase() : PAPER_SHADOW_MARKET_ID;
  if (!PAPER_SHADOW_SUPPORTED_MARKET_IDS.includes(marketId)) {
    problems.push(
      `unsupported market '${marketId}'; the paper-shadow experiment observes exactly: ${PAPER_SHADOW_SUPPORTED_MARKET_IDS.join(", ")}`,
    );
  }

  const durationMinutes = clamp(
    readInt(args.minutes, PAPER_SHADOW_DEFAULT_DURATION_MINUTES),
    PAPER_SHADOW_DURATION_BOUNDS.min,
    PAPER_SHADOW_DURATION_BOUNDS.max,
  );
  const cadenceMs = clamp(
    readInt(args["cadence-ms"], PAPER_SHADOW_DEFAULT_CADENCE_MS),
    PAPER_SHADOW_CADENCE_BOUNDS.min,
    PAPER_SHADOW_CADENCE_BOUNDS.max,
  );

  const requestedSessionId = args.session !== undefined ? String(args.session).trim() : "";
  if (requestedSessionId.length > 0 && !isValidPaperShadowSessionId(requestedSessionId)) {
    problems.push(`invalid --session '${requestedSessionId}'; session ids look like 'jpaper-<UTC timestamp>-<digest>'`);
  }

  return {
    version: PAPER_SHADOW_SETTINGS_VERSION,
    marketId,
    durationMinutes,
    durationMs: durationMinutes * 60_000,
    cadenceMs,
    startingCash: PAPER_SHADOW_STARTING_CASH,
    positionFraction: PAPER_SHADOW_POSITION_FRACTION,
    intentThreshold: PAPER_SHADOW_INTENT_THRESHOLD,
    sessionId: requestedSessionId.length > 0 ? requestedSessionId : null,
    baseRoot: args.out !== undefined && String(args.out).trim() !== "" ? String(args.out).trim() : null,
    problems,
  };
}

/**
 * FAIL-CLOSED enforcement of the direct-TypeSafe pins against the resolved Jev
 * environment configuration. Never throws, never falls back.
 *
 * @returns {{ ok: boolean, problems: string[], provider: string|null, model: string|null, identity: object|null, envConfig: object }}
 */
export function enforcePaperShadowProviderPins({ envConfig, modelOverride = null } = {}) {
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
      `Jev is disabled (EVOLVE_JEV_PROVIDER is not set). This experiment requires direct ${REQUIRED_PROVIDER}.`,
    );
    return { ok: false, problems, provider: null, model: null, identity: null, envConfig };
  }

  if (resolution.provider !== JEV_PROVIDER.TYPESAFE) {
    problems.push(
      `provider '${resolution.provider}' is refused: the paper-shadow experiment requires direct ${REQUIRED_PROVIDER} ` +
        `with gatewayUsed=false. Forbidden routes: ${PAPER_SHADOW_FORBIDDEN_PROVIDERS.join(", ")}.`,
    );
  }

  if (envConfig?.configError) {
    problems.push(`Jev configuration error: ${envConfig.configError}`);
  }
  if (envConfig?.modeValid !== true || envConfig?.mode !== PAPER_SHADOW_MODE) {
    problems.push(`Jev mode must be '${PAPER_SHADOW_MODE}'`);
  }

  // ---- transport chain: direct route only, and only as a single entry -------
  const chain = Array.isArray(envConfig?.transportChain) ? envConfig.transportChain : [];
  if (envConfig?.transportChainError) {
    problems.push(`EVOLVE_JEV_TRANSPORT_CHAIN is invalid: ${envConfig.transportChainError}`);
  } else if (chain.length > 1) {
    problems.push(
      `EVOLVE_JEV_TRANSPORT_CHAIN names ${chain.length} routes (${chain.join(", ")}): a failover chain could answer ` +
        "through the Vercel AI Gateway, which is never allowed for this experiment.",
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
      problems.push(`model alias '${model}' is a moving alias; pin '${PAPER_SHADOW_REQUIRED_MODEL}'`);
    }
    if (model !== PAPER_SHADOW_REQUIRED_MODEL) {
      problems.push(`model '${model}' is refused: this experiment pins '${PAPER_SHADOW_REQUIRED_MODEL}'`);
    }
    if (envConfig?.credentialConfigured !== true) {
      problems.push("the direct TypeSafe credential (EVOLVE_JEV_API_KEY) is not configured; refusing to start");
    }
  }

  const identity =
    resolution.provider === null
      ? null
      : jevIdentity({ ...(envConfig ?? {}), provider: resolution.provider, mode: PAPER_SHADOW_MODE });

  if (identity !== null) {
    if (identity.gatewayUsed !== false) problems.push("provider identity reports gatewayUsed=true; the gateway is refused");
    if (identity.upstreamProvider !== REQUIRED_UPSTREAM_PROVIDER) {
      problems.push(`provider identity reports upstream '${identity.upstreamProvider}'; expected '${REQUIRED_UPSTREAM_PROVIDER}'`);
    }
    if (identity.model !== PAPER_SHADOW_REQUIRED_MODEL && resolution.provider === JEV_PROVIDER.TYPESAFE) {
      problems.push(`provider identity reports model '${identity.model}'; expected '${PAPER_SHADOW_REQUIRED_MODEL}'`);
    }
  }

  return {
    ok: problems.length === 0,
    problems,
    provider: resolution.provider,
    model,
    identity,
    envConfig,
  };
}
