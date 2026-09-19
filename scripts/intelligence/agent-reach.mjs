/**
 * Phase 5E — the ISOLATED, READ-ONLY Agent-Reach adapter (PAPER ONLY).
 *
 * Agent-Reach (pinned: v1.5.0, tag commit f65526cbaaad3879473acc1ba6dbefd195caf2be,
 * MIT, Python >=3.10) is an installer/doctor/router CLI whose per-platform READ
 * capabilities are delegated to documented upstream tools. EVOLVE therefore
 * treats it as an EXTERNAL, BOUNDED CAPABILITY, never as a library:
 *
 * ARCHITECTURE — two tiers, deliberately separated:
 *
 *   Agent-Reach (pinned, project-local, `.tools/agent-reach/bin/agent-reach`)
 *     → HEALTH/ROUTER VERIFICATION ONLY: `version` and `doctor --json`. It is a
 *       capability router + installer/doctor layer, NOT a proxy executable: its
 *       CLI has no generic `search`/`read` wrapper, so an upstream tool's argv is
 *       NEVER handed to `agent-reach`.
 *
 *   The FROZEN capability map (authoritative)
 *     → names the approved upstream READ executable for every (op, channel):
 *       `gh`, `twitter`, `rdt`, `mcporter`, `curl`. EVOLVE resolves that bare
 *       basename with a bounded, shell-free search over the SANITIZED PATH and
 *       launches THAT executable with the capability's argv.
 *
 *   EVOLVE capture → normalization/fingerprint/replay over the bounded read.
 *
 * The remaining invariants apply to every tier:
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
 * HEALTH (`doctor --json`) and `version` are side-effect-free and are the ONLY
 * two commands the pinned CLI is ever asked to run: no upstream intelligence
 * query happens during a doctor. The text `doctor` path is NEVER used: upstream
 * Agent-Reach installs skill files in that path, while the `--json` path returns
 * before touching any file.
 *
 * A MISSING upstream tool is a bounded, recorded FAILURE for that query/channel.
 * It never triggers an automatic install (Agent-Reach `install` is never
 * invoked), never falls back to the pinned CLI, and never falls back to another
 * backend: dynamic backend selection does not exist during a canonical capture.
 *
 * PAPER ONLY. No wallet, no signer, no write RPC, no posting, no GitHub writes.
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { digestOf } from "../lib/hash.mjs";
import {
  AGENT_REACH_PIN,
  READ_ONLY_ACTIONS,
  requireReadOnlyAction,
} from "./config.mjs";

/** The capability map version — a change here is a deliberate contract change. */
export const REACH_CAPABILITY_MAP_VERSION = "reach-capability-map-v1";

/**
 * VERSIONED SUCCESSOR (Phase 5G.1b) — `reach-capability-map-v2`.
 *
 * `reach-capability-map-v1` is FROZEN: historical captures (and every replay
 * identity derived from them) were bounded by its EXACT argv, and silently
 * mutating it would rewrite the meaning of already-frozen evidence. V2 is
 * therefore an explicit, published successor — it never redefines V1.
 *
 * V2 changes ONE thing: the MCPorter / Exa web-search invocation contract. The
 * installed `mcporter 0.13.13` no longer accepts `--query`/`--limit` on `call`
 * (it wants `key=<value>` tool arguments and the Exa schema names the bounded
 * result count `numResults`, with a REQUIRED `objective`). V1 remains readable
 * forever; every NEW Agent-Reach capture is bounded by V2.
 */
export const REACH_CAPABILITY_MAP_VERSION_V2 = "reach-capability-map-v2";

/** The capability map NEW captures are bounded by (see `REACH_ACTIVE_CAPABILITY_MAP`). */
export const REACH_ACTIVE_CAPABILITY_MAP_VERSION = REACH_CAPABILITY_MAP_VERSION_V2;

/* ----------------------------------------------------------------------------
 * The frozen Exa / MCPorter web-search contract (V2)
 * --------------------------------------------------------------------------*/

/** The MCP tool EVOLVE calls for `exa`/`web` search. Exact, frozen, never built. */
export const EXA_WEB_SEARCH_TOOL = "exa.web_search_exa";

/**
 * The FROZEN search-ranking objective (a static literal, version 1).
 *
 * The installed `web_search_exa` schema makes `objective` REQUIRED, so EVOLVE
 * supplies a STATIC one: NO LLM, no candidate, no strategy, no genome and no
 * research proposal may ever write, extend or influence it. It is search-ranking
 * context only — never a research conclusion, never trading direction, never
 * asset quality, never profitability.
 *
 * The wording below is the carefully EQUIVALENT comma form of the semantic
 * content "... return search-result evidence only; do not infer trading
 * direction, asset quality or profitability." The `;` was replaced because the
 * frozen argv-token barrier refuses shell/control characters in EVERY token
 * (including this one) — the barrier is never weakened to accommodate a string.
 */
export const EXA_SEARCH_OBJECTIVE_VERSION = 1;
export const EXA_SEARCH_OBJECTIVE_V1 =
  "Return the public web pages most relevant to the supplied query. Prefer direct, substantive and information-rich pages. " +
  "Exclude unrelated results. Return search-result evidence only, and do not infer trading direction, asset quality or profitability.";
/** Pins BOTH the objective text and its version (a change here is a contract change). */
export const EXA_SEARCH_OBJECTIVE_DIGEST = digestOf({
  version: EXA_SEARCH_OBJECTIVE_VERSION,
  objective: EXA_SEARCH_OBJECTIVE_V1,
});

