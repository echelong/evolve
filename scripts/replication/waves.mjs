/**
 * Phase 5C.2/5C.3 — replication WAVES (PAPER ONLY).
 *
 * Phase 5C evaluates one frozen research-cohort A/B experiment against multiple
 * independent REAL market datasets. Phase 5C.1 made the CLI an exclusive
 * action-per-invocation tool. Phase 5C.2 adds *waves*: a prospective set of
 * datasets is declared, by name, BEFORE anything is evaluated — so a new wave is
 * never silently mixed with an already-completed one by `--datasets auto`.
 *
 * Phase 5C.3 adds CANONICAL PER-WAVE FREEZES. A wave manifest now records
 * WHERE its own freeze lives (`freezePath`), the full freeze digest it ran
 * under, and the `evaluationContractDigest` that decides cross-wave
 * comparability (`./contract.mjs`). Wave 1 keeps its historical freeze
 * (`.evolve/replication/phase5c-freeze.json`, commit `e7940e0…`) as immutable
 * evidence; Wave 2 is frozen against the commit that executes Wave 2, in its own
 * file (`freezes/wave-2.json`). Different full freeze digests, one evaluation
 * contract: that is what makes the waves comparable without weakening either
 * freeze.
 *
 * WHY WAVES EXIST
 * ---------------
 * `--datasets auto` selects EVERY eligible CLEAN dataset in the registry. Once a
 * second wave of captures exists, `auto` would re-select the first wave's
 * datasets too, silently turning a prospective replication into a rerun of
 * already-published evidence. A wave manifest fixes membership up front:
 *
 *   * the dataset ids and their fingerprints are PINNED, not discovered;
 *   * membership is chosen WITHOUT any outcome, metric, Arena result or rank —
 *     it is performance-blind by construction (no function here can see a
 *     strategy metric);
 *   * a dataset evaluated in an earlier COMPLETED wave is REJECTED here;
 *   * a stale/altered fingerprint, a synthetic/incomplete/contaminated dataset,
 *     a temporal overlap or a cohort/freeze mismatch all FAIL CLOSED.
 *
 * DIGEST SEMANTICS
 * ----------------
 * `manifestDigest` is deterministic. It is computed over every DEFINITION field
 * with the clock and lifecycle bookkeeping removed (`createdAt`, `manifestDigest`,
 * `status`, `notes`, `updatedAt`). Rebuilding the same logical wave at a
 * different second - or after its status flips from PLANNED to COMPLETED - yields
 * the SAME digest, while changing membership, a fingerprint, a cohort digest or
 * the freeze digest changes it. That digest is what a wave-aware replication id
 * binds to, so a stable rerun of the same wave definition reproduces the same
 * replication identity.
 *
 * HISTORICAL WAVE
 * ---------------
 * Wave 1 was already evaluated (canonical replication `rep-66884de4e460`) before
 * this phase existed. It is represented here as a READ-ONLY historical manifest
 * derived from those existing facts: it points at the canonical replication id
 * and is never re-run. Phase 5C.2 does not rewrite Wave 1, its freeze, its
 * cohorts or its results.
 *
 * PAPER ONLY. No wallet, no signing, no write-RPC, no provider call, and no
 * Phase 5D / Jev participation whatsoever.
 */

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { canonicalJson, digestOf } from "../lib/hash.mjs";
import {
  DATASET_CLASS,
  DATASET_ROLE,
  FREEZE_FILE,
  LEAKAGE_CLASS,
} from "./constants.mjs";
import { evaluationContractDigest } from "./contract.mjs";
import { temporalOverlap } from "./datasets.mjs";

export const WAVE_SCHEMA_VERSION = 1;
export const WAVE_PHASE = "5C.2";

/** Sub-directory (under the replication root) that holds wave manifests. */
export const WAVES_DIR = "waves";
export const WAVE_MANIFEST_SUFFIX = ".json";

/** Sub-directory (under the replication root) that holds PER-WAVE freeze artifacts. */
export const FREEZES_DIR = "freezes";

/** What a wave's `freezePath` must look like: relative, inside the root, no escapes. */
export function isSafeFreezePath(freezePath) {
  if (typeof freezePath !== "string" || freezePath.trim().length === 0) return false;
  const value = freezePath.trim();
  if (path.isAbsolute(value)) return false;
  if (value.split(/[\\/]/).some((part) => part === ".." || part === ".")) return false;
  if (value.includes("\u0000")) return false;
  return value.endsWith(".json");
}

