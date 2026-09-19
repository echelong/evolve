/**
 * Phase 5C/5C.3 — CLI command-mode resolution (PAPER ONLY).
 *
 * Phase 5C.3 extends the wave selectors to the freeze lifecycle:
 *
 *   `--write-freeze --wave wave-2`  write THAT wave's own canonical freeze
 *   `--verify-freeze --wave wave-2` verify THAT wave's own freeze (read-only)
 *
 * while keeping a wave-scoped command unable to reach any other wave's or the
 * historical freeze artifact. A wave-less `--write-freeze` still writes the
 * historical root freeze, byte-for-byte as before.
 *
 * Phase 5C is an action-per-invocation CLI, but the original implementation
 * treated `--write-freeze`, `--verify-freeze`, `--cohorts`, `--plan` and
 * `--summary` as *additive flags* evaluated against one shared control flow:
 *
 *   if (args["write-freeze"] || !freeze) { freeze = await writeFreeze(...) }   // no return
 *   if (args["verify-freeze"]) { ...; return }
 *   ... cohorts ... if (args.cohorts) { ...; return }
 *   ... registry ... plan ...
 *   if (args.summary || args.plan || !eligible) { ...; return }
 *   ... full replication run ...
 *
 * `--write-freeze` therefore wrote the freeze artifact and then FELL THROUGH
 * the whole remaining chain into a full replication run. Writing a freeze is an
 * ACTION, not a modifier: it must write the freeze and stop.
 *
 * This module makes the dispatch explicit and testable. `resolveAction` is a
 * pure function over parsed argv:
 *
 *   * zero action flags           -> ACTION.RUN (the only mode that may execute)
 *   * exactly one action flag     -> that action
 *   * two or more action flags    -> a loud failure (never a silent pick)
 *   * `--rerun`/`--dev`           -> run-only; rejected with any other action
 *
 * It touches no filesystem, no network, no subprocess, and no provider.
 */

export const ACTION = Object.freeze({
  RUN: "run",
  WRITE_FREEZE: "write-freeze",
  VERIFY_FREEZE: "verify-freeze",
  COHORTS: "cohorts",
  PLAN: "plan",
  SUMMARY: "summary",
  META_SUMMARY: "meta-summary",
});

/** Action flags in declaration order (order only shapes the error message). */
export const ACTION_FLAGS = Object.freeze([
  Object.freeze({ flag: "write-freeze", action: ACTION.WRITE_FREEZE }),
  Object.freeze({ flag: "verify-freeze", action: ACTION.VERIFY_FREEZE }),
  Object.freeze({ flag: "cohorts", action: ACTION.COHORTS }),
  Object.freeze({ flag: "plan", action: ACTION.PLAN }),
  Object.freeze({ flag: "summary", action: ACTION.SUMMARY }),
  Object.freeze({ flag: "meta-summary", action: ACTION.META_SUMMARY }),
]);

/** Actions that may be scoped to a single wave by `--wave <id>`. */
export const WAVE_SCOPED_ACTIONS = Object.freeze([
  ACTION.PLAN,
  ACTION.SUMMARY,
  ACTION.RUN,
  ACTION.WRITE_FREEZE,
  ACTION.VERIFY_FREEZE,
]);

/** Actions that may be scoped to a list of waves by `--waves <ids>`. */
export const MULTI_WAVE_SCOPED_ACTIONS = Object.freeze([ACTION.META_SUMMARY]);

/** Flags that only mean something for an actual replication run. */
export const EXECUTION_ONLY_FLAGS = Object.freeze(["rerun", "dev"]);

/** The only action that is allowed to plan or execute replication units. */
export function actionExecutesUnits(action) {
  return action === ACTION.RUN;
}

/**
 * Resolve exactly one command action from parsed arguments.
 *
 * @param {{ [key: string]: unknown }} [args]
 * @returns {{
 *   ok: boolean,
 *   action: string,
 *   requested: string[],
 *   executionOnly: string[],
 *   error: string|null,
 * }}
 */
