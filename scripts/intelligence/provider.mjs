/**
 * Phase 5E — fail-closed intelligence provider registry (PAPER ONLY).
 *
 *   disabled      nothing may be called at all (the default)
 *   mock          deterministic offline fixture provider
 *   agent-reach   the bounded, read-only subprocess adapter
 *
 * There is NO automatic fallback: a provider that fails at runtime is reported
 * as a failure, never silently replaced by the mock (the same rule the research
 * providers follow). A disabled provider refuses every call.
 *
 * PAPER ONLY, READ-ONLY. No provider here can write, post, sign or transact.
 */

import {
  DEFAULT_INTELLIGENCE_PROVIDER,
  DisabledIntelligenceProviderError,
  INTELLIGENCE_PROVIDER,
  REGISTERED_INTELLIGENCE_PROVIDERS,
  requireIntelligenceProvider,
} from "./config.mjs";
import { MOCK_INTELLIGENCE } from "./providers/mock-intelligence.mjs";
import { runReachCall } from "./agent-reach.mjs";

export const DISABLED_INTELLIGENCE_PROVIDER = Object.freeze({
  name: INTELLIGENCE_PROVIDER.DISABLED,
  deterministic: true,
  external: false,
  subprocess: false,
  network: false,
  syntheticIntelligence: false,
  execute() {
    throw new DisabledIntelligenceProviderError(
      "the intelligence provider is DISABLED (EVOLVE_INTELLIGENCE_PROVIDER=disabled). " +
        "Pass `--provider mock` for an offline fixture capture or `--provider agent-reach` to enable the read-only adapter explicitly.",
    );
  },
});

/**
 * The Agent-Reach provider: one bounded, read-only subprocess call per query.
 * Its records are always marked non-synthetic (they come from the real world)
 * but they are still only OBSERVATIONS until captured and frozen.
 */
export function createAgentReachIntelligenceProvider({ config, env = process.env, projectRoot = process.cwd(), spawn = null } = {}) {
  return {
    name: INTELLIGENCE_PROVIDER.AGENT_REACH,
    deterministic: false,
    external: true,
    subprocess: true,
    network: true,
    syntheticIntelligence: false,
    agentReachVersion: config?.agentReach?.release ?? null,
    execute(call = {}) {
      const result = runReachCall({
        op: call.op,
        channel: call.channel ?? null,
        values: {
          query: call.query ?? undefined,
          url: call.url ?? undefined,
          limit: call.limit ?? config?.maxResults ?? 10,
          timeoutSeconds: Math.max(1, Math.floor((config?.timeoutMs ?? 20_000) / 1000)),
        },
        config,
        budget: call.budget ?? null,
        env,
        projectRoot,
        ...(spawn ? { spawn } : {}),
      });
      const parsed = parseReachStdout(result.stdout);
      return {
        ok: result.ok,
        provider: INTELLIGENCE_PROVIDER.AGENT_REACH,
        syntheticIntelligence: false,
        backendVersion: config?.agentReach?.release ?? null,
        records: parsed.records,
        error: result.ok ? null : result.error,
        call: {
          commandPreview: result.commandPreview,
          durationMs: result.durationMs,
          bytes: result.bytes,
          timedOut: result.timedOut,
          overflowed: result.overflowed,
          envKeys: result.envKeys,
          walletEnvPresent: result.walletEnvPresent,
          tokensInEnv: result.tokensInEnv,
        },
      };
    },
  };
}

/**
 * Parse a read tool's stdout into raw records. Supports a JSON array, a JSON
 * object with a `results`/`items` array, and newline-delimited JSON.
 */
export function parseReachStdout(stdout) {
  const text = String(stdout ?? "").trim();
  if (text.length === 0) return { records: [], format: "empty" };
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return { records: parsed, format: "json-array" };
    if (Array.isArray(parsed?.results)) return { records: parsed.results, format: "json-results" };
    if (Array.isArray(parsed?.items)) return { records: parsed.items, format: "json-items" };
    if (parsed && typeof parsed === "object") return { records: [parsed], format: "json-object" };
    return { records: [], format: "json-scalar" };
  } catch {
    const records = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        records.push(JSON.parse(trimmed));
      } catch {
        // A non-JSON line is not evidence; it is ignored (and the caller's health
        // report still records the call as having produced no records).
      }
    }
    return { records, format: "ndjson" };
  }
}

/** Resolve the provider implementation (pure; never falls back). */
export function resolveIntelligenceProvider({ provider, config, env = process.env, projectRoot = process.cwd(), spawn = null } = {}) {
  const name = requireIntelligenceProvider(provider ?? DEFAULT_INTELLIGENCE_PROVIDER);
  if (name === INTELLIGENCE_PROVIDER.DISABLED) return DISABLED_INTELLIGENCE_PROVIDER;
  if (name === INTELLIGENCE_PROVIDER.MOCK) return MOCK_INTELLIGENCE;
  if (name === INTELLIGENCE_PROVIDER.AGENT_REACH) {
    return createAgentReachIntelligenceProvider({ config, env, projectRoot, spawn });
  }
  // Unreachable: `requireIntelligenceProvider` is fail-closed.
  throw new Error(`provider '${name}' is registered but has no implementation (registered: ${REGISTERED_INTELLIGENCE_PROVIDERS.join(", ")})`);
}

export default resolveIntelligenceProvider;
