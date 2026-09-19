/**
 * Phase 5C — CLI command-mode resolution (PAPER ONLY).
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
});

/** Action flags in declaration order (order only shapes the error message). */
export const ACTION_FLAGS = Object.freeze([
  Object.freeze({ flag: "write-freeze", action: ACTION.WRITE_FREEZE }),
  Object.freeze({ flag: "verify-freeze", action: ACTION.VERIFY_FREEZE }),
  Object.freeze({ flag: "cohorts", action: ACTION.COHORTS }),
  Object.freeze({ flag: "plan", action: ACTION.PLAN }),
  Object.freeze({ flag: "summary", action: ACTION.SUMMARY }),
]);

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

export default resolveAction;
