/**
 * Phase 5I.0b — run settings + enforcement.
 *
 * Everything an experiment pins is resolved HERE, before a single observation is
 * taken, and validated fail-closed:
 *
 *   - the one supported market (SOL-USDC);
 *   - the frozen 30-second horizon (changing it requires a new phase, not a flag);
 *   - a bounded cadence, observation count, resolution tolerance and runtime;
 *   - provider = `typesafe-jev` (direct, no gateway), model = `jev-1.13.0`;
 *   - NO failover transport chain: a chain exists to substitute a route, and the
 *     only other same-Jev route is the Vercel AI Gateway. A chain is therefore
 *     accepted ONLY when it names `typesafe-jev` exactly once — which is the
 *     operator's intended single-route configuration and cannot substitute
 *     anything.
 *
 * The offline mock is reachable only with an explicit `--allow-mock`, and such a
 * run still records `provider: "mock-jev"` honestly on every artifact.
 *
 * PAPER ONLY / DEVELOPMENT EVIDENCE ONLY.
 */

import {
  CADENCE_SECONDS_BOUNDS,
  DEFAULT_CADENCE_SECONDS,
  DEFAULT_MAX_OBSERVATIONS,
  DEFAULT_MAX_RUNTIME_MINUTES,
  DIRECTION_PHASE,
  FORBIDDEN_MODEL_ALIASES,
  HORIZON_SECONDS,
  MAX_OBSERVATIONS_BOUNDS,
  MAX_RUNTIME_MINUTES_BOUNDS,
  MOCK_PROVIDER,
  OFFLINE_FIXTURE_IMPLEMENTATION,
  REQUIRED_GATEWAY_USED,
  REQUIRED_MODEL,
  REQUIRED_PROVIDER,
  REQUIRED_UPSTREAM_PROVIDER,
  RESOLUTION_TOLERANCE_BOUNDS,
  RESOLUTION_TOLERANCE_MS,
  SUPPORTED_MARKET_IDS,
  BENCHMARK_MARKET,
} from "./definition.mjs";
import { jevIdentity, requireJevProviderName, resolveJevModelName } from "../config.mjs";

export const DIRECTION_SETTINGS_VERSION = 1;

