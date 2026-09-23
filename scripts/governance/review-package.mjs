/**
 * EVOLVE Development Governance v1 — bounded review package (§8).
 *
 * A review is a bounded package, not "the agent may browse the whole
 * repository". The package carries exactly:
 *
 *   - the diff needed (bounded, with explicit truncation metadata)
 *   - the relevant existing files (bounded, sanitized)
 *   - the explicit protocol/definitions touched, with digests
 *   - relevant logs (bounded tails)
 *   - the verification command policy
 *   - what may NOT be inferred from the package
 *
 * Secrets are never packaged — only a policy record naming what was excluded.
 * Large diffs are bounded and marked as truncated; nothing is silently dropped,
 * and no artifact may grow to hundreds of megabytes.
 *
 * DEVELOPMENT GOVERNANCE ONLY — read-only over the repository; the only write
 * is the package record itself beneath `.evolve/governance/`.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson, sha256Hex } from "../lib/hash.mjs";
import { parseGovernanceArgs } from "./cli.mjs";
import { redactSecrets } from "../lib/sanitize.mjs";
import {
  DEFAULT_REVIEW_FOCUS,
  DEFAULT_VERIFICATION_COMMANDS,
  GLOBAL_CONSTRAINTS,
  GLOBAL_CONSTRAINTS_DIGEST,
  GOVERNANCE_CLASSIFICATION,
  GOVERNANCE_NO_AUTHORITY_TAG,
  WARNING_TOLERANT_COMMANDS,
  isForbiddenGovernancePath,
} from "./definition.mjs";
import { PROJECT_ROOT, gitLines, writeGovernanceFile, newGovernanceId } from "./storage.mjs";
import { changedFilesBetweenRefs, normalizeRelativePath, scopeCheckFromGit } from "./scope-check.mjs";
import { checkPlanFile } from "./plan-check.mjs";

export const DEFAULT_DIFF_BOUND_BYTES = 512 * 1024;
export const DEFAULT_FILE_BOUND_BYTES = 128 * 1024;
export const DEFAULT_LOG_BOUND_BYTES = 64 * 1024;
export const DEFAULT_MAX_PACKAGE_FILES = 64;

const FORBIDDEN_DIFF_PATHS = Object.freeze([
  ":(exclude).env",
  ":(exclude).env.*",
  ":(exclude)**/.env",
  ":(exclude)**/.env.*",
  ":(exclude)**/*.pem",
  ":(exclude)**/*.key",
  ":(exclude)**/*.p12",
  ":(exclude)**/*.pfx",
  ":(exclude)**/id_rsa",
  ":(exclude)**/id_rsa.*",
  ":(exclude)**/wallet*",
  ":(exclude)**/signer*",
  ":(exclude)**/keystore*",
  ":(exclude)**/mnemonic*",
]);

function repositoryPath(relative, projectRoot) {
  const absolute = path.resolve(projectRoot, relative);
  const root = path.resolve(projectRoot);
  return absolute === root || absolute.startsWith(`${root}${path.sep}`) ? absolute : null;
}

/** What a reviewer may NOT conclude from a governance review package (§20). */
export const DEFAULT_FORBIDDEN_INFERENCES = Object.freeze([
  "No profitability claim may be drawn from this package.",
  "No scientific validity may be self-certified from this package.",
  "Development/shadow evidence shown here is not canonical, replication or temporal evidence.",
  "No authority may be granted to a model, agent or genome on the basis of this package.",
  "Arena / untouched future data remains authoritative over anything shown here.",
]);

/** Bounded commit metadata for the requested base/head range. */
async function collectCommitList({ base, head, projectRoot, maxCommits }) {
  const range = String(head).toUpperCase() === "WORKTREE" ? `${base}..HEAD` : `${base}..${head}`;
  const command = `git --no-pager log --oneline ${range}`;
  const { record, text } = await gitLines(["--no-pager", "log", "--oneline", range], { cwd: projectRoot });
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  return {
    range,
    command,
    exitCode: record.exitCode,
    commits: lines.slice(0, maxCommits),
    truncated: lines.length > maxCommits || Boolean(record.stdoutTruncated),
    omitted: Math.max(0, lines.length - maxCommits),
    stdoutBytes: record.stdoutBytes,
    stdoutDigest: record.stdoutDigest,
  };
}

