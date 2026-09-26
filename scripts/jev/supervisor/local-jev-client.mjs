/**
 * Phase 5I-PS.2e — the SHARED Local JEV client boundary.
 *
 * EVOLVE does NOT fork the Local JEV logic. This module is a thin adapter over
 * the shared implementation's own public interface:
 *
 *   decision ask --caller evolve --mode local-first   (JSON request on stdin,
 *                                                      one JSON outcome on stdout)
 *
 * The shared implementation owns the tiers, the acceptance policy, the retries,
 * the escalation rules and the persistent NobodyWho worker. PS.2e only:
 *
 *   - resolves the shared installation READ-ONLY (executable + effective config),
 *   - verifies the precommitted primary-classifier identity before any call,
 *   - sends the canonical request built by `local-tev-questions.mjs`,
 *   - validates the echoed answer strictly (fail closed: malformed is never a
 *     decision),
 *   - records the ACTUAL route: primary classifier, escalated local tier or the
 *     TypeSafe fallback tier, with the escalation reason.
 *
 * NO SECRETS. The child process receives a minimal allow-listed environment;
 * API-key/token/secret variables are never forwarded and never persisted. The
 * shared system reads its own key file only when its operator enabled TypeSafe.
 *
 * NO FAKE PROBABILITIES. The local classifier reports grammar-constrained option
 * votes (a `sample_stability` proxy) and no calibrated probability. This module
 * preserves those true semantics and never relabels a vote share or a logit as a
 * probability.
 *
 * PAPER ONLY / SHADOW ONLY / DEVELOPMENT EVIDENCE ONLY. ZERO AUTHORITY.
 */

import { spawn as nodeSpawn } from "node:child_process";
import { access as fsAccess, readFile as fsReadFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { digestOf, sha256Hex } from "../../lib/hash.mjs";
import { isPlainObject } from "../../lib/sanitize.mjs";
import {
  PS2E_CIRCUIT_BREAKER,
  PS2E_CLASSIFIER_PROVIDER,
  PS2E_DECISION_SOURCES,
  PS2E_DECISIONS,
  PS2E_ESCALATION_TIERS,
  PS2E_FINALIZATION_BUDGET_MS,
  PS2E_LOCAL_JEV_CLI_COMMAND,
  PS2E_LOCAL_JEV_CONTRACT,
  PS2E_LOCAL_JEV_EXECUTABLE_ENV,
  PS2E_LOCAL_JEV_MAX_STDERR_BYTES,
  PS2E_LOCAL_JEV_MAX_STDOUT_BYTES,
  PS2E_LOCAL_JEV_MODE,
  PS2E_LOCAL_TIER_COUNT_CEILING,
  PS2E_LOGICAL_CALL_TIMEOUT_MS,
  PS2E_MAX_FAILURE_REASON_LENGTH,
  PS2E_MAX_LOCAL_RETRIES_CEILING,
  PS2E_MAX_PERSISTED_ATTEMPTS_PER_RECORD,
  PS2E_OUTCOMES,
  PS2E_PHYSICAL_ATTEMPT_CEILING_PER_LOGICAL_CALL,
  PS2E_PRIMARY_TIER,
  PS2E_TYPESAFE_FALLBACK_PROVIDER,
  PS2E_TYPESAFE_FALLBACK_TIER,
  classifierPolicyProblems,
  effectiveLocalRetries,
  physicalAttemptCeilingFor,
  sharedIntegerValue,
  stripPythonWhitespace,
} from "./local-tev-protocol.mjs";
import {
  PS2E_ABSTAIN_TOKEN,
  PS2E_OPTION_TOKEN_COUNT,
  allowedTokens,
  buildLocalTevRequest,
  decisionFromOptionToken,
  localTevRequestIdFor,
} from "./local-tev-questions.mjs";

export const LOCAL_JEV_CLIENT_VERSION = 1;

export const LOCAL_JEV_CLIENT_STATUS = Object.freeze({
  OK: "LOCAL_JEV_OK",
  SKIPPED_BY_SHARED_ROUTER: "LOCAL_JEV_SKIPPED",
  REQUEST_REJECTED: "LOCAL_JEV_REQUEST_REJECTED",
  ROUTER_ERROR: "LOCAL_JEV_ROUTER_ERROR",
  MALFORMED: "LOCAL_JEV_MALFORMED",
  TIMEOUT: "LOCAL_JEV_TIMEOUT",
  EXIT_NONZERO: "LOCAL_JEV_EXIT_NONZERO",
  SPAWN_FAILED: "LOCAL_JEV_SPAWN_FAILED",
  REQUEST_TOO_LARGE: "LOCAL_JEV_REQUEST_TOO_LARGE",
});

/* ============================================================================
 * Environment projection (read-only; no secret is ever projected or persisted)
 * ==========================================================================*/

const ALLOWED_CHILD_ENV_KEYS = Object.freeze([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "TMPDIR",
  "TEMP",
  "TMP",
  "XDG_RUNTIME_DIR",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "VIRTUAL_ENV",
  "PYTHONPATH",
  // The shared configuration override is forwarded verbatim so the spawned child
  // resolves the SAME effective configuration readiness inspected (never one
  // config for inspection and another for execution).
  "DECISION_ROUTER_CONFIG_DIR",
]);

/**
 * Anything matching this is never forwarded to the child and never recorded.
 * Named as a declaration-shaped DENY vocabulary (the repo's documented
 * safety-vocabulary convention): this pattern IS the guard that forbids a
 * credential-bearing variable, never a capability — the child environment is
 * an allow-list on top of it.
 */
export const FORBIDDEN_SECRET_ENV_KEY_PATTERN = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE|AUTH|SIGNATURE|MNEMONIC|WALLET|PRIVATE|SALT|BEARER)/i;

/**
 * The minimal environment the shared Local JEV CLI receives. It deliberately
 * does NOT forward any secret-bearing variable (the shared system reads its own
 * key file only when its operator enabled the TypeSafe fallback).
 */
export function minimalChildEnv(env = process.env) {
  const out = { DECISION_ROUTER_CALLER: "evolve" };
  for (const key of ALLOWED_CHILD_ENV_KEYS) {
    const value = env?.[key];
    if (typeof value === "string" && value.length > 0) out[key] = value;
  }
  for (const key of Object.keys(out)) {
    if (FORBIDDEN_SECRET_ENV_KEY_PATTERN.test(key)) delete out[key];
  }
  return out;
}

/**
 * The shared implementation's own config path resolution (mirrored, read-only).
 * The shared router uses `DECISION_ROUTER_CONFIG_DIR` DIRECTLY as its config
 * directory (`config.json` inside it) and falls back to
 * `$XDG_CONFIG_HOME/decision-router` only when the override is empty or
 * whitespace. EVOLVE resolves exactly that path, and `minimalChildEnv` forwards
 * the override so the spawned child reads the SAME effective configuration
 * readiness inspected.
 */
export function resolveLocalJevConfigPath({ env = process.env, homeDir = os.homedir() } = {}) {
  const override = typeof env?.DECISION_ROUTER_CONFIG_DIR === "string" ? env.DECISION_ROUTER_CONFIG_DIR.trim() : "";
  const xdg = typeof env?.XDG_CONFIG_HOME === "string" ? env.XDG_CONFIG_HOME.trim() : "";
  const base = override.length > 0 ? override : path.join(xdg.length > 0 ? xdg : path.join(homeDir, ".config"), "decision-router");
  return path.join(base, "config.json");
}

/**
 * Normalize the Local JEV executable ONCE, for readiness and for the spawn
 * alike. A whitespace-only `EVOLVE_LOCAL_JEV_BIN` is treated as UNSET and falls
 * back to the documented default (`decision`, resolved by the child from PATH):
 * readiness and the spawned child can never disagree about which executable will
 * run, and a whitespace override can never become a runtime SPAWN_FAILED
 * surprise after READY.
 */
export function resolveLocalJevExecutable({ env = process.env, executable = null } = {}) {
  const explicit = typeof executable === "string" ? executable.trim() : "";
  const fromEnv = typeof env?.[PS2E_LOCAL_JEV_EXECUTABLE_ENV] === "string" ? env[PS2E_LOCAL_JEV_EXECUTABLE_ENV].trim() : "";
  if (explicit.length > 0) return { command: explicit, source: "explicit" };
  if (fromEnv.length > 0) return { command: fromEnv, source: `env:${PS2E_LOCAL_JEV_EXECUTABLE_ENV}` };
  return { command: PS2E_LOCAL_JEV_CLI_COMMAND, source: "PATH:decision" };
}

/**
 * The shared Local JEV configuration's own documented defaults (its config
 * module's DEFAULTS, resolved the same way): a decision tier inherits its
 * non-model settings from `local`, and the shared tier defaults apply where they
 * exist. These are used ONLY to resolve EFFECTIVE values the stored config
 * leaves implicit — never to invent a second timeout model.
 */
export const SHARED_LOCAL_JEV_DEFAULTS = Object.freeze({
  timeoutS: 60,
  samples: 3,
  temperature: 0.7,
  seed: 1234,
  nCtx: 2048,
  jevTimeoutS: 20,
});

/** Tier-level defaults of the shared config (tier 2 defaults to 300 s). */
const SHARED_TIER_DEFAULT_TIMEOUT_S = Object.freeze({ "2": 300 });

/**
 * The shared tier blocks' own DEFAULTS keys (`config.DEFAULTS["tiers"]` in the
 * pinned source): a tier key present here shadows the `local` value for that
 * tier, exactly like the shared deep merge. Only numeric keys matter here.
 */
const SHARED_TIER_DEFAULT_KEYS = Object.freeze({ "1": Object.freeze([]), "2": Object.freeze(["idle_timeout_s", "timeout_s"]) });

/** The shared acceptance DEFAULTS (`config.DEFAULTS["acceptance"]`). */
export const SHARED_ACCEPTANCE_DEFAULTS = Object.freeze({ minStability: 0.66, minMargin: 1, escalateOnAbstain: true });

/** The shared provider constructor's `samples` range (`1 <= int(samples) <= 15`). */
const SHARED_SAMPLES_RANGE = Object.freeze({ min: 1, max: 15 });

/**
 * The EFFECTIVE tier timeout after the shared configuration's inheritance is
 * resolved: an explicit tier `timeout_s`, else the shared tier default, else the
 * `local` block's `timeout_s`, else the shared local default. Same semantics as
 * the shared Local JEV configuration.
 */
export function effectiveTierTimeoutS({ tierName, tierTimeoutS = null, localTimeoutS = null } = {}) {
  if (typeof tierTimeoutS === "number" && Number.isFinite(tierTimeoutS)) return Math.max(0, tierTimeoutS);
  const tierDefault = SHARED_TIER_DEFAULT_TIMEOUT_S[String(tierName)];
  if (typeof tierDefault === "number") return tierDefault;
  if (typeof localTimeoutS === "number" && Number.isFinite(localTimeoutS)) return Math.max(0, localTimeoutS);
  return SHARED_LOCAL_JEV_DEFAULTS.timeoutS;
}

/**
 * Python's float literal grammar over ASCII digits: `digitpart` is digits with
 * at most ONE underscore BETWEEN two digits (mantissa and exponent alike), and
 * a number is `[digitpart] "." digitpart | digitpart ["."]`, then an optional
 * `e`/`E` exponent. `"0.2_5"` and `"1e1_0"` are accepted; `"_1"`, `"1_"`,
 * `"1__0"`, `"1_.5"`, `"1._5"`, `"1e_1"` and `"1_e1"` raise there.
 */
const PYTHON_DIGITPART = "[0-9](?:_?[0-9])*";
const PYTHON_FLOAT_LITERAL = new RegExp(
  `^[+-]?(?:${PYTHON_DIGITPART}(?:\\.(?:${PYTHON_DIGITPART})?)?|\\.${PYTHON_DIGITPART})(?:[eE][+-]?${PYTHON_DIGITPART})?$`,
);
const PYTHON_FLOAT_NON_FINITE_WORD = /^[+-]?(?:inf|infinity|nan)$/i;

/** Why a value has no representable effective float (see `sharedFloatCoercion`). */
export const SHARED_FLOAT_REFUSAL = Object.freeze({
  NOT_COERCIBLE: "not_coercible",
  NON_FINITE: "non_finite",
  NUMBER_OUT_OF_RANGE: "number_out_of_range",
  NON_ASCII_TEXT: "non_ascii_text",
});

/**
 * Exact mirror of the shared Python `float(...)` coercion over JSON values
 * (`float(temperature)` / `float(timeout_s)` / `float(idle_timeout_s)` in the
 * local provider, `float(min_stability)` in `acceptance.Policy.from_config`,
 * `float(timeout_s)` in the TypeSafe provider):
 *
 *   - booleans coerce to 1 / 0 (`float(True)` == 1.0, `float(False)` == 0.0);
 *   - finite numbers are kept (`-0.0` is normalized to 0: identical sampler
 *     behavior, and canonical JSON cannot tell them apart); a JSON number
 *     outside the binary64 range is refused (NUMBER_OUT_OF_RANGE): Python
 *     raises `OverflowError` for such an INTEGER literal but keeps a FLOAT
 *     literal as inf, and the parsed value cannot tell which it was;
 *   - strings follow Python's float grammar exactly: Python whitespace around
 *     the numeral, an optional sign, underscores only BETWEEN digits, optional
 *     fraction and exponent (`"0.2_5"` == 0.25, `" +2.5e-1 "` == 0.25);
 *   - null, arrays, objects and every other string raise there and are
 *     refused here (NOT_COERCIBLE).
 *
 * Two conservative refusals fail CLOSED where Python would still produce a
 * value: a NON-FINITE result (`"nan"`, `"inf"`, `"1e309"` overflow — the
 * shared stack has no finite check, but the canonical-JSON evidence cannot
 * represent NaN/Infinity, so persisting it would recreate a null effective
 * value) and any non-ASCII text left after the Python whitespace is stripped
 * (Python accepts Unicode decimal digits; the digit tables of two runtimes need
 * not agree, so EVOLVE never guesses, exactly like `sharedIntegerValue`). Neither can ever turn a refused value into an
 * accepted one.
 *
 * @returns {{ ok: true, value: number, refusal: null } | { ok: false, value: null, refusal: string }}
 */