export function resolveAction(args = {}) {
  const requested = ACTION_FLAGS.filter((entry) => args?.[entry.flag] === true).map((entry) => entry.flag);

  if (requested.length > 1) {
    return {
      ok: false,
      action: null,
      requested,
      executionOnly: [],
      error:
        `conflicting command modes: ${requested.map((flag) => `--${flag}`).join(" and ")}. ` +
        "Command modes are mutually exclusive — run one of them per invocation.",
    };
  }

  const action = requested.length === 1
    ? ACTION_FLAGS.find((entry) => entry.flag === requested[0]).action
    : ACTION.RUN;

  const executionOnly = EXECUTION_ONLY_FLAGS.filter((flag) => args?.[flag] === true);
  if (action !== ACTION.RUN && executionOnly.length > 0) {
    return {
      ok: false,
      action,
      requested,
      executionOnly,
      error:
        `${executionOnly.map((flag) => `--${flag}`).join(" and ")} ` +
        `${executionOnly.length > 1 ? "are run-only flags" : "is a run-only flag"} — ` +
        `${executionOnly.length > 1 ? "they do" : "it does"} not apply to --${action}; drop ` +
        `${executionOnly.length > 1 ? "them" : "it"} (a replication run is the default mode).`,
    };
  }

  return { ok: true, action, requested, executionOnly, error: null };
}

/**
 * Resolve the optional Phase 5C.2 wave selectors from parsed arguments.
 *
 * Pure: it touches no filesystem and executes nothing. It only rejects
 * impossible combinations, so the caller can fail closed before any handler
 * runs:
 *
 *   `--wave <id>`   scopes --plan, --summary and the normal run to ONE wave.
 *   `--waves <ids>` scopes --meta-summary to a subset of waves.
 *
 * A wave's membership is PREDECLARED, so combining `--wave` with `--datasets`
 * is rejected rather than silently preferring one.
 *
 * @param {{ [key: string]: unknown }} [args]
 * @param {string} action one of ACTION
 */
export function resolveWaveOptions(args = {}, action = ACTION.RUN) {
  const source = args ?? {};
  const waveProvided = Object.hasOwn(source, "wave") && source.wave !== false;
  const wavesProvided = Object.hasOwn(source, "waves") && source.waves !== false;
  const waveRaw = source.wave;
  const wavesRaw = source.waves;
  const waveId = typeof waveRaw === "string" && waveRaw.trim().length > 0 ? waveRaw.trim() : null;
  const waveIds = typeof wavesRaw === "string"
    ? wavesRaw.split(",").map((value) => value.trim()).filter(Boolean)
    : null;
  const errors = [];

  if (waveProvided && !waveId) {
    errors.push("--wave requires a wave id (for example `--wave wave-2`)");
  }
  if (waveProvided && !WAVE_SCOPED_ACTIONS.includes(action)) {
    errors.push(
      `--wave only applies to --plan, --summary, the normal run, --write-freeze and --verify-freeze (not --${action}); ` +
        (action === ACTION.META_SUMMARY ? "use --waves <list> for a cross-wave summary" : "drop it"),
    );
  }
  if (waveId && source.datasets !== undefined) {
    errors.push(
      "--wave and --datasets are mutually exclusive: a wave's membership is predeclared, so it is never discovered with `auto`",
    );
  }
  if (wavesProvided && action !== ACTION.META_SUMMARY) {
    errors.push(`--waves only applies to --meta-summary (not --${action})`);
  }
  if (wavesProvided && (!waveIds || waveIds.length === 0)) {
    errors.push("--waves was given no wave ids");
  }
  if (waveId && wavesProvided) {
    errors.push("--wave and --waves are mutually exclusive: use --waves <list> for --meta-summary");
  }

  return { ok: errors.length === 0, waveId, waveIds, waveProvided, wavesProvided, errors };
}

export default resolveAction;
