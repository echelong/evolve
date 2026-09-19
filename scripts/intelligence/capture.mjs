/**
 * Phase 5E — LIVE intelligence capture → FROZEN snapshot (PAPER ONLY).
 *
 * Live internet observations NEVER flow into Jev, DeepSeek, the compiler or the
 * Arena. They are captured first, written to an immutable snapshot, and only
 * then read back (from disk) by anything else:
 *
 *   .evolve/intelligence/<YYYY-MM-DD>/<captureId>/
 *     manifest.json     the immutable capture manifest (written LAST)
 *     records.ndjson    normalized evidence records (one per line)
 *     queries.json      the exact deterministic query plan that was executed
 *     health.json       per-channel statuses/counts/failures/timeouts
 *     x.ndjson · web.ndjson · exa.ndjson · reddit.ndjson · rss.ndjson · github.ndjson
 *
 * A capture is written ONCE. An existing capture directory is never overwritten:
 * re-capturing means a NEW capture id, so the bytes an experiment consumed can
 * always be replayed and verified.
 *
 * VERSION PINNING: a new manifest is written at `CAPTURE_SCHEMA_VERSION` (2) and
 * EXPLICITLY pins the feature transform that interprets its bytes
 * (`featureVersion`). Legacy schema-1 manifests that predate the pin are never
 * rewritten; replay resolves those to the frozen V1 transform in code.
 *
 * PAPER ONLY. Read-only, shadow-only, and no result may influence trading,
 * evolution, scoring, gates or replication.
 */

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";

import { digestOf } from "../lib/hash.mjs";
import {
  AGENT_REACH_PIN,
  DisabledIntelligenceProviderError,
  INTELLIGENCE_PHASE,
  INTELLIGENCE_PROVIDER,
} from "./config.mjs";
import {
  REACH_ACTIVE_CAPABILITY_MAP,
  createReachBudget,
  evaluateReachPlanReadiness,
  ReachPlanUnavailableError,
  sanitizeReachEnv,
} from "./agent-reach.mjs";
import { DEFAULT_FEATURE_VERSION } from "./features.mjs";
import { normalizeRecord, verifyRecord } from "./records.mjs";
import { assertCanonicalQueryPlan, buildQueryPlan, REACH_QUERY_SET_ID, REACH_QUERY_SET_VERSION } from "./query-sets.mjs";
import { resolveIntelligenceProvider } from "./provider.mjs";

export const CAPTURE_MANIFEST_FILE = "manifest.json";
export const CAPTURE_RECORDS_FILE = "records.ndjson";
export const CAPTURE_QUERIES_FILE = "queries.json";
export const CAPTURE_HEALTH_FILE = "health.json";
/**
 * Capture manifest schema.
 *
 *   v1  the original manifest: records/queries/provider/counts/digests only. It
 *       does NOT pin the feature transform, so replay resolves it to the frozen
 *       V1 transform by an explicit BACKWARDS-COMPATIBILITY rule.
 *   v2  a manifest that MUST explicitly pin `featureVersion`.
 *
 * Schema is versioned SEPARATELY from the feature transform: the bytes on disk
 * and the interpretation of those bytes evolve independently. Old manifests are
 * never rewritten.
 */
export const CAPTURE_SCHEMA_VERSION = 2;

/** Legacy schema, kept readable forever (byte-compatibility contract). */
export const LEGACY_CAPTURE_SCHEMA_VERSION = 1;

export class CaptureExistsError extends Error {
  constructor(captureId) {
    super(
      `capture '${captureId}' already exists — captures are IMMUTABLE and are never overwritten. ` +
        "Take a new capture instead (a new id is assigned automatically).",
    );
    this.name = "CaptureExistsError";
    this.captureId = captureId;
  }
}

/**
 * Raised when a capture's normalized records contradict the provenance its
 * provider declares (e.g. a real provider emitting records flagged synthetic).
 * Provenance is resolved from the provider, never inferred from record flags, so
 * a contradiction is a hard error rather than a silent relabelling.
 */
export class IntelligenceProvenanceError extends Error {
  constructor(provider, providerSyntheticIntelligence, contradictoryCount) {
    super(
      `capture refused: provider '${provider}' declares syntheticIntelligence=${providerSyntheticIntelligence} but ` +
        `${contradictoryCount} normalized record(s) disagree. Provenance is taken from the provider — a mixed or ` +
        "impossible provenance is never silently relabelled.",
    );
    this.name = "IntelligenceProvenanceError";
    this.provider = provider;
    this.providerSyntheticIntelligence = providerSyntheticIntelligence;
    this.contradictoryCount = contradictoryCount;
  }
}

