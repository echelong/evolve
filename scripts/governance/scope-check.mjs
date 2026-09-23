/**
 * EVOLVE Development Governance v1 — scope checker (§7).
 *
 * Every changed file is classified IN_SCOPE, JUSTIFIED_ADJACENT or
 * OUT_OF_SCOPE against the frozen plan's declared file scope:
 *
 *   - IN_SCOPE           — declared in the plan's Files / scope section
 *                          (exact path, directory prefix or glob pattern)
 *   - JUSTIFIED_ADJACENT — not declared, but the plan carries an explicit
 *                          justification for that path
 *   - OUT_OF_SCOPE       — anything else, including generated lock files that
 *                          changed without an explicit plan allowance, and any
 *                          protected evidence/artifact tree
 *
 * Protected evidence is never laundered into scope by silence: a change beneath
 * a protected tree is OUT_OF_SCOPE unless the plan both declares the path and
 * carries an explicit justification, and even then the preservation check still
 * demands byte-identical trees unless the plan declares an intended write.
 *
 * Out-of-scope changes fail scope-check loudly; they are never silently merged.
 *
 * DEVELOPMENT GOVERNANCE ONLY — read-only, no trading/evolution authority.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson } from "../lib/hash.mjs";
import { parseGovernanceArgs } from "./cli.mjs";
import {
  DEFAULT_PROTECTED_PATHS,
  GENERATED_LOCK_FILES,
  GOVERNANCE_CLASSIFICATION,
  GOVERNANCE_ROOT,
  SCOPE_CLASSIFICATIONS,
} from "./definition.mjs";
import { PROJECT_ROOT, gitLines } from "./storage.mjs";
import { checkPlanFile } from "./plan-check.mjs";

/** Repository-relative, forward-slash, `./`-free path text. */
export function normalizeRelativePath(value, projectRoot = PROJECT_ROOT) {
  const text = String(value ?? "").trim().replace(/\\/g, "/");
  if (text.length === 0) return "";
  if (path.isAbsolute(text)) {
    const relative = path.relative(projectRoot, text);
    return relative.length > 0 ? relative.replace(/\\/g, "/") : text;
  }
  return text.replace(/^\.\//, "");
}

function entryPath(entry) {
  if (typeof entry === "string") return entry;
  return String(entry?.path ?? "").trim();
}

/** Translate a declared glob (`scripts/**​/*.mjs`) into an anchored RegExp. */
export function patternToRegExp(pattern) {
  const escaped = String(pattern)
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, "(?:.*\\/)?")
    .replace(/\?/g, "[^/]");
  return new RegExp(`^${escaped}$`);
}