/** EVOLVE's hard cap for ONE Exa transport request: never ask Exa for more than this. */
export const EXA_WEB_SEARCH_MAX_RESULTS = 25;

/**
 * The CONSTRAINED named-tool-argument template form.
 *
 * Only a token of the exact shape `<approvedKey>={<approvedPlaceholder>}` is
 * ever recognised: one key, one placeholder, one substitution per token. Nested
 * braces, multiple placeholders, an unknown key, an unknown placeholder and a
 * caller-defined argument name are all refused. There is no general string
 * interpolation anywhere in the adapter — each item stays its OWN argv token.
 */
export const REACH_NAMED_ARGUMENT_PATTERN = /^([A-Za-z][A-Za-z0-9_]*)=\{([A-Za-z][A-Za-z0-9_]*)\}$/;

/** The ONLY placeholder names a named argument may resolve through. */
export const REACH_NAMED_ARGUMENT_PLACEHOLDERS = Object.freeze(["query", "limit", "objective"]);

/** The ONLY argument keys the MCPorter/Exa capability may declare. */
export const REACH_MCPORTER_ARGUMENT_KEYS = Object.freeze(["query", "numResults", "objective"]);

/**
 * The FROZEN key → placeholder PAIRING for the MCPorter/Exa contract.
 *
 * A named argument is accepted only as one of these exact pairs, so a forged or
 * hostile capability entry can neither invent a tool-argument name
 * (`maxResults=`, `limit=`, …) nor re-point a key at another placeholder (which
 * could otherwise push caller text into the `objective` slot).
 */
export const REACH_MCPORTER_ARGUMENT_TEMPLATES = Object.freeze({
  query: "query",
  numResults: "limit",
  objective: "objective",
});

/**
 * The FROZEN named-argument keys, per upstream executable.
 *
 * A named argument is accepted only when its key is a frozen literal for the
 * executable the capability declares — so a forged/hostile capability entry can
 * never define its own tool-argument name (`maxResults=`, `limit=`, …), even if
 * it tries to declare one.
 */
export const REACH_FROZEN_ARGUMENT_KEYS_BY_BINARY = Object.freeze({
  mcporter: REACH_MCPORTER_ARGUMENT_KEYS,
});

/** The bounded result-count argument name at the Exa provider boundary. */
export const EXA_RESULT_COUNT_ARGUMENT = "numResults";

/**
 * MCPorter's explicit output-format flag.
 *
 * `--output <format>` writes no file: it selects MCPorter's OUTPUT FORMAT, and
 * EVOLVE always asks for `raw` so the COMPLETE MCP CallResult is available to
 * the bounded parser (a JSON convenience mode must never decide how many
 * results exist). The flag is only ever accepted for MCPorter and only ever
 * followed by an approved format — the file-writing flag list stays closed for
 * every other tool (+ everything else MCPorter could be asked to do).
 */
export const REACH_MCPORTER_OUTPUT_FLAG = "--output";
export const REACH_MCPORTER_OUTPUT_FORMATS = Object.freeze(["raw"]);
export const REACH_MCPORTER_OUTPUT_BINARIES = Object.freeze(["mcporter"]);

/**
 * Side-effect-free health operations. These are INTERNAL ONLY: they exist for the
 * doctor/probe path, are never produced by a query template, and are never
 * reachable from research/strategy state. They are deliberately NOT added to the
 * public read-only action allowlist.
 */
export const INTERNAL_REACH_HEALTH_ACTIONS = Object.freeze(["version", "health"]);

/**
 * Executables EVOLVE may ever launch for intelligence capture. Basenames only:
 * a caller can never point the adapter at an arbitrary binary, and a
 * path-qualified name (e.g. `/usr/bin/gh`) is refused outright.
 *
 * `agent-reach` is the pinned HEALTH/router executable; every other entry is an
 * approved upstream READ tool that the pinned capability map may select.
 */
export const REACH_EXECUTABLE_ALLOWLIST = Object.freeze([
  "agent-reach",
  "gh",
  "twitter",
  "rdt",
  "mcporter",
  "curl",
]);

/** The pinned health/router executable — the ONLY one used for a health probe. */
export const REACH_HEALTH_EXECUTABLE = AGENT_REACH_PIN.cli;

/**
 * Approved UPSTREAM read executables (the allowlist minus the pinned router).
 * Every entry here is resolved through `resolveCapabilityExecutable`; none of
 * them is ever replaced by, or routed through, the pinned Agent-Reach CLI.
 */
export const REACH_UPSTREAM_EXECUTABLES = Object.freeze(
  REACH_EXECUTABLE_ALLOWLIST.filter((basename) => basename !== REACH_HEALTH_EXECUTABLE),
);

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

/**
 * Raised when an approved upstream executable cannot be resolved on the
 * SANITIZED PATH. It is deliberately NOT a fallback trigger: the caller records
 * the query/channel as unavailable and moves on.
 */