/**
 * `capture-YYYYMMDDTHHMMSSmmmZ` — second AND millisecond UTC precision.
 *
 * Millisecond precision makes the id collision-proof for two independent captures
 * that start within the same second, while remaining lexicographically
 * time-sortable and filesystem-safe. Deterministic: the exact same injected clock
 * always yields the exact same id (randomness is never added to hide a collision).
 *
 * Legacy second-resolution ids (`capture-YYYYMMDDTHHMMSSZ`) stay readable forever.
 */
export function buildCaptureId(now = Date.now()) {
  const iso = new Date(now).toISOString();
  return `capture-${iso.replace(/[-:.]/g, "")}`;
}

/**
 * Bounded, content-free provider-call provenance for ONE capture call.
 *
 * Records WHICH contract ran, which executable served it, and the parser's
 * COUNTS — never the payload: no raw text, no result URL, no title, no author,
 * no excerpt and no command preview (which would echo the query). Returns `null`
 * when a provider places no external provider call at all (the offline mock).
 */
export function boundedCallProvenance(query, call) {
  if (!call || typeof call !== "object") return null;
  const parse = call.parse ?? {};
  const count = (value) => (Number.isFinite(value) ? value : null);
  return {
    queryId: query?.queryId ?? null,
    channel: query?.channel ?? null,
    operation: query?.op ?? "search",
    capabilityMapVersion: call.capabilityMapVersion ?? null,
    binary: call.executable?.basename ?? null,
    parse: {
      format: typeof parse.format === "string" ? parse.format : null,
      blocksSeen: count(parse.blocksSeen),
      recordsExtracted: count(parse.recordsExtracted ?? parse.extractedRecords),
      blocksDiscarded: count(parse.blocksDiscarded),
      outputBytes: count(parse.outputBytes ?? call.bytes),
    },
    spawned: call.spawned === true,
    unavailable: call.unavailable === true,
  };
}

/**
 * Capture-id shape, newest first: millisecond (`...SSmmmZ`) or legacy second
 * (`...SSZ`). Both parse; nothing older is ever rewritten.
 */
export const CAPTURE_ID_PATTERN = /^capture-\d{8}T\d{6}(?:\d{3})?Z$/;

/** A syntactically valid capture id (millisecond or legacy second resolution). */
export function isValidCaptureId(captureId) {
  return typeof captureId === "string" && CAPTURE_ID_PATTERN.test(captureId);
}

