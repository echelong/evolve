/**
 * Phase 5E — external-intelligence SHADOW dashboard state (PAPER ONLY).
 *
 * Builds the compact `externalIntelligence` panel block consumed by
 * `scripts/lib/dashboard-state.mjs` / `/api/state`. Read-only: it never runs a
 * capture, never calls a provider and never writes.
 *
 * Exposed fields are identity, health and counts only. Raw social content, URLs,
 * cookies and tokens are NEVER sent to the browser; the public sanitizer runs on
 * top as a second line of defence.
 *
 * PAPER ONLY.
 */

import { readdir } from "node:fs/promises";
import path from "node:path";

import { INTELLIGENCE_DIR, resolveIntelligenceConfig } from "./config.mjs";
import { listCaptures, readCaptureManifest, resolveCaptureSyntheticProvenance } from "./capture.mjs";

export const INTELLIGENCE_DASHBOARD_VERSION = 1;

/**
 * Load the compact shadow state.
 *
 * @param {string} root `.evolve` root
 * @param {{ env?: object, now?: number }} [options]
 */
export async function loadExternalIntelligenceState(root = path.join(process.cwd(), ".evolve"), { env = process.env, now = Date.now() } = {}) {
  let config = null;
  let configError = null;
  try {
    config = resolveIntelligenceConfig(env);
  } catch (error) {
    configError = String(error?.message ?? error);
  }

  const captureRoot = path.join(root, "intelligence");
  const captures = await listCaptures(captureRoot);
  const latest = captures.length > 0 ? captures[captures.length - 1] : null;
  const manifest = latest ? await readCaptureManifest(captureRoot, latest.captureId) : null;

  const provider = characteriseProvider(env, config, configError);
  // Presentation-only: how long ago the latest capture was taken. It is derived
  // from the injected clock, never from a provider, and never digested.
  const startedAt = manifest?.startedAt ?? null;
  const lastCaptureAgeMs =
    startedAt && Number.isFinite(now) ? Math.max(0, now - Date.parse(startedAt)) : null;
  const health = manifest?.health ?? {};
  const channels = Object.entries(health).map(([channel, row]) => ({
    channel,
    status: row?.status ?? "unknown",
    records: row?.records ?? 0,
    failures: row?.failures ?? 0,
    timeouts: row?.timeouts ?? 0,
  }));

  return {
    available: Boolean(manifest) || provider.enabled === true,
    version: INTELLIGENCE_DASHBOARD_VERSION,
    phase: "5E",
    provider: provider.name,
    providerEnabled: provider.enabled === true,
    providerRegistered: provider.registered === true,
    providerError: provider.error,
    mode: config?.mode ?? "shadow",
    modeIsShadowOnly: true,
    agentReachVersion: config?.agentReach?.release ?? null,
    agentReachCommit: config?.agentReach?.commit ?? null,
    agentReachLicense: config?.agentReach?.license ?? null,
    health: provider.health,
    enabledChannels: provider.channels,
    disabledChannels: provider.disabledChannels,
    captures: captures.length,
    records: manifest?.counts?.records ?? 0,
    calls: manifest?.counts?.calls ?? 0,
    failures: manifest?.counts?.failures ?? 0,
    timeouts: manifest?.counts?.timeouts ?? 0,
    lastCaptureAt: startedAt,
    lastCaptureAgeMs,
    latestCaptureId: manifest?.captureId ?? null,
    latestCaptureDigest: manifest?.manifestDigest ?? null,
    // Corrected provenance (provider-derived), so a legacy zero-record real
    // capture is not displayed as synthetic. Immutable stored bytes are untouched.
    latestCaptureSynthetic: resolveCaptureSyntheticProvenance(manifest).effective,
    evidenceQuality: null,
    replayMode: "replay-only",
    network: { liveInternetInsideArena: false, replayIsOffline: true },
    channels,
    routing: { jevRoutingActive: false, deepseekRoutingActive: false },
    paperOnly: true,
    note:
      manifest
        ? "SHADOW external intelligence: observations are captured, frozen, fingerprinted and replayed offline. Nothing here can influence trading, evolution, Arena scoring, gates or replication."
        : "No external-intelligence capture exists in this workspace yet. The provider is disabled by default — an operator must explicitly opt in (`npm run intelligence:capture -- --provider mock` for an offline fixture).",
  };
}

function characteriseProvider(env, config, configError) {
  if (configError) {
    return {
      name: String(env?.EVOLVE_INTELLIGENCE_PROVIDER ?? "disabled"),
      enabled: false,
      registered: false,
      error: configError,
      channels: [],
      disabledChannels: [],
      health: "CONFIG_ERROR",
    };
  }
  const enabled = config.provider !== "disabled";
  return {
    name: config.provider,
    enabled,
    registered: true,
    error: null,
    channels: [...config.channels],
    disabledChannels: [],
    health: enabled ? "CONFIGURED" : "DISABLED",
  };
}

/**
 * Read-only helper used by the CLI `stats` action.
 *
 * `captureRoot` is the capture root itself (e.g. `.evolve/intelligence`), the
 * same argument `listCaptures` takes — not the `.evolve` root.
 */
export async function listCaptureSummaries(captureRoot, { limit = 20 } = {}) {
  const captures = await listCaptures(captureRoot);
  const rows = [];
  for (const entry of captures.slice(-limit).reverse()) {
    const manifest = await readCaptureManifest(captureRoot, entry.captureId);
    if (!manifest) continue;
    rows.push({
      captureId: entry.captureId,
      provider: manifest.provider ?? null,
      syntheticIntelligence: resolveCaptureSyntheticProvenance(manifest).effective,
      storedSyntheticIntelligence: manifest.syntheticIntelligence === true,
      records: manifest.counts?.records ?? 0,
      failures: manifest.counts?.failures ?? 0,
      timeouts: manifest.counts?.timeouts ?? 0,
      channels: manifest.queries?.channels ?? [],
      manifestDigest: manifest.manifestDigest ?? null,
      startedAt: manifest.startedAt ?? null,
    });
  }
  return rows;
}

/** Directory helper kept next to the panel for symmetry with the other phases. */
export const INTELLIGENCE_ROOT = INTELLIGENCE_DIR;

/** Count of capture days present (used by nothing critical; kept for tooling). */
export async function captureDayCount(captureRoot) {
  try {
    const days = (await readdir(captureRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory());
    return days.length;
  } catch {
    return 0;
  }
}
