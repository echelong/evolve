/**
 * Phase 5E — the ISOLATED, READ-ONLY Agent-Reach adapter (PAPER ONLY).
 *
 * Agent-Reach (pinned: v1.5.0, tag commit f65526cbaaad3879473acc1ba6dbefd195caf2be,
 * MIT, Python >=3.10) is an installer/doctor/router CLI whose per-platform READ
 * capabilities are delegated to documented upstream tools. EVOLVE therefore
 * treats it as an EXTERNAL, BOUNDED CAPABILITY, never as a library:
 *
 *   * no `import` of Agent-Reach's Python package anywhere in this repository;
 *   * EVOLVE launches a bounded subprocess/CLI call with an ARGUMENT ARRAY;
 *   * `shell: false` always (no shell interpolation, ever);
 *   * a strict EXECUTABLE allowlist and a strict COMMAND MAP;
 *   * a hard timeout, an output byte limit, and a per-capture CALL BUDGET;
 *   * a SANITIZED environment (no wallet/signer/private-key/token/cookie vars);
 *   * a READ-ONLY action allowlist: write-capable actions and argv are rejected
 *     BEFORE anything is spawned;
 *   * no arbitrary command pass-through: nothing from research/strategy state,
 *     a proposal, a genome, an LLM answer or a dataset can become an argv token
 *     except as a VALUE substituted into a frozen template.
 *
 * HEALTH (`doctor --json`) and `version` are side-effect-free. The text `doctor`
 * path is NEVER used: upstream Agent-Reach installs skill files in that path,
 * while the `--json` path returns before touching any file.
 *
 * PAPER ONLY. No wallet, no signer, no write RPC, no posting, no GitHub writes.
 */

import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  AGENT_REACH_PIN,
  READ_ONLY_ACTIONS,
  requireReadOnlyAction,
} from "./config.mjs";

/** The capability map version — a change here is a deliberate contract change. */
export const REACH_CAPABILITY_MAP_VERSION = "reach-capability-map-v1";

/**
 * Side-effect-free health operations. These are INTERNAL ONLY: they exist for the
 * doctor/probe path, are never produced by a query template, and are never
 * reachable from research/strategy state. They are deliberately NOT added to the
 * public read-only action allowlist.
 */
export const INTERNAL_REACH_HEALTH_ACTIONS = Object.freeze(["version", "health"]);

/**
 * Executables EVOLVE may ever launch for intelligence capture. Basenames only:
 * a caller can never point the adapter at an arbitrary binary.
 */
export const REACH_EXECUTABLE_ALLOWLIST = Object.freeze([
  "agent-reach",
  "gh",
  "twitter",
  "rdt",
  "mcporter",
  "curl",
]);

/**
 * Extra argv tokens that are write-capable or file-writing and always refused.
 *
 * Two kinds are listed: write/file FLAGS, and bare WRITE VERBS (`post`, `create`,
 * `push`, `fork`, …). Matching is exact-token equality, so a substitution value
 * such as `"create token"` is unaffected while a bare write verb can never be
 * smuggled in as an argument.
 */
export const FORBIDDEN_ARGV_TOKENS = Object.freeze([
  "-X",
  "--request",
  "-d",
  "--data",
  "--data-raw",
  "--data-binary",
  "--upload-file",
  "-T",
  "-F",
  "--form",
  "-o",
  "--output",
  "-O",
  "--remote-name",
  "--remove",
  "--delete",
  "--set",
  "--create",
  "--push",
  "--edit",
  "-i",
  "--method",
  "--request-target",
  "post",
  "reply",
  "repost",
  "retweet",
  "like",
  "follow",
  "unfollow",
  "subscribe",
  "create",
  "fork",
  "push",
  "delete",
  "modify",
  "edit",
  "merge",
  "comment",
  "publish",
  "upload",
  "dm",
]);

/** Bare write verbs, matched case-insensitively (see `assertReadOnlyArgv`). */
const BARE_FORBIDDEN_VERBS = Object.freeze(
  new Set(
    FORBIDDEN_ARGV_TOKENS.filter((token) => !token.startsWith("-")).map((token) => token.toLowerCase()),
  ),
);

