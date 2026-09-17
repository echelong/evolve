/**
 * Historical dataset reader.
 *
 * Streaming by design: replay walks a dataset forward one snapshot at a time and
 * never loads the whole file into memory. Reads are strictly forward-only, which
 * is also the structural guarantee against look-ahead bias — there is no API to
 * jump backwards, and the cursor cannot see a snapshot it has not reached.
 *
 * Files inside a session directory:
 *   manifest.json     session metadata, final classification, fingerprint
 *   snapshots.ndjson  session header + snapshots (+ optional events)
 *   events.ndjson     feed and system events
 */

import { createReadStream } from "node:fs";
import { access, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

import { hashFile, sha256Hex } from "../lib/hash.mjs";
import {
  HISTORY_SCHEMA_VERSION,
  RECORD_TYPE,
  ROW_FIELDS,
  parseRecord,
  rowToMarket,
} from "./schema.mjs";

export const HISTORY_ROOT = path.join(".evolve", "history");
export const MANIFEST_FILE = "manifest.json";
export const SNAPSHOT_FILE = "snapshots.ndjson";
export const EVENT_FILE = "events.ndjson";

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

/** List dataset session directories under a history root. */
export async function listDatasets(root = HISTORY_ROOT) {
  if (!(await exists(root))) return [];
  const found = [];

  const days = await readdir(root, { withFileTypes: true });
  for (const day of days) {
    if (!day.isDirectory()) continue;
    const dayPath = path.join(root, day.name);
    const sessions = await readdir(dayPath, { withFileTypes: true });
    for (const session of sessions) {
      if (!session.isDirectory()) continue;
      const dir = path.join(dayPath, session.name);
      found.push({
        dir,
        day: day.name,
        sessionId: session.name,
        manifest: await readManifest(dir),
      });
    }
  }

  // Direct session directories (a dataset path passed straight in).
  const flat = await readdir(root, { withFileTypes: true });
  for (const entry of flat) {
    if (!entry.isDirectory()) continue;
    if ((await exists(path.join(root, entry.name, MANIFEST_FILE))) === false) continue;
    found.push({
      dir: path.join(root, entry.name),
      day: null,
      sessionId: entry.name,
      manifest: await readManifest(path.join(root, entry.name)),
    });
  }

  return found.sort((a, b) => String(a.dir).localeCompare(String(b.dir)));
}

export async function readManifest(dir) {
  const manifestPath = path.join(dir, MANIFEST_FILE);
  if (!(await exists(manifestPath))) return null;
  try {
    return JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * SHA-256 fingerprint of the dataset's *data* files.
 *
 * `manifest.json` is deliberately excluded from `combined`: the recorder writes
 * the fingerprint into the manifest, so a manifest that hashed itself could
 * never verify. The fingerprint therefore identifies the recorded bytes — what a
 * replay actually reads — while manifest metadata (counts, classification,
 * status) is descriptive and may be rewritten on close.
 */
export async function fingerprintDataset(dir) {
  const dataFiles = [SNAPSHOT_FILE, EVENT_FILE];
  const hashes = {};
  const lines = [];

  for (const name of dataFiles) {
    const target = path.join(dir, name);
    if (!(await exists(target))) continue;
    const info = await stat(target);
    if (info.size === 0) {
      hashes[name] = null;
      continue;
    }
    hashes[name] = await hashFile(target);
    lines.push(`${name}:${hashes[name]}`);
  }

  return {
    algorithm: "sha256",
    covers: [...dataFiles],
    files: hashes,
    combined: sha256Hex(lines.sort().join("\n")),
    computedAt: new Date().toISOString(),
  };
}

/**
 * Open a dataset for forward-only streaming reads.
 * @param {string} dir session directory
 * @param {{ requireManifest?: boolean }} [options]
 */
export async function openDataset(dir, { requireManifest = false } = {}) {
  const snapshotPath = path.join(dir, SNAPSHOT_FILE);

  if (!(await exists(snapshotPath))) {
    throw new Error(
      `dataset at ${dir} has no ${SNAPSHOT_FILE}; point EVOLVE_REPLAY_DATASET at a session directory`,
    );
  }

  const manifest = await readManifest(dir);
  if (!manifest && requireManifest) {
    throw new Error(`dataset at ${dir} has no ${MANIFEST_FILE}`);
  }

  const session = await readSessionHeader(snapshotPath);
  const rowFields = Array.isArray(session?.rowFields) && session.rowFields.length > 0
    ? session.rowFields
    : [...ROW_FIELDS];

  return {
    dir,
    manifest,
    session,
    rowFields,
    datasetId: manifest?.datasetId ?? session?.datasetId ?? path.basename(dir),
    schemaVersion: manifest?.schemaVersion ?? session?.v ?? HISTORY_SCHEMA_VERSION,
    classification: manifest?.dataClass ?? null,
    containsSynthetic: manifest?.containsSynthetic ?? null,
    firstObservedAt: manifest?.firstObservedAt ?? null,
    lastObservedAt: manifest?.lastObservedAt ?? null,
    snapshotCount: manifest?.snapshotCount ?? null,
    durationMs: manifest?.durationMs ?? null,
    fingerprint: manifest?.fingerprint ?? null,
    snapshotPath,
    eventPath: path.join(dir, EVENT_FILE),
    /** Forward-only snapshot stream; see `streamSnapshots`. */
    snapshots: (options = {}) => streamSnapshots(snapshotPath, rowFields, options),
    events: () => streamEvents(path.join(dir, EVENT_FILE)),
    verifyFingerprint: async () => {
      const computed = await fingerprintDataset(dir);
      return {
        ok: manifest?.fingerprint?.combined
          ? manifest.fingerprint.combined === computed.combined
          : null,
        expected: manifest?.fingerprint?.combined ?? null,
        computed: computed.combined,
        files: computed.files,
      };
    },
  };
}

/** Read only the first record (the session header). */
export async function readSessionHeader(snapshotPath) {
  const stream = createReadStream(snapshotPath, { encoding: "utf8" });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      const record = parseRecord(line);
      if (!record) continue;
      if (record.type === RECORD_TYPE.SESSION) return record;
      // A dataset without a header is still readable; stop at the first record.
      return null;
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  return null;
}

/**
 * Stream snapshots in file order (which is capture order).
 *
 * @param {string} snapshotPath
 * @param {string[]} rowFields
 * @param {{ from?: number, until?: number, limit?: number, onSkip?: (info: object) => void }} [options]
 */
export async function* streamSnapshots(snapshotPath, rowFields, options = {}) {
  const { from = null, until = null, limit = 0, onSkip = null } = options;

  const stream = createReadStream(snapshotPath, { encoding: "utf8" });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let yielded = 0;
  let lastTimestamp = null;
  let skipped = 0;

  try {
    for await (const line of lines) {
      const record = parseRecord(line);
      if (!record) {
        skipped += 1;
        continue;
      }
      if (record.type !== RECORD_TYPE.SNAPSHOT) continue;

      const t = Number(record.t);
      if (!Number.isFinite(t)) {
        skipped += 1;
        continue;
      }

      if (from !== null && t < from) continue;
      if (until !== null && t > until) break;

      // Monotonicity guard: capture order must be time order.
      if (lastTimestamp !== null && t < lastTimestamp) {
        skipped += 1;
        continue;
      }
      lastTimestamp = t;

      yield {
        seq: record.seq,
        t,
        capturedAt: record.capturedAt ?? null,
        mode: record.mode ?? null,
        health: record.health ?? null,
        count: Number.isFinite(record.count) ? record.count : (record.rows?.length ?? 0),
        markets: decodeRows(record.rows, rowFields),
      };

      yielded += 1;
      if (limit > 0 && yielded >= limit) break;
    }
  } finally {
    lines.close();
    stream.destroy();
    if (onSkip && skipped > 0) onSkip({ skipped });
  }
}

export async function* streamEvents(eventPath) {
  if (!(await exists(eventPath))) return;
  const stream = createReadStream(eventPath, { encoding: "utf8" });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      const record = parseRecord(line);
      if (!record) continue;
      if (record.type === RECORD_TYPE.EVENT) yield record;
    }
  } finally {
    lines.close();
    stream.destroy();
  }
}

/**
 * Decode snapshot rows using the dataset's own row layout.
 * A dataset recorded with a different field order still decodes correctly.
 */
export function decodeRows(rows, rowFields = ROW_FIELDS) {
  if (!Array.isArray(rows)) return [];

  const aligned =
    rowFields.length === ROW_FIELDS.length &&
    ROW_FIELDS.every((key, index) => rowFields[index] === key);

  const map = aligned
    ? null
    : ROW_FIELDS.map((key) => (rowFields.includes(key) ? rowFields.indexOf(key) : -1));

  const out = [];
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const source = map ? map.map((index) => (index === -1 ? null : row[index] ?? null)) : row;
    const market = rowToMarket(source);
    if (market) out.push(market);
  }
  return out;
}

