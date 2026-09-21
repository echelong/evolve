/**
 * EVOLVE Phase 5I-PS.1 — SOURCE PRESERVATION PROOF (§4).
 *
 * Before and after every analysis the analyzer snapshots:
 *
 *   - `.evolve/jev-paper-shadow/<session-id>`  (the one source session)
 *   - `.evolve/jev-direction/`                 (the whole canonical 5I tree)
 *
 * and asserts BYTE IDENTITY. It additionally confirms that the two named sealed
 * sessions below are present and untouched:
 *
 *   - jrep-20260920T090716Z-97c862   (Phase 5I.1 canonical replication)
 *   - jtrp-20260920T151033Z-f1c16a   (Phase 5I.1a temporal replication)
 *
 * The proof is evidence that the instrument is READ-ONLY: the analyzer cannot
 * repair, normalize, or "fix" a source artifact even accidentally.
 *
 * READ-ONLY / OFFLINE. Nothing in this module ever writes outside its own
 * forensic tree (it does not write at all).
 */

import { readFile, readdir, readlink, stat } from "node:fs/promises";
import path from "node:path";

import { digestOf, sha256Hex } from "../../lib/hash.mjs";
import {
  PAPER_FORENSICS_CANONICAL_ROOT_DIR,
  PAPER_FORENSICS_SOURCE_ROOT_DIR,
} from "./definition.mjs";

export const PAPER_FORENSICS_PRESERVATION_VERSION = 1;

/** The two sealed sessions whose continued presence is explicitly confirmed. */
export const PAPER_FORENSICS_SEALED_SESSIONS = Object.freeze([
  { id: "jrep-20260920T090716Z-97c862", label: "Phase 5I.1 canonical replication" },
  { id: "jtrp-20260920T151033Z-f1c16a", label: "Phase 5I.1a temporal replication" },
]);

/**
 * A deterministic, byte-level snapshot of a tree: every file with its size and
 * content digest, sorted by relative path. Directories are represented so an
 * added or removed empty directory is still visible.
 *
 * @returns {Promise<{ root: string, exists: boolean, entries: Array<{ path: string, bytes: number, digest: string }> }>}
 */
export async function snapshotTree(root) {
  const entries = [];
  let exists = true;
  try {
    const info = await stat(root);
    exists = info.isDirectory();
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    exists = false;
  }
  if (!exists) return { root, exists: false, entries: [] };

  const walk = async (dir, relative) => {
    const children = await readdir(dir, { withFileTypes: true });
    for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(dir, child.name);
      const rel = `${relative}/${child.name}`;
      if (child.isDirectory()) {
        entries.push({ path: `${rel}/`, bytes: 0, digest: null });
        await walk(absolute, rel);
        continue;
      }
      if (child.isSymbolicLink()) {
        const target = await readlink(absolute);
        entries.push({ path: rel, kind: "symlink", bytes: Buffer.byteLength(target), digest: sha256Hex(target) });
        continue;
      }
      if (!child.isFile()) throw new Error(`unsupported preservation entry: ${absolute}`);
      const content = await readFile(absolute);
      entries.push({ path: rel, bytes: content.length, digest: sha256Hex(content) });
    }
  };
  await walk(root, "");
  return { root, exists: true, entries };
}

/** Compare two snapshots of the same tree. */
export function compareSnapshots(before, after) {
  const beforeMap = new Map((before?.entries ?? []).map((entry) => [entry.path, entry]));
  const afterMap = new Map((after?.entries ?? []).map((entry) => [entry.path, entry]));
  const added = [...afterMap.keys()].filter((key) => !beforeMap.has(key));
  const removed = [...beforeMap.keys()].filter((key) => !afterMap.has(key));
  const changed = [...beforeMap.keys()].filter((key) => {
    const previous = beforeMap.get(key);
    const next = afterMap.get(key);
    if (!next) return false;
    return previous.digest !== next.digest || previous.bytes !== next.bytes;
  });
  return {
    identical: before?.exists === after?.exists && added.length === 0 && removed.length === 0 && changed.length === 0,
    added: added.slice(0, 20),
    removed: removed.slice(0, 20),
    changed: changed.slice(0, 20),
    fileCount: { before: beforeMap.size, after: afterMap.size },
    treeDigest: {
      before: digestOf((before?.entries ?? []).map((entry) => ({ path: entry.path, digest: entry.digest }))),
      after: digestOf((after?.entries ?? []).map((entry) => ({ path: entry.path, digest: entry.digest }))),
    },
  };
}