/**
 * Characters that must never appear in a NON-URL argv token.
 *
 * `shell: false` is always used, so this is defence in depth rather than shell
 * safety: `;`, `&`, `|`, backtick and `$` never belong in a literal token, in a
 * rendered query, or in a substitution value. Quotes are allowed because the
 * deterministic query templates legitimately quote a symbol
 * (`"AAA" (memecoin OR token)`), and `*`/`?` are allowed for the same reason
 * (they are data here — nothing is ever globbed).
 */
const FORBIDDEN_TOKEN_CHARS = /[;&|`$\n\r\t]/;
/** Unsubstituted template braces never survive into a final argv token. */
const TEMPLATE_BRACES = /[{}]/;

/** A token that is a plain, well-formed https URL (may carry ? & = # % data). */
export function isHttpsUrlToken(token) {
  const text = String(token ?? "");
  if (text.length === 0 || text.length > 2_048) return false;
  if (/\s/.test(text)) return false;
  if (text.includes('"') || text.includes("'") || text.includes("\\")) return false;
  try {
    return new URL(text).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Environment variable names that are NEVER inherited by an intelligence call:
 * wallet/signing material, credentials, cookies, and this project's API keys.
 */
const FORBIDDEN_ENV_PATTERN =
  /(WALLET|MNEMONIC|SEED_?PHRASE|PRIVATE_?KEY|SECRET|PASSPHRASE|SIGNER|API_?KEY|TOKEN|COOKIE|AUTH|CREDENTIAL|PASSWORD|KEYPAIR|JUPITER|HELIUS|SOLANA|RPC|DEEPSEEK|CLINE|OPENAI|ANTHROPIC|GROQ|EXA_)/i;

/**
 * Extra (non-inherited) variables a caller may inject — the MINIMUM set, so the
 * adapter cannot be turned into a generic environment-passthrough.
 */
const ALLOWED_EXTRA_ENV_KEYS = Object.freeze(["AGENT_REACH_LANG", "EVOLVE_REACH_LANG", "EVOLVE_REACH_PROXY"]);

/** Env vars an intelligence call MAY inherit (allowlist, not denylist-only). */
const ALLOWED_ENV_KEYS = Object.freeze([
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TERM",
  "TMPDIR",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "AGENT_REACH_LANG",
]);

export class ReachBinaryError extends Error {
  constructor(message) {
    super(message);
    this.name = "ReachBinaryError";
  }
}

export class ReachCommandError extends Error {
  constructor(message) {
    super(message);
    this.name = "ReachCommandError";
  }
}

export class ReachBudgetExceededError extends Error {
  constructor(maxCalls) {
    super(`the intelligence call budget is exhausted (max ${maxCalls} calls) — refusing to place another call.`);
    this.name = "ReachBudgetExceededError";
    this.maxCalls = maxCalls;
  }
}

/* ============================================================================
 * The frozen command map
 * ==========================================================================*/

/**
 * FROZEN capability map. Placeholders (`{query}`, `{limit}`, `{url}`,
 * `{readerUrl}`, `{timeoutSeconds}`) are the ONLY substitution points, and each
 * is validated before it becomes its own argv element (never
 * string-interpolated). EVOLVE always launches the pinned `agent-reach` CLI; the
 * `binary` field on each entry names the upstream READ tool whose argv the entry
 * mirrors, and it must be on the executable allowlist.
 *
 * Every entry is a documented Agent-Reach/upstream READ path for one of the six
 * enabled channels.
 */
export const REACH_CAPABILITY_MAP_V1 = Object.freeze({
  version: REACH_CAPABILITY_MAP_VERSION,
  pinned: AGENT_REACH_PIN,
  entries: Object.freeze([
    Object.freeze({ op: "version", channel: null, binary: "agent-reach", argv: Object.freeze(["version"]) }),
    Object.freeze({ op: "health", channel: null, binary: "agent-reach", argv: Object.freeze(["doctor", "--json"]) }),
    Object.freeze({ op: "search", channel: "x", binary: "twitter", argv: Object.freeze(["search", "{query}", "--json", "--limit", "{limit}"]) }),
    Object.freeze({ op: "read", channel: "x", binary: "twitter", argv: Object.freeze(["tweet", "{url}", "--json"]) }),
    Object.freeze({ op: "search", channel: "exa", binary: "mcporter", argv: Object.freeze(["call", "exa.web_search_exa", "--query", "{query}", "--limit", "{limit}"]) }),
    Object.freeze({ op: "search", channel: "web", binary: "mcporter", argv: Object.freeze(["call", "exa.web_search_exa", "--query", "{query}", "--limit", "{limit}"]) }),
    Object.freeze({ op: "read", channel: "web", binary: "curl", argv: Object.freeze(["-fsSL", "--max-time", "{timeoutSeconds}", "{readerUrl}"]) }),
    Object.freeze({ op: "search", channel: "reddit", binary: "rdt", argv: Object.freeze(["search", "{query}", "--json", "--limit", "{limit}"]) }),
    Object.freeze({ op: "read", channel: "reddit", binary: "rdt", argv: Object.freeze(["read", "{url}", "--json"]) }),
    Object.freeze({ op: "read", channel: "rss", binary: "curl", argv: Object.freeze(["-fsSL", "--max-time", "{timeoutSeconds}", "{url}"]) }),
    Object.freeze({ op: "search", channel: "github", binary: "gh", argv: Object.freeze(["search", "repos", "{query}", "--json", "name,owner,description,url,stargazersCount", "--limit", "{limit}"]) }),
    Object.freeze({ op: "read", channel: "github", binary: "gh", argv: Object.freeze(["repo", "view", "{query}", "--json", "name,description,url,stargazersCount"]) }),
  ]),
  note:
    "Read-only capability map. `gh`/`twitter`/`rdt`/`mcporter` are the upstream tools Agent-Reach documents for the enabled channels; " +
    "`curl` is its documented Jina-Reader/RSS read path. No write verb appears anywhere in this map.",
});

/** Look up the frozen entry for (op, channel). */
export function capabilityFor(op, channel = null) {
  const requested = String(op ?? "").trim().toLowerCase();
  const action = INTERNAL_REACH_HEALTH_ACTIONS.includes(requested) ? requested : requireReadOnlyAction(op);
  const entries = REACH_CAPABILITY_MAP_V1.entries.filter((entry) => entry.op === action);
  if (entries.length === 0) throw new ReachCommandError(`no capability entry for action '${action}'`);
  if (channel === null || channel === undefined) {
    const health = entries.find((entry) => entry.channel === null);
    if (!health) throw new ReachCommandError(`capability '${action}' requires a channel`);
    return health;
  }
  const entry = entries.find((candidate) => candidate.channel === channel);
  if (!entry) throw new ReachCommandError(`no capability entry for '${action}' on channel '${channel}'`);
  return entry;
}

/* ============================================================================
 * Guards
 * ==========================================================================*/

/** Validate a value destined for one argv slot. */
export function validateArgvValue(name, value) {
  if (value === null || value === undefined) throw new ReachCommandError(`missing value for '${name}'`);
  const text = String(value);
  if (text.length === 0 || text.length > 512) throw new ReachCommandError(`invalid length for '${name}'`);
  if (FORBIDDEN_TOKEN_CHARS.test(text)) throw new ReachCommandError(`'${name}' contains a character that is refused in an argv token`);
  if (TEMPLATE_BRACES.test(text)) throw new ReachCommandError(`'${name}' contains template braces and is refused`);
  if (text.startsWith("-")) throw new ReachCommandError(`'${name}' may not look like a flag`);
  return text;
}

/** A URL is only ever https. */
export function validateUrl(value) {
  if (value === null || value === undefined) throw new ReachCommandError("missing value for 'url'");
  const text = String(value);
  if (text.length === 0 || text.length > 1_024) throw new ReachCommandError("invalid length for 'url'");
  if (!isHttpsUrlToken(text)) throw new ReachCommandError("'url' must be an absolute https URL with no whitespace or quotes");
  return text;
}

/** Reject a write-capable argv before anything is spawned. */
export function assertReadOnlyArgv(argv = [], { binary = null } = {}) {
  const basename = binary === null ? null : path.basename(String(binary));
  if (basename !== null && !REACH_EXECUTABLE_ALLOWLIST.includes(basename)) {
    throw new ReachBinaryError(
      `executable '${basename}' is not on the intelligence allowlist (${REACH_EXECUTABLE_ALLOWLIST.join(", ")}).`,
    );
  }
  for (const token of argv) {
    const text = String(token);
    // Bare write verbs are matched case-insensitively (`POST` is as forbidden as
    // `post`); flags and file-writing options match exactly.
    if (FORBIDDEN_ARGV_TOKENS.includes(text) || BARE_FORBIDDEN_VERBS.has(text.toLowerCase())) {
      throw new ReachCommandError(`argv token '${text}' is write-capable or file-writing and is refused`);
    }
    // A well-formed https URL is DATA (it may carry ? & = # % and is never
    // globbed or interpreted), so it is exempt from the literal-token rules.
    if (isHttpsUrlToken(text)) continue;
    if (FORBIDDEN_TOKEN_CHARS.test(text)) {
      throw new ReachCommandError(`argv token '${text}' contains a character that is refused in an argv token`);
    }
    if (TEMPLATE_BRACES.test(text)) {
      throw new ReachCommandError(`argv token '${text}' still contains a template placeholder`);
    }
  }
  return argv;
}

/**
 * Sanitize the environment handed to an intelligence subprocess.
 *
 * ALLOWLIST (not just a denylist): only the variables an offline-capable read
 * tool genuinely needs can pass through. Wallet, signer, seed, key, token,
 * cookie and credential variables can never be inherited — including any of
 * EVOLVE's own API keys.
 */
export function sanitizeReachEnv(env = process.env, extra = {}) {
  const out = {};
  for (const key of ALLOWED_ENV_KEYS) {
    const value = env?.[key];
    if (typeof value === "string" && value.length > 0) out[key] = value;
  }
  for (const [key, value] of Object.entries(extra)) {
    if (!ALLOWED_EXTRA_ENV_KEYS.includes(key)) continue;
    if (FORBIDDEN_ENV_PATTERN.test(key)) continue;
    if (typeof value === "string" && value.length > 0) out[key] = value;
  }
  return out;
}

/** A tiny deterministic call budget for one capture. */
export function createReachBudget(maxCalls) {
  const limit = Math.max(1, Number(maxCalls) || 1);
  let used = 0;
  return {
    limit,
    get used() {
      return used;
    },
    get remaining() {
      return Math.max(0, limit - used);
    },
    take() {
      if (used >= limit) throw new ReachBudgetExceededError(limit);
      used += 1;
      return used;
    },
  };
}

/* ============================================================================
 * Invocation
 * ==========================================================================*/

/** Resolve the pinned Agent-Reach binary. Never an arbitrary executable. */
export function resolveReachBinary({ reachBin = null, projectRoot = process.cwd() } = {}) {
  if (reachBin === null) {
    return path.join(projectRoot, AGENT_REACH_PIN.localInstallDir, "bin", AGENT_REACH_PIN.cli);
  }
  const resolved = String(reachBin);
  const basename = path.basename(resolved);
  if (basename !== AGENT_REACH_PIN.cli) {
    throw new ReachBinaryError(
      `EVOLVE_REACH_BIN must point at the pinned '${AGENT_REACH_PIN.cli}' executable ` +
        `(got '${basename}'); the intelligence layer never launches an arbitrary binary.`,
    );
  }
  return resolved;
}

/**
 * Build the exact argv for one call: substitution happens slot-by-slot, and each
 * slot is validated on its own. `{readerUrl}` composes the read-only Jina Reader
 * URL from an already-validated https source URL.
 */
export function buildReachArgv({ op, channel = null, values = {}, entry = null } = {}) {
  const capability = entry ?? capabilityFor(op, channel);
  const argv = capability.argv.map((token) => {
    if (!token.startsWith("{")) return token;
    const name = token.slice(1, -1);
    // `{readerUrl}` is composed from the caller's `url` slot.
    const source = name === "readerUrl" ? (values.readerUrl ?? values.url) : values[name];
    if (source === undefined) throw new ReachCommandError(`missing substitution '${name}' for capability '${capability.op}'`);
    if (name === "url") return validateUrl(source);
    if (name === "readerUrl") {
      const composed = `https://r.jina.ai/${validateUrl(source)}`;
      if (!isHttpsUrlToken(composed)) throw new ReachCommandError("the reader URL could not be composed safely");
      return composed;
    }
    return validateArgvValue(name, values[name]);
  });
  assertReadOnlyArgv(argv, { binary: capability.binary });
  return { capability, argv };
}

