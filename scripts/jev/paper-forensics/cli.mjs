/**
 * EVOLVE Phase 5I-PS.1 — forensic CLI (§17, §18).
 *
 *   npm run jev:paper:analyze -- --session jpaper-<UTC timestamp>-<digest>
 *                             [--out .evolve/jev-paper-forensics]
 *                             [--json]
 *
 * The session is ALWAYS named explicitly. There is deliberately no `--latest`:
 * a forensic instrument must analyze the capture the operator asked for, never
 * whatever happened to be newest.
 *
 * The CLI constructs NO provider, needs NO API key, needs NO Jev configuration,
 * makes NO network call, and has no wallet, signing, swap, order, RPC-write or
 * execution capability of any kind.
 *
 * It prints NO winner and NO recommendation: the counterfactual block is a
 * frozen diagnostic set, reported in declaration order.
 *
 * PAPER ONLY / DEVELOPMENT ONLY / POST-HOC ONLY.
 */

import { parseArgs } from "../../lib/args.mjs";
import { analyzePaperShadowSession } from "./analysis.mjs";
import {
  PAPER_FORENSICS_CLOSING_BANNER,
  PAPER_FORENSICS_COUNTERFACTUAL_BANNER,
  PAPER_FORENSICS_FILES,
  PAPER_FORENSICS_LABEL,
  PAPER_FORENSICS_ROOT_DIR,
  PAPER_FORENSICS_SOURCE_ROOT_DIR,
  PAPER_FORENSICS_TOLERANCE,
  isValidPaperShadowSourceSessionId,
} from "./definition.mjs";
import { readPaperForensicsJson } from "./storage.mjs";

export const PAPER_FORENSICS_CLI_VERSION = 1;

/** The usage text. Printed on `--help` and on any invalid invocation. */
export const PAPER_FORENSICS_USAGE = [
  "EVOLVE JEV PAPER FORENSICS (Phase 5I-PS.1) — offline post-hoc development instrument",
  "",
  "Usage:",
  "  npm run jev:paper:analyze -- --session <paper-shadow-session-id> [--out <dir>] [--json]",
  "",
  "  --session  REQUIRED. The captured session id, e.g. jpaper-20260920T154342Z-4734bb.",
  "             Read from .evolve/jev-paper-shadow/<session-id>/. There is no --latest.",
  "  --out      Optional forensic tree base (default .evolve/jev-paper-forensics).",
  "  --json     Optional: print the analysis summary as JSON (no color, no prose).",
  "",
  "Read-only: the source session and the whole .evolve/jev-direction tree are proven",
  "byte-identical after the analysis. No network call, no Jev call, no Jupiter call,",
  "no provider, no API key, and no wallet/signing/execution capability.",
].join("\n");

/** Parse CLI args into a settings record. Never throws on its own. */
export function buildPaperForensicsCliSettings(argv = []) {
  const args = parseArgs(argv, { booleanFlags: ["json", "help"] });
  const problems = [];
  for (const key of Object.keys(args)) {
    if (!["_", "session", "out", "json", "help"].includes(key)) problems.push(`unsupported option --${key}`);
  }
  if (args._.length) problems.push("unexpected positional arguments");
  if (args.out !== undefined && typeof args.out !== "string") problems.push("--out requires a directory");
  const sessionId = args.session !== undefined ? String(args.session).trim() : "";
  if (sessionId.length === 0) {
    problems.push("--session is required; this analyzer never infers a session (there is no --latest)");
  } else if (!isValidPaperShadowSourceSessionId(sessionId)) {
    problems.push(`invalid --session '${sessionId}'; session ids look like 'jpaper-<UTC timestamp>-<digest>'`);
  }
  const out = args.out !== undefined && String(args.out).trim() !== "" ? String(args.out).trim() : null;
  return {
    version: PAPER_FORENSICS_CLI_VERSION,
    sessionId: sessionId.length > 0 ? sessionId : null,
    out,
    json: args.json === true,
    help: args.help === true,
    problems,
  };
}

function pad(label, width = 16) {
  return String(label).padEnd(width, " ");
}

function number(value, digits = 6) {
  return Number.isFinite(value) ? String(Number(value.toFixed(digits))) : "n/a";
}