/** Resolve a wave's freeze path (relative to the replication root) to a file path. */
export function resolveWaveFreezePath(baseDir, freezePath) {
  if (!isSafeFreezePath(freezePath)) return null;
  return path.join(baseDir, freezePath.trim());
}

/** Wave lifecycle. Never a winner rating — a wave either ran or it did not. */
export const WAVE_STATUS = Object.freeze({
  PLANNED: "PLANNED",
  RUNNING: "RUNNING",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
});

/**
 * Fields that NEVER participate in the manifest digest: the wall clock, the
 * digest itself, lifecycle bookkeeping, prose notes, and the derived
 * replication id (which is a function of the digest, not an input to it).
 */
export const WAVE_DIGEST_EXCLUDED_FIELDS = Object.freeze([
  "createdAt",
  "updatedAt",
  "manifestDigest",
  "status",
  "notes",
  "replicationId",
]);

/* ============================================================================
 * Predeclared wave definitions
 *
 * These are the canonical, immutable wave definitions. They are the SOURCE of
 * the on-disk manifests; validation re-derives the manifest from the definition
 * and compares digests, so a hand-edited manifest is detectable.
 * ==========================================================================*/

const CANONICAL_FREEZE_DIGEST = "4959974d1b78635e63c0d9038c582c9ceb5a7411366d9c95c82e7ee3bac3f500";
const CANONICAL_MOCK_COHORT_DIGEST = "b26d63a2a0787e954ed7e4e63e668fe4664e58059508145345214facc4e12858";
const CANONICAL_DEEPSEEK_COHORT_DIGEST = "13c7c93d707b26f8b92042d488ff0a63f5de3f9f81b8145be4eac7a70cc550a8";

/**
 * The Wave 1 EVALUATION CONTRACT digest, derived from the STORED historical
 * Wave 1 freeze (never regenerated). Every canonical wave must match it before
 * two waves may be combined; Wave 2's manifest pins it BEFORE its own freeze
 * exists, so a Wave 2 freeze built from drifted evaluator semantics is refused
 * at freeze-write time rather than discovered after a run.
 */
export const CANONICAL_EVALUATION_CONTRACT_DIGEST = "4cf8ac1fa7db290acadeccf6043ec34c3239f8e3f848e9e50d8560826de85052";

/** The historical Wave 1 freeze file (root of the replication dir; immutable). */
export const CANONICAL_HISTORICAL_FREEZE_PATH = FREEZE_FILE;

/** The canonical Wave 1 replication (already evaluated; never re-run). */
export const CANONICAL_WAVE_1_REPLICATION_ID = "rep-66884de4e460";

export const WAVE_1_DATASET_IDS = Object.freeze([
  "session-20260918T132822Z-live",
  "session-20260918T143827Z-live",
  "session-20260918T153954Z-live",
]);

export const WAVE_2_DATASET_IDS = Object.freeze([
  "session-20260919T040641Z-live",
  "session-20260919T051349Z-live",
  "session-20260919T062122Z-live",
]);

/** The three Wave 2 captures' pinned fingerprints (declared before evaluation). */
export const WAVE_2_DATASET_FINGERPRINTS = Object.freeze({
  "session-20260919T040641Z-live": "2b3652d11390af1269891dcfcf9bf029e5ed110bf05e6982046016d3ea185bbb",
  "session-20260919T051349Z-live": "c77ba361b956e54afd721997daafd4793117b0e8c05aff087e8d70b180afc81f",
  "session-20260919T062122Z-live": "288a795af3e88019cf1a96f2ebdc577661d1f8101643c5bbc81f9771137dc587",
});

/** Pinned Wave 1 fingerprints, read from the canonical run's own manifest. */
export const WAVE_1_DATASET_FINGERPRINTS = Object.freeze({
  "session-20260918T132822Z-live": "d47d4d1750c9e6e9bafce9dbbaec3cd8694a6ef2c92f587a0ddabd28de431e8b",
  "session-20260918T143827Z-live": "2c29e28fea9bc5dc4dddbea245d88c836a9c5f2356f7dc871eb2831d1bc9eeb9",
  "session-20260918T153954Z-live": "d0f1e43d1d89efdcfed454fb5acd3d4b263c7dd0ffd4582ba6d8d50d89c15551",
});