export function sharedFloatCoercion(value) {
  const refuse = (refusal) => ({ ok: false, value: null, refusal });
  const accept = (number) => ({ ok: true, value: number === 0 ? 0 : number, refusal: null });
  if (typeof value === "boolean") return accept(value ? 1 : 0);
  if (typeof value === "number") {
    return Number.isFinite(value) ? accept(value) : refuse(SHARED_FLOAT_REFUSAL.NUMBER_OUT_OF_RANGE);
  }
  if (typeof value !== "string") return refuse(SHARED_FLOAT_REFUSAL.NOT_COERCIBLE);
  // `stripPythonWhitespace` is the SHARED Python-whitespace helper (measured on
  // the pinned interpreter; documented in local-tev-protocol.mjs): the same set
  // `int(...)` strips — never JavaScript's `trim()` set, so U+FEFF is refused.
  const text = stripPythonWhitespace(value);
  if (/[^\x00-\x7f]/.test(text)) return refuse(SHARED_FLOAT_REFUSAL.NON_ASCII_TEXT);
  if (PYTHON_FLOAT_NON_FINITE_WORD.test(text)) return refuse(SHARED_FLOAT_REFUSAL.NON_FINITE);
  if (!PYTHON_FLOAT_LITERAL.test(text)) return refuse(SHARED_FLOAT_REFUSAL.NOT_COERCIBLE);
  // The grammar is validated above, so dropping the underscores yields a plain
  // decimal literal; both runtimes round it to the nearest binary64 value.
  const parsed = Number(text.replace(/_/g, ""));
  return Number.isFinite(parsed) ? accept(parsed) : refuse(SHARED_FLOAT_REFUSAL.NON_FINITE);
}

/** The effective float of `sharedFloatCoercion`, or null when it is refused. */
export function sharedFloatValue(value) {
  return sharedFloatCoercion(value).value;
}

function floatRefusalText(refusal) {
  if (refusal === SHARED_FLOAT_REFUSAL.NON_FINITE) {
    return "coerces to a non-finite float, which the PS.2e evidence cannot represent (fail closed)";
  }
  if (refusal === SHARED_FLOAT_REFUSAL.NUMBER_OUT_OF_RANGE) {
    return "is a JSON number outside the float range (an integer literal makes the shared `float(...)` raise; fail closed)";
  }
  if (refusal === SHARED_FLOAT_REFUSAL.NON_ASCII_TEXT) {
    return "contains non-ASCII text, which EVOLVE never interprets as a numeral (fail closed)";
  }
  return "is not coercible with the shared `float(...)` semantics";
}

/**
 * Mirror of the shared Python `bool(...)` truthiness over JSON values
 * (`bool(use_gpu)` / `bool(cpu_fallback)` in the local provider constructor):
 * false, null, 0, "", [] and {} are false; everything else is true.
 */