/* ============================================================================
 * Bounding helpers
 * ==========================================================================*/

/**
 * Redact credential material from packaged text. Uses the repository's existing
 * secret-redaction helper so governance never invents its own policy.
 */
export function sanitizeText(text) {
  const source = String(text ?? "");
  const redacted = redactSecrets(source)
    .replace(/((?:"?)(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|secret|authorization|cookie)(?:"?)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\r\n,}]+)/gi, "$1[redacted]")
    .replace(/((?:authorization|x-api-key|api[-_]?key)\s*[:=]\s*)[^\r\n]+/gi, "$1[redacted]")
    .replace(/\b(?:Bearer|Basic)\s+[^\s"',}]+/gi, (value) => `${value.split(/\s+/, 1)[0]} [redacted]`)
    .replace(/(^|\n)(\s*Cookie\s*:\s*)[^\n]*/gi, "$1$2[redacted]")
    .replace(/(^|\n)(\s*Set-Cookie\s*:\s*)[^\n]*/gi, "$1$2[redacted]")
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[redacted]@")
    .replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g, "[redacted-jwt]");
  return { text: redacted, changed: redacted !== source };
}


/** Keep at most `maxBytes` of a string and report exactly what was dropped. */
export function boundedText(text, maxBytes) {
  const source = String(text ?? "");
  const buffer = Buffer.from(source, "utf8");
  const bytes = buffer.byteLength;
  if (bytes <= maxBytes) {
    return { text: source, bytes, includedBytes: bytes, truncated: false, omittedBytes: 0 };
  }
  const kept = buffer.subarray(0, maxBytes).toString("utf8");
  return {
    text: kept,
    bytes,
    includedBytes: Buffer.byteLength(kept, "utf8"),
    truncated: true,
    omittedBytes: bytes - Buffer.byteLength(kept, "utf8"),
  };
}

/** Keep the LAST `maxBytes` of a log: failures usually live at the end. */
export function boundedTail(text, maxBytes) {
  const source = String(text ?? "");
  const buffer = Buffer.from(source, "utf8");
  const bytes = buffer.byteLength;
  if (bytes <= maxBytes) {
    return { text: source, bytes, includedBytes: bytes, truncated: false, omittedBytes: 0, tail: false };
  }
  const kept = buffer.subarray(bytes - maxBytes).toString("utf8");
  return {
    text: kept,
    bytes,
    includedBytes: Buffer.byteLength(kept, "utf8"),
    truncated: true,
    omittedBytes: bytes - Buffer.byteLength(kept, "utf8"),
    tail: true,
  };
}

/** Secret-bearing paths are excluded from every package (§19). */
export function secretPolicyFor(paths) {
  const excluded = [];
  for (const entry of paths ?? []) {
    const relative = typeof entry === "string" ? entry : entry?.path;
    if (!relative) continue;
    if (isForbiddenGovernancePath(relative)) excluded.push(String(relative));
  }
  return {
    packagedSecrets: false,
    excludedPaths: excluded,
    note: "Secrets are never packaged; secret-bearing paths are excluded and only this policy record is kept.",
  };
}

/* ============================================================================
 * Package content collection (read-only)
 * ==========================================================================*/

/**
 * Bounded diff of the worktree against a base ref. Untracked files cannot
 * appear in `git diff`, so they are listed separately and their content is
 * included bounded and sanitized up to the package limits.
 */