/**
 * The predeclared wave definitions. Frozen so nothing can mutate the declared
 * membership at runtime.
 */
export const WAVE_DEFINITIONS = Object.freeze([
  Object.freeze({
    version: 1,
    waveId: "wave-1",
    identityMode: "historical",
    historical: true,
    replicationId: CANONICAL_WAVE_1_REPLICATION_ID,
    freezePath: CANONICAL_HISTORICAL_FREEZE_PATH,
    freezeDigest: CANONICAL_FREEZE_DIGEST,
    evaluationContractDigest: CANONICAL_EVALUATION_CONTRACT_DIGEST,
    mockCohortDigest: CANONICAL_MOCK_COHORT_DIGEST,
    deepseekCohortDigest: CANONICAL_DEEPSEEK_COHORT_DIGEST,
    datasetIds: WAVE_1_DATASET_IDS,
    datasetFingerprints: WAVE_1_DATASET_FINGERPRINTS,
    priorWaveIds: Object.freeze([]),
    excludedDatasetIds: Object.freeze([]),
    jevInvolved: false,
    providerCallsRequired: false,
    status: WAVE_STATUS.COMPLETED,
    notes: Object.freeze([
      "HISTORICAL WAVE — already evaluated as replication rep-66884de4e460 before Phase 5C.2 existed.",
      "Canonical against its own historical freeze (.evolve/replication/phase5c-freeze.json, commit e7940e0…); never re-run and never rewritten.",
      "Represented read-only from existing facts. Phase 5C.2 never re-runs and never rewrites Wave 1.",
    ]),
  }),
  Object.freeze({
    version: 1,
    waveId: "wave-2",
    identityMode: "wave",
    historical: false,
    replicationId: null,
    // Phase 5C.3: Wave 2 is canonical against ITS OWN freeze, which can only be
    // written after the implementing commit exists. Until then the freeze digest
    // is null and every canonical command fails closed.
    freezePath: `${FREEZES_DIR}/wave-2.json`,
    freezeDigest: null,
    evaluationContractDigest: CANONICAL_EVALUATION_CONTRACT_DIGEST,
    mockCohortDigest: CANONICAL_MOCK_COHORT_DIGEST,
    deepseekCohortDigest: CANONICAL_DEEPSEEK_COHORT_DIGEST,
    datasetIds: WAVE_2_DATASET_IDS,
    datasetFingerprints: WAVE_2_DATASET_FINGERPRINTS,
    priorWaveIds: Object.freeze(["wave-1"]),
    excludedDatasetIds: WAVE_1_DATASET_IDS,
    jevInvolved: false,
    providerCallsRequired: false,
    status: WAVE_STATUS.PLANNED,
    notes: Object.freeze([
      "PROSPECTIVE WAVE — membership declared before any Wave 2 evaluation.",
      "Replicates the SAME frozen Mock and frozen DeepSeek cohorts against three new, untouched REAL captures.",
      "Membership is performance-blind: no outcome, Arena result or metric informed this list.",
      "Wave 1 ids are explicitly excluded; they must never appear in a Wave 2 plan or run.",
      "Phase 5C.3: canonical against its own per-wave freeze (freezes/wave-2.json), written AFTER the implementing commit is pushed; the historical Wave 1 freeze is never rewritten.",
      "Phase 5D / Jev does not participate in this wave.",
    ]),
  }),
]);

/** Look up a predeclared wave definition by id (null when unknown). */
export function waveDefinitionFor(waveId) {
  const id = waveId === null || waveId === undefined ? null : String(waveId);
  return WAVE_DEFINITIONS.find((definition) => definition.waveId === id) ?? null;
}

/* ============================================================================
 * Build + digest
 * ==========================================================================*/

/**
 * Build a wave manifest from a predeclared definition. The clock and the
 * lifecycle status are recorded but never digested.
 *
 * @param {object} definition a `WAVE_DEFINITIONS` entry
 * @param {{ createdAt?: number, status?: string, replicationId?: string|null }} [options]
 */