/**
 * Run ONE bounded, read-only intelligence call.
 *
 * @param {{
 *   op: string,
 *   channel?: string|null,
 *   values?: object,
 *   config: object,
 *   budget?: object,
 *   env?: object,
 *   projectRoot?: string,
 *   spawn?: Function,
 * }} options
 */
export function runReachCall({
  op,
  channel = null,
  values = {},
  config,
  budget = null,
  env = process.env,
  projectRoot = process.cwd(),
  spawn = spawnSync,
} = {}) {
  const requested = String(op ?? "").trim().toLowerCase();
  const action = INTERNAL_REACH_HEALTH_ACTIONS.includes(requested) ? requested : requireReadOnlyAction(op);
  const binary = resolveReachBinary({ reachBin: config?.reachBin ?? null, projectRoot });
  const { capability, argv } = buildReachArgv({ op: action, channel, values });
  if (budget) budget.take();

  const timeoutMs = Math.min(config?.timeoutMs ?? 20_000, 600_000);
  const maxBytes = Math.min(config?.maxBytes ?? 262_144, 8_388_608);
  const childEnv = sanitizeReachEnv(env);

  const started = Date.now();
  const result = spawn(binary, argv, {
    shell: false,
    timeout: timeoutMs,
    maxBuffer: maxBytes,
    windowsHide: true,
    env: childEnv,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const durationMs = Date.now() - started;

  const stdout = typeof result?.stdout === "string" ? result.stdout : "";
  const stderr = typeof result?.stderr === "string" ? result.stderr : "";
  const timedOut = result?.error?.code === "ETIMEDOUT" || result?.signal === "SIGTERM";
  const overflowed = result?.error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
  const ok = !timedOut && !overflowed && result?.status === 0;

  return {
    op: action,
    channel,
    capability: capability.op,
    binary: path.basename(binary),
    argv,
    commandPreview: `${path.basename(binary)} ${argv.join(" ")}`,
    ok,
    status: result?.status ?? null,
    timedOut,
    overflowed,
    durationMs,
    bytes: Buffer.byteLength(stdout, "utf8"),
    maxBytes,
    timeoutMs,
    stdout: ok ? stdout.slice(0, maxBytes) : "",
    stderr: stderr.slice(0, 2_048),
    error: ok
      ? null
      : timedOut
        ? `timed out after ${timeoutMs}ms`
        : overflowed
          ? `output exceeded the ${maxBytes}-byte limit`
          : `exit ${result?.status ?? "signal"}${stderr ? `: ${stderr.trim().slice(0, 200)}` : ""}`,
    envKeys: Object.keys(childEnv).sort(),
    // Both self-checks reuse the single deny-list above, so the vocabulary that
    // forbids credentials lives in exactly ONE place.
    walletEnvPresent: Object.keys(childEnv).some((key) => FORBIDDEN_ENV_PATTERN.test(key)),
    tokensInEnv: Object.keys(childEnv).some((key) => FORBIDDEN_ENV_PATTERN.test(key)),
  };
}

/** `version` + `doctor --json` — side-effect-free health for the doctor/probe CLI. */
export function probeReachHealth({ config, env = process.env, projectRoot = process.cwd(), spawn = spawnSync } = {}) {
  const version = runReachCall({ op: "health", config, env, projectRoot, spawn: spawnFor(spawn, "version") });
  const doctor = runReachCall({ op: "health", config, env, projectRoot, spawn });
  return {
    provider: "agent-reach",
    pinned: AGENT_REACH_PIN,
    binary: path.basename(resolveReachBinary({ reachBin: config?.reachBin ?? null, projectRoot })),
    version: { ok: version.ok, stdout: version.stdout.trim(), error: version.error },
    doctor: { ok: doctor.ok, json: parseJsonSafe(doctor.stdout), error: doctor.error, bytes: doctor.bytes },
    channels: { enabled: config?.channels ?? [] },
    readOnly: true,
    paperOnly: true,
    note: "Read-only probe. `doctor --json` is used deliberately: the text path installs skill files, the JSON path does not.",
  };
}

function spawnFor(spawn, op) {
  return (binary, argv, options) => spawn(binary, op === "version" ? ["version"] : argv, options);
}

function parseJsonSafe(text) {
  try {
    return JSON.parse(String(text ?? ""));
  } catch {
    return null;
  }
}

export { READ_ONLY_ACTIONS };