export async function collectDiff({
  projectRoot = PROJECT_ROOT,
  base = "HEAD",
  head = "WORKTREE",
  maxBytes = DEFAULT_DIFF_BOUND_BYTES,
  maxFiles = DEFAULT_MAX_PACKAGE_FILES,
  maxFileBytes = DEFAULT_FILE_BOUND_BYTES,
} = {}) {
  const diffArgs = ["--no-pager", "diff", "--no-color", base];
  if (String(head).toUpperCase() !== "WORKTREE") diffArgs.push(head);
  diffArgs.push("--", ".", ...FORBIDDEN_DIFF_PATHS);
  const { record, text } = await gitLines(diffArgs, { cwd: projectRoot });
  const statResult = await gitLines(
    ["--no-pager", "diff", "--stat", base, ...(String(head).toUpperCase() === "WORKTREE" ? [] : [head]), "--", ".", ...FORBIDDEN_DIFF_PATHS],
    { cwd: projectRoot },
  );
  const sanitizedDiff = sanitizeText(text);
  const diff = boundedText(sanitizedDiff.text, maxBytes);
  const { files } = await changedFilesBetweenRefs({ base, head, projectRoot, includeUntracked: true });
  const changedFilesTruncated = files.length > maxFiles;

  const untracked = [];
  let untrackedIncluded = 0;
  for (const entry of files.filter((file) => file.untracked)) {
    if (isForbiddenGovernancePath(entry.path)) continue;
    if (untrackedIncluded >= maxFiles) {
      untracked.push({ path: entry.path, included: false, reason: "package file limit reached" });
      continue;
    }
    try {
      const raw = await readFile(path.resolve(projectRoot, entry.path), "utf8");
      const bounded = boundedText(raw, maxFileBytes);
      const sanitized = sanitizeText(bounded.text);
      untracked.push({
        path: entry.path,
        included: true,
        bytes: bounded.bytes,
        includedBytes: bounded.includedBytes,
        truncated: bounded.truncated,
        omittedBytes: bounded.omittedBytes,
        digest: sha256Hex(raw),
        sanitized: sanitized.changed,
        content: sanitized.text,
      });
      untrackedIncluded += 1;
    } catch (error) {
      untracked.push({ path: entry.path, included: false, reason: String(error.message) });
    }
  }

  const stat = boundedText(statResult.text, maxBytes);
  const commits = await collectCommitList({ base, head, projectRoot, maxCommits: maxFiles });

  return {
    base,
    head,
    command: `git --no-pager diff --no-color ${base}${String(head).toUpperCase() === "WORKTREE" ? "" : ` ${head}`} -- . [forbidden paths excluded]`,
    exitCode: record.exitCode,
    stat: stat.text,
    statExitCode: statResult.record.exitCode,
    statBytes: stat.bytes,
    statIncludedBytes: stat.includedBytes,
    statTruncated: stat.truncated,
    statOmittedBytes: stat.omittedBytes,
    commits,
    diffDigest: sha256Hex(text),
    diffSanitized: sanitizedDiff.changed,
    diffBytes: diff.bytes,
    diffIncludedBytes: diff.includedBytes,
    diffTruncated: diff.truncated,
    diffOmittedBytes: diff.omittedBytes,
    diff: diff.text,
    changedFiles: files.slice(0, maxFiles),
    changedFilesTruncated,
    changedFilesOmitted: Math.max(0, files.length - maxFiles),
    untrackedFiles: untracked,
    note:
      "The diff is bounded. When diffTruncated is true the omitted byte count is explicit and the full diff must be read from the repository before approving the change.",
  };
}

/** Relevant existing files: bounded, sanitized, digest-recorded. */
export async function collectRelevantFiles({
  paths = [],
  projectRoot = PROJECT_ROOT,
  maxFiles = DEFAULT_MAX_PACKAGE_FILES,
  maxFileBytes = DEFAULT_FILE_BOUND_BYTES,
} = {}) {
  const entries = [];
  const requested = (paths ?? []).map((entry) => normalizeRelativePath(entry, projectRoot)).filter(Boolean);
  let included = 0;
  for (const relative of requested) {
    if (repositoryPath(relative, projectRoot) === null) {
      entries.push({ path: relative, included: false, reason: "path is outside the repository root" });
      continue;
    }
    if (isForbiddenGovernancePath(relative)) {
      entries.push({ path: relative, included: false, reason: "secret-bearing path is never packaged" });
      continue;
    }
    if (included >= maxFiles) {
      entries.push({ path: relative, included: false, reason: "package file limit reached" });
      continue;
    }
    try {
      const raw = await readFile(path.resolve(projectRoot, relative), "utf8");
      const bounded = boundedText(raw, maxFileBytes);
      const sanitized = sanitizeText(bounded.text);
      entries.push({
        path: relative,
        included: true,
        bytes: bounded.bytes,
        includedBytes: bounded.includedBytes,
        truncated: bounded.truncated,
        omittedBytes: bounded.omittedBytes,
        digest: sha256Hex(raw),
        sanitized: sanitized.changed,
        content: sanitized.text,
      });
      included += 1;
    } catch (error) {
      entries.push({ path: relative, included: false, reason: String(error.message) });
    }
  }
  return entries;
}

