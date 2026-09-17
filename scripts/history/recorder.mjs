/**
 * Historical market recorder.
 *
 * Captures the normalized market representation that the running engine already
 * consumes (`feed.markets(at)` plus `feed.health(at)`) into an append-only
 * NDJSON dataset. No second normalization pipeline exists: the recorder writes
 * what agents see.
 *
 * Crash safety:
 *   - every record is one line, written with an awaited append, so an
 *     interrupted process leaves complete lines behind
 *   - unreadable/short lines are skipped by the reader instead of failing a
 *     whole dataset
 *   - the manifest is written at session start (status "recording") and rewritten
 *     atomically on close (status "complete"/"interrupted"), so a killed run is
 *     still identifiable and partially usable
 *   - long sessions flush the manifest periodically, so even a hard kill leaves
 *     a usable index of what exists
 *
 * Secrets: the recorder never receives the API key. It writes observation data
 * and feed metadata only, and every record is passed through the shared
 * sanitizer as a belt-and-braces measure.
 */

import { appendFile, mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { sha256Hex } from "../lib/hash.mjs";
import { HISTORY_SCHEMA_VERSION } from "./schema.mjs";
import {
  DATASET_STATUS,
  buildEventRecord,
  buildManifest,
  buildSessionRecord,
  buildSnapshotRecord,
  serializeRecord,
} from "./schema.mjs";
import { fingerprintDataset } from "./dataset.mjs";

export const DEFAULT_HISTORY_ROOT = path.join(".evolve", "history");
export const DEFAULT_CAPTURE_MS = 5000;

/** `2026-09-17/session-20260917T120000Z` — readable, sortable, unique per day. */
export function sessionDirectoryName(at = Date.now(), suffix = null) {
  const iso = new Date(at).toISOString();
  const compact = iso.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const tail = suffix ? `-${suffix}` : "";
  return { day: iso.slice(0, 10), session: `session-${compact}${tail}` };
}

export function resolveDatasetDir(root, { at = Date.now(), suffix = null } = {}) {
  const { day, session } = sessionDirectoryName(at, suffix);
  return path.join(root, day, session);
}

/** Append a single NDJSON line; never throws into the capture loop. */
async function appendRecord(filePath, record) {
  try {
    await appendFile(filePath, serializeRecord(record), "utf8");
    return true;
  } catch {
    return false;
  }
}

async function writeJsonAtomic(filePath, value) {
  const temp = `${filePath}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temp, filePath);
}

/**
 * @param {{
 *   dir: string,
 *   feed: object,
 *   config: object,
 *   now?: () => number,
 *   captureMs?: number,
 *   engineVersion?: string | null,
 *   gitCommit?: string | null,
 *   manifestEvery?: number,
 *   onLog?: (line: string) => void,
 * }} options
 */
export function createRecorder({
  dir,
  feed,
  config,
  now = () => Date.now(),
  captureMs = DEFAULT_CAPTURE_MS,
  engineVersion = null,
  gitCommit = null,
  manifestEvery = 12,
  onLog = null,
}) {
  const snapshotPath = path.join(dir, "snapshots.ndjson");
  const eventPath = path.join(dir, "events.ndjson");
  const manifestPath = path.join(dir, "manifest.json");

  const startedAt = now();
  const datasetId = path.basename(dir);
  const mints = new Set();
  const captures = [];
  const events = [];
  const pendingEvents = [];

  let seq = 0;
  let eventSeq = 0;
  let failedWrites = 0;
  let closed = false;

  const log = (line) => {
    if (typeof onLog === "function") onLog(line);
  };

  function recordEvent(kind, message, detail = null) {
    const at = now();
    eventSeq += 1;
    events.push({ t: at, kind });
    return buildEventRecord({ seq: eventSeq, t: at, at: new Date(at).toISOString(), kind, message, detail });
  }

  /** Attach feed/caller events to the dataset (never captured data). */
  function pushEvent(kind, message, detail = null) {
    if (closed) return false;
    pendingEvents.push(recordEvent(kind, message, detail));
    return true;
  }

  async function flushEvents() {
    while (pendingEvents.length > 0) {
      const record = pendingEvents.shift();
      const ok = await appendRecord(eventPath, record);
      if (!ok) failedWrites += 1;
    }
  }

  async function start() {
    await mkdir(dir, { recursive: true });

    // Session header must be the first line of the dataset.
    const header = buildSessionRecord({
      datasetId,
      createdAt: new Date(startedAt).toISOString(),
      source: feed?.health?.(startedAt)?.source ?? config?.provider ?? null,
      requestedMode: config?.requestedMode ?? null,
      effectiveMode: feed?.effectiveMode ?? config?.requestedMode ?? null,
      captureMs,
      engineVersion,
      gitCommit,
    });
    await appendRecord(snapshotPath, header);

    const manifest = buildManifest({
      datasetId,
      status: DATASET_STATUS.RECORDING,
      createdAt: new Date(startedAt).toISOString(),
      endedAt: null,
      source: header.source,
      requestedMode: header.requestedMode,
      effectiveMode: header.effectiveMode,
      captureMs,
      engineVersion,
      gitCommit,
      snapshots: [],
      mints,
      events: [],
      feedErrors: 0,
      rateLimits: 0,
      stalePeriods: 0,
      fingerprint: null,
      extra: {
        historySchemaVersion: HISTORY_SCHEMA_VERSION,
        schemaDigest: schemaDigest(),
        recording: true,
      },
    });
    await writeJsonAtomic(manifestPath, manifest);

    pushEvent("SYSTEM", `Recording started (capture every ${captureMs}ms).`);
    await flushEvents();
    log(`[EVOLVE] recording into ${dir}`);
    return { dir, datasetId };
  }

  /** Capture one normalized market snapshot plus its feed health. */
  async function capture(at = now()) {
    if (closed) return null;

    const markets = feed?.markets ? feed.markets(at) : [];
    const health = feed?.health ? feed.health(at) : null;

    seq += 1;
    const record = buildSnapshotRecord({
      seq,
      t: at,
      capturedAt: new Date(now()).toISOString(),
      markets: Array.isArray(markets) ? markets : [],
      health,
    });

    for (const row of record.rows) {
      const mint = row[0];
      if (typeof mint === "string") mints.add(mint);
    }

    const ok = await appendRecord(snapshotPath, record);
    if (!ok) failedWrites += 1;

    captures.push({
      seq,
      t: at,
      count: record.count,
      mode: record.mode,
      health: record.health,
    });

    await flushEvents();

    if (manifestEvery > 0 && seq % manifestEvery === 0) {
      await writeManifest(DATASET_STATUS.RECORDING);
    }

    return { seq, t: at, count: record.count, ok };
  }

  function buildCurrentManifest(status) {
    const stalePeriods = captures.filter((entry) => entry.mode?.stale === true).length;
    const feedErrors =
      captures.length > 0
        ? Math.max(...captures.map((entry) => entry.health?.errorCount ?? 0))
        : 0;
    const rateLimits =
      captures.length > 0
        ? Math.max(...captures.map((entry) => entry.health?.rateLimitCount ?? 0))
        : 0;

    const lastHealth = captures.length > 0 ? captures[captures.length - 1].health : null;

    return buildManifest({
      datasetId,
      status,
      createdAt: new Date(startedAt).toISOString(),
      endedAt: status === DATASET_STATUS.RECORDING ? null : new Date(now()).toISOString(),
      source: lastHealth?.source ?? config?.provider ?? null,
      requestedMode: config?.requestedMode ?? null,
      effectiveMode: lastHealth?.effectiveMode ?? feed?.effectiveMode ?? null,
      captureMs,
      engineVersion,
      gitCommit,
      snapshots: captures,
      mints,
      events,
      feedErrors,
      rateLimits,
      stalePeriods,
      fingerprint: null,
      extra: {
        historySchemaVersion: HISTORY_SCHEMA_VERSION,
        schemaDigest: schemaDigest(),
      },
    });
  }

  async function writeManifest(status = DATASET_STATUS.RECORDING) {
    const manifest = buildCurrentManifest(status);
    await writeJsonAtomic(manifestPath, manifest);
    return manifest;
  }

  /**
   * Finalize the session: write the manifest with the dataset fingerprint.
   * Safe to call more than once (idempotent).
   */
  async function close({ reason = "stop", status = DATASET_STATUS.COMPLETE } = {}) {
    if (closed) return null;
    closed = true;

    pushEvent("SYSTEM", `Recording stopped (${reason}).`);
    await flushEvents();

    const base = buildCurrentManifest(status);
    // Fingerprint covers a manifest that already describes the content.
    const interim = { ...base, fingerprint: null };
    await writeJsonAtomic(manifestPath, interim);
    const fingerprint = await fingerprintDataset(dir);
    const final = { ...interim, fingerprint, closedReason: reason };
    await writeJsonAtomic(manifestPath, final);

    log(
      `[EVOLVE] recording closed: ${final.snapshotCount} snapshots · ${final.uniqueMintCount} mints · ${final.dataClass}`,
    );
    if (failedWrites > 0) {
      log(`[EVOLVE] ${failedWrites} write(s) failed during this session.`);
    }

    return final;
  }

  return {
    dir,
    datasetId,
    snapshotPath,
    eventPath,
    manifestPath,
    start,
    capture,
    pushEvent,
    writeManifest,
    close,
    get seq() {
      return seq;
    },
    get closed() {
      return closed;
    },
    stats: () => ({
      seq,
      failedWrites,
      mints: mints.size,
      events: events.length,
    }),
  };
}

/** Stable digest of the recorded row schema, included in experiment reports. */
export function schemaDigest() {
  return sha256Hex(`history-schema-v${HISTORY_SCHEMA_VERSION}`).slice(0, 16);
}