/** Does a changed path match one declared scope entry? */
export function matchesDeclaredPath(relativePath, entry) {
  const declared = normalizeRelativePath(entryPath(entry));
  if (declared.length === 0) return false;
  const target = normalizeRelativePath(relativePath);
  if (declared.includes("*") || declared.includes("?")) {
    return patternToRegExp(declared.replace(/^\.\//, "")).test(target);
  }
  if (declared.endsWith("/")) return target.startsWith(declared) || `${target}/` === declared;
  return target === declared;
}

/** Is this path inside a protected evidence/artifact tree (§22)? */
export function isProtectedEvidencePath(relativePath, protectedPaths = DEFAULT_PROTECTED_PATHS) {
  const target = normalizeRelativePath(relativePath);
  return protectedPaths.some((protectedPath) => {
    const prefix = normalizeRelativePath(protectedPath);
    const withSlash = prefix.endsWith("/") ? prefix : `${prefix}/`;
    return target.startsWith(withSlash) || target === prefix.replace(/\/$/, "");
  });
}

/** Is this path a governance record (the only place governance may write)? */
export function isGovernanceRecordPath(relativePath, root = GOVERNANCE_ROOT) {
  const target = normalizeRelativePath(relativePath);
  const prefix = normalizeRelativePath(root);
  return target === prefix || target.startsWith(`${prefix}/`);
}

/** package-lock.json / yarn.lock / pnpm-lock.yaml. */
export function isGeneratedLockFile(relativePath) {
  const base = path.basename(normalizeRelativePath(relativePath));
  return GENERATED_LOCK_FILES.includes(base);
}

/* ============================================================================
 * Classification
 * ==========================================================================*/

function findJustification(relativePath, justifications, projectRoot) {
  const target = normalizeRelativePath(relativePath, projectRoot);
  for (const entry of justifications ?? []) {
    const declared = normalizeRelativePath(entryPath(entry), projectRoot);
    if (declared.length === 0) continue;
    if (declared === target) return entry;
    if (declared.endsWith("/") && target.startsWith(declared)) return entry;
    if (declared.includes("*") && patternToRegExp(declared).test(target)) return entry;
  }
  return null;
}

/**
 * Classify one changed path against the frozen plan.
 *
 * @param {string} filePath
 * @param {{ declaredPaths?: Array<string|{path:string,kind:string}>, justifications?: Array<{path:string,reason:string}>, lockFilesAllowed?: boolean, protectedPaths?: string[], projectRoot?: string }} [options]
 */
export function classifyFile(filePath, options = {}) {
  const {
    declaredPaths = [],
    justifications = [],
    lockFilesAllowed = false,
    protectedPaths = DEFAULT_PROTECTED_PATHS,
    projectRoot = PROJECT_ROOT,
  } = options;

  const relative = normalizeRelativePath(filePath, projectRoot);
  const matchedDeclared = (declaredPaths ?? []).find((entry) => matchesDeclaredPath(relative, entry));
  const justification = findJustification(relative, justifications, projectRoot);
  const declaredPath = matchedDeclared ? normalizeRelativePath(entryPath(matchedDeclared), projectRoot) : null;

  if (isProtectedEvidencePath(relative, protectedPaths)) {
    if (matchedDeclared && justification) {
      return {
        path: relative,
        classification: "JUSTIFIED_ADJACENT",
        declaredPath,
        reason: `protected evidence path explicitly declared and justified (${justification.reason}); preservation still requires byte-identical trees unless the plan declares an intended write`,
      };
    }
    return {
      path: relative,
      classification: "OUT_OF_SCOPE",
      declaredPath,
      reason: `protected evidence/artifact tree is immutable and must not change: ${relative}`,
    };
  }

  if (matchedDeclared) {
    return {
      path: relative,
      classification: "IN_SCOPE",
      declaredPath,
      reason: `declared in plan file scope: ${declaredPath}`,
    };
  }

  if (justification) {
    return {
      path: relative,
      classification: "JUSTIFIED_ADJACENT",
      declaredPath: null,
      reason: `adjacent change with explicit plan justification: ${justification.reason}`,
    };
  }

  if (isGeneratedLockFile(relative)) {
    if (lockFilesAllowed) {
      return {
        path: relative,
        classification: "JUSTIFIED_ADJACENT",
        declaredPath: null,
        reason: "generated lock file changed and the plan explicitly allows lock-file changes",
      };
    }
    return {
      path: relative,
      classification: "OUT_OF_SCOPE",
      declaredPath: null,
      reason: `generated lock file changed without an explicit plan allowance: ${relative}`,
    };
  }

  if (isGovernanceRecordPath(relative)) {
    return {
      path: relative,
      classification: "IN_SCOPE",
      declaredPath: null,
      reason: `governance record directory (governance may only write here): ${GOVERNANCE_ROOT}/`,
    };
  }

  return {
    path: relative,
    classification: "OUT_OF_SCOPE",
    declaredPath: null,
    reason: `not declared in plan file scope and no explicit justification: ${relative}`,
  };
}

/**
 * Classify a whole change set and produce the scope-check report.
 *
 * @param {{ changedFiles?: Array<string|{path:string,status?:string,untracked?:boolean}>, declaredPaths?: Array<string|{path:string}>, justifications?: Array<{path:string,reason:string}>, lockFilesAllowed?: boolean, protectedPaths?: string[], projectRoot?: string }} [options]
 */
export function checkScope(options = {}) {
  const {
    changedFiles = [],
    declaredPaths = [],
    justifications = [],
    lockFilesAllowed = false,
    protectedPaths = DEFAULT_PROTECTED_PATHS,
    projectRoot = PROJECT_ROOT,
  } = options;

  const problems = [];
  const warnings = [];
  const entries = (changedFiles ?? []).map((file) => {
    const raw = typeof file === "string" ? file : file?.path;
    const result = classifyFile(raw, {
      declaredPaths,
      justifications,
      lockFilesAllowed,
      protectedPaths,
      projectRoot,
    });
    return {
      ...result,
      status: typeof file === "object" && file !== null ? (file.status ?? null) : null,
      untracked: typeof file === "object" && file !== null ? Boolean(file.untracked) : false,
    };
  });

  const counts = Object.fromEntries(SCOPE_CLASSIFICATIONS.map((name) => [name, 0]));
  for (const entry of entries) {
    counts[entry.classification] = (counts[entry.classification] ?? 0) + 1;
    if (entry.classification === "OUT_OF_SCOPE") {
      problems.push(`out-of-scope change: ${entry.path} — ${entry.reason}`);
    }
    if (entry.classification === "JUSTIFIED_ADJACENT") {
      warnings.push(`adjacent change accepted with justification: ${entry.path} — ${entry.reason}`);
    }
  }

  const normalizedDeclared = (declaredPaths ?? []).map((entry) =>
    normalizeRelativePath(entryPath(entry), projectRoot),
  );
  const changedSet = new Set(entries.map((entry) => entry.path));
  const declaredNotChanged = normalizedDeclared.filter((declared) => {
    if (declared.endsWith("/") || declared.includes("*")) {
      return !entries.some((entry) => matchesDeclaredPath(entry.path, declared));
    }
    return !changedSet.has(declared);
  });

  return {
    status: problems.length === 0 ? "PASS" : "FAIL",
    problems,
    warnings,
    changedFiles: entries,
    counts,
    declaredPaths: normalizedDeclared,
    declaredNotChanged,
    justifications: (justifications ?? []).map((entry) => ({
      path: normalizeRelativePath(entryPath(entry), projectRoot),
      reason: String(entry?.reason ?? ""),
    })),
    lockFilesAllowed: Boolean(lockFilesAllowed),
    protectedPaths: (protectedPaths ?? []).map((entry) => normalizeRelativePath(entry, projectRoot)),
    classification: GOVERNANCE_CLASSIFICATION,
  };
}

/* ============================================================================
 * Change discovery and CLI
 * ==========================================================================*/

/** Current changed files from Git (staged, unstaged and untracked). Read-only. */
export async function changedFilesFromGit({ projectRoot = PROJECT_ROOT, includeUntracked = true } = {}) {
  const { text, ok } = await gitLines(["status", "--porcelain", includeUntracked ? "-uall" : "-uno"], {
    cwd: projectRoot,
  });
  const files = [];
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    const status = line.slice(0, 2).trim();
    let raw = line.slice(3).trim();
    const arrow = raw.indexOf(" -> ");
    if (arrow >= 0) raw = raw.slice(arrow + 4).trim();
    if (raw.startsWith('"') && raw.endsWith('"') && raw.length > 1) raw = raw.slice(1, -1);
    const untracked = status === "??";
    if (untracked && !includeUntracked) continue;
    files.push({ path: normalizeRelativePath(raw, projectRoot), status, untracked });
  }
  return { ok, files };
}

/** Changed files between a base and a commit, or between a base and WORKTREE. */
export async function changedFilesBetweenRefs({
  base = "HEAD",
  head = "WORKTREE",
  projectRoot = PROJECT_ROOT,
  includeUntracked = true,
} = {}) {
  const args = ["--no-pager", "diff", "--name-status", "--find-renames", base];
  if (String(head).toUpperCase() !== "WORKTREE") args.push(head);
  args.push("--");
  const { text, ok } = await gitLines(args, { cwd: projectRoot });
  const files = [];
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    const fields = line.split("\t");
    const status = fields[0] ?? "";
    const raw = fields.at(-1)?.trim() ?? "";
    if (raw.length > 0) files.push({ path: normalizeRelativePath(raw, projectRoot), status, untracked: false });
  }
  if (String(head).toUpperCase() === "WORKTREE" && includeUntracked) {
    const current = await changedFilesFromGit({ projectRoot, includeUntracked: true });
    for (const entry of current.files.filter((file) => file.untracked)) files.push(entry);
  }
  const unique = new Map(files.map((entry) => [entry.path, entry]));
  return { ok, files: [...unique.values()].sort((a, b) => a.path.localeCompare(b.path)) };
}