export function buildWaveManifest(definition, { createdAt = Date.now(), status = null, replicationId } = {}) {
  if (!definition?.waveId) throw new Error("buildWaveManifest requires a wave definition");
  const manifest = {
    schemaVersion: WAVE_SCHEMA_VERSION,
    phase: WAVE_PHASE,
    paperOnly: true,
    version: definition.version,
    waveId: definition.waveId,
    identityMode: definition.identityMode,
    historical: definition.historical === true,
    replicationId: replicationId !== undefined ? replicationId : (definition.replicationId ?? null),
    freezePath: definition.freezePath ?? null,
    freezeDigest: definition.freezeDigest ?? null,
    evaluationContractDigest: definition.evaluationContractDigest ?? null,
    mockCohortDigest: definition.mockCohortDigest,
    deepseekCohortDigest: definition.deepseekCohortDigest,
    cohortDigests: {
      mock: definition.mockCohortDigest,
      deepseek: definition.deepseekCohortDigest,
    },
    datasetIds: [...(definition.datasetIds ?? [])],
    datasetFingerprints: { ...(definition.datasetFingerprints ?? {}) },
    priorWaveIds: [...(definition.priorWaveIds ?? [])],
    excludedDatasetIds: [...(definition.excludedDatasetIds ?? [])],
    jevInvolved: definition.jevInvolved === true,
    providerCallsRequired: definition.providerCallsRequired === true,
    status: status ?? definition.status ?? WAVE_STATUS.PLANNED,
    notes: [...(definition.notes ?? [])],
    createdAt: new Date(createdAt).toISOString(),
  };
  return withWaveManifestDigest(manifest);
}

/**
 * Is this wave bound to its own freeze artifact yet?
 *
 * A wave without a bound freeze cannot be planned, run or summarized
 * canonically: `freezeDigest` is null until `--write-freeze --wave <id>` writes
 * the per-wave freeze and binds the manifest to it (which recomputes the
 * manifest digest and the replication id).
 */
export function waveFreezeBound(manifest) {
  return Boolean(
    manifest &&
      typeof manifest.freezeDigest === "string" &&
      manifest.freezeDigest.length > 0 &&
      typeof manifest.freezePath === "string" &&
      manifest.freezePath.length > 0,
  );
}

/** A historical wave is permanent evidence: it is never re-run or rewritten. */
export function isHistoricalWave(manifest) {
  return manifest?.historical === true || manifest?.identityMode === "historical";
}

/**
 * Bind a freeze artifact to a wave manifest (Phase 5C.3).
 *
 * Pure: it returns a NEW manifest whose `freezePath` / `freezeDigest` /
 * `evaluationContractDigest` are bound and whose manifest digest + replication
 * id are recomputed. Used by `--write-freeze --wave <id>`; the caller persists
 * it explicitly with `overwrite: true` (a bound wave is a DIFFERENT definition
 * from its unbound skeleton, which is exactly why the digest changes).
 *
 * @param {{
 *   manifest: object,
 *   freezePath?: string|null,
 *   freezeDigest: string,
 *   evaluationContractDigest?: string|null,
 *   replicationId?: string|null,
 *   status?: string|null,
 * }} options
 */
export function bindWaveManifest({
  manifest,
  freezePath = null,
  freezeDigest,
  evaluationContractDigest: contractDigest = null,
  replicationId = null,
  status = null,
} = {}) {
  if (!manifest?.waveId) throw new Error("bindWaveManifest requires a wave manifest");
  if (typeof freezeDigest !== "string" || freezeDigest.length === 0) {
    throw new Error("bindWaveManifest requires a freeze digest");
  }
  const next = {
    ...manifest,
    freezePath: freezePath ?? manifest.freezePath ?? null,
    freezeDigest,
    evaluationContractDigest: contractDigest ?? manifest.evaluationContractDigest ?? null,
    replicationId: replicationId ?? manifest.replicationId ?? null,
    status: status ?? manifest.status ?? WAVE_STATUS.PLANNED,
  };
  return withWaveManifestDigest(next);
}

/** The subject a wave manifest digest is computed over: everything but the clock/lifecycle. */
export function waveManifestDigestSubject(manifest) {
  const subject = { ...(manifest ?? {}) };
  for (const field of WAVE_DIGEST_EXCLUDED_FIELDS) delete subject[field];
  return subject;
}

/** Deterministic, clock-independent digest of a wave manifest. */
export function waveManifestDigest(manifest) {
  return digestOf(waveManifestDigestSubject(manifest));
}

/** Attach `manifestDigest` to a wave manifest (non-mutating). */
export function withWaveManifestDigest(manifest) {
  const next = { ...manifest };
  next.manifestDigest = waveManifestDigest(manifest);
  return next;
}

/* ============================================================================
 * Persistence
 * ==========================================================================*/