/** Relevant log excerpts: bounded tails with explicit truncation metadata. */
export async function collectLogs({
  paths = [],
  projectRoot = PROJECT_ROOT,
  maxFiles = DEFAULT_MAX_PACKAGE_FILES,
  maxLogBytes = DEFAULT_LOG_BOUND_BYTES,
} = {}) {
  const entries = [];
  const requested = (paths ?? []).map((entry) => normalizeRelativePath(entry, projectRoot)).filter(Boolean);
  let included = 0;
  for (const relative of requested) {
    if (repositoryPath(relative, projectRoot) === null) {
      entries.push({ path: relative, included: false, reason: "path is outside the repository root" });
      continue;
    }
    if (isForbiddenGovernancePath(relative)) {
      entries.push({ path: relative, included: false, reason: "secret-bearing path is never packaged" });
      continue;
    }
    if (included >= maxFiles) {
      entries.push({ path: relative, included: false, reason: "package log limit reached" });
      continue;
    }
    try {
      const raw = await readFile(path.resolve(projectRoot, relative), "utf8");
      const bounded = boundedTail(raw, maxLogBytes);
      const sanitized = sanitizeText(bounded.text);
      entries.push({
        path: relative,
        included: true,
        bytes: bounded.bytes,
        includedBytes: bounded.includedBytes,
        truncated: bounded.truncated,
        omittedBytes: bounded.omittedBytes,
        tail: bounded.tail,
        digest: sha256Hex(raw),
        sanitized: sanitized.changed,
        content: sanitized.text,
      });
      included += 1;
    } catch (error) {
      entries.push({ path: relative, included: false, reason: String(error.message) });
    }
  }
  return entries;
}

/** Explicit protocol/definition references: path + digest, never implied. */
export async function collectProtocolDefinitions({ paths = [], projectRoot = PROJECT_ROOT } = {}) {
  const entries = [];
  for (const raw of paths ?? []) {
    const relative = normalizeRelativePath(raw, projectRoot);
    if (relative.length === 0) continue;
    if (repositoryPath(relative, projectRoot) === null) {
      entries.push({ path: relative, included: false, reason: "path is outside the repository root" });
      continue;
    }
    if (isForbiddenGovernancePath(relative)) {
      entries.push({ path: relative, included: false, reason: "secret-bearing path is never packaged" });
      continue;
    }
    try {
      const content = await readFile(path.resolve(projectRoot, relative), "utf8");
      entries.push({
        path: relative,
        included: true,
        bytes: Buffer.byteLength(content),
        digest: sha256Hex(content),
      });
    } catch (error) {
      entries.push({ path: relative, included: false, reason: String(error.message) });
    }
  }
  return entries;
}

/* ============================================================================
 * Package assembly (§8)
 * ==========================================================================*/

/**
 * Build one bounded review package. Read-only over the repository.
 *
 * @param {{ planPath?: string|null, reviewId?: string|null, runId?: string|null, base?: string, relevantFiles?: string[], protocolDefinitions?: string[], logs?: string[], verificationCommands?: string[], forbiddenInferences?: string[], projectRoot?: string, bounds?: object }} [options]
 */