/** Scope-check the requested ref range or live worktree against a plan. */
export async function scopeCheckFromGit({ planReport = null, projectRoot = PROJECT_ROOT, includeUntracked = true, base = null, head = "WORKTREE" } = {}) {
  const { files } = base === null
    ? await changedFilesFromGit({ projectRoot, includeUntracked })
    : await changedFilesBetweenRefs({ base, head, projectRoot, includeUntracked });
  return checkScope({
    changedFiles: files,
    declaredPaths: planReport?.declaredFiles ?? [],
    justifications: planReport?.justifications ?? [],
    lockFilesAllowed: Boolean(planReport?.lockFilesAllowed),
    projectRoot,
  });
}

function printHumanScope(report) {
  console.log(`scope-check: ${report.status}`);
  console.log(
    `changed files: ${report.changedFiles.length} (IN_SCOPE ${report.counts.IN_SCOPE}, JUSTIFIED_ADJACENT ${report.counts.JUSTIFIED_ADJACENT}, OUT_OF_SCOPE ${report.counts.OUT_OF_SCOPE})`,
  );
  for (const entry of report.changedFiles) {
    console.log(`  ${entry.classification.padEnd(18)} ${entry.path}`);
  }
  for (const problem of report.problems) console.log(`PROBLEM: ${problem}`);
  for (const warning of report.warnings) console.log(`WARNING: ${warning}`);
}

