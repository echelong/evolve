/**
 * Phase 5E — external-intelligence configuration (PAPER ONLY, SHADOW ONLY).
 *
 * Agent-Reach provides READ-ONLY internet observations. EVOLVE never uses the
 * live internet inside the Arena: observations are captured, frozen,
 * fingerprinted and replayed from disk (`./capture.mjs`, `./replay.mjs`), and no
 * intelligence result may affect trading, evolution, scoring, gates or
 * replication.
 *
 * FAIL-CLOSED CONFIGURATION
 * -------------------------
 *   EVOLVE_INTELLIGENCE_PROVIDER = disabled (default) | mock | agent-reach
 *   EVOLVE_INTELLIGENCE_MODE     = shadow (the ONLY mode Phase 5E allows)
 *
 * An unknown provider or mode is a hard error — never a silent fallback to the
 * mock. The default provider is `disabled`, so nothing can call the internet
 * unless an operator explicitly asks for it.
 *
 * CHANNELS
 * --------
 * Phase 5E enables a NARROW allowlist:
 *
 *   x · web · exa (search) · reddit · rss · github
 *
 * Everything else Agent-Reach supports is DISABLED here, and the browser-login
 * channels (Facebook, Instagram, LinkedIn, XiaoHongShu, OpenCLI-backed browsing)
 * are refused outright: they require an authenticated browser session, which is
 * out of scope for a canonical capture. Channels may be requested with
 * EVOLVE_REACH_CHANNELS; anything outside the allowlist fails closed.
 *
 * PAPER ONLY. No wallet, no signer, no write RPC, no posting.
 */

import path from "node:path";

export const INTELLIGENCE_PHASE = "5E";
export const INTELLIGENCE_SCHEMA_VERSION = 1;

/** Default capture root (gitignored, like every other `.evolve/` artifact). */
export const INTELLIGENCE_DIR = path.join(".evolve", "intelligence");

export const INTELLIGENCE_PROVIDER = Object.freeze({
  DISABLED: "disabled",
  MOCK: "mock",
  AGENT_REACH: "agent-reach",
});

export const REGISTERED_INTELLIGENCE_PROVIDERS = Object.freeze([
  INTELLIGENCE_PROVIDER.DISABLED,
  INTELLIGENCE_PROVIDER.MOCK,
  INTELLIGENCE_PROVIDER.AGENT_REACH,
]);

export const DEFAULT_INTELLIGENCE_PROVIDER = INTELLIGENCE_PROVIDER.DISABLED;

/** Phase 5E is SHADOW ONLY: no routing, no influence, no threshold promotion. */
export const INTELLIGENCE_MODE = Object.freeze({ SHADOW: "shadow" });
export const REGISTERED_INTELLIGENCE_MODES = Object.freeze([INTELLIGENCE_MODE.SHADOW]);
export const DEFAULT_INTELLIGENCE_MODE = INTELLIGENCE_MODE.SHADOW;

/** The six channels Phase 5E allows. NOTHING else may be enabled. */
export const ENABLED_INTELLIGENCE_CHANNELS = Object.freeze(["x", "web", "exa", "reddit", "rss", "github"]);

/**
 * Channels that stay DISABLED for canonical Phase 5E. Kept as data (not prose)
 * so a test can assert the exact allowlist and an operator gets a precise error.
 */
export const DISABLED_INTELLIGENCE_CHANNELS = Object.freeze([
  "facebook",
  "instagram",
  "linkedin",
  "xiaohongshu",
  "bilibili",
  "boss",
  "xueqiu",
  "xiaoyuzhou",
  "youtube",
  "v2ex",
  "opencli",
]);

/** Read-only actions EVOLVE may ever request from an intelligence backend. */
export const READ_ONLY_ACTIONS = Object.freeze(["search", "read", "fetch", "list", "metadata"]);

/** Actions that must be REJECTED before any call is made. */
export const WRITE_ACTIONS = Object.freeze([
  "post",
  "reply",
  "comment",
  "like",
  "follow",
  "fork",
  "create-issue",
  "create-pr",
  "push",
  "write",
  "delete",
  "modify",
  "dm",
  "subscribe",
  "unfollow",
  "repost",
  "retweet",
  "star",
]);

/** The pinned upstream repository identity (verified 2026-09-19, see README). */
export const AGENT_REACH_PIN = Object.freeze({
  repository: "https://github.com/Panniantong/Agent-Reach",
  repoSlug: "Panniantong/Agent-Reach",
  release: "v1.5.0",
  version: "1.5.0",
  commit: "f65526cbaaad3879473acc1ba6dbefd195caf2be",
  license: "MIT",
  python: ">=3.10",
  cli: "agent-reach",
  localInstallDir: path.join(".tools", "agent-reach"),
});

export const DEFAULT_REACH_TIMEOUT_MS = 20_000;
export const DEFAULT_REACH_MAX_CALLS = 6;
export const DEFAULT_REACH_MAX_RESULTS = 10;
export const DEFAULT_REACH_MAX_BYTES = 262_144;

export class UnknownIntelligenceProviderError extends Error {
  constructor(name) {
    super(
      `unknown intelligence provider '${name}'. Registered providers: ${REGISTERED_INTELLIGENCE_PROVIDERS.join(", ")}. ` +
        "Selection is FAIL-CLOSED: there is no automatic fallback to the mock provider.",
    );
    this.name = "UnknownIntelligenceProviderError";
    this.provider = name;
  }
}