export async function buildReviewPackage(options = {}) {
  const {
    planPath = null,
    reviewId = null,
    runId = null,
    base = "HEAD",
    head = "WORKTREE",
    relevantFiles = [],
    protocolDefinitions = [],
    logs = [],
    verificationCommands = DEFAULT_VERIFICATION_COMMANDS,
    forbiddenInferences = DEFAULT_FORBIDDEN_INFERENCES,
    projectRoot = PROJECT_ROOT,
    bounds = {},
  } = options;

  const limits = {
    maxDiffBytes: bounds.maxDiffBytes ?? DEFAULT_DIFF_BOUND_BYTES,
    maxFileBytes: bounds.maxFileBytes ?? DEFAULT_FILE_BOUND_BYTES,
    maxLogBytes: bounds.maxLogBytes ?? DEFAULT_LOG_BOUND_BYTES,
    maxFiles: bounds.maxFiles ?? DEFAULT_MAX_PACKAGE_FILES,
  };

  const createdAt = new Date().toISOString();
  const planReport = planPath ? await checkPlanFile(planPath, { projectRoot }) : null;
  const changeSet = await collectDiff({
    projectRoot,
    base,
    head,
    maxBytes: limits.maxDiffBytes,
    maxFiles: limits.maxFiles,
    maxFileBytes: limits.maxFileBytes,
  });
  const fullScopeCheck = await scopeCheckFromGit({ planReport, projectRoot, base, head });
  const scopeCheck = {
    ...fullScopeCheck,
    changedFiles: fullScopeCheck.changedFiles.slice(0, limits.maxFiles),
    changedFilesTruncated: fullScopeCheck.changedFiles.length > limits.maxFiles,
    changedFilesOmitted: Math.max(0, fullScopeCheck.changedFiles.length - limits.maxFiles),
    problems: fullScopeCheck.problems.slice(0, limits.maxFiles),
    problemsTruncated: fullScopeCheck.problems.length > limits.maxFiles,
    problemsOmitted: Math.max(0, fullScopeCheck.problems.length - limits.maxFiles),
  };
  const files = await collectRelevantFiles({
    paths: relevantFiles,
    projectRoot,
    maxFiles: limits.maxFiles,
    maxFileBytes: limits.maxFileBytes,
  });
  const logEntries = await collectLogs({
    paths: logs,
    projectRoot,
    maxFiles: limits.maxFiles,
    maxLogBytes: limits.maxLogBytes,
  });
  const definitions = await collectProtocolDefinitions({ paths: protocolDefinitions, projectRoot });

  const candidatePaths = [
    ...changeSet.changedFiles.map((entry) => entry.path),
    ...changeSet.untrackedFiles.map((entry) => entry.path),
    ...files.map((entry) => entry.path),
    ...logEntries.map((entry) => entry.path),
    ...definitions.map((entry) => entry.path),
  ];

  const body = {
    purpose: "EVOLVE_DEVELOPMENT_GOVERNANCE",
    kind: "GOVERNANCE_REVIEW_PACKAGE",
    reviewId: reviewId ?? newGovernanceId("review"),
    runId: runId ?? null,
    createdAt,
    classification: GOVERNANCE_CLASSIFICATION,
    noAuthority: GOVERNANCE_NO_AUTHORITY_TAG,
    plan: planReport
      ? {
          path: planReport.planPath,
          planDigest: planReport.planDigest,
          planCheckStatus: planReport.status,
          declaredFiles: planReport.declaredFilePaths,
          reviewFocus: planReport.reviewFocus,
          protectedPaths: planReport.protectedPaths,
          dedicatedValidator: planReport.dedicatedValidator,
        }
      : null,
    globalConstraints: GLOBAL_CONSTRAINTS,
    globalConstraintsDigest: GLOBAL_CONSTRAINTS_DIGEST,
    reviewFocus: planReport?.reviewFocus?.length ? planReport.reviewFocus : DEFAULT_REVIEW_FOCUS,
    changeSet,
    scopeCheck,
    relevantFiles: files,
    protocolDefinitions: definitions,
    logs: logEntries,
    verificationPolicy: {
      commands: [...verificationCommands],
      warningTolerant: [...WARNING_TOLERANT_COMMANDS],
      note:
        "Fresh verification must run these commands again in the verifying invocation; a reviewer may not accept a cached or reported result.",
    },
    forbiddenInferences: [...forbiddenInferences],
    secretPolicy: secretPolicyFor(candidatePaths),
    bounds: limits,
  };

  return { ...body, packageDigest: sha256Hex(canonicalJson(body)) };
}