export class ReachExecutableUnavailableError extends Error {
  constructor(basename, searched = []) {
    super(
      `upstream executable '${basename}' is not available on the sanitized PATH (searched ${searched.length} ` +
        "director(ies)) — the channel is reported UNAVAILABLE. EVOLVE never installs it, never routes it through " +
        "the pinned Agent-Reach CLI, and never falls back to another backend.",
    );
    this.name = "ReachExecutableUnavailableError";
    this.basename = basename;
    this.searched = [...searched];
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

/**
 * Raised BEFORE a capture places any upstream call when the exact rendered query
 * plan needs an executable that is not present on the sanitized PATH.
 *
 * This is deliberately finer-grained than the missing-executable runtime failure:
 * every query is inspected offline first, so a plan that cannot run locally fails
 * closed with ZERO upstream calls and WITHOUT writing a partial capture artifact.
 * Nothing is installed, nothing is routed through the pinned Agent-Reach CLI, and
 * no other backend is substituted.
 *
 * Diagnostics are bounded and carry no environment dump: channel, operation,
 * executable basename and the availability flag only.
 */
export class ReachPlanUnavailableError extends Error {
  constructor(readiness = {}) {
    const rows = Array.isArray(readiness?.unavailableQueries) ? readiness.unavailableQueries : [];
    const total = Number.isFinite(readiness?.queryCount) ? readiness.queryCount : rows.length;
    const summary = rows
      .slice(0, 8)
      .map((row) => `${row.channel ?? "-"}/${row.operation ?? "-"} -> ${row.binary ?? "(no capability)"} unavailable`)
      .join("; ");
    super(
      `the rendered query plan is UNAVAILABLE locally: ${rows.length} of ${total} rendered quer(y/ies) require an ` +
        `executable that is not present on the sanitized PATH (${summary}). EVOLVE never installs it, never routes it through ` +
        "the pinned Agent-Reach CLI, and never falls back to another backend. No upstream call was placed and no capture " +
        "artifact was written.",
    );
    this.name = "ReachPlanUnavailableError";
    this.queryCount = total;
    // Bounded, environment-free diagnostics: one row per unavailable query.
    this.unavailable = rows.map((row) => ({
      channel: row.channel ?? null,
      operation: row.operation ?? null,
      binary: row.binary ?? null,
      available: false,
    }));
    this.unavailableReasons = [...(readiness?.unavailableReasons ?? [])];
    this.capabilities = [...(readiness?.capabilities ?? [])];
  }
}

/* ============================================================================
 * The frozen command map
 * ==========================================================================*/

/**
 * FROZEN capability map (V1). Placeholders (`{query}`, `{limit}`, `{url}`,
 * `{readerUrl}`, `{timeoutSeconds}`) are the ONLY substitution points, and each
 * is validated before it becomes its own argv element (never
 * string-interpolated).
 *
 * FROZEN FOREVER: this map bounded every historical capture, so it is never
 * mutated. Phase 5G.1b introduced `REACH_CAPABILITY_MAP_V2` as an explicit,
 * versioned successor for NEW captures (see below).
 *
 * The `binary` field names the executable each entry is launched WITH (see
 * `resolveCapabilityExecutable`): `agent-reach` only for the two side-effect-free
 * health entries, and the upstream READ tool Agent-Reach documents for every data
 * entry. The argv of a data entry is NEVER handed to the pinned `agent-reach`
 * CLI — it is a router/doctor layer, not a generic `search`/`read` proxy.
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
    "`curl` is its documented Jina-Reader/RSS read path. Each entry is launched with the executable it names; the pinned " +
    "`agent-reach` CLI only ever runs `version` and `doctor --json`. No write verb appears anywhere in this map.",
});

/**
 * The V2 replacement for ONE search entry: named tool arguments + explicit raw
 * output, with every item remaining its OWN argv token.
 *
 * The conceptual command is
 *
 *   mcporter call exa.web_search_exa query=<query> numResults=<limit> \
 *     objective=<frozen objective> --output raw
 *
 * but it is NEVER a string: it is an argv ARRAY handed to `spawn` with
 * `shell: false`, exactly like every V1 entry.
 */
function withMcpSearchInvocation(entry) {
  if (entry.op !== "search" || (entry.channel !== "exa" && entry.channel !== "web")) return entry;
  return Object.freeze({
    op: "search",
    channel: entry.channel,
    binary: "mcporter",
    tool: EXA_WEB_SEARCH_TOOL,
    // `<key>={<placeholder>}` only: no interpolation, no nesting, no caller keys.
    argv: Object.freeze([
      "call",
      EXA_WEB_SEARCH_TOOL,
      `query={query}`,
      `${EXA_RESULT_COUNT_ARGUMENT}={limit}`,
      `objective={objective}`,
      REACH_MCPORTER_OUTPUT_FLAG,
      REACH_MCPORTER_OUTPUT_FORMATS[0],
    ]),
    namedArguments: REACH_MCPORTER_ARGUMENT_KEYS,
  });
}

/**
 * FROZEN successor capability map (Phase 5G.1b).
 *
 * Identical to V1 — same twelve entries, in the same order, with the same
 * `(operation, channel, executable)` triples, the same allowlists, the same
 * `shell: false` launch and the same read-only discipline — EXCEPT the two
 * MCPorter search entries (`search:exa` and `search:web`), which now use the
 * named-tool-argument contract above and explicitly request `--output raw`.
 *
 * Nothing about V1 is redefined here: `extendsVersion` records the parent the
 * successor was derived from.
 */
export const REACH_CAPABILITY_MAP_V2 = Object.freeze({
  version: REACH_CAPABILITY_MAP_VERSION_V2,
  extendsVersion: REACH_CAPABILITY_MAP_VERSION,
  pinned: AGENT_REACH_PIN,
  entries: Object.freeze(REACH_CAPABILITY_MAP_V1.entries.map(withMcpSearchInvocation)),
  mcpSearch: Object.freeze({
    binary: "mcporter",
    tool: EXA_WEB_SEARCH_TOOL,
    queryArgument: "query",
    resultCountArgument: EXA_RESULT_COUNT_ARGUMENT,
    objectiveArgument: "objective",
    objectiveVersion: EXA_SEARCH_OBJECTIVE_VERSION,
    objectiveDigest: EXA_SEARCH_OBJECTIVE_DIGEST,
    maxResults: EXA_WEB_SEARCH_MAX_RESULTS,
    outputFlag: REACH_MCPORTER_OUTPUT_FLAG,
    outputFormat: REACH_MCPORTER_OUTPUT_FORMATS[0],
  }),
  note:
    "Read-only capability map successor. Only the MCPorter/Exa search invocation changed: named tool arguments " +
    "(`query=`, `numResults=`, `objective=`) plus an explicit `--output raw`, so MCPorter 0.13.13's `call` contract and " +
    "Exa's installed `web_search_exa` schema are both satisfied without any shell interpolation. `reach-capability-map-v1` " +
    "stays frozen and readable for historical captures; this map bounds every NEW capture.",
});

/** The capability map new captures are bounded by (an explicit, versioned successor). */
export const REACH_ACTIVE_CAPABILITY_MAP = REACH_CAPABILITY_MAP_V2;

/** Look up the frozen entry for (op, channel). */
export function capabilityFor(op, channel = null, capabilityMap = REACH_CAPABILITY_MAP_V1) {
  const requested = String(op ?? "").trim().toLowerCase();
  const action = INTERNAL_REACH_HEALTH_ACTIONS.includes(requested) ? requested : requireReadOnlyAction(op);
  const entries = (capabilityMap?.entries ?? REACH_CAPABILITY_MAP_V1.entries).filter((entry) => entry.op === action);
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

/**
 * Is this exact token position the ONE bounded `--output <format>` exception?
 *
 * `--output` stays a file-writing flag for every tool (and for every value)
 * except MCPorter's output-FORMAT selector, and then only when the very next
 * token is an approved format from the frozen allowlist (`raw`). Nothing else
 * about the flag list is relaxed.
 */
function isApprovedOutputFlag({ text, next, basename }) {
  if (text !== REACH_MCPORTER_OUTPUT_FLAG) return false;
  if (basename === null || !REACH_MCPORTER_OUTPUT_BINARIES.includes(basename)) return false;
  return REACH_MCPORTER_OUTPUT_FORMATS.includes(String(next ?? ""));
}

/** Reject a write-capable argv before anything is spawned. */
export function assertReadOnlyArgv(argv = [], { binary = null } = {}) {
  const basename = binary === null ? null : path.basename(String(binary));
  if (basename !== null && !REACH_EXECUTABLE_ALLOWLIST.includes(basename)) {
    throw new ReachBinaryError(
      `executable '${basename}' is not on the intelligence allowlist (${REACH_EXECUTABLE_ALLOWLIST.join(", ")}).`,
    );
  }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const text = String(token);
    // The bounded MCPorter output-FORMAT flag (writes no file): approved only
    // for `mcporter` and only when followed by an approved format token.
    if (isApprovedOutputFlag({ text, next: argv[index + 1], basename })) continue;
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

/* ----------------------------------------------------------------------------
 * Executable resolution (health vs upstream)
 * --------------------------------------------------------------------------*/

/** Bound on how much of PATH is ever walked. */
const MAX_TRUSTED_PATH_ENTRIES = 256;
/** Fallback executable extensions, Windows only (POSIX relies on the X bit). */
const WINDOWS_EXECUTABLE_EXTENSIONS = Object.freeze([".exe", ".cmd", ".bat"]);

function realpathOrNull(target) {
  try {
    return fs.realpathSync(target);
  } catch {
    return null;
  }
}

/** A regular file that this process may execute (best effort, never throws). */
export function isExecutableFile(candidate) {
  try {
    if (!fs.statSync(candidate).isFile()) return false;
  } catch {
    return false;
  }
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    // On Windows the execute bit is not meaningful: a readable regular file with
    // a known executable extension is the closest equivalent.
    if (process.platform === "win32") {
      try {
        fs.accessSync(candidate, fs.constants.R_OK);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
}

/**
 * Split a PATH value into ABSOLUTE, de-duplicated directories.
 *
 * Relative entries (and empty segments, which historically mean "the current
 * directory") are DROPPED: a relative PATH entry is a binary-hijack vector, and
 * nothing in the intelligence layer may be resolved out of the working
 * directory. The walk is bounded by `MAX_TRUSTED_PATH_ENTRIES`.
 */
export function trustedPathDirs(pathValue) {
  const raw = typeof pathValue === "string" ? pathValue : "";
  const dirs = [];
  for (const entry of raw.split(path.delimiter)) {
    const dir = entry.trim();
    if (dir.length === 0) continue;
    if (!path.isAbsolute(dir)) continue;
    if (dirs.includes(dir)) continue;
    dirs.push(dir);
    if (dirs.length >= MAX_TRUSTED_PATH_ENTRIES) break;
  }
  return dirs;
}

/**
 * Bounded, shell-free PATH search for ONE allowlisted basename.
 *
 * Nothing is shelled out (`which`/`command -v`/`bash -c` are never used): the
 * search splits the PATH itself, builds `<dir>/<basename>`, and returns the first
 * legitimate executable. Symlinks are followed (as any exec would) and the
 * `realpath` is retained as diagnostic metadata only.
 */
export function searchTrustedPath(basename, { path: pathValue = null } = {}) {
  const searched = trustedPathDirs(pathValue);
  for (const dir of searched) {
    const names =
      process.platform === "win32" ? [basename, ...WINDOWS_EXECUTABLE_EXTENSIONS.map((ext) => `${basename}${ext}`)] : [basename];
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (!isExecutableFile(candidate)) continue;
      return { path: candidate, realPath: realpathOrNull(candidate), searched };
    }
  }
  return { path: null, realPath: null, searched };
}

/**
 * Resolve the executable ONE capability entry is launched with.
 *
 * Rules (all fail closed):
 *
 *   1. `capability.binary === "agent-reach"` → the exact pinned project-local
 *      binary, used ONLY for `version` / `doctor --json`.
 *   2. any other `capability.binary` MUST be a bare basename on
 *      `REACH_EXECUTABLE_ALLOWLIST` — a path-qualified name, an arbitrary
 *      caller-supplied executable, or `""` is refused with `ReachBinaryError`.
 *   3. the upstream executable is resolved with the bounded PATH search above
 *      (never a shell, never `which`, never command interpolation).
 *   4. the PATH used is the SANITIZED one: the same environment handed to the
 *      child, so look-up and launch can never disagree.
 *   5. selection depends on the capability entry and the PATH alone — a query, a
 *      candidate, a genome, a proposal or an LLM answer cannot influence it.
 *
 * A missing upstream executable is reported as `available: false` (with the
 * searched directories); it never throws and never triggers an install.
 *
 * @returns {{ op: string|null, channel: string|null, basename: string,
 *   role: "health"|"upstream", source: string, path: string|null,
 *   realPath: string|null, available: boolean, searched: string[] }}
 */
export function resolveCapabilityExecutable(capability, { reachBin = null, projectRoot = process.cwd(), path: pathValue = null, env = null } = {}) {
  const declared = capability?.binary;
  const name = typeof declared === "string" ? declared : "";
  const basename = name.length > 0 ? path.basename(name) : "";
  const op = capability?.op ?? null;
  const channel = capability?.channel ?? null;

  if (name.length === 0 || basename !== name) {
    throw new ReachBinaryError(
      `capability '${op ?? "?"}' declares the executable '${name}', which is refused: only a bare basename from the ` +
        `intelligence allowlist is accepted (${REACH_EXECUTABLE_ALLOWLIST.join(", ")}). A path-qualified or ` +
        "caller-supplied executable is never launched.",
    );
  }
  if (!REACH_EXECUTABLE_ALLOWLIST.includes(basename)) {
    throw new ReachBinaryError(
      `executable '${basename}' is not on the intelligence allowlist (${REACH_EXECUTABLE_ALLOWLIST.join(", ")}).`,
    );
  }

  if (basename === REACH_HEALTH_EXECUTABLE) {
    const pinned = resolveReachBinary({ reachBin, projectRoot });
    return Object.freeze({
      op,
      channel,
      basename,
      role: "health",
      source: "agent-reach-pin",
      path: pinned,
      realPath: realpathOrNull(pinned),
      available: isExecutableFile(pinned),
      searched: Object.freeze([]),
    });
  }

  const effectivePath = pathValue ?? (typeof env?.PATH === "string" ? env.PATH : process.env.PATH);
  const found = searchTrustedPath(basename, { path: effectivePath });
  return Object.freeze({
    op,
    channel,
    basename,
    role: "upstream",
    source: "sanitized-path",
    path: found.path,
    realPath: found.realPath,
    available: found.path !== null,
    searched: Object.freeze([...found.searched]),
  });
}

/* ----------------------------------------------------------------------------
 * Operation-aware capability health (offline, read-only)
 *
 * Channel-level health is too coarse: `web` search needs `mcporter` while
 * `web` read needs `curl`, and an upstream doctor that only knows `web` is
 * reachable cannot tell the two apart. These helpers expose health at the exact
 * (channel, operation) capability level the frozen map defines.
 *
 * NOTHING here is spawned, installed or fetched: executable availability is
 * resolved with the bounded sanitized-PATH walk above (`stat`/`access` only), so
 * an inspection is pure and can run during a doctor without an upstream query.
 * --------------------------------------------------------------------------*/

/** The frozen DATA capability entries (every entry that names a channel). */
export function reachDataCapabilityEntries(capabilityMap = REACH_CAPABILITY_MAP_V1) {
  return (capabilityMap?.entries ?? []).filter((entry) => entry.channel !== null && entry.channel !== undefined);
}

/**
 * Inspect EVERY frozen data capability for local executable availability.
 *
 * @returns {{ capabilityMapVersion: string, health: object, capabilities: object[],
 *   byChannel: object, channels: string[], networkCalls: number, subprocessesSpawned: number }}
 */
export function inspectReachCapabilities({
  reachBin = null,
  projectRoot = process.cwd(),
  path: pathValue = null,
  env = null,
  capabilityMap = REACH_CAPABILITY_MAP_V1,
} = {}) {
  const resolveOptions = { reachBin, projectRoot, path: pathValue, env };
  const health = resolveCapabilityExecutable(capabilityFor("health"), resolveOptions);
  const byChannel = {};
  const capabilities = [];
  for (const entry of reachDataCapabilityEntries(capabilityMap)) {
    const resolved = resolveCapabilityExecutable(entry, resolveOptions);
    const row = Object.freeze({
      channel: entry.channel,
      operation: entry.op,
      binary: resolved.basename,
      executablePath: resolved.path,
      available: resolved.available,
      source: resolved.source,
      role: resolved.role,
    });
    capabilities.push(row);
    (byChannel[row.channel] ??= {})[row.operation] = row;
  }
  return Object.freeze({
    capabilityMapVersion: capabilityMap?.version ?? REACH_CAPABILITY_MAP_VERSION,
    health: Object.freeze({
      binary: health.basename,
      executablePath: health.path,
      available: health.available,
      source: health.source,
      role: health.role,
    }),
    capabilities: Object.freeze(capabilities),
    byChannel: Object.freeze(byChannel),
    channels: Object.freeze(Object.keys(byChannel).sort()),
    // Proven purity: an inspection executes nothing and reads no network.
    networkCalls: 0,
    subprocessesSpawned: 0,
    note:
      "Offline capability inspection: executable availability is resolved with a bounded sanitized-PATH walk (stat/access " +
      "only). Local availability does NOT claim the external source is healthy — it only establishes that EVOLVE has the " +
      "executable the frozen (channel, operation) requires.",
  });
}

/**
 * Evaluate a DETERMINISTIC rendered query plan against the frozen capability map.
 *
 * Every query is resolved to its (operation, channel) capability, then to the
 * executable that capability names, and finally to local availability. No network
 * call and no subprocess is made.
 *
 * @returns {{ queryCount: number, readyQueries: object[], unavailableQueries: object[],
 *   ready: boolean, capabilities: object[], unavailableReasons: string[], counts: object }}
 */
export function evaluateReachPlanReadiness(plan, {
  reachBin = null,
  projectRoot = process.cwd(),
  path: pathValue = null,
  env = null,
  capabilityMap = REACH_CAPABILITY_MAP_V1,
} = {}) {
  const queries = Array.isArray(plan?.queries) ? plan.queries : [];
  const resolveOptions = { reachBin, projectRoot, path: pathValue, env };
  const cache = new Map();

  const capabilityOf = (op, channel) => {
    const key = `${op}:${channel}`;
    if (cache.has(key)) return cache.get(key);
    const entry = reachDataCapabilityEntries(capabilityMap).find(
      (candidate) => candidate.op === op && candidate.channel === channel,
    );
    let row = null;
    if (entry) {
      const resolved = resolveCapabilityExecutable(entry, resolveOptions);
      row = Object.freeze({
        channel: entry.channel,
        operation: entry.op,
        binary: resolved.basename,
        executablePath: resolved.path,
        available: resolved.available,
        source: resolved.source,
        role: resolved.role,
      });
    }
    cache.set(key, row);
    return row;
  };

  const readyQueries = [];
  const unavailableQueries = [];
  for (const query of queries) {
    const operation = String(query?.op ?? "search").trim().toLowerCase();
    const channel = query?.channel ?? null;
    const queryId = query?.queryId ?? null;
    const capability = capabilityOf(operation, channel);
    if (!capability) {
      unavailableQueries.push({
        queryId,
        operation,
        channel,
        binary: null,
        available: false,
        reason: `no frozen capability exists for ${channel ?? "-"}/${operation}`,
      });
      continue;
    }
    if (capability.available) {
      readyQueries.push({ queryId, operation, channel, binary: capability.binary });
    } else {
      unavailableQueries.push({
        queryId,
        operation,
        channel,
        binary: capability.binary,
        available: false,
        reason: `${channel ?? "-"}/${operation} requires '${capability.binary}', which is not available on the sanitized PATH`,
      });
    }
  }

  return Object.freeze({
    querySetId: plan?.querySetId ?? null,
    queryCount: queries.length,
    readyQueries,
    unavailableQueries,
    ready: unavailableQueries.length === 0,
    capabilities: [...cache.values()].filter(Boolean),
    unavailableReasons: unavailableQueries.map((row) => row.reason),
    counts: { total: queries.length, ready: readyQueries.length, unavailable: unavailableQueries.length },
    networkCalls: 0,
    note:
      "Offline plan readiness: the exact rendered query plan is resolved against the frozen capability map. A ready plan " +
      "only means EVOLVE has the required local executable — it does not claim the external source is healthy.",
  });
}

/**
 * Resolve the FROZEN Exa search objective.
 *
 * The objective is a code literal. A caller that tries to supply one (a
 * candidate, an LLM answer, a strategy, a research proposal — anything that can
 * reach `values`) is REFUSED rather than silently overridden.
 */
function resolveFrozenObjective(values = {}) {
  const supplied = values.objective;
  if (supplied !== undefined && supplied !== null && String(supplied) !== EXA_SEARCH_OBJECTIVE_V1) {
    throw new ReachCommandError(
      "the Exa search objective is FROZEN (EXA_SEARCH_OBJECTIVE_V1, version " +
        `${EXA_SEARCH_OBJECTIVE_VERSION}) and may never be supplied by a caller, a candidate, an LLM answer, a strategy or a ` +
        "research proposal — a substituted objective is refused.",
    );
  }
  return validateArgvValue("objective", EXA_SEARCH_OBJECTIVE_V1);
}

/**
 * Resolve a bounded result count for one named argument.
 *
 * EVOLVE's generic `limit` concept is unchanged: the query set still passes its
 * own logical `limit`, and only the Exa transport request is additionally
 * clamped to `EXA_WEB_SEARCH_MAX_RESULTS`. The requested/effective pair is
 * reported as bounded diagnostics (never a raw payload).
 */
function resolveResultCount({ key, placeholder, values, boundedArguments }) {
  const requested = Number.parseInt(validateArgvValue(placeholder, values[placeholder]), 10);
  if (!Number.isFinite(requested)) {
    throw new ReachCommandError(`the result count for named argument '${key}' is not a number`);
  }
  const max = key === EXA_RESULT_COUNT_ARGUMENT ? EXA_WEB_SEARCH_MAX_RESULTS : Number.MAX_SAFE_INTEGER;
  const effective = Math.max(1, Math.min(max, requested));
  boundedArguments.push({ argument: key, requested, effective, max, clamped: effective !== requested });
  return String(effective);
}

/**
 * Build the exact argv for one call: substitution happens slot-by-slot, and each
 * slot is validated on its own. `{readerUrl}` composes the read-only Jina Reader
 * URL from an already-validated https source URL.
 *
 * TWO template forms exist, and only these two:
 *
 *   1. `{placeholder}`      a WHOLE token (every V1 entry): the substituted value
 *                           becomes that entire argv element.
 *   2. `<key>={placeholder}` a constrained NAMED-ARGUMENT token (the V2 MCPorter
 *                           contract): the key must be a frozen literal the
 *                           capability map declared, the placeholder must be one
 *                           of the three approved names, and the value is
 *                           validated through the SAME path as form 1 before it
 *                           becomes its own argv element.
 *
 * Anything else — a nested placeholder, two placeholders in one token, an
 * unapproved key, an unknown placeholder, a caller-defined argument name, a
 * stray brace — is refused. There is no general string interpolation, no eval,
 * no string-built command and no shell.
 */
export function buildReachArgv({ op, channel = null, values = {}, entry = null, capabilityMap = REACH_CAPABILITY_MAP_V1 } = {}) {
  const capability = entry ?? capabilityFor(op, channel, capabilityMap);
  const frozenKeys = REACH_FROZEN_ARGUMENT_KEYS_BY_BINARY[capability.binary] ?? [];
  const declaredKeys = Array.isArray(capability.namedArguments) ? capability.namedArguments : [];
  // A caller-defined argument NAME is refused outright, even before a token is
  // inspected: only the executable's frozen key literals may be declared.
  const undeclared = declaredKeys.filter((key) => !frozenKeys.includes(key));
  if (undeclared.length > 0) {
    throw new ReachCommandError(
      `capability '${capability.op}/${capability.channel ?? "-"}' declares the named argument(s) ` +
        `${undeclared.map((key) => `'${key}'`).join(", ")}, which are not frozen keys for '${capability.binary}' ` +
        `(frozen: ${frozenKeys.join(", ") || "none"}) — a caller can never define a tool argument name.`,
    );
  }
  const approvedKeys = declaredKeys;
  const boundedArguments = [];
  const argv = capability.argv.map((token) => {
    if (token.startsWith("{")) {
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
    }
    const named = REACH_NAMED_ARGUMENT_PATTERN.exec(token);
    if (named) {
      const [, key, placeholder] = named;
      if (!approvedKeys.includes(key)) {
        throw new ReachCommandError(
          `named argument '${key}' is not approved for capability '${capability.op}/${capability.channel ?? "-"}' ` +
            `(approved: ${approvedKeys.join(", ") || "none"}) — a caller can never define a tool argument name.`,
        );
      }
      if (!REACH_NAMED_ARGUMENT_PLACEHOLDERS.includes(placeholder)) {
        throw new ReachCommandError(
          `named argument '${key}' references the unknown placeholder '{${placeholder}}' (approved: ` +
            `${REACH_NAMED_ARGUMENT_PLACEHOLDERS.map((name) => `{${name}}`).join(", ")}).`,
        );
      }
      // The pairing is FROZEN: `query={query}`, `numResults={limit}`,
      // `objective={objective}`. Nothing else is a valid named argument.
      const expected = REACH_MCPORTER_ARGUMENT_TEMPLATES[key];
      if (expected !== undefined && placeholder !== expected) {
        throw new ReachCommandError(
          `named argument '${key}' may only resolve '{${expected}}' (got '{${placeholder}}') — the key/placeholder pairing is frozen.`,
        );
      }
      // The `objective` key can NEVER carry caller text: it is always the frozen
      // constant, whatever a caller put in `values`.
      if (key === "objective") return `${key}=${resolveFrozenObjective(values)}`;
      if (key === EXA_RESULT_COUNT_ARGUMENT) {
        return `${key}=${resolveResultCount({ key, placeholder, values, boundedArguments })}`;
      }
      return `${key}=${validateArgvValue(placeholder, values[placeholder])}`;
    }
    if (TEMPLATE_BRACES.test(token)) {
      throw new ReachCommandError(
        `argv token '${token}' is neither an approved whole-token placeholder nor a single approved named argument and is refused`,
      );
    }
    return token;
  });
  assertReadOnlyArgv(argv, { binary: capability.binary });
  return { capability, argv, boundedArguments };
}

/**
 * Run ONE bounded, read-only intelligence call.
 *
 * The executable is chosen by the FROZEN capability entry — never by the pinned
 * Agent-Reach CLI for a data operation, and never by anything a caller passes:
 *
 *   version / health  → the pinned project-local `agent-reach` (`version`, `doctor --json`)
 *   github            → `gh`
 *   x                 → `twitter`
 *   reddit            → `rdt`
 *   exa / web search  → `mcporter`
 *   web / rss read    → `curl`
 *
 * A missing upstream executable is a bounded, recorded UNAVAILABLE result: no
 * spawn, no install, no fallback.
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
  capabilityMap = REACH_CAPABILITY_MAP_V1,
} = {}) {
  const requested = String(op ?? "").trim().toLowerCase();
  const action = INTERNAL_REACH_HEALTH_ACTIONS.includes(requested) ? requested : requireReadOnlyAction(op);
  // argv is built (and validated read-only) BEFORE anything can be spawned.
  const { capability, argv, boundedArguments } = buildReachArgv({ op: action, channel, values, capabilityMap });
  // The budget is consumed before the executable is resolved, so an exhausted
  // budget refuses the call without even a filesystem walk.
  if (budget) budget.take();

  const timeoutMs = Math.min(config?.timeoutMs ?? 20_000, 600_000);
  const maxBytes = Math.min(config?.maxBytes ?? 262_144, 8_388_608);
  const childEnv = sanitizeReachEnv(env);
  // Look-up uses the SAME sanitized PATH that the child receives.
  const executable = resolveCapabilityExecutable(capability, {
    reachBin: config?.reachBin ?? null,
    projectRoot,
    env: childEnv,
  });

  const base = {
    op: action,
    channel,
    capability: capability.op,
    // Which capability CONTRACT bounded this call, and any bounded result-count
    // clamp that was applied at the provider boundary (requested vs effective).
    capabilityMapVersion: capabilityMap?.version ?? REACH_CAPABILITY_MAP_VERSION,
    tool: capability.tool ?? null,
    boundedArguments,
    binary: executable.basename,
    executable: {
      basename: executable.basename,
      role: executable.role,
      source: executable.source,
      path: executable.path,
      realPath: executable.realPath,
      available: executable.available,
    },
    argv,
    commandPreview: `${executable.basename} ${argv.join(" ")}`,
    maxBytes,
    timeoutMs,
    envKeys: Object.keys(childEnv).sort(),
    // Both self-checks reuse the single deny-list above, so the vocabulary that
    // forbids credentials lives in exactly ONE place.
    walletEnvPresent: Object.keys(childEnv).some((key) => FORBIDDEN_ENV_PATTERN.test(key)),
    tokensInEnv: Object.keys(childEnv).some((key) => FORBIDDEN_ENV_PATTERN.test(key)),
  };

  // An approved upstream tool that is not installed is a bounded FAILURE for this
  // query/channel. Nothing is installed, nothing is substituted, nothing is
  // spawned, and the pinned Agent-Reach CLI is never used as a fallback.
  if (executable.role === "upstream" && !executable.available) {
    const unavailable = new ReachExecutableUnavailableError(executable.basename, executable.searched);
    return {
      ...base,
      ok: false,
      spawned: false,
      unavailable: true,
      status: null,
      timedOut: false,
      overflowed: false,
      durationMs: 0,
      bytes: 0,
      stdout: "",
      stderr: "",
      error: unavailable.message,
      errorName: unavailable.name,
      searched: [...executable.searched],
    };
  }

  const started = Date.now();
  const result = spawn(executable.path, argv, {
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
    ...base,
    ok,
    spawned: true,
    unavailable: false,
    status: result?.status ?? null,
    timedOut,
    overflowed,
    durationMs,
    bytes: Buffer.byteLength(stdout, "utf8"),
    stdout: ok ? stdout.slice(0, maxBytes) : "",
    stderr: stderr.slice(0, 2_048),
    error: ok
      ? null
      : timedOut
        ? `timed out after ${timeoutMs}ms`
        : overflowed
          ? `output exceeded the ${maxBytes}-byte limit`
          : `exit ${result?.status ?? "signal"}${stderr ? `: ${stderr.trim().slice(0, 200)}` : ""}`,
    errorName: ok ? null : timedOut ? "ReachTimeoutError" : overflowed ? "ReachOutputOverflowError" : "ReachCallError",
  };
}

/** `version` + `doctor --json` — side-effect-free health for the doctor/probe CLI. */
export function probeReachHealth({ config, env = process.env, projectRoot = process.cwd(), spawn = spawnSync } = {}) {
  // ONLY the two side-effect-free Agent-Reach paths run here: no upstream tool is
  // resolved, launched or queried, so a doctor can never turn into a capture.
  const version = runReachCall({ op: "version", config, env, projectRoot, spawn });
  const doctor = runReachCall({ op: "health", config, env, projectRoot, spawn });
  return {
    provider: "agent-reach",
    pinned: AGENT_REACH_PIN,
    binary: path.basename(resolveReachBinary({ reachBin: config?.reachBin ?? null, projectRoot })),
    executables: {
      health: { basename: version.binary, source: version.executable.source, path: version.executable.path },
      upstream: [...REACH_UPSTREAM_EXECUTABLES],
    },
    version: { ok: version.ok, stdout: version.stdout.trim(), error: version.error, commandPreview: version.commandPreview },
    doctor: {
      ok: doctor.ok,
      json: parseJsonSafe(doctor.stdout),
      error: doctor.error,
      bytes: doctor.bytes,
      commandPreview: doctor.commandPreview,
    },
    upstreamCalls: 0,
    channels: { enabled: config?.channels ?? [] },
    readOnly: true,
    paperOnly: true,
    note:
      "Read-only probe. `version` + `doctor --json` are the ONLY commands executed: the pinned Agent-Reach CLI is a router/doctor " +
      "layer, so no upstream intelligence tool is queried during a doctor. (`doctor --json` is used deliberately: the text path " +
      "installs skill files, the JSON path does not.)",
  };
}

function parseJsonSafe(text) {
  try {
    return JSON.parse(String(text ?? ""));
  } catch {
    return null;
  }
}

export { READ_ONLY_ACTIONS };
