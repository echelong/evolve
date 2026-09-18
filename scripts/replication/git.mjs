/**
 * Phase 5C — read-only git metadata (PAPER ONLY).
 *
 * The only place in the Phase 5C modules that shells out at all, and it runs
 * exactly two read-only git queries (`rev-parse HEAD`, `status --porcelain`).
 * It cannot write, commit, push, or alter the repository.
 */

import { execFileSync } from "node:child_process";

/** Current git commit SHA (best effort; never fatal). */
export function readGitCommit({ cwd = process.cwd() } = {}) {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .trim()
      .slice(0, 40);
  } catch {
    return null;
  }
}

/** Is the working tree dirty? Reported so evidence can be labelled, never fatal. */
export function readWorkingTreeDirty({ cwd = process.cwd() } = {}) {
  try {
    const out = execFileSync("git", ["status", "--porcelain"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim().length > 0;
  } catch {
    return null;
  }
}
