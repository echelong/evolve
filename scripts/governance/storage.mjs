/**
 * EVOLVE Development Governance v1 — storage, confinement and command capture.
 *
 * Two jobs:
 *
 *   1. CONFINEMENT — every governance write goes through `writeGovernanceFile`,
 *      which refuses any target that does not resolve beneath the configured
 *      governance root (`.evolve/governance/` by default). Governance can never
 *      write into an evidence tree, a source file or the repository root.
 *   2. FRESH COMMAND CAPTURE — `runCommand` spawns a real process in this
 *      invocation and records timing, exit code and output digests, keeping only
 *      a bounded prefix of each stream so a huge log can never become a huge
 *      artifact. The digest covers the FULL stream, so truncation is visible but
 *      never hides what actually happened.
 *
 * DEVELOPMENT GOVERNANCE ONLY. No trading, evolution or deployment authority.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { sha256Hex } from "../lib/hash.mjs";
import { GOVERNANCE_ROOT, GOVERNANCE_SUBDIRS } from "./definition.mjs";

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Bounded per-stream log capture (§18): digests stay full, bytes stay capped. */
export const DEFAULT_LOG_BYTES = 256 * 1024;

/* ============================================================================
 * Confinement
 * ==========================================================================*/

export function governanceRootAbsolute({ root = GOVERNANCE_ROOT, projectRoot = PROJECT_ROOT } = {}) {
  return path.resolve(projectRoot, root);
}

/**
 * Refuse any write outside the governance root. Fail closed: an invalid target
 * throws instead of being silently redirected.
 */
export function assertGovernanceWriteTarget(target, { root = GOVERNANCE_ROOT, projectRoot = PROJECT_ROOT } = {}) {
  const rootDir = governanceRootAbsolute({ root, projectRoot });
  const absolute = path.resolve(target);
  const inside = absolute === rootDir || absolute.startsWith(rootDir + path.sep);
  if (!inside) {
    throw new Error(
      `governance may only write beneath ${rootDir}; refused ${absolute}`,
    );
  }
  return { absolute, rootDir };
}

/** Resolve a governance-relative path and prove it is inside the root. */
export function governancePath(relativePath, { root = GOVERNANCE_ROOT, projectRoot = PROJECT_ROOT } = {}) {
  const rootDir = governanceRootAbsolute({ root, projectRoot });
  const absolute = path.resolve(rootDir, String(relativePath ?? ""));
  return assertGovernanceWriteTarget(absolute, { root, projectRoot }).absolute;
}

/** The only write primitive governance uses. */
export async function writeGovernanceFile(relativePath, contents, options = {}) {
  const absolute = governancePath(relativePath, options);
  await mkdir(path.dirname(absolute), { recursive: true });
  const body = typeof contents === "string" ? contents : Buffer.from(contents);
  await writeFile(absolute, body);
  return { path: relativePath, absolute, bytes: Buffer.byteLength(body), digest: sha256Hex(body) };
}

export async function readGovernanceFile(relativePath, options = {}) {
  const absolute = governancePath(relativePath, options);
  return readFile(absolute, "utf8");
}

export function governanceSubdir(kind, options = {}) {
  const subdir = GOVERNANCE_SUBDIRS[kind];
  if (!subdir) throw new Error(`unknown governance subdir: ${kind}`);
  return governancePath(subdir, options);
}

/** `gov-20260922T120000Z-ab12cd` style ids: timestamp plus a short random tail. */
export function newGovernanceId(prefix, now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  return `${prefix}-${stamp}-${randomBytes(3).toString("hex")}`;
}

/* ============================================================================
 * Fresh command capture (§9)
 * ==========================================================================*/

/**
 * Run a real process now and capture bounded evidence about it.
 *
 * The returned record never claims more than what happened: `exitCode` is the
 * process exit code (or null when the process could not be spawned), the digests
 * cover the complete stdout/stderr, and only a bounded prefix of each stream is
 * retained for the report.
 *
 * @param {string} file executable or full shell command line
 * @param {string[]} [args]
 * @param {{ cwd?: string, shell?: boolean, env?: NodeJS.ProcessEnv, maxOutputBytes?: number, timeoutMs?: number }} [options]
 */
