/**
 * EVOLVE Phase 5F.1 — JEV PROVIDER HEALTH / COOLDOWN (bounded circuit breaker).
 *
 * Retry/backoff protects ONE logical decision. This module protects EVOLVE
 * ACROSS repeated runs: without it, a provider that is rate-limited for ten
 * minutes would be rediscovered (and hammered) by every new experiment.
 *
 * State lives under the JEV subsystem — `.evolve/jev/provider-health/<provider>.json`
 * — never under market, research, Arena, replication or trading storage. It is
 * bounded, plain JSON, and contains NO secret of any kind:
 *
 *   provider, model, consecutiveTransientFailures, lastFailureStatus,
 *   lastFailureAt, cooldownUntil, lastSuccessAt, formatVersion
 *
 * Rules:
 *
 *   * a logical decision that exhausted ALL its attempts on exclusively
 *     transient (429 / 5xx / timeout / unavailable) failures increments the
 *     streak and opens a bounded cooldown window;
 *   * cooldown escalates geometrically (60s → 120s → 240s …) and is CLAMPED at
 *     a configured maximum (default 15 minutes) — never indefinite;
 *   * during an active cooldown no network call is made at all: the call fails
 *     safely with `JEV_COOLDOWN`, so the provider is never touched merely to
 *     rediscover that it is still rate limited. An explicit
 *     `--override-cooldown` is the only way past it;
 *   * a successful `JEV_OK` RESETS the transient-failure streak and clears the
 *     cooldown;
 *   * auth/config/invalid-response failures are recorded but NEVER create a
 *     transient cooldown — sleeping cannot fix a revoked key or a rejected
 *     schema.
 *
 * PAPER ONLY. No wallet, no signing, no RPC, no order execution.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const JEV_PROVIDER_HEALTH_FORMAT_VERSION = 1;
export const JEV_PROVIDER_HEALTH_DIR = path.join(".evolve", "jev", "provider-health");

/** Only these eight fields are ever persisted. Nothing else, ever. */
export const JEV_PROVIDER_HEALTH_FIELDS = Object.freeze([
  "provider",
  "model",
  "consecutiveTransientFailures",
  "lastFailureStatus",
  "lastFailureAt",
  "cooldownUntil",
  "lastSuccessAt",
  "formatVersion",
]);

/** Safe file name for a provider id; anything else is refused (no path traversal). */
function safeProviderFile(provider) {
  const name = String(provider ?? "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name)) {
    throw new Error(`refusing an unsafe Jev provider name for the health store: '${provider}'`);
  }
  return `${name}.json`;
}

export function providerHealthPath(root, provider) {
  return path.join(root ?? JEV_PROVIDER_HEALTH_DIR, safeProviderFile(provider));
}

function isoOrNull(value, fallbackMs) {
  if (typeof value === "string" && value.length > 0) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return fallbackMs === undefined ? null : new Date(fallbackMs).toISOString();
}

