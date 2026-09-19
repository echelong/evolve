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
 *
 * FEATURE-VERSION RESOLUTION (Phase 5E.2)
 * ---------------------------------------
 * Replay chooses the feature transform FROM THE FROZEN MANIFEST — never from
 * "latest" — and fails closed on anything it does not recognise:
 *
 *   schema 1 (or older) + no featureVersion   -> external-intelligence-features-v1
 *                                                 (explicit BACKWARDS-COMPATIBILITY
 *                                                 rule, not a default-to-latest rule)
 *   featureVersion = ...features-v1            -> V1
 *   featureVersion = ...features-v2            -> V2
 *   schema >= 2 with NO featureVersion         -> fail closed (malformed manifest)
 *   any unknown featureVersion                  -> fail closed
 *
 * `replayDigest` deliberately does NOT include the replay implementation version
 * or the resolved feature version: the historical contract is that a legacy
 * capture replays to exactly the same digest it always did, under its frozen V1
 * transform. The resolved versions are reported as provenance instead.
 */

import { digestOf } from "../lib/hash.mjs";
import { LEGACY_CAPTURE_SCHEMA_VERSION, loadCaptureRecords, readCaptureManifest, verifyCapture } from "./capture.mjs";
import {
  INTELLIGENCE_FEATURE_VERSION,
  UnknownFeatureVersionError,
  featureExtractorFor,
  featuresDigest,
} from "./features.mjs";

export const INTELLIGENCE_REPLAY_VERSION = "external-intelligence-replay-v2";

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
 * Resolve the feature transform a frozen manifest pins.
 *
 * FAIL-CLOSED. See the module header for the exact rules.
 *
 * @param {object|null} manifest
 * @returns {string} a registered feature version
 */
export function resolveCaptureFeatureVersion(manifest) {
  const pinned = typeof manifest?.featureVersion === "string" && manifest.featureVersion.trim().length > 0
    ? manifest.featureVersion.trim()
    : null;
  const declared = Number.isFinite(manifest?.captureSchemaVersion)
    ? manifest.captureSchemaVersion
    : Number.isFinite(manifest?.schemaVersion)
      ? manifest.schemaVersion
      : null;
  if (pinned !== null) {
    // Registered => that transform. Unknown => throws (never "latest").
    return featureExtractorFor(pinned).version;
  }
  // No pin. A manifest that PREDATES the pin (schema 1, or no schema at all) is
  // legacy V1 by an explicit compatibility rule. Anything newer MUST pin one.
  if (declared === null || declared <= LEGACY_CAPTURE_SCHEMA_VERSION) {
    return INTELLIGENCE_FEATURE_VERSION;
  }
  throw new UnknownFeatureVersionError(
    null,
    `Capture manifest schema ${declared} requires an explicit registered \`featureVersion\`; the manifest pins none.`,
  );
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
  const featureVersion = resolveCaptureFeatureVersion(manifest);
  const extractor = featureExtractorFor(featureVersion);
  const features = extractor.extract({
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
    // Provenance: which manifest schema produced these bytes, and which frozen
    // feature transform interpreted them. Neither participates in `replayDigest`.
    captureSchemaVersion: Number.isFinite(manifest.captureSchemaVersion)
      ? manifest.captureSchemaVersion
      : Number.isFinite(manifest.schemaVersion)
        ? manifest.schemaVersion
        : null,
    featureVersion,
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
    captureSchemaVersion: replay?.captureSchemaVersion ?? null,
    featureVersion: replay?.featureVersion ?? null,
    recordCount: replay?.recordCount ?? 0,
    channels: replay?.channels ?? [],
    counts: replay?.counts ?? {},
    manifestDigest: replay?.captureManifestDigest ?? null,
    replayDigest: replay?.replayDigest ?? null,
    features: replay?.features ?? null,
  };
}

export default replayCapture;