/** `scope-check [--plan <path.md>] [--base <ref>] [--head <ref|WORKTREE>] [--changed <path> ...] [--json]`. */
export async function runScopeCheckCli(argv = process.argv.slice(2), options = {}) {
  const args = parseGovernanceArgs(argv, { json: true, plan: false, changed: false, base: false, head: false }, { multi: ["changed"] });
  const projectRoot = options.projectRoot ?? PROJECT_ROOT;

  let planReport = null;
  if (typeof args.flags.plan === "string" && args.flags.plan.trim().length > 0) {
    planReport = await checkPlanFile(args.flags.plan, { projectRoot });
  }

  const declaredChanged = args.flags.changed;
  const explicitChanged = Array.isArray(declaredChanged)
    ? declaredChanged
    : typeof declaredChanged === "string" && declaredChanged.trim().length > 0
      ? [declaredChanged]
      : null;

  const report = explicitChanged
    ? checkScope({
        changedFiles: explicitChanged,
        declaredPaths: planReport?.declaredFiles ?? [],
        justifications: planReport?.justifications ?? [],
        lockFilesAllowed: Boolean(planReport?.lockFilesAllowed),
        projectRoot,
      })
    : await scopeCheckFromGit({
        planReport,
        projectRoot,
        base: typeof args.flags.base === "string" ? args.flags.base : null,
        head: typeof args.flags.head === "string" ? args.flags.head : "WORKTREE",
      });

  if (planReport) {
    report.planCheckStatus = planReport.status;
    report.planDigest = planReport.planDigest;
    if (planReport.status !== "PASS") {
      report.warnings.unshift(
        `plan-check did not pass (${planReport.problems.length} problems); scope declarations may be incomplete`,
      );
    }
  }

  if (args.flags.json) console.log(canonicalJson(report, 2));
  else printHumanScope(report);
  process.exitCode = report.status === "PASS" ? 0 : 1;
  return report;
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  await runScopeCheckCli();
}