/** The compact human-readable summary (§18). No winner is ever printed. */
export function formatForensicsSummary(analysis) {
  const summary = analysis.summary;
  const lines = [];
  lines.push(PAPER_FORENSICS_LABEL);
  lines.push("");
  lines.push(`${pad("source")}${analysis.sessionId}`);
  lines.push(`${pad("analysis")}${analysis.analysisId}`);
  lines.push(`${pad("decisions")}${summary.decisions}`);
  lines.push(`${pad("integrity")}${summary.integrity}`);
  lines.push("");
  lines.push(`${pad("pHigher mean")}${number(summary.pHigher.mean)}`);
  lines.push(
    `${pad("pHigher range")}${number(summary.pHigher.min)} … ${number(summary.pHigher.max)} (stddev ${number(summary.pHigher.stddev)})`,
  );
  lines.push(`${pad("pHigher == 0.50")}${summary.pHigher.atHalf}`);
  lines.push(`${pad("intents")}HIGHER ${summary.intents.higher} / LOWER ${summary.intents.lower} (flips ${summary.intents.flips})`);
  lines.push("");
  lines.push(`${pad("round trips")}${summary.roundTrips}`);
  lines.push(`${pad("gross P&L")}${number(summary.grossPnl)}`);
  lines.push(`${pad("costs")}${number(summary.costs)}`);
  lines.push(`${pad("net P&L")}${number(summary.netPnl)}`);
  lines.push(
    `${pad("hold (mean)")}${number(summary.churn.meanHoldMs, 0)} ms   median ${number(summary.churn.medianHoldMs, 0)} ms`,
  );
  lines.push("");
  for (const horizon of summary.horizons) {
    const accuracy = Number.isFinite(horizon.directionalAccuracy) ? ` (n=${horizon.n})` : " (unavailable)";
    lines.push(`${pad(`${horizon.seconds}s direction`)}${number(horizon.directionalAccuracy)}${accuracy}`);
  }
  lines.push("");
  lines.push("counterfactuals");
  for (const policy of summary.counterfactuals) {
    lines.push(
      `  ${pad(policy.policyId, 24)}entries ${String(policy.entries).padStart(3)}  ` +
        `roundTrips ${String(policy.roundTrips).padStart(3)}  net ${number(policy.netPnl)}  ` +
        `equity ${number(policy.endingEquity)}  costs ${number(policy.costs)}`,
    );
  }
  lines.push("");
  lines.push(
    `${pad("replay check")}RECORDED_BINARY reproduces the recorded account: ${
      summary.recordedBinaryReproducesAccount ? "YES" : "NO"
    }`,
  );
  lines.push(
    `${pad("metadata")}upstream present: ${summary.metadataDiagnostic.upstreamPresent ? "yes" : "no (expected " + summary.metadataDiagnostic.expectedUpstream + ")"}`,
  );
  lines.push(`${pad("digests")}stateDigest/packetDigest: ${summary.digestAudit.conclusion}`);
  lines.push(
    `${pad("preservation")}source + canonical 5I trees byte-identical: ${summary.preservation.ok ? "YES" : "NO"}`,
  );
  lines.push("");
  for (const entry of PAPER_FORENSICS_COUNTERFACTUAL_BANNER) lines.push(entry);
  for (const entry of PAPER_FORENSICS_CLOSING_BANNER) lines.push(entry);
  return lines.join("\n");
}

/**
 * Run the CLI. `deps` allows the validator to drive it without touching the real
 * trees (it never constructs a provider, so there is nothing to inject).
 *
 * @returns {Promise<number>} process exit code
 */
export async function runPaperForensicsCli(argv = process.argv.slice(2), {
  log = console.log,
  error = console.error,
  analyze = analyzePaperShadowSession,
  now = () => Date.now(),
} = {}) {
  const settings = buildPaperForensicsCliSettings(argv);
  if (settings.help) {
    log(PAPER_FORENSICS_USAGE);
    return 0;
  }
  if (settings.problems.length > 0) {
    for (const problem of settings.problems) error(`error: ${problem}`);
    error("");
    error(PAPER_FORENSICS_USAGE);
    return 2;
  }

  const analysis = await analyze(
    settings.out === null
      ? { sessionId: settings.sessionId, createdAt: now() }
      : { sessionId: settings.sessionId, out: settings.out, createdAt: now() },
  );

  if (analysis.ok !== true) {
    error(`error: ${analysis.message ?? analysis.reason}`);
    if (analysis.integrity) {
      for (const problem of analysis.integrity.problems ?? []) error(`  ${problem}`);
    }
    return 1;
  }

  if (settings.json) {
    log(JSON.stringify(analysis.summary, null, 2));
    return 0;
  }

  log(formatForensicsSummary(analysis));
  log("");
  log(`artifacts: ${analysis.root}`);
  log(`  ${Object.values(PAPER_FORENSICS_FILES).join(", ")}`);
  return 0;
}

/** Read the persisted summary of one analysis (used by tooling and tests). */
export async function readForensicsSummary(root) {
  return readPaperForensicsJson(root, PAPER_FORENSICS_FILES.summary);
}

/** The frozen defaults, exposed so the CLI's contract is checkable. */
export const PAPER_FORENSICS_CLI_DEFAULTS = Object.freeze({
  sourceRoot: PAPER_FORENSICS_SOURCE_ROOT_DIR,
  forensicRoot: PAPER_FORENSICS_ROOT_DIR,
  accountToleranceUsd: PAPER_FORENSICS_TOLERANCE.accountUsd,
  supportsLatest: false,
  requiresSession: true,
  constructsProvider: false,
  requiresApiKey: false,
  networkCalls: 0,
});