function readInt(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function fail(problems, message) {
  problems.push(message);
  return problems;
}

/**
 * Build the mutable run settings from parsed CLI arguments.
 * Values are CLAMPED into their documented bounds; the horizon is not a value at
 * all — it is the phase constant, and an explicit different value is an error.
 */
export function buildDirectionRunSettings(args = {}) {
  const problems = [];
  const marketId = args.market !== undefined ? String(args.market).trim().toUpperCase() : BENCHMARK_MARKET.marketId;
  if (!SUPPORTED_MARKET_IDS.includes(marketId)) {
    fail(problems, `unsupported market '${marketId}'; Phase ${DIRECTION_PHASE} benchmarks exactly: ${SUPPORTED_MARKET_IDS.join(", ")}`);
  }

  if (args["horizon-seconds"] !== undefined && readInt(args["horizon-seconds"], null) !== HORIZON_SECONDS) {
    fail(
      problems,
      `the ${HORIZON_SECONDS}-second horizon is FROZEN for Phase ${DIRECTION_PHASE}; there is no horizon optimization ` +
        `(got --horizon-seconds ${String(args["horizon-seconds"])})`,
    );
  }

  const cadenceSeconds = clamp(
    readInt(args["cadence-seconds"], DEFAULT_CADENCE_SECONDS),
    CADENCE_SECONDS_BOUNDS.min,
    CADENCE_SECONDS_BOUNDS.max,
  );
  const maxObservations = clamp(
    readInt(args["max-observations"], DEFAULT_MAX_OBSERVATIONS),
    MAX_OBSERVATIONS_BOUNDS.min,
    MAX_OBSERVATIONS_BOUNDS.max,
  );
  const maxRuntimeMinutes = clamp(
    readInt(args["max-runtime-minutes"], DEFAULT_MAX_RUNTIME_MINUTES),
    MAX_RUNTIME_MINUTES_BOUNDS.min,
    MAX_RUNTIME_MINUTES_BOUNDS.max,
  );
  const toleranceMs = clamp(
    readInt(args["tolerance-ms"], RESOLUTION_TOLERANCE_MS),
    RESOLUTION_TOLERANCE_BOUNDS.min,
    RESOLUTION_TOLERANCE_BOUNDS.max,
  );

  return {
    version: DIRECTION_SETTINGS_VERSION,
    phase: DIRECTION_PHASE,
    marketId,
    market: BENCHMARK_MARKET,
    horizonSeconds: HORIZON_SECONDS,
    horizonMs: HORIZON_SECONDS * 1_000,
    cadenceMs: cadenceSeconds * 1_000,
    cadenceSeconds,
    maxObservations,
    maxRuntimeMinutes,
    maxRuntimeMs: maxRuntimeMinutes * 60_000,
    resolutionToleranceMs: toleranceMs,
    providerRequested: args.provider !== undefined ? String(args.provider).trim().toLowerCase() : "",
    allowMock: args["allow-mock"] === true,
    allowUnsafeModel: args["allow-unsafe-model"] === true,
    modelOverride: args.model !== undefined ? String(args.model).trim() : "",
    timeoutMs: readInt(args["timeout-ms"], null),
    baseRoot: args.out !== undefined ? String(args.out).trim() : null,
    problems,
  };
}

/**
 * Fail-closed enforcement of provider/model/transport pins against the resolved
 * Jev environment configuration. Returns `{ ok, problems, resolution, model,
 * identity }` — never throws, never falls back.
 */
export function enforceDirectionProviderPins({ settings, envConfig }) {
  const problems = [];

  let resolution = null;
  try {
    resolution = requireJevProviderName(settings.providerRequested || envConfig?.requestedProvider || "");
  } catch (error) {
    fail(problems, `${error.message}; registered providers are resolved by name only, and there is no fallback`);
    return { ok: false, problems, resolution: null, model: null, identity: null };
  }

  if (resolution.provider === null) {
    fail(
      problems,
      `Jev is disabled (no --provider and EVOLVE_JEV_PROVIDER is not set). Phase ${DIRECTION_PHASE} requires ` +
        `${REQUIRED_PROVIDER} (direct TypeSafe only).`,
    );
    return { ok: false, problems, resolution, model: null, identity: null };
  }

  if (resolution.provider !== REQUIRED_PROVIDER && !(settings.allowMock === true && resolution.provider === MOCK_PROVIDER)) {
    fail(
      problems,
      `provider '${resolution.provider}' is refused for Phase ${DIRECTION_PHASE}: canonical direction evidence requires ` +
        `${REQUIRED_PROVIDER} with gatewayUsed=false. '${MOCK_PROVIDER}' is accepted only with an explicit --allow-mock ` +
        "offline run.",
    );
  }

  // ---- transport chain: only the DIRECT route, and only as a single entry ---
  // A chain exists to FAIL OVER, and the only other same-Jev route is the Vercel
  // AI Gateway. Canonical 5I evidence may therefore never be produced through a
  // chain that could substitute a gateway answer, so a chain is accepted ONLY
  // when it names `typesafe-jev` exactly once.
  if (resolution.provider !== MOCK_PROVIDER) {
    const chain = Array.isArray(envConfig?.transportChain) ? envConfig.transportChain : [];
    if (envConfig?.transportChainError) {
      fail(problems, `EVOLVE_JEV_TRANSPORT_CHAIN is invalid: ${envConfig.transportChainError}`);
    } else if (chain.length > 1) {
      fail(
        problems,
        `EVOLVE_JEV_TRANSPORT_CHAIN names ${chain.length} routes (${chain.join(", ")}): a failover chain could answer ` +
          "through the Vercel AI Gateway, which is never allowed for canonical 5I evidence.",
      );
    } else if (chain.length === 1 && chain[0] !== REQUIRED_PROVIDER) {
      fail(
        problems,
        `EVOLVE_JEV_TRANSPORT_CHAIN names '${chain[0]}'; canonical 5I evidence may only ever use the direct route ` +
          `'${REQUIRED_PROVIDER}'.`,
      );
    }
  }

  const model =
    resolution.provider === MOCK_PROVIDER
      ? OFFLINE_FIXTURE_IMPLEMENTATION
      : resolveJevModelName(envConfig ?? {}, { provider: resolution.provider, override: settings.modelOverride || null });

  if (resolution.provider !== MOCK_PROVIDER) {
    if (FORBIDDEN_MODEL_ALIASES.includes(String(model))) {
      fail(
        problems,
        `model alias '${model}' is a MOVING alias and may never be pinned as canonical 5I evidence; pin '${REQUIRED_MODEL}'`,
      );
    }
    if (model !== REQUIRED_MODEL && settings.allowUnsafeModel !== true) {
      fail(
        problems,
        `model '${model}' is refused: Phase ${DIRECTION_PHASE} pins '${REQUIRED_MODEL}' (pass --allow-unsafe-model only for ` +
          "a deliberately separate, non-canonical experiment).",
      );
    }
    if (envConfig?.credentialConfigured !== true) {
      fail(problems, "the direct TypeSafe credential (EVOLVE_JEV_API_KEY) is not configured; refusing to start");
    }
  }

  const identity = jevIdentity({ ...(envConfig ?? {}), provider: resolution.provider, mode: "shadow" });
  if (resolution.provider !== MOCK_PROVIDER && identity.gatewayUsed !== REQUIRED_GATEWAY_USED) {
    fail(problems, `provider identity reports gatewayUsed=${identity.gatewayUsed}; expected ${REQUIRED_GATEWAY_USED}`);
  }
  if (identity.upstreamProvider !== REQUIRED_UPSTREAM_PROVIDER && resolution.provider !== MOCK_PROVIDER) {
    fail(problems, `provider identity reports upstream '${identity.upstreamProvider}'; expected '${REQUIRED_UPSTREAM_PROVIDER}'`);
  }

  return { ok: problems.length === 0, problems, resolution, model, identity };
}

/** All problems from every stage, as one list. */
export function collectDirectionSettingsProblems(settings, pinResult) {
  return [...(settings?.problems ?? []), ...(pinResult?.problems ?? [])];
}