function sharedBoolValue(value) {
  if (value === false || value === null || value === 0 || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (isPlainObject(value)) return Object.keys(value).length > 0;
  return true;
}

/**
 * The EFFECTIVE shared `acceptance.min_stability` — `float(a.get("min_stability",
 * 0.66))` then `0.0 <= value <= 1.0` or `acceptance.Policy.from_config` raises
 * (and the shared router refuses every call). It is also the worker's early-stop
 * `min_share`, so it alters the inference request as well as acceptance.
 *
 * @returns {{ ok: boolean, value: number|null, problem: string|null }}
 */
export function effectiveMinStability(value) {
  if (value === undefined) return { ok: true, value: SHARED_ACCEPTANCE_DEFAULTS.minStability, problem: null };
  const coerced = sharedFloatCoercion(value);
  if (!coerced.ok) {
    return { ok: false, value: null, problem: `acceptance.min_stability ${floatRefusalText(coerced.refusal)}` };
  }
  if (!(coerced.value >= 0 && coerced.value <= 1)) {
    return {
      ok: false,
      value: null,
      problem: "acceptance.min_stability must be within [0, 1] after shared coercion (the shared Policy refuses the config)",
    };
  }
  return { ok: true, value: coerced.value, problem: null };
}

/**
 * The EFFECTIVE shared `acceptance.min_margin` — `int(a.get("min_margin", 1))`
 * then `>= 0` or the shared Policy raises. Also the worker's early-stop margin.
 *
 * @returns {{ ok: boolean, value: number|null, problem: string|null }}
 */
export function effectiveMinMargin(value) {
  if (value === undefined) return { ok: true, value: SHARED_ACCEPTANCE_DEFAULTS.minMargin, problem: null };
  const coerced = sharedIntegerValue(value);
  if (coerced === null) {
    return { ok: false, value: null, problem: "acceptance.min_margin is not coercible with the shared `int(...)` semantics, or is outside the exact safe-integer range" };
  }
  if (coerced < 0) {
    return { ok: false, value: null, problem: "acceptance.min_margin must be >= 0 after shared coercion (the shared Policy refuses the config)" };
  }
  return { ok: true, value: coerced, problem: null };
}

/**
 * Every refusal the shared router's BUILD would raise on for the numeric
 * settings it coerces (`cli.build_router`, run by EVERY `decision ask`; any
 * exception becomes `router_error` with no decision), in the shared order:
 *
 *   1. the `local` provider (`NobodyWhoProvider.from_config(config)`), even in
 *      local-first mode;
 *   2. the TypeSafe provider when the shared system enables it
 *      (`float(jev.timeout_s)`);
 *   3. BOTH decision tiers (`NobodyWhoProvider.for_tier`, the merged
 *      `tier_settings`: tier key, else the shared tier default, else `local`,
 *      else the shared local default);
 *   4. `acceptance.Policy.from_config`.
 *
 * Each provider applies `1 <= int(samples) <= 15`, `float(temperature)`,
 * `int(seed)`, `int(n_ctx)`, `float(timeout_s)` and, when `persistent` is
 * truthy, `float(idle_timeout_s)`. `max_local_retries` is reported by its own
 * normalization (`effectiveLocalRetries`). A non-object block breaks the shared
 * deep merge the same way. An empty list means the shared build accepts every
 * numeric setting.
 *
 * @returns {string[]}
 */
export function sharedRouterBuildProblems(raw) {
  if (!isPlainObject(raw)) return ["the shared Local JEV config is not a JSON object"];
  const problems = [];
  for (const key of ["local", "jev", "tiers", "acceptance"]) {
    if (Object.hasOwn(raw, key) && !isPlainObject(raw[key])) problems.push(`${key} is not an object (the shared config merge breaks)`);
  }
  const rawTiers = isPlainObject(raw.tiers) ? raw.tiers : {};
  for (const name of ["1", "2"]) {
    if (Object.hasOwn(rawTiers, name) && !isPlainObject(rawTiers[name])) {
      problems.push(`tiers.${name} is not an object (the shared tier merge breaks)`);
    }
  }
  if (problems.length > 0) return problems;

  const local = isPlainObject(raw.local) ? raw.local : {};
  const providerProblems = (label, resolve) => {
    const has = (key) => resolve(key) !== undefined;
    const intProblem = (key) => has(key) && sharedIntegerValue(resolve(key)) === null;
    if (intProblem("samples")) {
      problems.push(`${label}.samples is not coercible with the shared \`int(...)\` semantics, or is outside the exact safe-integer range`);
    } else if (has("samples")) {
      const samples = sharedIntegerValue(resolve("samples"));
      if (samples < SHARED_SAMPLES_RANGE.min || samples > SHARED_SAMPLES_RANGE.max) {
        problems.push(`${label}.samples must be within ${SHARED_SAMPLES_RANGE.min}..${SHARED_SAMPLES_RANGE.max} after shared coercion`);
      }
    }
    for (const key of ["seed", "n_ctx"]) {
      if (intProblem(key)) problems.push(`${label}.${key} is not coercible with the shared \`int(...)\` semantics, or is outside the exact safe-integer range`);
    }
    for (const key of ["temperature", "timeout_s"]) {
      if (!has(key)) continue;
      const coerced = sharedFloatCoercion(resolve(key));
      if (!coerced.ok) problems.push(`${label}.${key} ${floatRefusalText(coerced.refusal)}`);
    }
    // `idle_timeout_s` only sets the persistent worker's idle exit: it reaches
    // neither the inference request, the evidence nor the PS.2e bounds, so a
    // non-finite value the shared build accepts is accepted here too.
    if (has("idle_timeout_s") && sharedBoolValue(has("persistent") ? resolve("persistent") : true)) {
      const coerced = sharedFloatCoercion(resolve("idle_timeout_s"));
      if (!coerced.ok && coerced.refusal !== SHARED_FLOAT_REFUSAL.NON_FINITE) {
        problems.push(`${label}.idle_timeout_s ${floatRefusalText(coerced.refusal)}`);
      }
    }
  };
  const blockValue = (block, key) => (Object.hasOwn(block, key) ? block[key] : undefined);

  providerProblems("local", (key) => blockValue(local, key));
  const jevEnabled = (isPlainObject(raw.jev) && Object.hasOwn(raw.jev, "enabled") ? raw.jev.enabled : false) !== false;
  if (jevEnabled && isPlainObject(raw.jev) && Object.hasOwn(raw.jev, "timeout_s")) {
    const coerced = sharedFloatCoercion(raw.jev.timeout_s);
    if (!coerced.ok) problems.push(`jev.timeout_s ${floatRefusalText(coerced.refusal)}`);
  }
  for (const name of ["1", "2"]) {
    const tier = isPlainObject(rawTiers[name]) ? rawTiers[name] : {};
    providerProblems(`tiers.${name}`, (key) => {
      if (Object.hasOwn(tier, key)) return tier[key];
      if (SHARED_TIER_DEFAULT_KEYS[name].includes(key)) return undefined; // the shared tier default (valid) shadows `local`
      return blockValue(local, key);
    });
  }
  const acceptance = isPlainObject(raw.acceptance) ? raw.acceptance : {};
  const minStability = effectiveMinStability(blockValue(acceptance, "min_stability"));
  if (!minStability.ok) problems.push(minStability.problem);
  const minMargin = effectiveMinMargin(blockValue(acceptance, "min_margin"));
  if (!minMargin.ok) problems.push(minMargin.problem);
  return problems;
}

/**
 * The EFFECTIVE model-inference settings of one shared decision tier, resolved
 * with the SHARED configuration's own precedence semantics
 * (`decision_router.config.tier_settings`: `local` without the model identity,
 * deep-merged with the tier's own block — a tier key overrides the local key, a
 * missing key falls back to `local`, then to the shared defaults) and coerced
 * exactly like the shared local provider's constructor (`int(...)`,
 * `float(...)`, `bool(...)`). These settings materially alter the inference
 * request (drawn samples and their seeds, temperature, context size, and the
 * early-stop rule that changes option-token generation), so the digest must
 * reflect the EFFECTIVE values actually used — never raw config syntax. Values
 * the shared coercion would refuse stay null (never invented): such a config
 * makes the shared router itself fail to build.
 */
export function effectiveTierInferenceSettings({ tierSettings = null, localSettings = null } = {}) {
  const resolve = (key) => {
    if (isPlainObject(tierSettings) && Object.hasOwn(tierSettings, key)) return tierSettings[key];
    if (isPlainObject(localSettings) && Object.hasOwn(localSettings, key)) return localSettings[key];
    return undefined; // absent at both levels: the shared default applies
  };
  const intSetting = (key, fallback) => {
    const raw = resolve(key);
    return raw === undefined ? fallback : sharedIntegerValue(raw);
  };
  const floatSetting = (key, fallback) => {
    const raw = resolve(key);
    return raw === undefined ? fallback : sharedFloatValue(raw);
  };
  const boolSetting = (key, fallback) => {
    const raw = resolve(key);
    return raw === undefined ? fallback : sharedBoolValue(raw);
  };
  const earlyStopRaw = resolve("early_stop");
  return {
    samples: intSetting("samples", SHARED_LOCAL_JEV_DEFAULTS.samples),
    seed: intSetting("seed", SHARED_LOCAL_JEV_DEFAULTS.seed),
    temperature: floatSetting("temperature", SHARED_LOCAL_JEV_DEFAULTS.temperature),
    nCtx: intSetting("n_ctx", SHARED_LOCAL_JEV_DEFAULTS.nCtx),
    // The shared worker draws every planned sample ONLY when `early_stop` is
    // literally `false` (`settings.get("early_stop", True) is False` in
    // `providers/nobodywho.py`): any other value — including 0, null or a
    // missing key — leaves the acceptance-based stop rule in place.
    earlyStop: earlyStopRaw !== false,
    useGpu: boolSetting("use_gpu", false),
    cpuFallback: boolSetting("cpu_fallback", true),
  };
}

function baseNameOf(value) {
  return typeof value === "string" && value.length > 0 ? path.basename(value) : null;
}

function boundedNumber(value, fallback = null) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function boundedString(value, limit = 160) {
  return typeof value === "string" ? value.slice(0, limit) : null;
}

/** Read-only projection of the tier's specialist classifier sub-block (no paths). */
function classifierProjection(classifier) {
  if (!isPlainObject(classifier)) return null;
  return {
    classifierId: boundedString(classifier.id, 64),
    classifierFamily: boundedString(classifier.family, 64),
    classifierKind: boundedString(classifier.kind, 64),
    classifierVersion: boundedString(classifier.version, 64),
    thinkingEnabled: classifier.thinking === true,
    optionTokenGrammar: classifier.option_token_grammar === true,
    onIdentityMismatch: boundedString(classifier.on_identity_mismatch, 32),
  };
}

/**
 * The EFFECTIVE tier timeout from the stored config, with the stored values
 * coerced by the shared `float(...)` (`"30"` is 30 s, `true` is 1 s). When the
 * value that governs this tier is refused by the shared coercion there is no
 * effective timeout (null): the shared router cannot build, and readiness fails
 * closed on `sharedRouterBuildProblems` instead of assuming a fallback.
 */
function effectiveTierTimeoutFromConfig(tierName, settings, localSettings) {
  const explicit = (block) => (isPlainObject(block) && Object.hasOwn(block, "timeout_s") ? sharedFloatValue(block.timeout_s) : undefined);
  const tierTimeoutS = explicit(settings);
  const localTimeoutS = explicit(localSettings);
  if (tierTimeoutS === null) return null;
  if (tierTimeoutS === undefined && SHARED_TIER_DEFAULT_TIMEOUT_S[String(tierName)] === undefined && localTimeoutS === null) return null;
  return effectiveTierTimeoutS({ tierName, tierTimeoutS: tierTimeoutS ?? null, localTimeoutS: localTimeoutS ?? null });
}

/** Read-only projection of one shared local-first tier (no paths beyond a basename). */
function tierProjection(tierName, settings, localSettings = null) {
  const info = isPlainObject(settings?.model_info) ? settings.model_info : {};
  const modelFile = baseNameOf(settings?.model_path) ?? (typeof info.file === "string" ? info.file : null);
  return {
    tier: tierName,
    label: boundedString(settings?.label, 32),
    modelName: boundedString(info.name, 64) ?? (modelFile !== null ? modelFile.replace(/\.[^.]+$/, "") : null),
    modelFile: boundedString(modelFile, 128),
    modelSha256: /^[0-9a-f]{64}$/.test(String(settings?.model_sha256 ?? "")) ? settings.model_sha256 : null,
    quantization: boundedString(info.quantization, 16),
    architecture: boundedString(info.architecture, 32),
    source: boundedString(settings?.source, 160),
    useGpu: settings?.use_gpu === true,
    persistent: settings?.persistent !== false,
    timeoutS: boundedNumber(settings?.timeout_s),
    effectiveTimeoutS: effectiveTierTimeoutFromConfig(tierName, settings, localSettings),
    idleTimeoutS: boundedNumber(settings?.idle_timeout_s),
    cpuFallback: settings?.cpu_fallback !== false,
    classifier: classifierProjection(settings?.classifier),
    configured: modelFile !== null,
  };
}

/**
 * Project the shared Local JEV installation READ-ONLY. Every field here is
 * identity/configuration only: no credential, no environment dump, no key file
 * content, and no absolute model directory.
 *
 * @returns {{ executable: object, config: object, problems: string[] }}
 */
export async function readLocalJevEnvironment({
  env = process.env,
  homeDir = os.homedir(),
  configPath = null,
  executable = null,
  readFileImpl = fsReadFile,
  accessImpl = fsAccess,
} = {}) {
  const problems = [];
  const executableResolution = {
    ...resolveLocalJevExecutable({ env, executable }),
    found: null,
    checkedPath: null,
  };
  // An explicit path is verified here. A bare command name is resolved by the
  // child process itself (PATH), so "found" stays unknown until a call happens.
  if (executableResolution.command.includes(path.sep)) {
    executableResolution.checkedPath = executableResolution.command;
    try {
      await accessImpl(executableResolution.command);
      executableResolution.found = true;
    } catch {
      executableResolution.found = false;
      problems.push(`the shared Local JEV executable '${executableResolution.command}' is not accessible`);
    }
  }

  const resolvedConfigPath = configPath ?? resolveLocalJevConfigPath({ env, homeDir });
  const projection = {
    executable: executableResolution,
    configPath,
    config: {
      found: false,
      path: null,
      mode: null,
      modeSource: null,
      jevFallbackEnabled: null,
      tiers: {},
      local: {},
      acceptance: {},
      problems: [],
    },
    problems,
  };

  let raw = null;
  try {
    raw = JSON.parse(await readFileImpl(resolvedConfigPath, "utf8"));
  } catch (error) {
    projection.config.problems.push(`the shared Local JEV config is unreadable at ${resolvedConfigPath}`);
    problems.push(`the shared Local JEV config is unreadable at ${resolvedConfigPath}: ${String(error?.code ?? "error")}`);
    return projection;
  }
  if (!isPlainObject(raw)) {
    projection.config.problems.push("the shared Local JEV config is not a JSON object");
    problems.push("the shared Local JEV config is not a JSON object");
    return projection;
  }

  const tierNames = Object.keys(isPlainObject(raw.tiers) ? raw.tiers : {}).sort();
  const rawTiers = isPlainObject(raw.tiers) ? raw.tiers : {};
  const acceptanceValue = (key) =>
    isPlainObject(raw.acceptance) && Object.hasOwn(raw.acceptance, key) ? raw.acceptance[key] : undefined;
  const retryResolution = effectiveLocalRetries(acceptanceValue("max_local_retries"));
  const escalateOnAbstainRaw = acceptanceValue("escalate_on_abstain");
  projection.config = {
    found: true,
    path: boundedString(resolvedConfigPath, 240),
    mode: typeof raw.mode === "string" ? raw.mode.toLowerCase() : null,
    modeSource: "config",
    // The pinned shared defaults resolve `jev.enabled` to FALSE when omitted
    // (`DEFAULTS["jev"]["enabled"] = False` merged with the stored config), and
    // only an explicit `false` disables (`config["jev"].get("enabled") is not
    // False` in the shared CLI). Both halves are mirrored exactly so readiness
    // can never disagree with what the shared router would do.
    jevFallbackEnabled:
      (isPlainObject(raw.jev) && Object.hasOwn(raw.jev, "enabled") ? raw.jev.enabled : false) !== false,
    // `float(jev.timeout_s)` in the shared TypeSafe provider; null = not stored
    // (the shared default applies) or refused (see `sharedBuildProblems`).
    jevTimeoutS: isPlainObject(raw.jev) ? sharedFloatValue(raw.jev.timeout_s) : null,
    tiers: Object.fromEntries(tierNames.map((name) => [name, tierProjection(name, raw.tiers[name], raw.local)])),
    local: {
      samples: boundedNumber(raw.local?.samples),
      seed: boundedNumber(raw.local?.seed),
      temperature: boundedNumber(raw.local?.temperature),
      nCtx: boundedNumber(raw.local?.n_ctx),
      timeoutS: boundedNumber(raw.local?.timeout_s),
      persistent: raw.local?.persistent !== false,
    },
    // The EFFECTIVE model-inference settings per SHARED decision-tier slot
    // (`config.TIER_NAMES` = ("1", "2") in the pinned source: the shared router
    // builds exactly these slots on every call), resolved with the shared
    // precedence semantics and coerced like the shared provider constructor.
    // This is the effective-settings projection the complete-input digest
    // covers: effective values only, never raw config syntax.
    inference: Object.fromEntries(
      ["1", "2"].map((name) => [
        name,
        effectiveTierInferenceSettings({ tierSettings: rawTiers[name], localSettings: raw.local }),
      ]),
    ),
    // The EFFECTIVE shared acceptance policy (`acceptance.Policy.from_config`:
    // `float(...)` / `int(...)` / `bool(...)` over the merged defaults). The same
    // `min_stability` / `min_margin` are the worker's early-stop thresholds, so
    // they alter the inference request too. `null` = refused by the shared
    // parser (readiness fails closed on `sharedBuildProblems`).
    acceptance: {
      minStability: effectiveMinStability(acceptanceValue("min_stability")).value,
      minMargin: effectiveMinMargin(acceptanceValue("min_margin")).value,
      escalateOnAbstain:
        escalateOnAbstainRaw === undefined ? SHARED_ACCEPTANCE_DEFAULTS.escalateOnAbstain : sharedBoolValue(escalateOnAbstainRaw),
      // The EFFECTIVE retry count after the shared parser's exact normalization
      // (Python `int(...)` then the shared 0..3 range). `null` means the shared
      // router would REFUSE every call (its Policy.from_config raises), so
      // readiness fails closed instead of assuming zero retries.
      maxLocalRetries: retryResolution.ok ? retryResolution.effectiveRetries : null,
      maxLocalRetriesProblem: retryResolution.ok ? null : boundedString(retryResolution.problem, 160),
    },
    // Every numeric setting the shared router's BUILD would refuse (it then
    // answers every call with `router_error`): readiness fails closed on any.
    sharedBuildProblems: sharedRouterBuildProblems(raw).map((problem) => boundedString(problem, 200)),
    problems: [],
  };
  return projection;
}

/* ============================================================================
 * Readiness — the precommitted primary-classifier identity gate
 * ==========================================================================*/

/**
 * Assess whether the shared Local JEV installation can serve the PRECOMMITTED
 * PS.2e primary classifier. Fail closed: any uncertainty refuses primary calls.
 *
 * @returns {{ status: string, ready: boolean, problems: string[], primaryIdentity: object|null,
 *   escalationTiers: object[], typesafeFallbackEnabled: boolean, localTierCount: number,
 *   configuredDecisionTiers: number, maxLocalRetries: number, physicalAttemptCeilingPerLogicalCall: number|null,
 *   derivedWorstCaseLogicalMs: number|null, timeoutBounds: object|null,
 *   classifierIdentityDigest: string, routingDigest: string|null }}
 */
export function assessLocalTevReadiness({ projection, policy, logicalTimeoutMs = PS2E_LOGICAL_CALL_TIMEOUT_MS } = {}) {
  const problems = [];
  const identity = {
    classifierId: policy?.classifierId ?? null,
    classifierFamily: policy?.classifierFamily ?? null,
    classifierKind: policy?.classifierKind ?? null,
    classifierRuntime: policy?.classifierRuntime ?? null,
    classifierProvider: policy?.classifierProvider ?? null,
    classifierMode: policy?.classifierMode ?? null,
    primaryTier: policy?.primaryTier ?? null,
    thinkingEnabled: policy?.thinkingEnabled === true,
    pinnedModel: policy?.pinnedModel ?? null,
    pinnedModelSha256: policy?.pinnedModelSha256 ?? null,
    available: policy?.available === true,
    unavailableReason: policy?.unavailableReason ?? null,
  };
  const classifierIdentityDigest = digestOf(identity);

  const result = {
    status: "READY",
    ready: false,
    problems,
    primaryIdentity: null,
    escalationTiers: [],
    typesafeFallbackEnabled: false,
    localTierCount: 0,
    configuredDecisionTiers: PS2E_LOCAL_TIER_COUNT_CEILING,
    maxLocalRetries: 0,
    physicalAttemptCeilingPerLogicalCall: physicalAttemptCeilingFor({}),
    derivedWorstCaseLogicalMs: null,
    timeoutBounds: null,
    classifierIdentityDigest,
    routingDigest: null,
  };

  for (const problem of classifierPolicyProblems(policy)) problems.push(`classifier policy: ${problem}`);
  if (problems.length > 0) {
    result.status = "CLASSIFIER_POLICY_INVALID";
    return result;
  }

  // 1. THE BLOCKER: no Tev-style specialist is exposed by the shared stack.
  if (policy.available !== true) {
    problems.push(
      policy.unavailableReason ??
        "the shared Local JEV installation exposes no Tev-style specialist classifier; PS.2e refuses to substitute a generic local model",
    );
    result.status = "PRIMARY_CLASSIFIER_UNAVAILABLE";
    return result;
  }

  // 2. The shared CLI and its effective configuration must be resolvable.
  if (projection?.executable?.found === false) {
    problems.push("the shared Local JEV `decision` executable was not found");
    result.status = "LOCAL_JEV_UNAVAILABLE";
    return result;
  }
  const config = projection?.config;
  if (!config || config.found !== true) {
    problems.push("the shared Local JEV effective configuration is unreadable; PS.2e cannot verify the classifier identity");
    result.status = "LOCAL_JEV_UNAVAILABLE";
    return result;
  }

  const tiers = config.tiers ?? {};
  const tierNames = Object.keys(tiers).sort();
  result.localTierCount = tierNames.length;
  // The shared acceptance parser coerces `max_local_retries` exactly like Python
  // `int(...)` and then requires 0..3 (`acceptance.Policy.from_config`): a value
  // outside that contract makes the shared router raise on EVERY call
  // (`router_error`). Readiness mirrors the SAME normalization and fails closed
  // on anything the shared parser would refuse — it never falls back to zero
  // retries, which would understate both the physical-attempt ceiling and the
  // router theoretical worst case.
  const retryResolution = effectiveLocalRetries(config.acceptance?.maxLocalRetries);
  if (!retryResolution.ok) {
    problems.push(
      `the shared Local JEV acceptance.max_local_retries cannot be normalized (${retryResolution.problem}); ` +
        "the shared router would refuse every call",
    );
    result.status = "LOCAL_JEV_CONFIG_INVALID";
    return result;
  }
  // Every other numeric setting the shared router's build coerces (Python
  // `float(...)` / `int(...)` plus its range checks): a value the shared build
  // refuses makes EVERY call a `router_error`, so readiness fails closed — an
  // accepted value is never replaced by a default, a refused one never
  // normalized. (Always present on a projection from `readLocalJevEnvironment`.)
  const buildProblems = Array.isArray(config.sharedBuildProblems) ? config.sharedBuildProblems : [];
  if (buildProblems.length > 0) {
    for (const problem of buildProblems) {
      problems.push(`the shared Local JEV config would be refused by the shared router build: ${problem}`);
    }
    result.status = "LOCAL_JEV_CONFIG_INVALID";
    return result;
  }
  result.maxLocalRetries = retryResolution.effectiveRetries;
  result.typesafeFallbackEnabled = config.jevFallbackEnabled === true;
  result.escalationTiers = tierNames
    .filter((name) => name !== policy.primaryTier)
    .map((name) => ({ tier: name, provider: "nobodywho", ...tiers[name] }));

  const primary = tiers[policy.primaryTier] ?? null;
  if (primary === null || primary.configured !== true) {
    problems.push(
      `the shared Local JEV local-first tier ${policy.primaryTier} is not configured with a local model, so the ` +
        "precommitted primary classifier cannot be served",
    );
    result.status = "PRIMARY_CLASSIFIER_UNAVAILABLE";
  } else if (typeof policy.pinnedModel === "string" && policy.pinnedModel.length > 0 && primary.modelName !== policy.pinnedModel) {
    problems.push(
      `tier ${policy.primaryTier} serves model '${primary.modelName ?? "unknown"}'; the precommitted PS.2e primary ` +
        `classifier is '${policy.pinnedModel}'`,
    );
    result.status = "PRIMARY_IDENTITY_MISMATCH";
  } else if (
    typeof policy.pinnedModelSha256 === "string" &&
    policy.pinnedModelSha256.length > 0 &&
    primary.modelSha256 !== policy.pinnedModelSha256 &&
    policy.validationOnly !== true
  ) {
    problems.push(
      `tier ${policy.primaryTier} model sha256 is '${primary.modelSha256 ?? "unknown"}'; the precommitted PS.2e pin is ` +
        `'${policy.pinnedModelSha256}'`,
    );
    result.status = "PRIMARY_IDENTITY_MISMATCH";
  }

  result.primaryIdentity = primary === null ? null : { tier: policy.primaryTier, provider: "nobodywho", ...primary };
  result.routingDigest = digestOf({
    mode: policy.classifierMode,
    primaryTier: policy.primaryTier,
    escalationTiers: result.escalationTiers,
    typesafeFallbackEnabled: result.typesafeFallbackEnabled,
    acceptance: config.acceptance,
    local: config.local,
  });

  if (problems.length > 0) return result;

  // 3. The exact shared-router physical-attempt ceiling, reported honestly and
  //    BEFORE the time bounds (so a timeout-bound failure still reports the true
  //    ceiling): the shared router always iterates its fixed decision-tier slots
  //    (tier 1 primary + tier 2 escalation, `config.TIER_NAMES` in the pinned
  //    source). A slot whose tier is model-configured can consume up to
  //    `1 + normalized retries` physical attempts (retryable rejections only);
  //    an unconfigured slot records exactly one failed physical attempt when it
  //    is reached; the optional TypeSafe fallback adds one. Readiness fails
  //    closed when the derived ceiling exceeds the frozen PS.2e maximum — the
  //    bound is never grown to accommodate a permissive config.
  result.configuredDecisionTiers = [PS2E_PRIMARY_TIER, ...PS2E_ESCALATION_TIERS].filter(
    (name) => tiers[name]?.configured === true,
  ).length;
  const physicalAttemptCeiling = physicalAttemptCeilingFor({
    configuredLocalTiers: result.configuredDecisionTiers,
    maxLocalRetries: result.maxLocalRetries,
    typesafeFallbackEnabled: result.typesafeFallbackEnabled,
  });
  if (physicalAttemptCeiling === null || physicalAttemptCeiling > PS2E_PHYSICAL_ATTEMPT_CEILING_PER_LOGICAL_CALL) {
    problems.push(
      `the derived physical-attempt ceiling (${physicalAttemptCeiling ?? "unbounded"}) exceeds the frozen PS.2e ` +
        `maximum (${PS2E_PHYSICAL_ATTEMPT_CEILING_PER_LOGICAL_CALL}); readiness refuses to run beyond the ` +
        "precommitted bound",
    );
    result.status = "LOCAL_JEV_ATTEMPT_CEILING_EXCEEDS_PS2E_BOUND";
    return result;
  }
  result.physicalAttemptCeilingPerLogicalCall = physicalAttemptCeiling;

  // 4. The frozen EVOLVE-side logical bound must cover the shared system's own
  //    worst case, otherwise a legitimate call could be truncated silently.
  //    The bound uses each tier's EFFECTIVE timeout AFTER the shared
  //    configuration's inheritance and defaults are resolved (an omitted
  //    `timeout_s` is NOT zero), plus the NORMALIZED per-tier retries,
  //    escalation across every local tier and the optional provider fallback
  //    with its own effective timeout. THREE bounds are kept distinct: the
  //    router theoretical worst case below, the EVOLVE child hard timeout
  //    (`logicalTimeoutMs`, enforced on the child process group) and the PS.2e
  //    finalization budget.
  const attemptsPerTier = 1 + result.maxLocalRetries;
  const perTierAttemptMs = tierNames.map((name) => {
    const projected = tiers[name] ?? {};
    const effectiveS = projected.effectiveTimeoutS ?? effectiveTierTimeoutS({
      tierName: name,
      tierTimeoutS: projected.timeoutS ?? null,
      localTimeoutS: config.local?.timeoutS ?? null,
    });
    return Math.round(Math.max(0, effectiveS) * 1000);
  });
  const worstLocalMs = perTierAttemptMs.reduce((sum, value) => sum + value, 0) * attemptsPerTier;
  const fallbackMs = result.typesafeFallbackEnabled
    ? Math.round(Math.max(0, config.jevTimeoutS ?? SHARED_LOCAL_JEV_DEFAULTS.jevTimeoutS) * 1000)
    : 0;
  const derivedWorstCaseLogicalMs = worstLocalMs + fallbackMs;
  result.derivedWorstCaseLogicalMs = derivedWorstCaseLogicalMs;
  result.timeoutBounds = {
    routerTheoreticalWorstCaseMs: derivedWorstCaseLogicalMs,
    routerPerTierAttemptMs: perTierAttemptMs,
    routerAttemptsPerTier: attemptsPerTier,
    routerProviderFallbackMs: fallbackMs,
    evolveChildHardTimeoutMs: logicalTimeoutMs,
    ps2eFinalizationBudgetMs: PS2E_FINALIZATION_BUDGET_MS,
  };
  if (derivedWorstCaseLogicalMs > logicalTimeoutMs) {
    problems.push(
      `the shared Local JEV worst-case logical call (${derivedWorstCaseLogicalMs} ms from its own EFFECTIVE tier ` +
        `timeouts, retries and fallback) exceeds the frozen PS.2e client bound (${logicalTimeoutMs} ms)`,
    );
    result.status = "LOCAL_JEV_TIMEOUT_BOUND_EXCEEDS_PS2E_BOUND";
    return result;
  }

  result.ready = result.status === "READY";
  return result;
}

/* ============================================================================
 * Response validation (strict; malformed is never a decision)
 * ==========================================================================*/

function boundedAttempt(attempt) {
  if (!isPlainObject(attempt)) return null;
  const tier = typeof attempt.tier === "number" && Number.isInteger(attempt.tier) ? attempt.tier : null;
  const provider = boundedString(attempt.provider, 32);
  if (tier === null || provider === null) return null;
  const choice = typeof attempt.choice === "string" ? attempt.choice.slice(0, 64) : null;
  if (choice !== null && !allowedTokens().includes(choice)) return null;
  return {
    tier,
    tierToken: String(tier),
    provider,
    model: boundedString(attempt.model, 128),
    choice,
    abstain: attempt.abstain === true,
    accepted: attempt.accepted === true,
    confidence: boundedNumber(attempt.confidence),
    confidenceKind: boundedString(attempt.confidence_kind, 32),
    latencyMs: boundedNumber(attempt.latency_ms),
    escalationReason: boundedString(attempt.escalation_reason, 64),
    fallbackFrom: boundedString(attempt.fallback_from, 96),
    fallbackReason: boundedString(attempt.fallback_reason, 96),
    // Physical-attempt provenance from the hardened shared router: `status` is
    // accepted/abstained/failed for a PHYSICAL attempt and "skipped" for a
    // disabled-fallback record that made no physical call. `role` is the router's
    // own specialist/generic/typesafe label. Both are additive evidence.
    status: boundedString(attempt.status, 16),
    role: boundedString(attempt.role, 16),
    abstainReason: boundedString(attempt.abstain_reason, 32),
  };
}

/**
 * The shared router's own classifier identity/digest evidence (`classifier`
 * block of a local-first outcome), when exposed. Every field stays null when
 * the shared system did not expose it; none is ever invented.
 */
function classifierEvidenceFrom(classifier) {
  if (!isPlainObject(classifier)) return null;
  const hex64 = (value) => (/^[0-9a-f]{64}$/.test(String(value ?? "")) ? String(value) : null);
  return {
    classifierId: boundedString(classifier.classifierId, 64),
    classifierFamily: boundedString(classifier.classifierFamily, 64),
    classifierKind: boundedString(classifier.classifierKind, 64),
    classifierVersion: boundedString(classifier.classifierVersion, 64),
    tier: Number.isInteger(classifier.tier) ? classifier.tier : null,
    thinkingEnabled: typeof classifier.thinkingEnabled === "boolean" ? classifier.thinkingEnabled : null,
    grammarConstrainedOptionTokens:
      typeof classifier.grammarConstrainedOptionTokens === "boolean" ? classifier.grammarConstrainedOptionTokens : null,
    status: boundedString(classifier.status, 16),
    verifiedBy: boundedString(classifier.verifiedBy, 32),
    expectedSha256: hex64(classifier.expectedSha256),
    observedSha256: hex64(classifier.observedSha256),
    available: typeof classifier.available === "boolean" ? classifier.available : null,
  };
}

/**
 * Whether the raw classifier identity object can be interpreted as the required
 * classifier contract at all:
 *
 *   "absent"         nothing was exposed (no identity evidence);
 *   "interpretable"  every exposed identity field carries its contract type;
 *   "malformed"      an exposed identity field has a wrong type (including a
 *                    "digest" that is not a digest): a contradictory object the
 *                    required contract cannot express.
 */
export function classifierEvidenceShape(classifier) {
  if (classifier === undefined || classifier === null) return "absent";
  if (!isPlainObject(classifier)) return "malformed";
  for (const name of [
    "classifierId",
    "classifierFamily",
    "classifierKind",
    "classifierVersion",
    "status",
    "verifiedBy",
    "expectedSha256",
    "observedSha256",
  ]) {
    const value = classifier[name];
    if (value !== undefined && value !== null && typeof value !== "string") return "malformed";
  }
  for (const name of ["thinkingEnabled", "grammarConstrainedOptionTokens", "available"]) {
    const value = classifier[name];
    if (value !== undefined && value !== null && typeof value !== "boolean") return "malformed";
  }
  const tier = classifier.tier;
  if (tier !== undefined && tier !== null && !Number.isInteger(tier)) return "malformed";
  for (const name of ["expectedSha256", "observedSha256"]) {
    const value = classifier[name];
    if (value !== undefined && value !== null && !/^[0-9a-f]{64}$/.test(String(value))) return "malformed";
  }
  return "interpretable";
}

/**
 * Validate the shared implementation's answer strictly. A mismatched echo, a
 * wrong mode, an unknown token or a malformed shape is a recorded failure, never
 * a decision.
 */
export function validateLocalJevOutcome(value, { requestId, allowed = null } = {}) {
  const tokens = allowed ?? allowedTokens();
  const problems = [];
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return { ok: false, status: LOCAL_JEV_CLIENT_STATUS.MALFORMED, problems: ["not_json: stdout was not JSON"], outcome: null };
    }
  }
  if (!isPlainObject(value)) {
    return { ok: false, status: LOCAL_JEV_CLIENT_STATUS.MALFORMED, problems: ["not_an_object"], outcome: null };
  }
  if (value.request_id !== requestId) problems.push("request_id_mismatch: the answer does not belong to this request");
  if (typeof value.mode !== "string") {
    problems.push("mode_mismatch: the shared router reported no mode");
  } else if (value.mode !== PS2E_LOCAL_JEV_MODE) {
    problems.push(`mode_mismatch: the shared router ran '${value.mode}', PS.2e requires '${PS2E_LOCAL_JEV_MODE}'`);
  }
  if (problems.length > 0) {
    return { ok: false, status: LOCAL_JEV_CLIENT_STATUS.MALFORMED, problems, outcome: null };
  }
  if (typeof value.skipped === "string" && value.skipped.length > 0) {
    return { ok: false, status: LOCAL_JEV_CLIENT_STATUS.SKIPPED_BY_SHARED_ROUTER, problems: [`skipped:${value.skipped}`], outcome: null };
  }
  if (typeof value.error === "string" && value.error.length > 0) {
    const status =
      value.error === "invalid_request" ? LOCAL_JEV_CLIENT_STATUS.REQUEST_REJECTED : LOCAL_JEV_CLIENT_STATUS.ROUTER_ERROR;
    return { ok: false, status, problems: [`shared_router_${value.error}`], outcome: null };
  }

  const decision = value.decision;
  if (decision !== null && decision !== undefined && !isPlainObject(decision)) {
    return { ok: false, status: LOCAL_JEV_CLIENT_STATUS.MALFORMED, problems: ["decision_shape_invalid"], outcome: null };
  }
  if (isPlainObject(decision)) {
    if (typeof decision.provider !== "string" || decision.provider.length === 0) problems.push("decision_shape_invalid: provider");
    if (decision.choice !== null && decision.choice !== undefined && !tokens.includes(decision.choice)) {
      problems.push("follow_outside_option_set: the answer is not one of the allowed option ids");
    }
    if (typeof decision.abstain !== "boolean" && decision.abstain !== undefined) problems.push("decision_shape_invalid: abstain");
  }
  if (value.decision_source !== undefined && value.decision_source !== null && typeof value.decision_source !== "string") {
    problems.push("decision_shape_invalid: decision_source");
  }
  if (value.follow !== null && value.follow !== undefined && !tokens.includes(value.follow)) {
    problems.push("follow_outside_option_set: follow is not one of the allowed option ids");
  }
  let attempts = [];
  if (value.attempts !== undefined && !Array.isArray(value.attempts)) problems.push("attempt_shape_invalid: attempts");
  else if (Array.isArray(value.attempts)) {
    if (value.attempts.length > 32) problems.push("attempt_shape_invalid: too many attempts");
    attempts = value.attempts
      .slice(0, PS2E_MAX_PERSISTED_ATTEMPTS_PER_RECORD * 4)
      .map(boundedAttempt)
      .filter((entry) => entry !== null);
    if (attempts.length !== Math.min(value.attempts.length, PS2E_MAX_PERSISTED_ATTEMPTS_PER_RECORD * 4)) {
      problems.push("attempt_shape_invalid: an attempt was not a tier/provider record");
    }
    for (const raw of value.attempts) {
      if (isPlainObject(raw) && raw.accepted === true && raw.status === "skipped") {
        problems.push("attempt_shape_invalid: a skipped record made no physical call and can never be an accepted attempt");
      }
    }
  }

  // ---- CROSS-CHECK: the chosen decision must agree across EVERY authoritative
  // location the real shared-router schema exposes (`follow`, `decision.choice`
  // and the accepted attempt's own choice). Conflicting authoritative choice
  // fields are structurally MALFORMED: malformed is never a decision.
  const normalizeToken = (choice, abstain) => (abstain === true ? PS2E_ABSTAIN_TOKEN : (choice ?? null));
  const decisionToken = isPlainObject(decision) ? normalizeToken(decision.choice, decision.abstain) : null;
  // `follow` is the router's own final choice: for an abstention it is null, and
  // so is `decision.choice`. The two must agree exactly wherever both exist.
  if ((value.follow ?? null) !== (isPlainObject(decision) ? decision.choice ?? null : null)) {
    problems.push("choice_contradiction: follow does not agree with the decision's own choice");
  }
  const acceptedAttempt =
    (Array.isArray(value.attempts)
      ? [...value.attempts].reverse().find((entry) => isPlainObject(entry) && entry.accepted === true)
      : null) ?? null;
  if (acceptedAttempt !== null && isPlainObject(decision)) {
    const acceptedToken = normalizeToken(acceptedAttempt.choice, acceptedAttempt.abstain);
    if (acceptedToken !== decisionToken) {
      problems.push("choice_contradiction: the accepted attempt's answer does not agree with the decision's own choice");
    }
  }

  // ---- ABSTENTION COHERENCE -----------------------------------------------
  // The SAME authoritative representations must also agree about abstention. A
  // record that simultaneously claims a binary answer and abstention — or an
  // abstaining representation that also claims a selected option — is
  // structurally MALFORMED: malformed is never a decision.
  if (isPlainObject(decision)) {
    if (decision.abstain === true && decision.choice !== null && decision.choice !== undefined) {
      problems.push("abstain_contradiction: the decision simultaneously claims abstention and a selected option");
    }
    if (decision.abstain !== true && decision.choice != null && decision.abstain_reason != null) {
      problems.push("abstain_contradiction: a binary decision carries abstention metadata (abstain_reason)");
    }
  }
  for (const rawAttempt of Array.isArray(value.attempts) ? value.attempts : []) {
    if (!isPlainObject(rawAttempt)) continue;
    if (rawAttempt.abstain === true && rawAttempt.choice !== null && rawAttempt.choice !== undefined) {
      problems.push("abstain_contradiction: an attempt simultaneously claims abstention and a selected option");
    }
    if (rawAttempt.accepted === true && rawAttempt.abstain !== true && rawAttempt.choice != null && rawAttempt.abstain_reason != null) {
      problems.push("abstain_contradiction: an accepted binary attempt carries abstention metadata (abstain_reason)");
    }
  }
  if (value.abstained !== undefined && value.abstained !== null && typeof value.abstained !== "boolean") {
    problems.push("decision_shape_invalid: abstained");
  }

  if (problems.length > 0) {
    return { ok: false, status: LOCAL_JEV_CLIENT_STATUS.MALFORMED, problems, outcome: null };
  }

  return {
    ok: true,
    status: LOCAL_JEV_CLIENT_STATUS.OK,
    problems: [],
    outcome: {
      requestId: String(value.request_id),
      mode: typeof value.mode === "string" ? value.mode : null,
      follow: value.follow ?? null,
      tier: Number.isInteger(value.tier) ? String(value.tier) : null,
      attempts,
      agreement: typeof value.agreement === "boolean" ? value.agreement : null,
      note: boundedString(value.note, 240),
      // A defensive top-level abstention flag, captured ONLY when the shared
      // response actually exposes one (the pinned schema expresses abstention
      // through `decision.abstain` / `abstain_reason` and the attempt trace).
      abstained: typeof value.abstained === "boolean" ? value.abstained : null,
      // The shared router's own provenance, captured verbatim when exposed.
      routerDecisionSource: boundedString(value.decision_source, 48),
      classifier: classifierEvidenceFrom(value.classifier),
      classifierEvidenceShape: classifierEvidenceShape(value.classifier),
      decision: isPlainObject(decision)
        ? {
            provider: decision.provider,
            choice: decision.choice ?? null,
            abstain: decision.abstain === true,
            abstainReason: boundedString(decision.abstain_reason, 32),
            model: boundedString(decision.model, 128),
            latencyMs: boundedNumber(decision.latency_ms),
            confidence: boundedNumber(decision.confidence),
            confidenceKind: boundedString(decision.confidence_kind, 32),
            distribution: null, // local vote shares are never a probability distribution
            votes: isPlainObject(decision.votes) ? boundedVotes(decision.votes, tokens) : null,
            samples: boundedNumber(decision.samples),
            samplesPlanned:
              isPlainObject(decision.details) && Number.isInteger(decision.details.samples_planned)
                ? decision.details.samples_planned
                : null,
            earlyStop: isPlainObject(decision.details) && decision.details.early_stop === true,
            worker: isPlainObject(decision.details) ? boundedString(decision.details.worker, 16) : null,
            runtime: isPlainObject(decision.details) ? boundedString(decision.details.runtime, 32) : null,
            modelReused:
              isPlainObject(decision.details) && typeof decision.details.model_reused === "boolean"
                ? decision.details.model_reused
                : null,
            modelSha256:
              isPlainObject(decision.details) && /^[0-9a-f]{64}$/.test(String(decision.details.model_sha256 ?? ""))
                ? decision.details.model_sha256
                : null,
            error: boundedString(decision.error, 200),
            fallbackReason: boundedString(decision.fallback_reason, 96),
          }
        : null,
    },
  };
}