export function wavesDirFor(baseDir) {
  return path.join(baseDir, WAVES_DIR);
}

export function waveManifestPath(baseDir, waveId) {
  return path.join(wavesDirFor(baseDir), `${waveId}${WAVE_MANIFEST_SUFFIX}`);
}

async function writeJsonAtomic(target, value) {
  await mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  const { rename } = await import("node:fs/promises");
  await rename(tmp, target);
}

/** Persist a wave manifest. Never silently replaces a different definition. */
export async function writeWaveManifest(baseDir, manifest, { overwrite = false } = {}) {
  if (!baseDir || !manifest?.waveId) throw new Error("writeWaveManifest requires baseDir and a wave manifest");
  const record = withWaveManifestDigest(manifest);
  const existing = await readWaveManifest(baseDir, record.waveId);
  if (existing && existing.manifestDigest !== record.manifestDigest && overwrite !== true) {
    throw new Error(
      `wave '${record.waveId}' already exists with manifest digest ${String(existing.manifestDigest).slice(0, 12)}; ` +
        `refusing to overwrite with ${String(record.manifestDigest).slice(0, 12)} (pass overwrite to replace explicitly)`,
    );
  }
  await writeJsonAtomic(waveManifestPath(baseDir, record.waveId), record);
  return record;
}

export async function readWaveManifest(baseDir, waveId) {
  try {
    return JSON.parse(await readFile(waveManifestPath(baseDir, waveId), "utf8"));
  } catch {
    return null;
  }
}

/** Every wave manifest under a replication root, sorted by wave id. */
export async function listWaveManifests(baseDir) {
  let names = [];
  try {
    names = (await readdir(wavesDirFor(baseDir))).filter((name) => name.endsWith(WAVE_MANIFEST_SUFFIX)).sort();
  } catch {
    return [];
  }
  const manifests = [];
  for (const name of names) {
    try {
      manifests.push(JSON.parse(await readFile(path.join(wavesDirFor(baseDir), name), "utf8")));
    } catch {
      // An unreadable manifest contributes nothing; callers that need it fail closed.
    }
  }
  return manifests;
}

/**
 * Does a wave manifest still match its PREDECLARED definition? A prospective
 * wave's skeleton may be BOUND (freezePath/freezeDigest/contract digest/
 * replicationId filled in) without changing any of the declared invariants.
 * Everything else must match the definition field-for-field.
 */
export function waveDefinitionMatch({ manifest, definition } = {}) {
  if (!manifest) return { ok: false, checked: false, drifted: ["manifest"] };
  // A wave id with no REGISTERED definition (a purely local fixture) cannot be
  // checked against one; its own manifest-digest self-consistency still holds.
  if (!definition) return { ok: true, checked: false, drifted: [] };
  const drifted = [];
  for (const [key, value] of Object.entries(definition)) {
    const actual = manifest[key] ?? null;
    const declared = value ?? null;
    // A PREDECLARED null is an unbound skeleton slot: binding it later is the
    // documented lifecycle, not drift. A declared non-null value must hold.
    const unboundSlot = declared === null && (key === "freezeDigest" || key === "replicationId");
    // `status` is lifecycle bookkeeping and never part of the frozen definition.
    const lifecycle = key === "status";
    if (unboundSlot || lifecycle) continue;
    if (canonicalJson(actual) !== canonicalJson(declared)) drifted.push(key);
  }
  return { ok: drifted.length === 0, checked: true, drifted };
}

/**
 * Resolve a manifest's declared membership against a registry.
 *
 * A dataset whose fingerprint does not match the PINNED manifest fingerprint is
 * NOT silently included: it is reported as `mismatched` and excluded.
 */
export function waveMembership({ manifest, registry } = {}) {
  const byId = new Map((registry?.records ?? []).map((record) => [record.datasetId, record]));
  const datasets = [];
  const datasetIds = [];
  const unknown = [];
  const mismatched = [];
  for (const id of manifest?.datasetIds ?? []) {
    const record = byId.get(id);
    if (!record) {
      unknown.push(id);
      continue;
    }
    const pinned = manifest?.datasetFingerprints?.[id] ?? null;
    if (pinned && record.fingerprint !== pinned) {
      mismatched.push({ datasetId: id, pinned, actual: record.fingerprint ?? null });
      continue;
    }
    datasets.push(record);
    datasetIds.push(id);
  }
  return { mode: "wave", waveId: manifest?.waveId ?? null, datasets, datasetIds, unknown, mismatched };
}

