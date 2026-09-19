/**
 * Phase 5E — deterministic INTELLIGENCE REPLAY (PAPER ONLY).
 *
 * Research consumes persisted snapshots, never the live internet. A replay
 * reads a finalized capture from disk and reconstructs the exact normalized
 * evidence + features:
 *
 *   * ZERO network access — this module imports no HTTP client and calls no
 *     provider; it only reads files under the capture root;
 *   * byte-equivalent results — replaying the same capture twice returns the
 *     same records and the same digests (`replayDigest`);
 *   * fail-closed — a capture whose bytes no longer match its manifest is
 *     REFUSED instead of being replayed with silently different evidence.
 *
 * PAPER ONLY. No wallet, no signing, no write RPC, no posting.
 */

import { digestOf } from "../lib/hash.mjs";
import { loadCaptureRecords, readCaptureManifest, verifyCapture } from "./capture.mjs";
import { extractIntelligenceFeatures, featuresDigest } from "./features.mjs";

export const INTELLIGENCE_REPLAY_VERSION = "external-intelligence-replay-v1";

export class CaptureIntegrityError extends Error {
  constructor(captureId, reason) {
    super(
      `capture '${captureId}' failed integrity verification (${reason}) — refusing to replay evidence that no longer ` +
        "matches its frozen manifest.",
    );
    this.name = "CaptureIntegrityError";
    this.captureId = captureId;
  }
}

/**
 * Replay one frozen capture.
 *
 * @param {{ root: string, captureId: string, asOf?: number|null, verify?: boolean }} options
 */
export async function replayCapture({ root, captureId, asOf = null, verify = true } = {}) {
  const manifest = await readCaptureManifest(root, captureId);
  if (!manifest) throw new Error(`no capture '${captureId}' under ${root}`);
  if (manifest.finalized !== true) throw new CaptureIntegrityError(captureId, "the manifest is not finalized");

  const integrity = verify ? await verifyCapture(root, captureId) : { ok: true, reason: null };
  if (!integrity.ok) throw new CaptureIntegrityError(captureId, integrity.reason ?? "integrity check failed");

  const records = await loadCaptureRecords(root, captureId);
  const features = extractIntelligenceFeatures({
    records,
    capturedAt: manifest.startedAt ?? null,
    asOf,
    queryPlanCount: manifest.queries?.count ?? null,
    failureCount: manifest.counts?.failures ?? null,
  });

  const replayDigest = digestOf({
    captureId,
    recordsDigest: manifest.digests?.recordsDigest ?? null,
    records: records.map((record) => record.normalizedDigest).sort(),
    featuresDigest: featuresDigest(features),
  });

  return {
    phase: "5E",
    replayVersion: INTELLIGENCE_REPLAY_VERSION,
    captureId,
    captureManifestDigest: manifest.manifestDigest,
    mode: "replay",
    live: false,
    networkCalls: 0,
    provider: manifest.provider,
    syntheticIntelligence: manifest.syntheticIntelligence === true,
    capturedAt: manifest.startedAt ?? null,
    channels: [...(manifest.queries?.channels ?? [])],
    querySetId: manifest.queries?.querySetId ?? null,
    health: manifest.health ?? {},
    counts: manifest.counts ?? {},
    failures: manifest.failures ?? [],
    timeouts: manifest.timeouts ?? [],
    records,
    recordCount: records.length,
    features,
    replayDigest,
    integrity: { ok: integrity.ok, recordsDigest: integrity.recordsDigest, manifestDigest: manifest.manifestDigest },
    paperOnly: true,
    note:
      "REPLAY: byte-equivalent normalized evidence reconstructed from the frozen capture. No network access, no provider call, " +
      "and no influence on trading, evolution, scoring, gates or replication.",
  };
}

/** Replay twice and report whether the two results are byte-equivalent. */
export async function verifyReplayDeterminism({ root, captureId, asOf = null } = {}) {
  const first = await replayCapture({ root, captureId, asOf });
  const second = await replayCapture({ root, captureId, asOf });
  return {
    ok: first.replayDigest === second.replayDigest,
    captureId,
    replayDigest: first.replayDigest,
    note: "Byte-equivalent replay: identical records and identical digests across two independent reads.",
  };
}

/** Compact stats for one capture (read-only; no records returned). */
export function captureStats(replay) {
  return {
    captureId: replay?.captureId ?? null,
    provider: replay?.provider ?? null,
    syntheticIntelligence: replay?.syntheticIntelligence === true,
    capturedAt: replay?.capturedAt ?? null,
    recordCount: replay?.recordCount ?? 0,
    channels: replay?.channels ?? [],
    counts: replay?.counts ?? {},
    manifestDigest: replay?.captureManifestDigest ?? null,
    replayDigest: replay?.replayDigest ?? null,
    features: replay?.features ?? null,
  };
}

export default replayCapture;