/** The day bucket a capture id belongs to (UTC). Works for ms and second ids. */
export function captureDayOf(captureId) {
  const match = /^capture-(\d{4})(\d{2})(\d{2})T/.exec(String(captureId ?? ""));
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

/* ----------------------------------------------------------------------------
 * Provenance (authoritative = the provider, never the record array)
 * --------------------------------------------------------------------------*/

/**
 * Synthetic provenance declared by a provider name.
 *
 *   mock          -> true  (the deterministic synthetic fixture provider)
 *   any real one  -> false (e.g. `agent-reach`)
 *   unknown/empty -> null  (caller must fall back to the stored manifest value)
 *
 * Returned as a value so `[].every(...)` can never stand in for provider truth:
 * an EMPTY real capture is still real (`false`), and an empty mock capture is
 * still synthetic (`true`).
 */
export function syntheticIntelligenceForProvider(provider) {
  if (provider === null || provider === undefined || String(provider).trim().length === 0) return null;
  return String(provider) === INTELLIGENCE_PROVIDER.MOCK;
}

/**
 * Resolve the synthetic provenance of a frozen manifest.
 *
 * `stored` is the value written at capture time (historical provenance, never
 * rewritten). `corrected` is what the provider implies. `effective` prefers the
 * provider and falls back to the stored value only when the provider is unknown,
 * so a legacy zero-record real capture is no longer displayed as SYNTHETIC while
 * its immutable bytes keep their original value.
 */
export function resolveCaptureSyntheticProvenance(manifest) {
  const stored = manifest?.syntheticIntelligence === true;
  const corrected = syntheticIntelligenceForProvider(manifest?.provider);
  return Object.freeze({
    stored,
    corrected,
    effective: corrected === null ? stored : corrected,
    source: corrected === null ? "manifest" : "provider",
    legacyMismatch: corrected !== null && corrected !== stored,
  });
}

export function captureDirFor(root, captureId) {
  const day = captureDayOf(captureId);
  if (!day) throw new Error(`cannot derive a day bucket from capture id '${captureId}'`);
  return path.join(root, day, captureId);
}

/** The digested subject of a capture manifest (everything but the digest). */
export function captureManifestSubject(manifest) {
  const subject = { ...(manifest ?? {}) };
  delete subject.manifestDigest;
  return subject;
}

export function captureManifestDigest(manifest) {
  return digestOf(captureManifestSubject(manifest));
}

export function withCaptureManifestDigest(manifest) {
  const next = { ...manifest };
  next.manifestDigest = captureManifestDigest(manifest);
  return next;
}

async function writeJson(target, value) {
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/* ============================================================================
 * Execution
 * ==========================================================================*/

/**
 * Execute ONE capture.
 *
 * @param {{
 *   root: string,
 *   config: object,
 *   candidates?: object[],
 *   querySetId?: string,
 *   requestedQuery?: string|null,
 *   provider?: string|null,
 *   now?: number,
 *   env?: object,
 *   projectRoot?: string,
 *   spawn?: Function|null,
 *   executor?: Function|null,
 *   budget?: object|null,
 * }} options
 */
export async function runCapture({
  root,
  config,
  candidates = [],
  querySetId = REACH_QUERY_SET_ID,
  requestedQuery = null,
  provider = null,
  now = Date.now(),
  env = process.env,
  projectRoot = process.cwd(),
  spawn = null,
  executor = null,
  budget = null,
} = {}) {
  if (!root) throw new Error("runCapture requires a capture root");
  const providerName = provider ?? config?.provider;
  if (providerName === INTELLIGENCE_PROVIDER.DISABLED || providerName === undefined || providerName === null) {
    throw new DisabledIntelligenceProviderError(
      "capture refused: the intelligence provider is DISABLED. Pass `--provider mock` (offline fixture) or `--provider agent-reach` (read-only adapter).",
    );
  }

  const plan = assertCanonicalQueryPlan(
    buildQueryPlan({ candidates, querySetId, channels: config?.channels ?? null }),
    { requestedQuery },
  );

  // OPERATION-AWARE PREFLIGHT. Before a single upstream call is placed (and
  // before any capture directory is created), the EXACT rendered query plan is
  // resolved against the frozen capability map at (operation, channel) precision.
  // A plan that needs a locally-missing executable fails closed here: zero
  // upstream calls, no partial capture artifact, no install, no fallback backend.
  // Runtime failures AFTER a successful preflight remain legitimate capture
  // failures.
  if (providerName === INTELLIGENCE_PROVIDER.AGENT_REACH) {
    const readiness = evaluateReachPlanReadiness(plan, {
      reachBin: config?.reachBin ?? null,
      projectRoot,
      env: sanitizeReachEnv(env),
      // The preflight and the runtime call must agree on the CONTRACT: a new
      // capture is resolved against the same versioned capability map the
      // adapter will launch (never a silently different one).
      capabilityMap: REACH_ACTIVE_CAPABILITY_MAP,
    });
    if (!readiness.ready) throw new ReachPlanUnavailableError(readiness);
  }

  const resolved = executor
    ? { name: providerName, deterministic: providerName === INTELLIGENCE_PROVIDER.MOCK, execute: executor, syntheticIntelligence: providerName === INTELLIGENCE_PROVIDER.MOCK }
    : resolveIntelligenceProvider({ provider: providerName, config, env, projectRoot, spawn });

  const captureId = buildCaptureId(now);
  const dir = captureDirFor(root, captureId);
  const capturedAt = new Date(now).toISOString();

  // Refuse to touch an existing capture: never overwrite frozen evidence.
  const existing = await readdir(dir).catch(() => null);
  if (existing !== null) throw new CaptureExistsError(captureId);

  // ONE call budget for the whole capture: the adapter can never place an
  // unbounded number of provider calls, whatever the query plan contains.
  const callBudget = budget ?? createReachBudget(config?.maxCalls ?? 1);

  const records = [];
  const channelFiles = new Map();
  const health = {};
  const failures = [];
  const timeouts = [];
  // PROVIDER-CALL PROVENANCE (Phase 5G.1c): bounded parser diagnostics per call.
  // Counts, identifiers and flags only — never raw text, a URL, a title, an
  // author or an excerpt (see `boundedCallProvenance`).
  const providerCalls = [];
  let calls = 0;

  for (const query of plan.queries) {
    const channelState = (health[query.channel] ??= {
      channel: query.channel,
      status: "ok",
      calls: 0,
      records: 0,
      failures: 0,
      timeouts: 0,
      lastError: null,
    });
    let outcome;
    try {
      calls += 1;
      channelState.calls += 1;
      // The plan owns the read-only operation: a `read` template renders ONE
      // deterministic URL, a `search` template renders a keyword query. Nothing
      // here can become a write, and the provider re-validates both slots.
      outcome = await resolved.execute({
        op: query.op ?? "search",
        channel: query.channel,
        query: query.query,
        url: query.op === "read" ? query.query : undefined,
        limit: config?.maxResults ?? 10,
        now,
        budget: callBudget,
      });
    } catch (error) {
      outcome = { ok: false, records: [], error: String(error?.message ?? error) };
    }

    const provenance = boundedCallProvenance(query, outcome?.call ?? null);
    if (provenance) providerCalls.push(provenance);

    if (!outcome?.ok) {
      const message = String(outcome?.error ?? "provider call failed");
      channelState.status = /timed out|timeout/i.test(message) ? "timeout" : "error";
      channelState.failures += 1;
      channelState.lastError = message;
      failures.push({ queryId: query.queryId, channel: query.channel, query: query.query, error: message });
      if (channelState.status === "timeout") timeouts.push({ queryId: query.queryId, channel: query.channel, error: message });
      continue;
    }

    for (const raw of outcome.records ?? []) {
      const record = normalizeRecord({
        raw,
        context: {
          captureId,
          capturedAt,
          channel: query.channel,
          backend: resolved.name ?? providerName,
          queryId: query.queryId,
          query: query.query,
          sourceVersion: raw?.sourceVersion ?? resolved.version ?? null,
          agentReachVersion: config?.agentReach?.release ?? null,
          backendVersion: outcome.backendVersion ?? resolved.agentReachVersion ?? null,
          syntheticIntelligence: outcome.syntheticIntelligence === true,
        },
      });
      records.push(record);
      channelState.records += 1;
      const list = channelFiles.get(query.channel) ?? [];
      list.push(record);
      channelFiles.set(query.channel, list);
    }
  }

  const perChannelDigests = {};
  for (const [channel, list] of channelFiles) {
    perChannelDigests[channel] = digestOf(list.map((record) => record.normalizedDigest).sort());
  }
  const recordsDigest = digestOf(records.map((record) => record.normalizedDigest).sort());

  // Provenance comes from the PROVIDER, never from the record array. `.every()`
  // over an empty array is `true`, which is exactly how a zero-record real
  // capture used to be mislabelled synthetic. When records DO exist, their flags
  // may never contradict the provider: an impossible/mixed provenance fails
  // closed instead of being silently relabelled.
  const providerSyntheticIntelligence = resolved.syntheticIntelligence === true;
  const contradictoryRecords = records.filter(
    (record) => record.syntheticIntelligence !== providerSyntheticIntelligence,
  );
  if (contradictoryRecords.length > 0) {
    throw new IntelligenceProvenanceError(providerName, providerSyntheticIntelligence, contradictoryRecords.length);
  }

  const manifest = withCaptureManifestDigest({
    schemaVersion: CAPTURE_SCHEMA_VERSION,
    phase: INTELLIGENCE_PHASE,
    captureSchemaVersion: CAPTURE_SCHEMA_VERSION,
    // The frozen manifest PINS the transform that interprets these bytes, so a
    // later change to features.mjs can never silently reinterpret this capture.
    // Explicit and versioned — never "latest".
    featureVersion: DEFAULT_FEATURE_VERSION,
    captureId,
    paperOnly: true,
    readOnly: true,
    shadowOnly: true,
    finalized: true,
    immutable: true,
    provider: providerName,
    providerDeterministic: resolved.deterministic === true,
    syntheticIntelligence: providerSyntheticIntelligence,
    // CAPABILITY-CONTRACT PROVENANCE (Phase 5G.1b): which versioned capability
    // map bounded this capture. `null` means the provider uses no external
    // capability map at all (the offline mock). Historical manifests are never
    // rewritten; this field is additive on schema 2.
    capabilityMapVersion: resolved.capabilityMapVersion ?? null,
    agentReach: { ...AGENT_REACH_PIN },
    evolveCommit: readEvolveCommit(),
    mode: config?.mode ?? "shadow",
    enabledChannels: [...(config?.channels ?? [])],
    health,
    queries: {
      querySetId: plan.querySetId,
      querySetVersion: plan.version ?? REACH_QUERY_SET_VERSION,
      count: plan.queries.length,
      channels: [...plan.channels],
      definitions: plan.queries,
    },
    counts: {
      calls,
      records: records.length,
      channels: channelFiles.size,
      failures: failures.length,
      timeouts: timeouts.length,
    },
    failures,
    timeouts,
    providerCalls,
    startedAt: capturedAt,
    endedAt: new Date(Date.now()).toISOString(),
    finalizedAt: new Date(Date.now()).toISOString(),
    limits: { timeoutMs: config?.timeoutMs ?? null, maxCalls: config?.maxCalls ?? null, maxResults: config?.maxResults ?? null, maxBytes: config?.maxBytes ?? null },
    digests: {
      recordsDigest,
      perChannel: perChannelDigests,
      queryDefinitionsDigest: digestOf(plan.queries),
    },
    note:
      "PAPER ONLY / READ-ONLY capture. Frozen evidence: replay reads these bytes and never re-queries the internet. " +
      "Social observations can be noisy, duplicated or manipulated; nothing here may influence trading, evolution, scoring, gates or replication.",
  });

  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, CAPTURE_RECORDS_FILE), records.map((record) => JSON.stringify(record)).join("\n") + (records.length > 0 ? "\n" : ""), "utf8");
  await writeJson(path.join(dir, CAPTURE_QUERIES_FILE), { querySetId: plan.querySetId, version: plan.version, queries: plan.queries });
  await writeJson(path.join(dir, CAPTURE_HEALTH_FILE), { captureId, health, failures, timeouts, counts: manifest.counts });
  for (const [channel, list] of channelFiles) {
    await writeFile(path.join(dir, `${channel}.ndjson`), list.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");
  }
  // The manifest is written LAST: it is the finalization record.
  await writeJson(path.join(dir, CAPTURE_MANIFEST_FILE), manifest);

  return { captureId, dir, manifest, records, health, failures, timeouts, calls, provider: providerName };
}

/** The EVOLVE commit the capture was taken from (read-only, best effort). */
export function readEvolveCommit({ cwd = process.cwd() } = {}) {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .trim()
      .slice(0, 40);
  } catch {
    return null;
  }
}