export class UnsupportedIntelligenceModeError extends Error {
  constructor(name) {
    super(
      `unsupported intelligence mode '${name}'. Phase 5E allows only: ${REGISTERED_INTELLIGENCE_MODES.join(", ")}. ` +
        "There is no active/routing mode for external intelligence.",
    );
    this.name = "UnsupportedIntelligenceModeError";
    this.mode = name;
  }
}

export class DisabledIntelligenceProviderError extends Error {
  constructor(message) {
    super(message);
    this.name = "DisabledIntelligenceProviderError";
  }
}

export class DisabledIntelligenceChannelError extends Error {
  constructor(channel) {
    super(
      `intelligence channel '${channel}' is DISABLED in Phase 5E. Allowed: ${ENABLED_INTELLIGENCE_CHANNELS.join(", ")}. ` +
        "Browser-login and write-capable channels are never enabled for a canonical capture.",
    );
    this.name = "DisabledIntelligenceChannelError";
    this.channel = channel;
  }
}

export class WriteCapableActionError extends Error {
  constructor(action) {
    super(
      `intelligence action '${action}' is WRITE-CAPABLE and is rejected before any call. ` +
        `Allowed actions: ${READ_ONLY_ACTIONS.join(", ")}.`,
    );
    this.name = "WriteCapableActionError";
    this.action = action;
  }
}

/* ============================================================================
 * Env readers (bounded; never throw on the value, only on unknown names)
 * ==========================================================================*/

function readString(env, names, fallback = null) {
  for (const name of names) {
    const value = env?.[name];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return fallback;
}

function readBoundedInt(env, names, fallback, min, max) {
  const raw = readString(env, names, null);
  if (raw === null) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function readChannels(env) {
  const raw = readString(env, ["EVOLVE_REACH_CHANNELS"], null);
  if (raw === null) return [...ENABLED_INTELLIGENCE_CHANNELS];
  const requested = raw
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (requested.length === 0) return [...ENABLED_INTELLIGENCE_CHANNELS];
  for (const channel of requested) {
    if (!ENABLED_INTELLIGENCE_CHANNELS.includes(channel)) {
      // Fail closed: a disabled channel is a configuration error, not a skip.
      throw new DisabledIntelligenceChannelError(channel);
    }
  }
  return [...new Set(requested)];
}

/** Validate a provider name (fail-closed; no fallback). */
export function requireIntelligenceProvider(name) {
  if (name === null || name === undefined || String(name).trim() === "") return DEFAULT_INTELLIGENCE_PROVIDER;
  const normalized = String(name).trim().toLowerCase();
  if (!REGISTERED_INTELLIGENCE_PROVIDERS.includes(normalized)) throw new UnknownIntelligenceProviderError(name);
  return normalized;
}

/** Validate a mode name (Phase 5E: `shadow` only). */
export function requireIntelligenceMode(name) {
  if (name === null || name === undefined || String(name).trim() === "") return DEFAULT_INTELLIGENCE_MODE;
  const normalized = String(name).trim().toLowerCase();
  if (!REGISTERED_INTELLIGENCE_MODES.includes(normalized)) throw new UnsupportedIntelligenceModeError(name);
  return normalized;
}

/** Reject write-capable actions before anything is spawned. */
export function requireReadOnlyAction(action) {
  const normalized = String(action ?? "").trim().toLowerCase();
  if (!READ_ONLY_ACTIONS.includes(normalized)) throw new WriteCapableActionError(action);
  return normalized;
}

/**
 * Resolve the effective intelligence configuration.
 *
 * @param {{ [key: string]: string|undefined }} [env]
 * @param {{ loadEnv?: boolean }} [options]
 */
export function resolveIntelligenceConfig(env = process.env, options = {}) {
  const provider = requireIntelligenceProvider(readString(env, ["EVOLVE_INTELLIGENCE_PROVIDER"], DEFAULT_INTELLIGENCE_PROVIDER));
  const mode = requireIntelligenceMode(readString(env, ["EVOLVE_INTELLIGENCE_MODE"], DEFAULT_INTELLIGENCE_MODE));
  return {
    phase: INTELLIGENCE_PHASE,
    schemaVersion: INTELLIGENCE_SCHEMA_VERSION,
    paperOnly: true,
    shadowOnly: true,
    provider,
    mode,
    enabled: provider !== INTELLIGENCE_PROVIDER.DISABLED,
    channels: readChannels(env),
    reachBin: readString(env, ["EVOLVE_REACH_BIN"], null),
    timeoutMs: readBoundedInt(env, ["EVOLVE_REACH_TIMEOUT_MS"], DEFAULT_REACH_TIMEOUT_MS, 1_000, 600_000),
    maxCalls: readBoundedInt(env, ["EVOLVE_REACH_MAX_CALLS"], DEFAULT_REACH_MAX_CALLS, 1, 64),
    maxResults: readBoundedInt(env, ["EVOLVE_REACH_MAX_RESULTS"], DEFAULT_REACH_MAX_RESULTS, 1, 50),
    maxBytes: readBoundedInt(env, ["EVOLVE_REACH_MAX_BYTES"], DEFAULT_REACH_MAX_BYTES, 1_024, 8_388_608),
    loadedEnvFiles: options.loadEnv === true,
    agentReach: AGENT_REACH_PIN,
    note:
      "External intelligence is READ-ONLY, SHADOW-ONLY and cannot influence trading, evolution, scoring, gates or replication in Phase 5E.",
  };
}

export default resolveIntelligenceConfig;
