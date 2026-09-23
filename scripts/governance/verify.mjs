/**
 * EVOLVE Development Governance v1 — fresh verification (§9).
 *
 * The VERIFIER re-runs the commands and judges from what actually happened in
 * this invocation. Nothing may be inferred from an implementer or reviewer
 * report, and no cached result may be reused.
 *
 * Every command record carries: command, startedAt, finishedAt, durationMs,
 * exitCode, stdoutDigest, stderrDigest, status. Logs are bounded and carry
 * explicit truncation metadata. Failures are reported, never swallowed. Lint
 * warnings are recorded separately from failures.
 *
 * Default suite (§9):
 *   npm run validate
 *   npx tsc --noEmit
 *   npm run lint
 *   npm run build -- --webpack
 *   git diff --check
 *   git status --short
 *   plus the plan's dedicated governance validator when one is declared
 *
 * DEVELOPMENT GOVERNANCE ONLY. Verification runs read-only checks; the only
 * writes are its own records beneath `.evolve/governance/`.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson, sha256Hex } from "../lib/hash.mjs";
import { parseGovernanceArgs } from "./cli.mjs";
import {
  DEFAULT_VERIFICATION_COMMANDS,
  GOVERNANCE_CLASSIFICATION,
  WARNING_TOLERANT_COMMANDS,
} from "./definition.mjs";
import {
  PROJECT_ROOT,
  newGovernanceId,
  runCommand,
  worktreeDigestOf,
  writeGovernanceFile,
} from "./storage.mjs";
import { checkPlanFile } from "./plan-check.mjs";
import { buildPreservationReport, capturePreservation, mergeProtectedPaths } from "./preservation.mjs";

/** Long enough for a full Next.js build; still bounded so a hang cannot run forever. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 45 * 60 * 1000;

/** Lint may warn; a non-zero exit is still a failure. */
export function isWarningTolerant(command) {
  const text = String(command ?? "").trim();
  return WARNING_TOLERANT_COMMANDS.some((entry) => text === entry || text.startsWith(`${entry} `));
}

/** Count warning lines in a command's combined output. */
export function countWarnings(record) {
  const text = `${record?.stdout ?? ""}\n${record?.stderr ?? ""}`;
  const summary = /(\d+)\s+warnings?/i.exec(text);
  const lines = text
    .split("\n")
    .filter((line) => /\bwarning\b/i.test(line)).length;
  return Math.max(lines, summary ? Number.parseInt(summary[1], 10) : 0);
}

/** Bounded sample of warning lines for the report. */
export function warningSample(record, limit = 10) {
  const text = `${record?.stdout ?? ""}\n${record?.stderr ?? ""}`;
  return text
    .split("\n")
    .filter((line) => /\bwarning\b/i.test(line))
    .slice(0, limit);
}

/**
 * The command policy for one run: the canonical suite, plus the plan's dedicated
 * validator when declared, de-duplicated and order-preserved.
 */
export function commandPolicyFor({ commands = DEFAULT_VERIFICATION_COMMANDS, dedicatedValidator = null } = {}) {
  const policy = [];
  for (const command of [...(commands ?? []), dedicatedValidator].filter(Boolean)) {
    const text = String(command).trim();
    if (text.length === 0) continue;
    if (!policy.includes(text)) policy.push(text);
  }
  return policy;
}