/* ============================================================================
 * Read-only access
 * ==========================================================================*/

export async function readCaptureManifest(root, captureId) {
  try {
    return JSON.parse(await readFile(path.join(captureDirFor(root, captureId), CAPTURE_MANIFEST_FILE), "utf8"));
  } catch {
    return null;
  }
}

/** Every capture id under a root, sorted (read-only). */
export async function listCaptures(root) {
  const out = [];
  let days = [];
  try {
    days = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch {
    return out;
  }
  for (const day of days) {
    let names = [];
    try {
      names = (await readdir(path.join(root, day), { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && entry.name.startsWith("capture-"))
        .map((entry) => entry.name)
        .sort();
    } catch {
      continue;
    }
    for (const name of names) out.push({ captureId: name, day });
  }
  return out;
}

/** Load a capture's records (read-only). */
export async function loadCaptureRecords(root, captureId) {
  try {
    const text = await readFile(path.join(captureDirFor(root, captureId), CAPTURE_RECORDS_FILE), "utf8");
    return text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

/**
 * Verify a capture against its own manifest: the records files match the
 * recorded digests, and the manifest digest is self-consistent. Read-only.
 */
export async function verifyCapture(root, captureId) {
  const manifest = await readCaptureManifest(root, captureId);
  if (!manifest) return { ok: false, captureId, reason: "no capture manifest" };
  const records = await loadCaptureRecords(root, captureId);
  const recordsDigest = digestOf(records.map((record) => record.normalizedDigest).sort());
  const perChannel = {};
  for (const [channel] of Object.entries(manifest.digests?.perChannel ?? {})) {
    const list = records.filter((record) => record.channel === channel);
    perChannel[channel] = digestOf(list.map((record) => record.normalizedDigest).sort());
  }
  const manifestOk = withCaptureManifestDigest(manifest).manifestDigest === manifest.manifestDigest;
  const recordsOk = recordsDigest === manifest.digests?.recordsDigest;
  const channelsOk = Object.entries(manifest.digests?.perChannel ?? {}).every(([channel, digest]) => perChannel[channel] === digest);
  const verified = records.map((record) => verifyRecord(record));
  const recordDigestsOk = verified.every((row) => row.ok);
  return {
    ok: manifestOk && recordsOk && channelsOk && recordDigestsOk,
    captureId,
    manifestDigest: manifest.manifestDigest,
    recomputedManifestDigest: captureManifestDigest(manifest),
    recordsDigest,
    expectedRecordsDigest: manifest.digests?.recordsDigest ?? null,
    manifestOk,
    recordsOk,
    channelsOk,
    recordDigestsOk,
    recordCount: records.length,
    immutable: manifest.immutable === true,
    finalized: manifest.finalized === true,
    reason: manifestOk && recordsOk && channelsOk && recordDigestsOk ? null : "capture bytes do not match the frozen manifest",
  };
}

export default runCapture;