export function runProcess(file, args = [], options = {}) {
  const {
    cwd = PROJECT_ROOT,
    shell = false,
    env = process.env,
    maxOutputBytes = DEFAULT_LOG_BYTES,
    timeoutMs = 0,
  } = options;

  const command = shell ? String(file) : [file, ...args].join(" ");
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(file, args, { cwd, env, shell });
    } catch (error) {
      resolve(spawnFailure({ command, startedAt, startedAtMs, error }));
      return;
    }

    const hashes = { stdout: createHash("sha256"), stderr: createHash("sha256") };
    const state = {
      stdoutBytes: 0,
      stderrBytes: 0,
      stdoutKept: [],
      stderrKept: [],
      stdoutKeptBytes: 0,
      stderrKeptBytes: 0,
    };
    let settled = false;
    let timedOut = false;
    let timer = null;

    const consume = (stream, chunk) => {
      hashes[stream].update(chunk);
      state[`${stream}Bytes`] += chunk.length;
      const kept = state[`${stream}KeptBytes`];
      if (kept < maxOutputBytes) {
        const room = maxOutputBytes - kept;
        const piece = chunk.length > room ? chunk.subarray(0, room) : chunk;
        state[`${stream}Kept`].push(piece);
        state[`${stream}KeptBytes`] += piece.length;
      }
    };

    const finish = (extra) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const finishedAtMs = Date.now();
      const exitCode = typeof extra.exitCode === "number" ? extra.exitCode : null;
      resolve({
        command,
        startedAt,
        finishedAt: new Date(finishedAtMs).toISOString(),
        durationMs: finishedAtMs - startedAtMs,
        exitCode,
        signal: extra.signal ?? null,
        stdoutDigest: hashes.stdout.digest("hex"),
        stderrDigest: hashes.stderr.digest("hex"),
        stdoutBytes: state.stdoutBytes,
        stderrBytes: state.stderrBytes,
        stdout: Buffer.concat(state.stdoutKept).toString("utf8"),
        stderr: Buffer.concat(state.stderrKept).toString("utf8"),
        stdoutTruncated: state.stdoutBytes > state.stdoutKeptBytes,
        stderrTruncated: state.stderrBytes > state.stderrKeptBytes,
        timedOut,
        spawnError: extra.spawnError ?? null,
        status: extra.spawnError ? "ERROR" : exitCode === 0 ? "PASSED" : "FAILED",
      });
    };

    if (child.stdout) child.stdout.on("data", (chunk) => consume("stdout", chunk));
    if (child.stderr) child.stderr.on("data", (chunk) => consume("stderr", chunk));
    child.on("error", (error) => finish({ exitCode: null, spawnError: String(error?.message ?? error) }));
    child.on("close", (code, signal) => finish({ exitCode: code, signal }));

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);
    }
  });
}

function spawnFailure({ command, startedAt, startedAtMs, error }) {
  const message = String(error?.message ?? error);
  const finishedAtMs = Date.now();
  return {
    command,
    startedAt,
    finishedAt: new Date(finishedAtMs).toISOString(),
    durationMs: finishedAtMs - startedAtMs,
    exitCode: null,
    signal: null,
    stdoutDigest: sha256Hex(""),
    stderrDigest: sha256Hex(message),
    stdoutBytes: 0,
    stderrBytes: Buffer.byteLength(message),
    stdout: "",
    stderr: message,
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    spawnError: message,
    status: "ERROR",
  };
}

/** Run a shell command line (used for the npm/npx/git verification suite). */
export function runCommand(command, options = {}) {
  return runProcess(command, [], { ...options, shell: true });
}

/* ============================================================================
 * Git facts used by governance records
 * ==========================================================================*/

export async function gitLines(args, options = {}) {
  const record = await runProcess("git", args, options);
  return { record, text: record.stdout ?? "", ok: record.exitCode === 0 };
}

export async function gitHead(options = {}) {
  const { text, ok } = await gitLines(["rev-parse", "HEAD"], options);
  return ok ? text.trim() : null;
}

/**
 * Worktree digest: HEAD plus the porcelain status. Two runs on the same tree
 * produce the same digest; any edit, staging change or untracked file changes it.
 */
export async function worktreeDigestOf(options = {}) {
  const head = await gitHead(options);
  const status = await gitLines(["status", "--porcelain"], options);
  return {
    gitHead: head,
    worktreeDigest: sha256Hex(`${head ?? "NO_HEAD"}\n${status.text ?? ""}`),
    dirtyEntries: (status.text ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  };
}