/** Collect manifest-level statistics for a dataset, falling back to a scan. */
export async function datasetStats(dir) {
  const manifest = await readManifest(dir);
  if (manifest) {
    return {
      dir,
      datasetId: manifest.datasetId,
      status: manifest.status,
      dataClass: manifest.dataClass,
      snapshotCount: manifest.snapshotCount,
      uniqueMints: manifest.uniqueMintCount,
      durationMs: manifest.durationMs,
      firstObservedAt: manifest.firstObservedAt,
      lastObservedAt: manifest.lastObservedAt,
      fingerprint: manifest.fingerprint?.combined ?? null,
      usableForRealMarketReplay: manifest.usableForRealMarketReplay === true,
    };
  }

  const session = await readSessionHeader(path.join(dir, SNAPSHOT_FILE));
  return {
    dir,
    datasetId: session?.datasetId ?? path.basename(dir),
    status: "unknown",
    dataClass: null,
    snapshotCount: null,
    uniqueMints: null,
    durationMs: null,
    firstObservedAt: null,
    lastObservedAt: null,
    fingerprint: null,
    usableForRealMarketReplay: false,
  };
}

/** Merge per-file hashes into the manifest fingerprint shape. */
export async function withFingerprint(dir, manifest) {
  const fingerprint = await fingerprintDataset(dir);
  return { ...manifest, fingerprint };
}