function finiteCount(value) {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

export function emptyProviderHealth({ provider = null, model = null } = {}) {
  return {
    provider: provider ?? null,
    model: model ?? null,
    consecutiveTransientFailures: 0,
    lastFailureStatus: null,
    lastFailureAt: null,
    cooldownUntil: null,
    lastSuccessAt: null,
    formatVersion: JEV_PROVIDER_HEALTH_FORMAT_VERSION,
  };
}

/** Bounded re-shape of anything read off disk: unknown fields are dropped. */
export function normalizeProviderHealth(raw, { provider = null, model = null } = {}) {
  const source = raw && typeof raw === "object" ? raw : {};
  return {
    provider: provider ?? (typeof source.provider === "string" ? source.provider.slice(0, 64) : null),
    model: model ?? (typeof source.model === "string" ? source.model.slice(0, 128) : null),
    consecutiveTransientFailures: finiteCount(source.consecutiveTransientFailures),
    lastFailureStatus: typeof source.lastFailureStatus === "string" ? source.lastFailureStatus.slice(0, 64) : null,
    lastFailureAt: isoOrNull(source.lastFailureAt),
    cooldownUntil: isoOrNull(source.cooldownUntil),
    lastSuccessAt: isoOrNull(source.lastSuccessAt),
    formatVersion: JEV_PROVIDER_HEALTH_FORMAT_VERSION,
  };
}

export async function readProviderHealth(root, provider) {
  if (!root || !provider) return null;
  try {
    const parsed = JSON.parse(await readFile(providerHealthPath(root, provider), "utf8"));
    return normalizeProviderHealth(parsed, { provider, model: typeof parsed?.model === "string" ? parsed.model : null });
  } catch {
    return null;
  }
}

export async function writeProviderHealth(root, health) {
  if (!root || !health?.provider) return null;
  const target = providerHealthPath(root, health.provider);
  const record = normalizeProviderHealth(health, { provider: health.provider, model: health.model ?? null });
  await mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
  await writeFile(tmp, JSON.stringify(record, null, 2), "utf8");
  await rename(tmp, target);
  return record;
}

/** Is the cooldown window still open at `nowMs`? */
export function isCooldownActive(health, nowMs) {
  const until = Date.parse(String(health?.cooldownUntil ?? ""));
  if (!Number.isFinite(until)) return false;
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  return until > now;
}

/**
 * Bounded geometric escalation: `base * 2^(streak - 1)`, clamped to
 * `maxCooldownMs`. The first exhausted transient decision therefore opens the
 * default 60s window, the second 120s, the third 240s, and so on — never
 * indefinite, never unbounded.
 */
export function cooldownEscalationMs(consecutiveTransientFailures, { baseCooldownMs = 60_000, maxCooldownMs = 900_000 } = {}) {
  const streak = Math.max(1, finiteCount(consecutiveTransientFailures));
  const base = Number.isFinite(baseCooldownMs) ? Math.max(0, baseCooldownMs) : 60_000;
  const ceiling = Number.isFinite(maxCooldownMs) ? Math.max(0, maxCooldownMs) : 900_000;
  return Math.min(ceiling, base * 2 ** (streak - 1));
}

/** A successful `JEV_OK` clears the streak AND the cooldown. */
export function applySuccess(health, { now = Date.now() } = {}) {
  const base = normalizeProviderHealth(health, { provider: health?.provider ?? null, model: health?.model ?? null });
  return {
    ...base,
    consecutiveTransientFailures: 0,
    cooldownUntil: null,
    lastSuccessAt: new Date(now).toISOString(),
  };
}

/**
 * A logical decision that exhausted every attempt on EXCLUSIVELY transient
 * failures: escalate the streak and open the (clamped) cooldown window.
 */
export function applyTransientExhaustion(
  health,
  { now = Date.now(), status = null, baseCooldownMs = 60_000, maxCooldownMs = 900_000 } = {},
) {
  const base = normalizeProviderHealth(health, { provider: health?.provider ?? null, model: health?.model ?? null });
  const streak = base.consecutiveTransientFailures + 1;
  const cooldownMs = cooldownEscalationMs(streak, { baseCooldownMs, maxCooldownMs });
  return {
    ...base,
    consecutiveTransientFailures: streak,
    lastFailureStatus: typeof status === "string" ? status.slice(0, 64) : base.lastFailureStatus,
    lastFailureAt: new Date(now).toISOString(),
    cooldownUntil: new Date(now + cooldownMs).toISOString(),
  };
}

/**
 * A non-transient failure (auth / config / malformed response / unknown model)
 * is recorded for observability but MUST NOT open or escalate a transient
 * cooldown, and must not reset an existing streak either — it is simply not a
 * transient signal.
 */
export function applyNonTransientFailure(health, { now = Date.now(), status = null } = {}) {
  const base = normalizeProviderHealth(health, { provider: health?.provider ?? null, model: health?.model ?? null });
  return {
    ...base,
    lastFailureStatus: typeof status === "string" ? status.slice(0, 64) : base.lastFailureStatus,
    lastFailureAt: new Date(now).toISOString(),
  };
}
