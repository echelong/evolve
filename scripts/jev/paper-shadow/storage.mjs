/**
 * Jev paper-shadow storage.
 *
 * A COMPLETELY SEPARATE tree from every canonical EVOLVE evidence tree:
 *
 *   .evolve/jev-paper-shadow/<session-id>/
 *     session.json     classification + frozen configuration (no secrets)
 *     events.ndjson    append-only decision stream (one line per decision)
 *     state.json       compact LATEST published state for the dashboard
 *     summary.json     finalized summary + its digest
 *
 * Everything a session writes lands under its own root. `assertPaperShadowWriteTarget`
 * is called on every directory creation so a future edit can never silently
 * start writing into Phase 5I's `jev-direction`, the Shadow League, or the
 * Arena trees.
 *
 * PAPER ONLY.
 */

import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { digestOf } from "../../lib/hash.mjs";
import { sanitizeForPublic } from "../../lib/sanitize.mjs";
import {
  PAPER_SHADOW_EVENTS_FILE,
  PAPER_SHADOW_ROOT_DIR,
  PAPER_SHADOW_SESSION_FILE,
  PAPER_SHADOW_STATE_FILE,
  PAPER_SHADOW_SUMMARY_FILE,
  assertPaperShadowWriteTarget,
  isValidPaperShadowSessionId,
} from "./definition.mjs";

export const PAPER_SHADOW_STORAGE_VERSION = 1;

function resolveBaseRoot(baseRoot) {
  return path.resolve(baseRoot ?? PAPER_SHADOW_ROOT_DIR);
}

/** Ensure a directory exists, refusing any forbidden target first. */
export async function ensurePaperShadowDir(dir, baseRoot) {
  assertPaperShadowWriteTarget(dir, resolveBaseRoot(baseRoot));
  await mkdir(dir, { recursive: true });
  return dir;
}

async function writeJsonAtomic(target, value, baseRoot) {
  assertPaperShadowWriteTarget(target, resolveBaseRoot(baseRoot));
  await mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
  await writeFile(tmp, JSON.stringify(sanitizeForPublic(value), null, 2), "utf8");
  await rename(tmp, target);
  return target;
}

async function readJson(target, fallback = null) {
  try {
    return JSON.parse(await readFile(target, "utf8"));
  } catch {
    return fallback;
  }
}

export async function writePaperShadowSession(root, session) {
  return writeJsonAtomic(path.join(root, PAPER_SHADOW_SESSION_FILE), session, root);
}

export async function readPaperShadowSession(root) {
  return readJson(path.join(root ?? "", PAPER_SHADOW_SESSION_FILE), null);
}

export async function writePaperShadowState(root, state) {
  return writeJsonAtomic(path.join(root, PAPER_SHADOW_STATE_FILE), state, root);
}

export async function readPaperShadowState(root) {
  return readJson(path.join(root ?? "", PAPER_SHADOW_STATE_FILE), null);
}

export async function writePaperShadowSummary(root, summary) {
  return writeJsonAtomic(
    path.join(root, PAPER_SHADOW_SUMMARY_FILE),
    { ...summary, updatedAt: new Date().toISOString() },
    root,
  );
}

export async function readPaperShadowSummary(root) {
  return readJson(path.join(root ?? "", PAPER_SHADOW_SUMMARY_FILE), null);
}

/**
 * Append ONE event as a single NDJSON line. Append-only: nothing is ever
 * rewritten, so the decision stream is a faithful record of what happened.
 */
export async function appendPaperShadowEvent(root, event) {
  const line = `${JSON.stringify(sanitizeForPublic(event))}\n`;
  assertPaperShadowWriteTarget(path.join(root, PAPER_SHADOW_EVENTS_FILE), resolveBaseRoot(root));
  await writeFile(path.join(root, PAPER_SHADOW_EVENTS_FILE), line, { encoding: "utf8", flag: "a" });
  return event;
}

/** Read the whole event stream. Truncated/corrupt lines are skipped, never fatal. */
export async function readPaperShadowEvents(root) {
  let body = "";
  try {
    body = await readFile(path.join(root ?? "", PAPER_SHADOW_EVENTS_FILE), "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // An interrupted append can leave a partial trailing line; the reader is
      // tolerant by design so a killed run is still partially usable.
    }
  }
  return out;
}

/** List session ids under a base root, newest last (name-sorted). */
export async function listPaperShadowSessions(baseRoot) {
  let entries = [];
  try {
    entries = await readdir(resolveBaseRoot(baseRoot), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && isValidPaperShadowSessionId(entry.name))
    .map((entry) => entry.name)
    .sort();
}

/** Byte-level metadata snapshot of a session tree, for isolation/tamper proofs. */
export async function paperShadowMetadataSnapshot(root) {
  const out = [];
  const walk = async (dir, relative) => {
    let entries = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(dir, entry.name);
      const rel = `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(absolute, rel);
        continue;
      }
      const content = await readFile(absolute, "utf8");
      out.push({ path: rel, bytes: content.length, digest: digestOf(content) });
    }
  };
  await walk(root, "");
  return out;
}

/** Digest of a summary record with the digest field itself removed. */
export function paperShadowSummaryDigestOf(summary) {
  if (!summary || typeof summary !== "object") return null;
  const subject = {};
  for (const [key, value] of Object.entries(summary)) {
    if (key === "summaryDigest") continue;
    subject[key] = value;
  }
  return digestOf(subject);
}