/** Persist a package beneath the governance root (the only write performed). */
export async function writeReviewPackage(packageBody, options = {}) {
  const reviewId = packageBody?.reviewId ?? newGovernanceId("review");
  const relative = `reviews/${reviewId}/review-package.json`;
  const record = await writeGovernanceFile(relative, `${canonicalJson(packageBody, 2)}\n`, options);
  return {
    reviewId,
    path: record.path,
    absolute: record.absolute,
    bytes: record.bytes,
    digest: record.digest,
    packageDigest: packageBody?.packageDigest ?? null,
  };
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

function printHumanPackage(packageBody, record) {
  console.log(`review-package: ${packageBody.reviewId}`);
  console.log(`plan: ${packageBody.plan?.path ?? "(none)"} status=${packageBody.plan?.planCheckStatus ?? "n/a"}`);
  console.log(
    `diff: ${packageBody.changeSet.diffBytes} bytes (included ${packageBody.changeSet.diffIncludedBytes}, truncated ${packageBody.changeSet.diffTruncated}) base=${packageBody.changeSet.base} head=${packageBody.changeSet.head}`,
  );
  console.log(`scope-check: ${packageBody.scopeCheck.status}`);
  console.log(`changed files: ${packageBody.changeSet.changedFiles.length}`);
  console.log(
    `relevant files: ${packageBody.relevantFiles.filter((entry) => entry.included).length} included / ${packageBody.relevantFiles.length} requested`,
  );
  console.log(
    `protocol definitions: ${packageBody.protocolDefinitions.filter((entry) => entry.included).length} included`,
  );
  console.log(`logs: ${packageBody.logs.filter((entry) => entry.included).length} included`);
  console.log(`verification commands: ${packageBody.verificationPolicy.commands.length}`);
  console.log(`forbidden inferences: ${packageBody.forbiddenInferences.length}`);
  console.log(`secret policy: packagedSecrets=${packageBody.secretPolicy.packagedSecrets} excluded=${packageBody.secretPolicy.excludedPaths.length}`);
  console.log(`packageDigest: ${packageBody.packageDigest}`);
  if (record) console.log(`written: ${record.path} (${record.bytes} bytes)`);
}

/**
 * `review-package [--plan <path>] [--file <path> ...] [--protocol <path> ...]
 * [--log <path> ...] [--base <ref>] [--head <ref|WORKTREE>] [--review-id <id>] [--run-id <id>]
 * [--max-diff-bytes N] [--max-file-bytes N] [--max-log-bytes N] [--max-files N]
 * [--write] [--json]`
 */
export async function runReviewPackageCli(argv = process.argv.slice(2), options = {}) {
  const args = parseGovernanceArgs(argv, {
    json: true,
    write: true,
    plan: false,
    base: false,
    head: false,
    "review-id": false,
    "run-id": false,
    file: false,
    protocol: false,
    log: false,
    "max-diff-bytes": false,
    "max-file-bytes": false,
    "max-log-bytes": false,
    "max-files": false,
  }, { multi: ["file", "protocol", "log"] });
  const projectRoot = options.projectRoot ?? PROJECT_ROOT;

  const packageBody = await buildReviewPackage({
    planPath: stringFlag(args.flags.plan),
    reviewId: stringFlag(args.flags["review-id"]),
    runId: stringFlag(args.flags["run-id"]),
    base: stringFlag(args.flags.base) ?? "HEAD",
    head: stringFlag(args.flags.head) ?? "WORKTREE",
    relevantFiles: asList(args.flags.file),
    protocolDefinitions: asList(args.flags.protocol),
    logs: asList(args.flags.log),
    projectRoot,
    bounds: {
      maxDiffBytes: numberFlag(args.flags["max-diff-bytes"], DEFAULT_DIFF_BOUND_BYTES),
      maxFileBytes: numberFlag(args.flags["max-file-bytes"], DEFAULT_FILE_BOUND_BYTES),
      maxLogBytes: numberFlag(args.flags["max-log-bytes"], DEFAULT_LOG_BOUND_BYTES),
      maxFiles: numberFlag(args.flags["max-files"], DEFAULT_MAX_PACKAGE_FILES),
    },
  });

  const record = args.flags.write ? await writeReviewPackage(packageBody, { projectRoot }) : null;
  if (args.flags.json) console.log(canonicalJson({ package: packageBody, record }, 2));
  else printHumanPackage(packageBody, record);
  process.exitCode = 0;
  return { package: packageBody, record };
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  await runReviewPackageCli();
}
