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
  CURRENT_OUTCOME_RESOLUTION_POLICY_VERSION,
  DEFAULT_CADENCE_SECONDS,
  DEFAULT_MAX_OBSERVATIONS,
  DEFAULT_MAX_RUNTIME_MINUTES,
  DEFAULT_OUTCOME_RESOLUTION_POLICY,
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
  SUPPORTED_MARKET_IDS,
  BENCHMARK_MARKET,
  outcomeResolutionPolicyDigestFor,
  outcomeResolutionPolicyForOffset,
} from "./definition.mjs";
import { jevIdentity, requireJevProviderName, resolveJevModelName } from "../config.mjs";
import {
  REPLICATION_SESSION_CADENCE_SECONDS,
  REPLICATION_SESSION_OBSERVATIONS,
} from "./replication/protocol.mjs";
import {
  TEMPORAL_SESSION_CADENCE_SECONDS,
  TEMPORAL_SESSION_OBSERVATIONS,
} from "./temporal/protocol.mjs";

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
  // The bounded maximum outcome offset is NOT a free number: it is the bound of a
  // FROZEN outcome-resolution policy. `--tolerance-ms` therefore selects a
  // registered policy by its bound (5000 -> v1, 10000 -> v2); any other value is
  // refused, because changing the offset again requires a new policy version.
  const requestedToleranceMs =
    args["tolerance-ms"] === undefined || String(args["tolerance-ms"]).trim() === ""
      ? null
      : clamp(
          readInt(args["tolerance-ms"], DEFAULT_OUTCOME_RESOLUTION_POLICY.maximumOffsetMs),
          RESOLUTION_TOLERANCE_BOUNDS.min,
          RESOLUTION_TOLERANCE_BOUNDS.max,
        );
  let outcomeResolutionPolicy = DEFAULT_OUTCOME_RESOLUTION_POLICY;
  let toleranceMs = outcomeResolutionPolicy.maximumOffsetMs;
  if (requestedToleranceMs !== null) {
    toleranceMs = requestedToleranceMs;
    const matched = outcomeResolutionPolicyForOffset(requestedToleranceMs);
    if (matched === null) {
      fail(
        problems,
        `--tolerance-ms ${requestedToleranceMs} matches no frozen outcome-resolution policy; the bound is a policy ` +
          `constant, not a knob (current v${CURRENT_OUTCOME_RESOLUTION_POLICY_VERSION} = ` +
          `${DEFAULT_OUTCOME_RESOLUTION_POLICY.maximumOffsetMs} ms). Changing it requires a NEW policy version.`,
      );
    } else {
      outcomeResolutionPolicy = matched;
    }
  }

  // ---------------------------------------------------------------------------
  // Phase 5I.1 REPLICATION SESSION pre-run guard (§5, §11, FAIL CLOSED).
  //
  // `--replication-session` marks ONE run as a CLEAN replication session of the
  // frozen 5I.0b protocol. Every value that the frozen protocol fixes is
  // therefore REFUSED if it differs — before a single observation is taken, so a
  // mistyped replication run can never burn 120 real observations and then be
  // discarded as ineligible. This guard changes NO protocol value; it only
  // refuses a run that would not be the frozen protocol.
  // ---------------------------------------------------------------------------
  const replicationSession = args["replication-session"] === true;
  if (replicationSession) {
    if (args["allow-mock"] === true) {
      fail(
        problems,
        `--replication-session refuses --allow-mock: a replication session must be genuine, direct-TypeSafe ${REQUIRED_PROVIDER} ` +
          "evidence on real observations, never an offline fixture",
      );
    }
    if (args["allow-unsafe-model"] === true) {
      fail(problems, `--replication-session refuses --allow-unsafe-model: the pinned model '${REQUIRED_MODEL}' is not optional`);
    }
    if (maxObservations !== REPLICATION_SESSION_OBSERVATIONS) {
      fail(
        problems,
        `--replication-session requires exactly ${REPLICATION_SESSION_OBSERVATIONS} observations per session ` +
          `(got --max-observations ${maxObservations}); a session of another size is not the frozen protocol`,
      );
    }
    if (cadenceSeconds !== REPLICATION_SESSION_CADENCE_SECONDS) {
      fail(
        problems,
        `--replication-session requires the frozen ${REPLICATION_SESSION_CADENCE_SECONDS}-second cadence ` +
          `(got --cadence-seconds ${cadenceSeconds})`,
      );
    }
    if (requestedToleranceMs !== null && outcomeResolutionPolicy.version !== CURRENT_OUTCOME_RESOLUTION_POLICY_VERSION) {
      fail(
        problems,
        `--replication-session requires frozen outcome-resolution policy v${CURRENT_OUTCOME_RESOLUTION_POLICY_VERSION} ` +
          `(got --tolerance-ms ${requestedToleranceMs})`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Phase 5I.1a TEMPORAL-EXTENSION SESSION pre-run guard (FAIL CLOSED).
  //
  // `--temporal-session` marks ONE run as a CLEAN TEMPORAL-EXTENSION session of
  // the SAME frozen 5I.0b predictive protocol. It refuses every value the frozen
  // protocol fixes, exactly like `--replication-session`, and it is mutually
  // exclusive with it. The two flags differ ONLY in the evidence class the run
  // declares (temporal vs replication) — never in predictive semantics.
  // ---------------------------------------------------------------------------
  const temporalSession = args["temporal-session"] === true;
  if (temporalSession) {
    if (replicationSession) {
      fail(problems, "--temporal-session and --replication-session are mutually exclusive: a run declares exactly ONE evidence class");
    }
    if (args["allow-mock"] === true) {
      fail(
        problems,
        `--temporal-session refuses --allow-mock: a temporal-extension session must be genuine, direct-TypeSafe ${REQUIRED_PROVIDER} ` +
          "evidence on real observations, never an offline fixture",
      );
    }
    if (args["allow-unsafe-model"] === true) {
      fail(problems, `--temporal-session refuses --allow-unsafe-model: the pinned model '${REQUIRED_MODEL}' is not optional`);
    }
    if (maxObservations !== TEMPORAL_SESSION_OBSERVATIONS) {
      fail(
        problems,
        `--temporal-session requires exactly ${TEMPORAL_SESSION_OBSERVATIONS} observations per session ` +
          `(got --max-observations ${maxObservations}); a session of another size is not the frozen protocol`,
      );
    }
    if (cadenceSeconds !== TEMPORAL_SESSION_CADENCE_SECONDS) {
      fail(
        problems,
        `--temporal-session requires the frozen ${TEMPORAL_SESSION_CADENCE_SECONDS}-second cadence ` +
          `(got --cadence-seconds ${cadenceSeconds})`,
      );
    }
    if (requestedToleranceMs !== null && outcomeResolutionPolicy.version !== CURRENT_OUTCOME_RESOLUTION_POLICY_VERSION) {
      fail(
        problems,
        `--temporal-session requires frozen outcome-resolution policy v${CURRENT_OUTCOME_RESOLUTION_POLICY_VERSION} ` +
          `(got --tolerance-ms ${requestedToleranceMs})`,
      );
    }
  }

  return {
    version: DIRECTION_SETTINGS_VERSION,
    phase: DIRECTION_PHASE,
    replicationSession,
    temporalSession,
    evidenceProfileId: temporalSession ? "temporal" : replicationSession ? "replication" : "development",
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
    outcomeResolutionPolicy,
    outcomeResolutionPolicyVersion: outcomeResolutionPolicy.version,
    outcomeResolutionPolicyDigest: outcomeResolutionPolicyDigestFor(outcomeResolutionPolicy.version),
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