/** Filesystem-safe log name for a command. */
export function commandSlug(command) {
  const slug = String(command ?? "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return (slug || "command").slice(0, 60);
}

/** Policy status for one captured command record. */
export function commandStatus(record) {
  if (record.spawnError || record.exitCode === null) return "ERROR";
  if (record.exitCode !== 0) return "FAILED";
  if (isWarningTolerant(record.command) && countWarnings(record) > 0) return "PASSED_WITH_WARNINGS";
  return "PASSED";
}

/* ============================================================================
 * Fresh execution
 * ==========================================================================*/

/**
 * Run every command NOW and capture bounded evidence for each.
 *
 * @param {{ commands?: string[], projectRoot?: string, timeoutMs?: number, maxOutputBytes?: number, onProgress?: (record:object, index:number)=>void }} [options]
 */
export async function verifyCommands(options = {}) {
  const {
    commands = DEFAULT_VERIFICATION_COMMANDS,
    projectRoot = PROJECT_ROOT,
    timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
    maxOutputBytes,
    onProgress = null,
  } = options;

  const records = [];
  for (const command of commands ?? []) {
    const captureOptions = { cwd: projectRoot, timeoutMs };
    if (typeof maxOutputBytes === "number" && maxOutputBytes > 0) captureOptions.maxOutputBytes = maxOutputBytes;
    const record = await runCommand(command, captureOptions);
    const enriched = {
      ...record,
      warningTolerant: isWarningTolerant(command),
      warnings: countWarnings(record),
      warningSample: warningSample(record),
      status: commandStatus(record),
      logFile: null,
    };
    records.push(enriched);
    if (typeof onProgress === "function") onProgress(enriched, records.length - 1);
  }
  return records;
}

/** Persist bounded logs for captured commands. Returns records with logFile set. */
export async function writeCommandLogs({ runId, records, projectRoot = PROJECT_ROOT } = {}) {
  const updated = [];
  for (let index = 0; index < (records ?? []).length; index += 1) {
    const record = records[index];
    const relative = `runs/${runId}/logs/${String(index + 1).padStart(2, "0")}-${commandSlug(record.command)}.log`;
    const header = [
      `# command: ${record.command}`,
      `# startedAt: ${record.startedAt}`,
      `# finishedAt: ${record.finishedAt}`,
      `# durationMs: ${record.durationMs}`,
      `# exitCode: ${record.exitCode ?? "null"}`,
      `# status: ${record.status}`,
      `# stdoutBytes: ${record.stdoutBytes} (included ${Buffer.byteLength(record.stdout ?? "")}, truncated ${record.stdoutTruncated})`,
      `# stderrBytes: ${record.stderrBytes} (included ${Buffer.byteLength(record.stderr ?? "")}, truncated ${record.stderrTruncated})`,
      `# stdoutDigest: ${record.stdoutDigest}`,
      `# stderrDigest: ${record.stderrDigest}`,
      `# timedOut: ${record.timedOut}`,
      "",
      "--- stdout ---",
      record.stdout ?? "",
      "--- stderr ---",
      record.stderr ?? "",
      "",
    ].join("\n");
    const written = await writeGovernanceFile(relative, header, { projectRoot });
    updated.push({ ...record, logFile: written.path, logBytes: written.bytes, logDigest: written.digest });
  }
  return updated;
}

/* ============================================================================
 * One fresh verification pass
 * ==========================================================================*/

/**
 * Run the whole verification suite fresh, optionally hashing protected paths
 * before and after, and produce the verification record.
 *
 * @param {{ planReport?: object|null, commands?: string[]|null, runId?: string|null, projectRoot?: string, timeoutMs?: number, maxOutputBytes?: number, writeLogs?: boolean, preserve?: boolean, protectedPaths?: string[]|null, intendedWrites?: string[], allowDeclaredWrites?: boolean, onProgress?: Function|null }} [options]
 */
export async function runFreshVerification(options = {}) {
  const {
    planReport = null,
    commands = null,
    runId = null,
    projectRoot = PROJECT_ROOT,
    timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
    maxOutputBytes,
    writeLogs = true,
    preserve = true,
    protectedPaths = null,
    intendedWrites = [],
    allowDeclaredWrites = false,
    onProgress = null,
  } = options;

  const effectiveRunId = runId ?? newGovernanceId("run");
  const policy = commandPolicyFor({
    commands: commands ?? DEFAULT_VERIFICATION_COMMANDS,
    dedicatedValidator: planReport?.dedicatedValidator ?? null,
  });
  const protectedList = mergeProtectedPaths(
    planReport?.protectedPaths ?? [],
    protectedPaths ?? [],
    projectRoot,
  );

  const createdAt = new Date().toISOString();
  const worktreeBefore = await worktreeDigestOf({ cwd: projectRoot });
  const preservationBefore = preserve
    ? await capturePreservation({ protectedPaths: protectedList, projectRoot })
    : null;

  let records = await verifyCommands({ commands: policy, projectRoot, timeoutMs, maxOutputBytes, onProgress });
  if (writeLogs) records = await writeCommandLogs({ runId: effectiveRunId, records, projectRoot });

  const preservationAfter = preserve
    ? await capturePreservation({ protectedPaths: protectedList, projectRoot })
    : null;
  const preservationReport = preserve
    ? buildPreservationReport({
        before: preservationBefore,
        after: preservationAfter,
        intendedWrites,
        allowDeclaredWrites,
        protectedPaths: protectedList,
        projectRoot,
      })
    : null;
  const worktreeAfter = await worktreeDigestOf({ cwd: projectRoot });

  const problems = [];
  const warnings = [];
  const counts = { PASSED: 0, PASSED_WITH_WARNINGS: 0, FAILED: 0, ERROR: 0 };
  for (const record of records) {
    counts[record.status] = (counts[record.status] ?? 0) + 1;
    if (record.status === "FAILED") {
      problems.push(`verification command failed: ${record.command} (exit ${record.exitCode})`);
    }
    if (record.status === "ERROR") {
      problems.push(
        `verification command could not run: ${record.command} (${record.spawnError ?? "no exit code captured"})`,
      );
    }
    if (record.status === "PASSED_WITH_WARNINGS") {
      warnings.push(`verification command passed with ${record.warnings} warnings: ${record.command}`);
    }
    if (record.timedOut) {
      problems.push(`verification command timed out after ${timeoutMs} ms: ${record.command}`);
    }
  }
  if (preservationReport && preservationReport.status !== "PASS") {
    problems.push(...preservationReport.problems);
    warnings.push(...preservationReport.warnings);
  }
  if (worktreeBefore.worktreeDigest !== worktreeAfter.worktreeDigest) {
    warnings.push(
      `worktree digest changed during verification: ${worktreeBefore.worktreeDigest} → ${worktreeAfter.worktreeDigest}`,
    );
  }

  const body = {
    purpose: "EVOLVE_DEVELOPMENT_GOVERNANCE",
    kind: "GOVERNANCE_VERIFICATION_RECORD",
    runId: effectiveRunId,
    createdAt,
    finishedAt: new Date().toISOString(),
    verdict: problems.length === 0 ? "PASS" : "FAIL",
    problems,
    warnings,
    commands: records,
    counts,
    commandPolicy: policy,
    dedicatedValidator: planReport?.dedicatedValidator ?? null,
    planDigest: planReport?.planDigest ?? null,
    worktree: { before: worktreeBefore, after: worktreeAfter },
    preservation: preservationReport,
    classification: GOVERNANCE_CLASSIFICATION,
  };
  return { ...body, verificationDigest: sha256Hex(canonicalJson(body)) };
}

/* ============================================================================
 * CLI
 * ==========================================================================*/

function asList(value) {
  if (Array.isArray(value)) return value.filter((entry) => typeof entry === "string" && entry.trim().length > 0);
  if (typeof value === "string" && value.trim().length > 0) return [value.trim()];
  return [];
}

function stringFlag(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function numberFlag(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function printHumanVerification(report, record) {
  console.log(`verification: ${report.verdict} (runId ${report.runId})`);
  for (const entry of report.commands) {
    console.log(
      `  ${entry.status.padEnd(20)} exit=${String(entry.exitCode ?? "null").padEnd(4)} ${String(entry.durationMs).padStart(7)}ms  ${entry.command}`,
    );
    if (entry.logFile) console.log(`    log: ${entry.logFile} (${entry.logBytes} bytes)`);
  }
  console.log(
    `counts: PASSED ${report.counts.PASSED}, PASSED_WITH_WARNINGS ${report.counts.PASSED_WITH_WARNINGS}, FAILED ${report.counts.FAILED}, ERROR ${report.counts.ERROR}`,
  );
  if (report.preservation) console.log(`preservation: ${report.preservation.status}`);
  for (const problem of report.problems) console.log(`PROBLEM: ${problem}`);
  for (const warning of report.warnings) console.log(`WARNING: ${warning}`);
  console.log(`verificationDigest: ${report.verificationDigest}`);
  if (record) console.log(`written: ${record.path} (${record.bytes} bytes)`);
}

/**
 * `verify [--plan <path.md>] [--command <cmd> ...] [--run-id <id>]
 * [--timeout-ms N] [--max-output-bytes N] [--no-logs] [--preserve]
 * [--protected <path> ...] [--no-preserve] [--allow-declared-write] [--json]`
 */
export async function runVerifyCli(argv = process.argv.slice(2), options = {}) {
  const args = parseGovernanceArgs(argv, {
    json: true,
    plan: false,
    command: false,
    "run-id": false,
    "timeout-ms": false,
    "max-output-bytes": false,
    "no-logs": true,
    preserve: true,
    protected: false,
    "allow-declared-write": true,
  }, { multi: ["command", "protected"] });
  const projectRoot = options.projectRoot ?? PROJECT_ROOT;
  const planPath = stringFlag(args.flags.plan);
  const planReport = planPath ? await checkPlanFile(planPath, { projectRoot }) : null;
  const explicitCommands = asList(args.flags.command);

  const report = await runFreshVerification({
    planReport,
    commands: explicitCommands.length > 0 ? explicitCommands : null,
    runId: stringFlag(args.flags["run-id"]),
    projectRoot,
    timeoutMs: numberFlag(args.flags["timeout-ms"], DEFAULT_COMMAND_TIMEOUT_MS),
    maxOutputBytes: numberFlag(args.flags["max-output-bytes"], 0) || undefined,
    writeLogs: !args.flags["no-logs"],
    preserve: args.flags.preserve !== false,
    protectedPaths: asList(args.flags.protected),
    intendedWrites: planReport?.intendedWrites ?? [],
    allowDeclaredWrites: Boolean(args.flags["allow-declared-write"]),
    onProgress: args.flags.json
      ? null
      : (entry) => console.log(`  ... ${entry.status} ${entry.command} (${entry.durationMs}ms)`),
  });

  const record = await writeGovernanceFile(
    `runs/${report.runId}/verification.json`,
    `${canonicalJson(report, 2)}\n`,
    { projectRoot },
  );

  if (args.flags.json) console.log(canonicalJson({ report, record }, 2));
  else printHumanVerification(report, record);
  process.exitCode = report.verdict === "PASS" ? 0 : 1;
  return { report, record };
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  await runVerifyCli();
}