/** Bounded, token-filtered vote counts (never presented as probabilities). */
function boundedVotes(votes, tokens) {
  const out = {};
  let keys = 0;
  for (const [token, count] of Object.entries(votes)) {
    if (keys >= 8) break;
    if (!tokens.includes(token)) continue;
    if (typeof count !== "number" || !Number.isFinite(count) || count < 0) continue;
    out[token] = Math.floor(count);
    keys += 1;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** The highest and lowest observed vote counts (a margin, never a probability). */
export function voteMarginOf(votes) {
  const counts = Object.values(votes ?? {}).filter((value) => typeof value === "number" && Number.isFinite(value));
  if (counts.length === 0) return null;
  return Math.max(...counts) - Math.min(...counts);
}

/* ============================================================================
 * Decision + provenance
 * ==========================================================================*/

function boundedReason(text) {
  return typeof text === "string" ? text.slice(0, PS2E_MAX_FAILURE_REASON_LENGTH) : null;
}

/**
 * Turn a validated shared-router outcome into a PS.2e record decision and its
 * ACTUAL provenance. A fallback result never masquerades as a primary
 * Tev-classifier result.
 *
 * @returns {{ decision: string, decisionSource: string, acceptedTier: string|null,
 *   classifierProvider: string|null, classifierModel: string|null, classifierModelSha256: string|null,
 *   escalated: boolean, escalationReason: string|null, fallbackTier: string|null,
 *   fallbackProvider: string|null, fallbackModel: string|null, fallbackUsed: boolean,
 *   primaryIdentityMismatch: boolean, localAttemptCount: number, fallbackAttemptCount: number,
 *   totalPhysicalAttempts: number, escalationPath: object[], failureReason: string|null,
 *   decisionScore: object, probabilityKind: string, coldOrWarm: string|null }}
 */
export function classifyLocalJevOutcome({ validation, policy, clientStatus = null } = {}) {
  const base = {
    decision: PS2E_OUTCOMES.FAILED,
    decisionSource: PS2E_DECISION_SOURCES.FAILED,
    acceptedTier: null,
    classifierProvider: null,
    classifierModel: null,
    classifierModelSha256: null,
    escalated: false,
    escalationReason: null,
    fallbackTier: null,
    fallbackProvider: null,
    fallbackModel: null,
    fallbackUsed: false,
    primaryIdentityMismatch: false,
    localAttemptCount: 0,
    fallbackAttemptCount: 0,
    totalPhysicalAttempts: 0,
    // No attempt list was readable. A dispatch that produced an unusable answer
    // still consumed at least one physical attempt inside the shared router, but
    // its exact routing is UNKNOWN: PS.2e records the unknown rather than a guess.
    physicalAttemptsUnknown: false,
    escalationPath: [],
    failureReason: null,
    decisionScore: emptyDecisionScore(),
    probabilityKind: "none",
    coldOrWarm: null,
  };

  if (validation === null || validation === undefined || validation.ok !== true) {
    const status = validation?.status ?? clientStatus ?? LOCAL_JEV_CLIENT_STATUS.MALFORMED;
    // MALFORMED: the shared implementation produced something unusable
    // (invalid JSON, a wrong shape, a mismatched echo, a rejected request).
    // UNAVAILABLE: no model was consulted at all (skip, missing runtime,
    // over-long request). Everything else is an explicit FAILED record.
    const isMalformed =
      status === LOCAL_JEV_CLIENT_STATUS.MALFORMED || status === LOCAL_JEV_CLIENT_STATUS.REQUEST_REJECTED;
    const isUnavailable =
      status === LOCAL_JEV_CLIENT_STATUS.SKIPPED_BY_SHARED_ROUTER ||
      status === LOCAL_JEV_CLIENT_STATUS.SPAWN_FAILED ||
      status === LOCAL_JEV_CLIENT_STATUS.REQUEST_TOO_LARGE;
    return {
      ...base,
      decision: isMalformed ? PS2E_OUTCOMES.MALFORMED : isUnavailable ? PS2E_OUTCOMES.UNAVAILABLE : PS2E_OUTCOMES.FAILED,
      decisionSource: isMalformed
        ? PS2E_DECISION_SOURCES.MALFORMED
        : isUnavailable
          ? PS2E_DECISION_SOURCES.LOCAL_JEV_UNAVAILABLE
          : PS2E_DECISION_SOURCES.FAILED,
      // A refusal BEFORE any dispatch (spawn failed, skipped, over-long request)
      // is a known zero; anything that did reach the router is unknown.
      physicalAttemptsUnknown: !isUnavailable,
      failureReason: boundedReason((validation?.problems ?? []).join("; ") || `local client status ${status}`),
    };
  }

  const outcome = validation.outcome;
  if (!isPlainObject(outcome)) {
    return {
      ...base,
      decision: PS2E_OUTCOMES.MALFORMED,
      decisionSource: PS2E_DECISION_SOURCES.MALFORMED,
      failureReason: "the validated Local JEV outcome is not an object",
    };
  }
  const attempts = Array.isArray(outcome.attempts) ? outcome.attempts : [];
  // A disabled-fallback record ("skipped") made NO physical call and is never
  // counted as one; every other trace entry is a real physical attempt inside
  // the shared router. The full trace is still recorded as provenance.
  const physicalAttempts = attempts.filter((attempt) => attempt.status !== "skipped");
  const localAttempts = physicalAttempts.filter((attempt) => attempt.provider === "nobodywho");
  const fallbackAttempts = physicalAttempts.filter(
    (attempt) => attempt.provider === PS2E_TYPESAFE_FALLBACK_PROVIDER,
  );
  const normalizeToken = (choice, abstain) => (abstain === true ? PS2E_ABSTAIN_TOKEN : (choice ?? null));
  // EVERY attempt whose semantics indicate acceptance. The shared local-first
  // protocol admits EXACTLY ONE authoritative accepted result (the router stops
  // at the first acceptance and reaches the TypeSafe fallback only when no local
  // tier accepted), so a second accepted attempt is a coherently impossible
  // record: it is MALFORMED, and the record is NEVER silently reduced to the
  // last accepted attempt.
  const acceptedAttempts = attempts.filter((attempt) => attempt.accepted === true);
  const withCounts = {
    ...base,
    localAttemptCount: localAttempts.length,
    fallbackAttemptCount: fallbackAttempts.length,
    totalPhysicalAttempts: physicalAttempts.length,
    escalationPath: attempts.slice(0, PS2E_MAX_PERSISTED_ATTEMPTS_PER_RECORD),
    physicalAttemptsUnknown: false,
  };
  if (acceptedAttempts.length > 1) {
    const reference = acceptedAttempts[0];
    const tokenOf = (attempt) => normalizeToken(attempt.choice, attempt.abstain);
    const disagreement = acceptedAttempts.some(
      (other) =>
        tokenOf(other) !== tokenOf(reference) ||
        other.tierToken !== reference.tierToken ||
        other.role !== reference.role ||
        other.provider !== reference.provider ||
        other.model !== reference.model,
    );
    return {
      ...withCounts,
      decision: PS2E_OUTCOMES.MALFORMED,
      decisionSource: PS2E_DECISION_SOURCES.MALFORMED,
      classifierProvider: reference.provider,
      classifierModel: reference.model,
      failureReason: boundedReason(
        disagreement
          ? "multiple accepted attempts contradict each other (choice/tier/role/provider/model); the shared " +
            "local-first protocol admits exactly one authoritative accepted attempt"
          : "multiple accepted attempts claim acceptance; the shared local-first protocol admits exactly one " +
            "authoritative accepted attempt and the record can never be silently reduced to one",
      ),
    };
  }
  const accepted = acceptedAttempts[0] ?? null;

  if (accepted === null) {
    const abstained = attempts.some((attempt) => attempt.abstain === true);
    const lastReason =
      (attempts.length > 0 ? attempts[attempts.length - 1].escalationReason ?? attempts[attempts.length - 1].fallbackReason : null) ??
      outcome.decision?.fallbackReason ??
      outcome.decision?.error ??
      "no_accepted_tier";
    if (abstained) {
      if (outcome.abstained === false) {
        return {
          ...withCounts,
          decision: PS2E_OUTCOMES.MALFORMED,
          decisionSource: PS2E_DECISION_SOURCES.MALFORMED,
          classifierProvider: outcome.decision?.provider ?? null,
          classifierModel: outcome.decision?.model ?? null,
          failureReason: boundedReason("an ABSTAIN outcome contradicts the top-level abstained=false flag"),
        };
      }
      return {
        ...withCounts,
        decision: PS2E_DECISIONS.ABSTAIN,
        decisionSource: PS2E_DECISION_SOURCES.ABSTAINED_WITHOUT_ACCEPTED_TIER,
        classifierProvider: outcome.decision?.provider ?? attempts[attempts.length - 1]?.provider ?? null,
        classifierModel: outcome.decision?.model ?? attempts[attempts.length - 1]?.model ?? null,
        escalationReason: boundedReason(String(lastReason)),
        failureReason: null,
        decisionScore: emptyDecisionScore({
          representation: "bounded-abstention",
          note: "every tier abstained or no tier accepted an answer; ABSTAIN is the protocol outcome",
        }),
      };
    }
    return {
      ...withCounts,
      decision: PS2E_OUTCOMES.FAILED,
      decisionSource: PS2E_DECISION_SOURCES.FAILED,
      classifierProvider: outcome.decision?.provider ?? null,
      classifierModel: outcome.decision?.model ?? null,
      failureReason: boundedReason(String(lastReason)),
    };
  }

  const tierToken = accepted.tierToken;
  const isPrimaryTier = tierToken === String(policy?.primaryTier ?? "1");
  const isLocalProvider = accepted.provider === "nobodywho";
  const token = accepted.abstain === true ? PS2E_ABSTAIN_TOKEN : accepted.choice;
  const decision = decisionFromOptionToken(token);
  const firstFailure = attempts.find((attempt) => attempt.accepted !== true) ?? null;
  const escalationReason = accepted.accepted === true && attempts.length > 1 ? firstFailure?.escalationReason ?? null : null;

  // The frozen PS.2e contract requires thinking OFF. When the shared router
  // exposes its classifier contract and it disagrees, the answer is MALFORMED —
  // never a decision (fail closed; nothing is weakened to accept it).
  const classifierEvidence = outcome.classifier ?? null;
  if (classifierEvidence !== null && classifierEvidence.thinkingEnabled === true) {
    return {
      ...withCounts,
      decision: PS2E_OUTCOMES.MALFORMED,
      decisionSource: PS2E_DECISION_SOURCES.MALFORMED,
      classifierProvider: accepted.provider,
      classifierModel: accepted.model,
      failureReason: "the shared router reports thinking enabled; the frozen PS.2e contract requires thinking OFF",
    };
  }

  if (decision === null) {
    return {
      ...withCounts,
      decision: PS2E_OUTCOMES.MALFORMED,
      decisionSource: PS2E_DECISION_SOURCES.MALFORMED,
      classifierProvider: accepted.provider,
      classifierModel: accepted.model,
      failureReason: "the accepted tier answered with a token outside the frozen option set",
    };
  }

  // ---- CROSS-CHECK ROUTE / CHOICE / ATTEMPT CONSISTENCY --------------------
  // Defense in depth on top of `validateLocalJevOutcome`: an accepted attempt
  // must be a COHERENT physical route (provider ↔ tier, not a skipped record,
  // not contradicting the top-level tier) and the chosen answer must agree
  // across every authoritative location the real schema exposes. A
  // self-contradictory record is MALFORMED — never a decision and never primary.
  const malformedRoute = (reason) => ({
    ...withCounts,
    decision: PS2E_OUTCOMES.MALFORMED,
    decisionSource: PS2E_DECISION_SOURCES.MALFORMED,
    classifierProvider: accepted.provider,
    classifierModel: accepted.model,
    failureReason: boundedReason(reason),
  });
  const isFallbackRoute = tierToken === PS2E_TYPESAFE_FALLBACK_TIER && accepted.provider === PS2E_TYPESAFE_FALLBACK_PROVIDER;
  const isLocalRoute = (tierToken === "1" || tierToken === "2") && accepted.provider === PS2E_CLASSIFIER_PROVIDER;
  if (!isFallbackRoute && !isLocalRoute) {
    return malformedRoute(
      `the accepted attempt's provider '${accepted.provider ?? "unknown"}' contradicts its tier ${tierToken} route; ` +
        "no coherent Local JEV route exists for it",
    );
  }
  if (accepted.status === "skipped") {
    return malformedRoute("a skipped record made no physical call and can never be the accepted attempt");
  }
  if (outcome.tier !== null && outcome.tier !== tierToken) {
    return malformedRoute(
      `the shared router's top-level tier ${outcome.tier} contradicts the accepted attempt's tier ${tierToken}`,
    );
  }
  const acceptedToken = normalizeToken(accepted.choice, accepted.abstain);
  const decisionToken = normalizeToken(outcome.decision?.choice, outcome.decision?.abstain);
  if (decisionToken !== null && acceptedToken !== decisionToken) {
    return malformedRoute("the accepted attempt's answer contradicts the decision's own choice");
  }
  if ((outcome.follow ?? null) !== (outcome.decision?.choice ?? null)) {
    return malformedRoute("follow contradicts the decision's own choice");
  }

  // ---- DECISION / FOLLOW / ATTEMPT / ABSTAIN COHERENCE ---------------------
  // Every authoritative representation of the returned result — `follow`, the
  // decision block's choice / abstain / abstain_reason, the accepted attempt's
  // own fields, a top-level abstained flag when one is exposed, and the router's
  // `decision_source` — must describe ONE and the SAME result. A record that
  // simultaneously claims a binary decision and abstention, or an abstention
  // with an accepted binary attempt, is coherently impossible: MALFORMED, and a
  // malformed record NEVER retains a binary decision.
  const decisionIsBinary = decision === PS2E_DECISIONS.SUPPORT || decision === PS2E_DECISIONS.DO_NOT_SUPPORT;
  const acceptedAbstains = accepted.abstain === true || accepted.choice === PS2E_ABSTAIN_TOKEN;
  if (decisionIsBinary) {
    if (outcome.decision?.abstain === true) {
      return malformedRoute("a binary decision simultaneously claims abstention (decision.abstain)");
    }
    if (outcome.decision?.abstainReason != null) {
      return malformedRoute("a binary decision carries abstention metadata (decision.abstain_reason)");
    }
    if (acceptedAbstains) {
      return malformedRoute("the accepted attempt of a binary decision simultaneously claims abstention");
    }
    if (accepted.abstainReason != null) {
      return malformedRoute("the accepted attempt of a binary decision carries abstention metadata (abstain_reason)");
    }
    if (accepted.status === "abstained") {
      return malformedRoute("the accepted attempt of a binary decision is labelled abstained");
    }
    if (outcome.abstained === true) {
      return malformedRoute("a binary decision contradicts the top-level abstained flag");
    }
    if (
      outcome.routerDecisionSource === "ALL_AVAILABLE_TIERS_ABSTAINED" ||
      outcome.routerDecisionSource === PS2E_DECISION_SOURCES.ABSTAINED_WITHOUT_ACCEPTED_TIER
    ) {
      return malformedRoute(
        `the router's '${outcome.routerDecisionSource}' provenance cannot carry an accepted binary result`,
      );
    }
  } else {
    // The decision is ABSTAIN: a protocol outcome that must never coexist with
    // an accepted binary attempt.
    if (!acceptedAbstains) {
      return malformedRoute("an ABSTAIN decision carries an accepted binary attempt");
    }
    if (outcome.abstained === false) {
      return malformedRoute("an ABSTAIN decision contradicts the top-level abstained=false flag");
    }
  }

  // ---- CROSS-REPRESENTATION PROVENANCE COHERENCE --------------------------
  // The decision block and the accepted attempt are two views of ONE result:
  // their provider/model provenance must agree. A structurally valid but
  // contradictory provenance is NEVER attributed to the primary Tev classifier
  // (the route gate below fails it closed as PRIMARY_IDENTITY_MISMATCH); outside
  // the LIVE primary claim it is a coherently impossible record and MALFORMED.
  const decisionProvider = isPlainObject(outcome.decision) ? (outcome.decision.provider ?? null) : null;
  const decisionModel = isPlainObject(outcome.decision) ? (outcome.decision.model ?? null) : null;
  const providerContradiction = decisionProvider !== null && decisionProvider !== accepted.provider;
  const modelContradiction = decisionModel !== null && accepted.model !== null && decisionModel !== accepted.model;
  const claimsLivePrimary = isPrimaryTier && isLocalProvider && policy?.validationOnly !== true;
  if ((providerContradiction || modelContradiction) && !claimsLivePrimary) {
    return malformedRoute(
      providerContradiction
        ? `the decision's provider '${decisionProvider}' contradicts the accepted attempt's provider '${accepted.provider}'`
        : `the decision's model '${decisionModel}' contradicts the accepted attempt's model '${accepted.model}'`,
    );
  }

  // ---- UNKNOWN / UNSUPPORTED PROVIDER ------------------------------------
  // A provenance that is not the expected local provider and not the declared
  // TypeSafe fallback is MALFORMED as a WHOLE: a malformed source never keeps a
  // valid directional/support decision (no semantically contradictory record).
  if (!isLocalProvider && accepted.provider !== PS2E_TYPESAFE_FALLBACK_PROVIDER) {
    return malformedRoute(
      `the accepted attempt's provider '${accepted.provider ?? "unknown"}' is not the expected local provider ` +
        `'${PS2E_CLASSIFIER_PROVIDER}' nor the declared TypeSafe fallback '${PS2E_TYPESAFE_FALLBACK_PROVIDER}'`,
    );
  }

  // ---- THE PRIMARY IDENTITY GATE ---------------------------------------
  // Identity is never taken on trust and the model-name string alone is never
  // proof of the specialist. Two EXPLICIT policy paths:
  //
  //   LIVE (validationOnly !== true): primary Tev attribution requires the
  //   COMPLETE verified identity contract — the classifier identity block with
  //   classifierId / classifierFamily / classifierKind / tier /
  //   thinkingEnabled=false, status=verified, verifiedBy=loaded_artifact_digest,
  //   expected and observed loaded-artifact SHA-256 (both equal to the pin),
  //   and the pinned model name, ALL in exact agreement, and no
  //   router-reported identity mismatch. Absent evidence ->
  //   PRIMARY_IDENTITY_MISMATCH; a structurally malformed identity object ->
  //   MALFORMED; any validly typed but unverified or contradictory attestation
  //   -> PRIMARY_IDENTITY_MISMATCH. Missing values are never guessed.
  //
  //   VALIDATION-ONLY FIXTURES (validationOnly === true): historical offline
  //   compatibility only — older fixture responses may lack the hardened
  //   classifier fields, so name + any exposed evidence are checked leniently.
  //   This path can never apply to a live policy.
  const isPrimaryLocal = isPrimaryTier && isLocalProvider;
  const livePolicy = policy?.validationOnly !== true;
  const nameMismatch =
    isPrimaryLocal &&
    typeof policy?.pinnedModel === "string" &&
    policy.pinnedModel.length > 0 &&
    accepted.model !== policy.pinnedModel;
  const pinnedDigest =
    typeof policy?.pinnedModelSha256 === "string" && /^[0-9a-f]{64}$/.test(policy.pinnedModelSha256)
      ? policy.pinnedModelSha256
      : null;
  const routerFlaggedMismatch =
    isPrimaryLocal &&
    (outcome.routerDecisionSource === PS2E_DECISION_SOURCES.PRIMARY_IDENTITY_MISMATCH ||
      classifierEvidence?.status === "mismatch");
  // A generic/tier-3 attempt role can never satisfy the primary classifier gate.
  const roleContradiction =
    isPrimaryLocal && accepted.role !== undefined && accepted.role !== null && accepted.role !== "specialist";

  let identityMalformed = false;
  let identityMismatch = false;
  let identityMismatchReason =
    `tier ${tierToken} answered with '${accepted.model ?? "unknown"}', not the precommitted primary classifier ` +
    `'${policy?.pinnedModel ?? "unknown"}' or without its verified identity contract`;
  if (isPrimaryLocal && livePolicy) {
    // ---- ROUTE-PROVENANCE GATE (defense in depth) --------------------------
    // LIVE primary attribution ALSO requires the shared router's own routing
    // metadata to agree that this is the primary Tev specialist route:
    // `decision_source` is PRIMARY_TEV_CLASSIFIER, the top-level tier is
    // exposed, and the accepted PHYSICAL attempt is a `specialist` attempt with
    // status `accepted` (never `skipped`). Route provenance that contradicts
    // primary status is MALFORMED or PRIMARY_IDENTITY_MISMATCH per the existing
    // semantics — but NEVER primary.
    const routeSource = outcome.routerDecisionSource ?? null;
    let routeProblem = null;
    if (outcome.decision === null) {
      routeProblem = {
        kind: "mismatch",
        reason: "the shared router exposed no decision block for the accepted primary attempt",
      };
    } else if (providerContradiction) {
      routeProblem = {
        kind: "mismatch",
        reason:
          `the decision's provider '${decisionProvider}' contradicts the accepted primary attempt's provider ` +
          `'${accepted.provider}'; primary Tev attribution requires coherent provenance`,
      };
    } else if (modelContradiction) {
      routeProblem = {
        kind: "mismatch",
        reason:
          `the decision's model '${decisionModel}' contradicts the accepted primary attempt's model ` +
          `'${accepted.model}'; primary Tev attribution requires coherent provenance`,
      };
    } else if (decisionProvider !== PS2E_CLASSIFIER_PROVIDER) {
      routeProblem = {
        kind: "mismatch",
        reason:
          `the decision's provider '${decisionProvider}' is not the precommitted classifier provider ` +
          `'${PS2E_CLASSIFIER_PROVIDER}'`,
      };
    } else if (
      typeof policy?.pinnedModel === "string" &&
      policy.pinnedModel.length > 0 &&
      decisionModel !== policy.pinnedModel
    ) {
      routeProblem = {
        kind: "mismatch",
        reason: `the decision's model '${decisionModel ?? "unknown"}' is not the precommitted primary classifier '${policy.pinnedModel}'`,
      };
    } else if (routeSource === null && !routerFlaggedMismatch) {
      routeProblem = {
        kind: "mismatch",
        reason: "the shared router exposed no decision_source route provenance for the claimed primary answer",
      };
    } else if (routeSource === "PRIMARY_LOCAL_TIER") {
      routeProblem = {
        kind: "mismatch",
        reason: "the shared router attributes the answer to a generic primary tier, not to the verified specialist",
      };
    } else if (routeSource !== null && routeSource !== PS2E_DECISION_SOURCES.PRIMARY_TEV_CLASSIFIER && !routerFlaggedMismatch) {
      routeProblem = {
        kind: "malformed",
        reason: `the shared router's decision_source '${routeSource}' contradicts the accepted primary attempt`,
      };
    } else if (!routerFlaggedMismatch && routeSource === PS2E_DECISION_SOURCES.PRIMARY_TEV_CLASSIFIER && outcome.tier === null) {
      routeProblem = {
        kind: "mismatch",
        reason: "the shared router exposed no top-level tier for the accepted primary attempt",
      };
    } else if (!routerFlaggedMismatch && routeSource === PS2E_DECISION_SOURCES.PRIMARY_TEV_CLASSIFIER && accepted.role === null) {
      routeProblem = {
        kind: "mismatch",
        reason: "the accepted attempt exposes no role; the shared schema labels a specialist attempt 'specialist'",
      };
    } else if (!routerFlaggedMismatch && routeSource === PS2E_DECISION_SOURCES.PRIMARY_TEV_CLASSIFIER && accepted.role !== "specialist") {
      routeProblem = {
        kind: "mismatch",
        reason: `the accepted attempt's role is '${accepted.role}', not the specialist role of the primary classifier`,
      };
    } else if (!routerFlaggedMismatch && routeSource === PS2E_DECISION_SOURCES.PRIMARY_TEV_CLASSIFIER && accepted.status === null) {
      routeProblem = {
        kind: "mismatch",
        reason: "the accepted attempt exposes no physical status; the shared schema labels accepted attempts 'accepted'",
      };
    } else if (!routerFlaggedMismatch && routeSource === PS2E_DECISION_SOURCES.PRIMARY_TEV_CLASSIFIER && accepted.status !== "accepted") {
      routeProblem = {
        kind: "malformed",
        reason: `the accepted attempt's status '${accepted.status}' contradicts its accepted flag`,
      };
    }
    if (routeProblem !== null && routeProblem.kind === "malformed") {
      return malformedRoute(routeProblem.reason);
    }
    const evidenceShape =
      outcome.classifierEvidenceShape ?? (classifierEvidence === null ? "absent" : "interpretable");
    if (routerFlaggedMismatch || routeProblem !== null) {
      identityMismatch = true;
      if (routeProblem !== null) identityMismatchReason = routeProblem.reason;
    } else if (evidenceShape === "malformed") {
      identityMalformed = true;
    } else if (evidenceShape === "absent" || classifierEvidence === null) {
      identityMismatch = true; // missing required classifier identity evidence
    } else {
      const requiredPresent =
        typeof classifierEvidence.classifierId === "string" &&
        typeof classifierEvidence.classifierFamily === "string" &&
        typeof classifierEvidence.classifierKind === "string" &&
        Number.isInteger(classifierEvidence.tier) &&
        typeof classifierEvidence.thinkingEnabled === "boolean" &&
        typeof classifierEvidence.status === "string" &&
        typeof classifierEvidence.verifiedBy === "string" &&
        typeof classifierEvidence.expectedSha256 === "string" &&
        typeof classifierEvidence.observedSha256 === "string";
      identityMismatch =
        nameMismatch ||
        roleContradiction ||
        !requiredPresent || // missing required identity/digest evidence
        pinnedDigest === null ||
        classifierEvidence.classifierId !== policy?.classifierId ||
        classifierEvidence.classifierFamily !== policy?.classifierFamily ||
        classifierEvidence.classifierKind !== policy?.classifierKind ||
        classifierEvidence.tier !== Number(policy?.primaryTier) ||
        classifierEvidence.thinkingEnabled !== false ||
        classifierEvidence.status !== "verified" ||
        classifierEvidence.verifiedBy !== "loaded_artifact_digest" ||
        classifierEvidence.expectedSha256 !== pinnedDigest ||
        classifierEvidence.observedSha256 !== pinnedDigest ||
        classifierEvidence.observedSha256 !== classifierEvidence.expectedSha256 ||
        (outcome.decision?.modelSha256 != null && outcome.decision.modelSha256 !== pinnedDigest);
    }
  } else if (isPrimaryLocal) {
    // validationOnly: historical fixture compatibility (never a live policy).
    identityMismatch = nameMismatch || routerFlaggedMismatch;
  }

  if (identityMalformed) {
    return {
      ...withCounts,
      decision: PS2E_OUTCOMES.MALFORMED,
      decisionSource: PS2E_DECISION_SOURCES.MALFORMED,
      classifierProvider: accepted.provider,
      classifierModel: accepted.model,
      failureReason:
        "the classifier identity evidence is structurally malformed or self-contradictory and cannot be " +
        "interpreted as the required classifier contract",
    };
  }

  let decisionSource;
  if (!isLocalProvider) {
    // Route coherence above guarantees only the declared TypeSafe fallback
    // remains here; anything else was already returned as fully MALFORMED.
    if (accepted.provider !== PS2E_TYPESAFE_FALLBACK_PROVIDER) {
      return malformedRoute(`the accepted attempt's provider '${accepted.provider ?? "unknown"}' is not a known provider`);
    }
    decisionSource = PS2E_DECISION_SOURCES.FALLBACK_TYPESAFE_JEV;
  } else if (isPrimaryTier) {
    decisionSource = identityMismatch ? PS2E_DECISION_SOURCES.PRIMARY_IDENTITY_MISMATCH : PS2E_DECISION_SOURCES.PRIMARY_TEV_CLASSIFIER;
  } else {
    decisionSource = PS2E_DECISION_SOURCES.ESCALATED_LOCAL_TIER;
  }

  const escalated = !isPrimaryTier || identityMismatch;
  const fallbackUsed = accepted.provider === PS2E_TYPESAFE_FALLBACK_PROVIDER;
  const score = decisionScoreOf(outcome.decision, accepted, { primary: !escalated });

  return {
    ...withCounts,
    decision,
    decisionSource,
    acceptedTier: tierToken,
    classifierProvider: accepted.provider,
    classifierModel: accepted.model,
    classifierModelSha256: outcome.decision?.modelSha256 ?? classifierEvidence?.observedSha256 ?? null,
    escalated,
    escalationReason: boundedReason(identityMismatch ? identityMismatchReason : escalationReason),
    fallbackTier: escalated ? tierToken : null,
    fallbackProvider: escalated ? accepted.provider : null,
    fallbackModel: escalated ? accepted.model ?? null : null,
    fallbackUsed,
    primaryIdentityMismatch: identityMismatch,
    failureReason: null,
    decisionScore: score.decisionScore,
    probabilityKind: score.probabilityKind,
    coldOrWarm: coldOrWarmOf(outcome.decision),
  };
}

function emptyDecisionScore({ representation = null, note = null } = {}) {
  return {
    representation,
    calibratedProbability: null,
    calibratedProbabilityKind: null,
    sampleStability: null,
    sampleStabilityKind: null,
    votes: null,
    samples: null,
    samplesPlanned: null,
    voteMargin: null,
    optionTokenCount: PS2E_OPTION_TOKEN_COUNT,
    logitsAvailable: false,
    logitMargin: null,
    probabilityIsCalibrated: false,
    note,
  };
}

/**
 * Preserve the classifier's TRUE score semantics. A grammar-constrained vote
 * share is `sample_stability`, never a probability; a TypeSafe fallback's number
 * is `calibrated_probability` only because the shared implementation labels it
 * that way. No field is ever named `pSupport`.
 */
function decisionScoreOf(decision, accepted, { primary }) {
  const confidenceKind = accepted.confidenceKind ?? decision?.confidenceKind ?? null;
  const confidence = accepted.confidence ?? decision?.confidence ?? null;
  const votes = decision?.votes ?? null;
  const calibrated = confidenceKind === "calibrated_probability" && typeof confidence === "number" ? confidence : null;
  const stability = confidenceKind === "sample_stability" && typeof confidence === "number" ? confidence : null;
  return {
    probabilityKind: calibrated !== null ? "calibrated_probability" : stability !== null ? "sample_stability" : "none",
    decisionScore: {
      representation: votes !== null ? "grammar-constrained-option-votes" : calibrated !== null ? "provider-calibrated-probability" : null,
      calibratedProbability: calibrated,
      calibratedProbabilityKind: calibrated !== null ? "calibrated_probability" : null,
      sampleStability: stability,
      sampleStabilityKind: stability !== null ? "sample_stability" : null,
      votes,
      samples: decision?.samples ?? null,
      samplesPlanned: decision?.samplesPlanned ?? null,
      voteMargin: voteMarginOf(votes),
      optionTokenCount: PS2E_OPTION_TOKEN_COUNT,
      logitsAvailable: false,
      logitMargin: null,
      probabilityIsCalibrated: false,
      note: primary
        ? "the local classifier reports grammar-constrained option votes; a vote share is a stability proxy, not a probability"
        : "the accepted escalation/fallback tier's own score representation is preserved unchanged",
    },
  };
}

function coldOrWarmOf(decision) {
  if (!decision) return null;
  if (decision.worker === "persistent") {
    if (decision.modelReused === true) return "warm";
    if (decision.modelReused === false) return "cold";
    return null;
  }
  if (decision.worker === "oneshot") return "cold";
  return null;
}

/* ============================================================================
 * Transports
 * ==========================================================================*/

export const LOCAL_JEV_TRANSPORT_STATUS = Object.freeze({
  OK: "TRANSPORT_OK",
  TIMEOUT: "TRANSPORT_TIMEOUT",
  EXIT_NONZERO: "TRANSPORT_EXIT_NONZERO",
  SPAWN_FAILED: "TRANSPORT_SPAWN_FAILED",
});

/**
 * The production transport: the shared Local JEV CLI, one bounded child process
 * per logical call, minimal environment, hard timeout, bounded output capture.
 */
export function createDecisionCliTransport({
  executable = null,
  argv = null,
  spawnImpl = nodeSpawn,
  env = process.env,
  timeoutMs = PS2E_LOGICAL_CALL_TIMEOUT_MS,
  maxStdoutBytes = PS2E_LOCAL_JEV_MAX_STDOUT_BYTES,
  maxStderrBytes = PS2E_LOCAL_JEV_MAX_STDERR_BYTES,
} = {}) {
  const resolved = resolveLocalJevExecutable({ env, executable });
  const command = resolved.command;
  const args = argv ?? ["ask", "--caller", "evolve", "--mode", PS2E_LOCAL_JEV_MODE];
  // Linux: each request's child is launched as its OWN process group leader, so
  // cleanup on timeout/finalization can terminate exactly the process tree
  // created for this request (the child AND any grandchild) and nothing else.
  // The shared persistent model worker starts its own session and is never in
  // this group. On platforms without POSIX process groups this falls back to
  // terminating the direct child only. There is no command interpreter and the
  // argv stays fixed.
  const useProcessGroup = process.platform !== "win32";
  const live = new Set();
  const terminateTree = (entry) => {
    if (entry.treeTerminated) return;
    entry.treeTerminated = true;
    const pid = entry.child?.pid;
    if (useProcessGroup && typeof pid === "number" && pid > 0) {
      try {
        process.kill(-pid, "SIGKILL");
        return;
      } catch {
        /* the group is already gone; fall back to the direct child below */
      }
    }
    try {
      entry.child?.kill?.("SIGKILL");
    } catch {
      /* already gone */
    }
  };
  return {
    kind: "decision-cli",
    command,
    args: [...args],
    description: `${command} ${args.join(" ")}`,
    processGroupCleanup: useProcessGroup,
    dispatch({ request, timeoutMs: perCallTimeoutMs = null } = {}) {
      const bound = Number.isFinite(perCallTimeoutMs) && perCallTimeoutMs > 0 ? perCallTimeoutMs : timeoutMs;
      return new Promise((resolve) => {
        const entry = { child: null, treeTerminated: false };
        let settled = false;
        let stdoutBytes = 0;
        let stderrBytes = 0;
        const stdoutChunks = [];
        const stderrChunks = [];
        let timer = null;
        const finish = (result, { terminateTreeAfter = false } = {}) => {
          if (settled) return;
          settled = true;
          if (timer !== null) clearTimeout(timer);
          live.delete(entry);
          // Timeout/finalization/error cleanup terminates THIS request's process
          // group (the child and any grandchild it created), never anything
          // outside it. A normal child close needs no tree kill.
          if (terminateTreeAfter) terminateTree(entry);
          resolve({
            ...result,
            stdout: Buffer.concat(stdoutChunks).toString("utf8"),
            stderr: Buffer.concat(stderrChunks).toString("utf8").slice(0, 2_000),
            stdoutTruncated: stdoutBytes > maxStdoutBytes,
            stderrTruncated: stderrBytes > maxStderrBytes,
          });
        };
        try {
          entry.child = spawnImpl(command, args, {
            env: minimalChildEnv(env),
            stdio: ["pipe", "pipe", "pipe"],
            detached: useProcessGroup,
          });
        } catch (error) {
          finish({ status: LOCAL_JEV_TRANSPORT_STATUS.SPAWN_FAILED, exitCode: null, error: boundedReason(String(error?.message ?? error)) }, { terminateTreeAfter: true });
          return;
        }
        const child = entry.child;
        live.add(entry);
        child.on?.("error", (error) => {
          finish({ status: LOCAL_JEV_TRANSPORT_STATUS.SPAWN_FAILED, exitCode: null, error: boundedReason(String(error?.message ?? error)) }, { terminateTreeAfter: true });
        });
        child.stdout?.on?.("data", (chunk) => {
          stdoutBytes += chunk.length;
          if (stdoutBytes <= maxStdoutBytes) stdoutChunks.push(chunk);
        });
        child.stderr?.on?.("data", (chunk) => {
          stderrBytes += chunk.length;
          if (stderrBytes <= maxStderrBytes) stderrChunks.push(chunk);
        });
        child.on?.("close", (code, signal) => {
          finish({
            status: code === 0 ? LOCAL_JEV_TRANSPORT_STATUS.OK : LOCAL_JEV_TRANSPORT_STATUS.EXIT_NONZERO,
            exitCode: code,
            signal: signal ?? null,
            error: code === 0 ? null : `the shared Local JEV CLI exited with code ${code}${signal ? ` (${signal})` : ""}`,
          });
        });
        timer = setTimeout(() => {
          // TIMEOUT: the whole request process group is terminated (the direct
          // child alone is NOT enough — it may have spawned a grandchild).
          terminateTree(entry);
          finish({
            status: LOCAL_JEV_TRANSPORT_STATUS.TIMEOUT,
            exitCode: null,
            error: `the shared Local JEV CLI exceeded the ${bound} ms PS.2e bound`,
          });
        }, bound);
        // A child that exits before reading stdin must never surface as an
        // unhandled stream error: the close/timeout path reports it instead.
        child.stdin?.on?.("error", () => {});
        try {
          child.stdin?.end?.(JSON.stringify(request));
        } catch (error) {
          finish({ status: LOCAL_JEV_TRANSPORT_STATUS.SPAWN_FAILED, exitCode: null, error: boundedReason(String(error?.message ?? error)) }, { terminateTreeAfter: true });
        }
      });
    },
    /**
     * Finalization cleanup: terminate the process tree of every in-flight
     * request, scoped to those requests' own process groups. Each dispatch
     * settles through its own close/timeout path.
     */
    cancelPending() {
      for (const entry of [...live]) terminateTree(entry);
    },
  };
}

/**
 * Deterministic offline transport (VALIDATION ONLY, never CLI-selectable). It
 * returns canned transport outcomes so the complete PS.2e contract — including
 * escalation, abstention, malformed output, timeouts and runtime failure — can be
 * exercised without a live model.
 */
export function createFixtureTransport({ script = [], name = "fixture" } = {}) {
  const steps = Array.isArray(script) ? [...script] : [];
  const calls = [];
  return {
    kind: "fixture",
    name,
    description: `fixture:${name}`,
    calls,
    dispatch({ request } = {}) {
      calls.push(request);
      const step = steps.length > 1 ? steps.shift() : steps[0] ?? { status: LOCAL_JEV_TRANSPORT_STATUS.OK, stdout: "{}" };
      const status = step?.status ?? LOCAL_JEV_TRANSPORT_STATUS.OK;
      const stdout =
        typeof step?.stdout === "string"
          ? step.stdout.replace("__REQUEST_ID__", String(request?.id ?? ""))
          : JSON.stringify({ request_id: request?.id ?? null, mode: PS2E_LOCAL_JEV_MODE, follow: null, decision: null });
      return Promise.resolve({
        status,
        exitCode: status === LOCAL_JEV_TRANSPORT_STATUS.OK ? 0 : 1,
        signal: null,
        error: step?.error ?? (status === LOCAL_JEV_TRANSPORT_STATUS.OK ? null : `fixture transport ${status}`),
        stdout,
        stderr: typeof step?.stderr === "string" ? step.stderr : "",
        stdoutTruncated: step?.stdoutTruncated === true,
        stderrTruncated: step?.stderrTruncated === true,
      });
    },
  };
}

/* ============================================================================
 * Client
 * ==========================================================================*/

/**
 * The Local JEV client. It never retries: the shared implementation already owns
 * its own bounded retry/escalation policy, and PS.2e must not add a second one.
 */
export function createLocalJevClient({
  transport,
  policy,
  logicalTimeoutMs = PS2E_LOGICAL_CALL_TIMEOUT_MS,
  maxStateChars = PS2E_LOCAL_JEV_CONTRACT.maxStateChars,
  stateLengthOf = null,
  nowMs = () => Date.now(),
} = {}) {
  if (!transport || typeof transport.dispatch !== "function") throw new Error("a Local JEV transport is required");
  if (!policy || typeof policy !== "object") throw new Error("a classifier policy is required");

  function buildRequestFor({ sessionId, packet, globalAdmissionIndex }) {
    return buildLocalTevRequest({
      requestId: localTevRequestIdFor({ sessionId, globalAdmissionIndex }),
      packet,
    });
  }

  async function dispatch({ request, stateLength = null }) {
    const length =
      typeof stateLength === "number"
        ? stateLength
        : typeof stateLengthOf === "function"
          ? stateLengthOf(request?.state)
          : null;
    if (typeof length === "number" && Number.isFinite(length) && length > maxStateChars) {
      return {
        ok: false,
        status: LOCAL_JEV_CLIENT_STATUS.REQUEST_TOO_LARGE,
        validation: { ok: false, status: LOCAL_JEV_CLIENT_STATUS.REQUEST_TOO_LARGE, problems: [`request state is ${length} chars; the shared contract allows ${maxStateChars}`], outcome: null },
        transportStatus: null,
        dispatchMs: 0,
        rawDigest: null,
      };
    }
    const startedAtMs = nowMs();
    const result = await transport.dispatch({ request, timeoutMs: logicalTimeoutMs });
    const dispatchMs = Math.max(0, nowMs() - startedAtMs);
    const rawDigest = typeof result?.stdout === "string" && result.stdout.length > 0 ? sha256Hex(result.stdout) : null;
    if (result?.status !== LOCAL_JEV_TRANSPORT_STATUS.OK) {
      const status =
        result?.status === LOCAL_JEV_TRANSPORT_STATUS.TIMEOUT
          ? LOCAL_JEV_CLIENT_STATUS.TIMEOUT
          : result?.status === LOCAL_JEV_TRANSPORT_STATUS.SPAWN_FAILED
            ? LOCAL_JEV_CLIENT_STATUS.SPAWN_FAILED
            : LOCAL_JEV_CLIENT_STATUS.EXIT_NONZERO;
      return {
        ok: false,
        status,
        validation: {
          ok: false,
          status,
          problems: [boundedReason(result?.error ?? "the shared Local JEV transport failed") ?? "transport failure"],
          outcome: null,
        },
        transportStatus: result?.status ?? null,
        dispatchMs,
        rawDigest,
        stdoutTruncated: result?.stdoutTruncated === true,
        stderrTruncated: result?.stderrTruncated === true,
      };
    }
    // ---- TRUNCATED OUTPUT FAILS CLOSED ------------------------------------
    // The bounded capture cut the shared answer: the leading JSON object is
    // NEVER parsed or accepted (a valid prefix followed by more output can hide
    // a different final answer), the result is MALFORMED, and it can never
    // classify as primary. The honest failure/accounting provenance is retained.
    if (result?.stdoutTruncated === true) {
      const status = LOCAL_JEV_CLIENT_STATUS.MALFORMED;
      return {
        ok: false,
        status,
        validation: {
          ok: false,
          status,
          problems: [
            `stdout_truncated: the shared Local JEV answer exceeded the ${PS2E_LOCAL_JEV_MAX_STDOUT_BYTES}-byte capture ` +
              "bound; the truncated output is never parsed and never accepted",
          ],
          outcome: null,
        },
        transportStatus: result?.status ?? null,
        dispatchMs,
        rawDigest,
        stdoutTruncated: true,
        stderrTruncated: result?.stderrTruncated === true,
      };
    }
    const validation = validateLocalJevOutcome(result.stdout, { requestId: request?.id ?? null });
    return {
      ok: validation.ok,
      status: validation.status,
      validation,
      transportStatus: result.status,
      dispatchMs,
      rawDigest,
      stdoutTruncated: false,
      stderrTruncated: result?.stderrTruncated === true,
    };
  }

  return {
    version: LOCAL_JEV_CLIENT_VERSION,
    transport: {
      kind: transport.kind ?? "unknown",
      description: transport.description ?? null,
      command: transport.command ?? null,
      args: transport.args ?? null,
      processGroupCleanup: transport.processGroupCleanup === true,
    },
    policy: { ...policy },
    logicalTimeoutMs,
    buildRequestFor,
    dispatch,
    /** Finalization cleanup delegated to the transport (scoped to request trees). */
    cancelPending() {
      if (typeof transport.cancelPending === "function") transport.cancelPending();
    },
    breaker: { ...PS2E_CIRCUIT_BREAKER },
  };
}

export const PS2E_LOCAL_TIER_COUNT_FALLBACK = PS2E_LOCAL_TIER_COUNT_CEILING;
export const PS2E_MAX_LOCAL_RETRIES_FALLBACK = PS2E_MAX_LOCAL_RETRIES_CEILING;
export const PS2E_FALLBACK_TIER_TOKEN = PS2E_TYPESAFE_FALLBACK_TIER;
export const PS2E_LOCAL_PROVIDER = "nobodywho";