/** The union of every dataset id declared by prior COMPLETED (or historical) waves. */
export function priorWaveDatasetIds(priorWaves = []) {
  const ids = new Set();
  for (const wave of priorWaves) {
    if (!wave) continue;
    const terminal = wave.status === WAVE_STATUS.COMPLETED || wave.historical === true;
    if (!terminal) continue;
    for (const id of wave.datasetIds ?? []) ids.add(id);
  }
  return [...ids].sort();
}

/* ============================================================================
 * Validation (fail closed)
 * ==========================================================================*/

/**
 * Validate a wave manifest before a wave plan/run/summary is allowed.
 *
 * Pure: reads nothing, executes nothing, and can never see a strategy metric.
 * Every invariant the phase declares is checked and the result is a plain list
 * of failures so the caller can fail closed with an explicit reason.
 *
 * @returns {{ ok: boolean, failures: Array<{check: string, message: string}>, checks: object }}
 */
export function validateWaveManifest({ manifest, registry, frozen = null, cohorts = {}, priorWaves = [] } = {}) {
  const failures = [];
  const record = (check, ok, message) => {
    if (!ok) failures.push({ check, message });
    return ok;
  };
  const checks = {
    manifestPresent: false,
    manifestDigestStable: false,
    definitionMatches: false,
    freezePathSafe: false,
    datasetsUnique: false,
    fingerprintsPinned: false,
    datasetsExist: false,
    datasetsReal: false,
    cleanReplication: false,
    eligible: false,
    noDuplicateFingerprints: false,
    noTemporalOverlap: false,
    noPriorWaveReuse: false,
    wave1Excluded: false,
    mockCohortDigest: false,
    deepseekCohortDigest: false,
    freezeCompatibility: false,
    evaluationContractMatch: false,
    noJevState: false,
    noProviderCall: false,
  };

  if (!record("manifestPresent", Boolean(manifest?.waveId), "no wave manifest")) {
    return { ok: false, failures, checks };
  }
  checks.manifestPresent = true;

  // 0. The manifest is internally consistent: its digest matches its definition.
  checks.manifestDigestStable = record(
    "manifestDigestStable",
    manifest.manifestDigest === waveManifestDigest(manifest),
    "the wave manifest digest does not match its own definition (the manifest was edited)",
  );

  // 0b. The manifest still matches the PREDECLARED definition (a bound skeleton
  // is allowed; a hand-edited membership/fingerprint/cohort pin is not).
  // A manifest whose wave id has no registered definition (a purely local
  // fixture) cannot be checked against one; its own digest self-consistency is
  // already enforced above.
  const definition = waveDefinitionFor(manifest.waveId);
  const definitionMatch = waveDefinitionMatch({ manifest, definition });
  checks.definitionMatches = record(
    "definitionMatches",
    definitionMatch.ok,
    `the stored manifest does not match the predeclared definition of '${manifest.waveId}' (drifted field(s): ${definitionMatch.drifted.join(", ") || "none"})`,
  );

  // 0c. Phase 5C.3: the wave's own freeze path must be a safe relative `.json`.
  checks.freezePathSafe = record(
    "freezePathSafe",
    isSafeFreezePath(manifest.freezePath),
    `the wave manifest records no safe per-wave freezePath (got ${JSON.stringify(manifest.freezePath ?? null)})`,
  );

  const datasetIds = manifest.datasetIds ?? [];
  const pinned = manifest.datasetFingerprints ?? {};
  const excluded = new Set(manifest.excludedDatasetIds ?? []);

  // 1. membership is declared without duplicate ids.
  checks.datasetsUnique = record(
    "datasetsUnique",
    new Set(datasetIds).size === datasetIds.length,
    `the manifest declares a duplicate dataset id: ${datasetIds.join(", ")}`,
  );

  // 2. every declared dataset has a pinned fingerprint; every pin belongs to a declared dataset.
  const pinIds = Object.keys(pinned).sort();
  const declaredIds = [...datasetIds].sort();
  checks.fingerprintsPinned = record(
    "fingerprintsPinned",
    pinIds.length === declaredIds.length && pinIds.every((id, index) => id === declaredIds[index]),
    "every declared dataset must have exactly one pinned fingerprint and vice versa",
  );

  const byId = new Map((registry?.records ?? []).map((r) => [r.datasetId, r]));
  const resolved = [];
  // Each per-dataset check must hold for EVERY declared dataset, so the
  // accumulated check is the AND of the per-dataset results (every individual
  // failure is still recorded in `failures`).
  let allExist = true;
  let allReal = true;
  let allClean = true;
  let allEligible = true;
  let allFingerprints = true;

  for (const id of datasetIds) {
    const r = byId.get(id);
    // 3. the dataset exists in the registry.
    const exists = record("datasetsExist", Boolean(r), `declared dataset ${id} does not exist in the dataset registry`);
    allExist = allExist && exists;
    if (!exists) continue;

    // 4. it is REAL (never synthetic / mixed / invalid).
    allReal = record(
      "datasetsReal",
      r.classification === DATASET_CLASS.REAL,
      `dataset ${id} is ${r.classification}, not REAL`,
    ) && allReal;

    // 5. it is CLEAN_REPLICATION (no development / contamination / unknown provenance).
    const leakage = registry?.leakage?.[id]?.overall ?? null;
    allClean = record(
      "cleanReplication",
      leakage === LEAKAGE_CLASS.CLEAN_REPLICATION,
      `dataset ${id} has leakage class ${leakage}, not CLEAN_REPLICATION`,
    ) && allClean;

    // 6. it satisfies the existing Phase 5C eligibility criteria and is a REPLICATION dataset.
    const eligible = registry?.eligibility?.[id]?.eligible === true;
    const role = registry?.roles?.[id] ?? null;
    allEligible = record(
      "eligible",
      eligible && role === DATASET_ROLE.REPLICATION,
      `dataset ${id} is not an eligible ${DATASET_ROLE.REPLICATION} dataset (role ${role}): ${(registry?.eligibility?.[id]?.reasons ?? []).join("; ") || "no reason recorded"}`,
    ) && allEligible;

    // 7. the live fingerprint matches the PINNED manifest fingerprint exactly.
    allFingerprints = record(
      "fingerprintsPinned",
      r.fingerprint === pinned[id],
      `dataset ${id} fingerprint ${String(r.fingerprint).slice(0, 12)}… does not match the pinned ${String(pinned[id]).slice(0, 12)}…`,
    ) && allFingerprints;

    resolved.push(r);
  }

  checks.datasetsExist = allExist;
  checks.datasetsReal = allReal;
  checks.cleanReplication = allClean;
  checks.eligible = allEligible;
  checks.fingerprintsPinned = checks.fingerprintsPinned && allFingerprints;

  // 8. no duplicate fingerprints WITHIN the wave (a fingerprint counts once).
  const fpSeen = new Map();
  let duplicateFp = false;
  for (const [id, fp] of Object.entries(pinned)) {
    if (fpSeen.has(fp)) duplicateFp = true;
    fpSeen.set(fp, id);
  }
  checks.noDuplicateFingerprints = record(
    "noDuplicateFingerprints",
    !duplicateFp && fpSeen.size === new Set(Object.values(pinned)).size,
    "two Wave datasets share a fingerprint",
  );

  // 9. zero temporal overlap within the wave.
  let overlapConflict = null;
  for (let i = 0; i < resolved.length && !overlapConflict; i += 1) {
    for (let j = i + 1; j < resolved.length; j += 1) {
      const row = temporalOverlap(resolved[i], resolved[j]);
      if (row && row.independent !== true) {
        overlapConflict = `${resolved[i].datasetId} overlaps ${resolved[j].datasetId}`;
        break;
      }
    }
  }
  checks.noTemporalOverlap = record("noTemporalOverlap", !overlapConflict, `temporal overlap inside the wave: ${overlapConflict}`);

  // 10. no dataset may be reused from an already-completed prior wave.
  const priorIds = new Set(priorWaveDatasetIds(priorWaves));
  const reused = datasetIds.filter((id) => priorIds.has(id));
  checks.noPriorWaveReuse = record(
    "noPriorWaveReuse",
    reused.length === 0,
    `dataset(s) already evaluated in a completed prior wave: ${reused.join(", ")}`,
  );

  // 11. prior waves are explicitly excluded, and nothing is both included and excluded.
  const priorDeclared = priorWaveIdsOf(priorWaves);
  const includesExcluded = datasetIds.filter((id) => excluded.has(id));
  const missingExclusions = [...priorIds].filter((id) => !excluded.has(id));
  checks.wave1Excluded = record(
    "wave1Excluded",
    includesExcluded.length === 0 && missingExclusions.length === 0,
    includesExcluded.length > 0
      ? `wave declares and also excludes ${includesExcluded.join(", ")}`
      : `prior-wave dataset(s) not explicitly excluded: ${missingExclusions.join(", ")} (prior waves ${priorDeclared.join(", ") || "none"})`,
  );

  // 12/13. the frozen cohort digests must match the manifest pins.
  const cohortMock = cohorts?.mock?.cohortDigest ?? null;
  const cohortDeepseek = cohorts?.deepseek?.cohortDigest ?? null;
  checks.mockCohortDigest = record(
    "mockCohortDigest",
    cohortMock === manifest.mockCohortDigest,
    `frozen mock cohort digest ${cohortMock} does not match the manifest pin ${manifest.mockCohortDigest}`,
  );
  checks.deepseekCohortDigest = record(
    "deepseekCohortDigest",
    cohortDeepseek === manifest.deepseekCohortDigest,
    `frozen deepseek cohort digest ${cohortDeepseek} does not match the manifest pin ${manifest.deepseekCohortDigest}`,
  );

  // 14. freeze / config compatibility.
  const freezeOk =
    Boolean(frozen) &&
    frozen.freezeDigest === manifest.freezeDigest &&
    frozen.paperOnly === true &&
    frozen.replication?.llmCallsRequired === false &&
    frozen.replication?.unit === "dataset";
  checks.freezeCompatibility = record(
    "freezeCompatibility",
    freezeOk,
    `the stored freeze is not compatible with the wave manifest (freeze digest ${
      frozen?.freezeDigest ?? "none"
    }, manifest pin ${manifest.freezeDigest}; the freeze must be paper-only, dataset-level and require no LLM call)`,
  );

  // 14b. Phase 5C.3: the wave's freeze must carry the SAME evaluation contract
  // the manifest pins. This is what makes two differently-frozen waves comparable.
  const contractDigest = frozen ? evaluationContractDigest(frozen) : null;
  checks.evaluationContractMatch = record(
    "evaluationContractMatch",
    Boolean(contractDigest) && contractDigest === manifest.evaluationContractDigest,
    `the wave's freeze evaluation contract ${contractDigest ?? "none"} does not match the manifest pin ${
      manifest.evaluationContractDigest ?? "none"
    } — the wave would not be comparable with the other canonical waves`,
  );

  // 15. no Phase 5D / Jev state participates.
  checks.noJevState = record(
    "noJevState",
    manifest.jevInvolved === false,
    "the wave manifest declares Jev participation — Phase 5D is out of scope for replication",
  );

  // 16. no provider call is needed (the frozen cohorts already exist).
  checks.noProviderCall = record(
    "noProviderCall",
    manifest.providerCallsRequired === false,
    "the wave manifest declares that a research-provider call is still required",
  );

  return { ok: failures.length === 0, failures, checks };
}

