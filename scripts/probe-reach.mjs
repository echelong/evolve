#!/usr/bin/env node
/**
 * Phase 5E — Agent-Reach doctor/probe (`npm run probe:reach`).
 *
 * A READ-ONLY health check for the pinned external-intelligence backend:
 *
 *   * reports the pinned repository / release / commit / license / Python need;
 *   * shows the enabled and disabled channel allowlists;
 *   * checks whether the project-local Agent-Reach binary exists;
 *   * with `--probe`, runs ONLY the side-effect-free `agent-reach version` and
 *     `agent-reach doctor --json` paths (never the text `doctor` path, which
 *     installs skill files);
 *   * performs NO authenticated login, NO write operation and NO capture;
 *   * persists NOTHING unless `--save` is passed;
 *   * never touches EVOLVE market datasets (Wave 2 included).
 *
 * The probe is deliberately NOT run automatically: an operator runs it.
 *
 * PAPER ONLY. Read-only, shadow-only, no wallet, no posting.
 */

import { spawn } from "node:child_process";
import path from "node:path";

import { parseArgs } from "./lib/args.mjs";
import {
  AGENT_REACH_PIN,
  DEFAULT_REACH_MAX_BYTES,
  DEFAULT_REACH_MAX_CALLS,
  DEFAULT_REACH_MAX_RESULTS,
  DEFAULT_REACH_TIMEOUT_MS,
  DISABLED_INTELLIGENCE_CHANNELS,
  ENABLED_INTELLIGENCE_CHANNELS,
  READ_ONLY_ACTIONS,
  WRITE_ACTIONS,
} from "./intelligence/config.mjs";

const BOOLEAN_FLAGS = ["json", "probe", "save", "help"];

function usage() {
  return [
    "EVOLVE Phase 5E — Agent-Reach doctor/probe (READ-ONLY, PAPER ONLY)",
    "",
    "  npm run probe:reach                 report config + local install status (executes nothing)",
    "  npm run probe:reach -- --probe      additionally run `agent-reach version` and `agent-reach doctor --json`",
    "  npm run probe:reach -- --save       persist the report under .evolve/intelligence/health/",
    "",
    "Nothing is executed without --probe, nothing is persisted without --save, and no login is ever performed.",
  ].join("\n");
}

/**
 * A bounded, read-only probe delegated to `scripts/intelligence.mjs doctor`,
 * so there is exactly ONE implementation of the probe semantics.
 */
function main() {
  const args = parseArgs(process.argv.slice(2), { booleanFlags: BOOLEAN_FLAGS, valueFlags: ["out"] });
  if (args.help === true) {
    console.log(usage());
    return;
  }

  const childArgs = ["doctor", ...(args.probe === true ? ["--probe"] : []), ...(args.save === true ? ["--save"] : []), ...(args.json === true ? ["--json"] : [])];
  const script = path.join(process.cwd(), "scripts", "intelligence.mjs");
  if (args.json !== true) {
    console.log("[probe:reach] pinned backend:");
    console.log(`  repository : ${AGENT_REACH_PIN.repository}`);
    console.log(`  release    : ${AGENT_REACH_PIN.release} (commit ${AGENT_REACH_PIN.commit})`);
    console.log(`  license    : ${AGENT_REACH_PIN.license} · Python ${AGENT_REACH_PIN.python}`);
    console.log(`  local dir  : ${AGENT_REACH_PIN.localInstallDir} (project-local, gitignored)`);
    console.log(`  channels   : ${ENABLED_INTELLIGENCE_CHANNELS.join(", ")}`);
    console.log(`  disabled   : ${DISABLED_INTELLIGENCE_CHANNELS.join(", ")}`);
    console.log(`  read-only  : ${READ_ONLY_ACTIONS.join(", ")} · rejected writes: ${WRITE_ACTIONS.join(", ")}`);
    console.log(
      `  limits     : timeout ${DEFAULT_REACH_TIMEOUT_MS}ms · max calls ${DEFAULT_REACH_MAX_CALLS} · max results ${DEFAULT_REACH_MAX_RESULTS} · max bytes ${DEFAULT_REACH_MAX_BYTES}`,
    );
    console.log("");
  }

  const child = spawn(process.execPath, [script, ...childArgs], { stdio: "inherit", shell: false });
  child.on("close", (code) => {
    process.exitCode = code ?? 1;
  });
}

if (!process.env.EVOLVE_REACH_PROBE_INTERNAL) main();