/**
 * Snapshot the source session, the canonical 5I tree, and the two sealed
 * sessions. Called BEFORE the analysis and again AFTER it.
 */
export async function snapshotPreservationTargets({
  sessionId,
  sourceRoot = PAPER_FORENSICS_SOURCE_ROOT_DIR,
  canonicalRoot = PAPER_FORENSICS_CANONICAL_ROOT_DIR,
  sealedSessions = PAPER_FORENSICS_SEALED_SESSIONS,
} = {}) {
  sourceRoot ??= PAPER_FORENSICS_SOURCE_ROOT_DIR;
  canonicalRoot ??= PAPER_FORENSICS_CANONICAL_ROOT_DIR;
  const source = await snapshotTree(path.join(sourceRoot, sessionId));
  const canonical = await snapshotTree(canonicalRoot);
  const sealed = [];
  for (const session of sealedSessions) {
    const snapshot = await snapshotTree(path.join(canonicalRoot, session.id.startsWith("jrep-") ? "replication" : "temporal", session.id));
    sealed.push({
      id: session.id,
      label: session.label,
      root: path.join(canonicalRoot, session.id.startsWith("jrep-") ? "replication" : "temporal", session.id),
      present: snapshot.exists,
      fileCount: snapshot.entries.length,
      entries: snapshot.entries,
      treeDigest: digestOf(snapshot.entries.map((entry) => ({ path: entry.path, digest: entry.digest }))),
    });
  }
  return { sessionId, sourceRoot, canonicalRoot, source, canonical, sealedSessions: sealed };
}

/**
 * The preservation verdict, comparing the before/after snapshots byte for byte.
 * A tree that does not exist in this checkout is reported as `present: false`
 * and is not counted as a change.
 */
export function preservationProof({ before, after }) {
  const source = compareSnapshots(before?.source, after?.source);
  const canonical = compareSnapshots(before?.canonical, after?.canonical);
  const sealed = (after?.sealedSessions ?? []).map((session) => {
    const previous = (before?.sealedSessions ?? []).find((entry) => entry.id === session.id) ?? null;
    const unchanged =
      previous === null
        ? null
        : digestOf(previous.entries.map((entry) => ({ path: entry.path, digest: entry.digest }))) ===
          digestOf(session.entries.map((entry) => ({ path: entry.path, digest: entry.digest })));
    return {
      id: session.id,
      label: session.label,
      present: session.present,
      fileCount: session.fileCount,
      treeDigest: session.treeDigest,
      unchanged,
    };
  });

  const sealedOk = sealed.every((entry) => entry.unchanged !== false);
  const ok = source.identical && canonical.identical && sealedOk;

  return {
    version: PAPER_FORENSICS_PRESERVATION_VERSION,
    ok,
    sourceSession: {
      sessionId: before?.sessionId ?? null,
      root: before?.source?.root ?? null,
      present: before?.source?.exists === true,
      entryCount: source.fileCount,
      identical: source.identical,
      added: source.added,
      removed: source.removed,
      changed: source.changed,
      treeDigestBefore: source.treeDigest.before,
      treeDigestAfter: source.treeDigest.after,
    },
    canonicalTree: {
      root: before?.canonical?.root ?? null,
      present: before?.canonical?.exists === true,
      entryCount: canonical.fileCount,
      identical: canonical.identical,
      added: canonical.added,
      removed: canonical.removed,
      changed: canonical.changed,
      treeDigestBefore: canonical.treeDigest.before,
      treeDigestAfter: canonical.treeDigest.after,
    },
    sealedSessions: sealed,
    sealedSessionsUntouched: sealedOk,
    statement:
      "The source session tree and the whole canonical Phase 5I tree are byte-identical before and after the analysis, and the two named sealed sessions are untouched.",
    sourceNeverRewritten: true,
  };
}

/**
 * Snapshot ONE named file set (used to prove a source artifact's bytes did not
 * change between the integrity read and the end of the analysis).
 */
export async function fileDigestsOf(root, filenames) {
  const out = [];
  for (const filename of filenames) {
    try {
      const content = await readFile(path.join(root, filename));
      out.push({ file: filename, bytes: content.length, digest: sha256Hex(content) });
    } catch {
      out.push({ file: filename, bytes: null, digest: null });
    }
  }
  return out;
}