function priorWaveIdsOf(priorWaves = []) {
  return priorWaves.map((wave) => wave?.waveId).filter(Boolean).sort();
}

/* ============================================================================
 * Reporting helpers
 * ==========================================================================*/

/** Compact, secret-free view of a wave manifest for JSON output. */
export function describeWaveManifest(manifest) {
  if (!manifest) return null;
  return {
    waveId: manifest.waveId,
    version: manifest.version,
    phase: manifest.phase,
    identityMode: manifest.identityMode,
    historical: manifest.historical === true,
    status: manifest.status,
    manifestDigest: manifest.manifestDigest,
    replicationId: manifest.replicationId ?? null,
    freezePath: manifest.freezePath ?? null,
    freezeDigest: manifest.freezeDigest ?? null,
    freezeBound: waveFreezeBound(manifest),
    evaluationContractDigest: manifest.evaluationContractDigest ?? null,
    cohortDigests: { ...(manifest.cohortDigests ?? {}) },
    datasetIds: [...(manifest.datasetIds ?? [])],
    datasetFingerprints: { ...(manifest.datasetFingerprints ?? {}) },
    priorWaveIds: [...(manifest.priorWaveIds ?? [])],
    excludedDatasetIds: [...(manifest.excludedDatasetIds ?? [])],
    jevInvolved: manifest.jevInvolved === true,
    providerCallsRequired: manifest.providerCallsRequired === true,
    createdAt: manifest.createdAt,
    notes: [...(manifest.notes ?? [])],
  };
}
