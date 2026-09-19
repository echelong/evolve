/**
 * Phase 5G.0 — FROZEN external-intelligence CLASSIFICATION experiment (PAPER ONLY).
 *
 *   frozen capture → integrity check → deterministic input projection
 *     → classifier.dev FAST tier (ONE bounded request) → frozen artifact → STOP
 *
 * The artifact lives in its OWN tree and never inside the immutable capture:
 *
 *   .evolve/classifier/experiments/<clexp-id>/
 *     experiment.json          identity, provenance, counts, resultDigest (written LAST)
 *     results.ndjson           one bounded classification record per classified source record
 *     provider/runs/run-0001.json   bounded provider run (attempt metadata, never raw headers)
 *
 * NOTHING that identifies the text is persisted: no title, no excerpt, no URL, no
 * author, no query, no raw classifier input, no raw HTTP response. The source
 * capture already holds the frozen excerpt, and the deterministic projection
 * re-derives the input on demand (offline replay does exactly that and checks
 * each `inputDigest`).
 *
 * NOTHING is routed anywhere: this module imports no Jev, DeepSeek, Arena,
 * strategy-compiler, research, Agent-Reach provider, wallet or RPC code.
 * Classification never triggers a capture.
 *
 * The labels are DESCRIPTIVE and UNVERIFIED and have no authority over the
 * Arena, evolution, gates, replication or deployment.
 */

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { digestOf } from "../lib/hash.mjs";
import { loadCaptureRecords, readCaptureManifest, verifyCapture } from "./capture.mjs";
import { resolveCaptureFeatureVersion } from "./replay.mjs";
import {
  CLASSIFIER_DEFINITION,
  CLASSIFIER_DEFINITION_DIGEST,
  CLASSIFIER_ID,
  CLASSIFIER_INSTRUCTIONS_DIGEST,
  CLASSIFIER_LABELS,
  CLASSIFIER_VERSION,
  INPUT_PROJECTION_VERSION,
  classifierDefinitionFor,
  projectClassifierInputs,
} from "./classifier-definition.mjs";
import {
  CLASSIFIER_ATTEMPT_FIELDS,
  CLASSIFIER_DEV_API_VERSION,
  CLASSIFIER_DEV_ENDPOINT,
  CLASSIFIER_DEV_PROVIDER,
  CLASSIFIER_DEV_TIER,
  CLASSIFIER_MAX_INPUTS_PER_REQUEST,
} from "./classifier-dev.mjs";

export const CLASSIFIER_PHASE = "5G.0";
export const CLASSIFIER_EXPERIMENT_SCHEMA_VERSION = 1;

/** Default classifier root (gitignored like every `.evolve/` artifact). */
export const CLASSIFIER_DIR = path.join(".evolve", "classifier");
export const CLASSIFIER_EXPERIMENTS_SUBDIR = "experiments";
export const CLASSIFIER_EXPERIMENT_FILE = "experiment.json";
export const CLASSIFIER_RESULTS_FILE = "results.ndjson";
export const CLASSIFIER_PROVIDER_RUNS_DIR = path.join("provider", "runs");

/** The EXACT keys of one persisted classification record. Nothing else is ever written. */
export const CLASSIFICATION_RECORD_FIELDS = Object.freeze([
  "recordDigest",
  "inputProjectionVersion",
  "inputDigest",
  "classifierId",
  "classifierVersion",
  "label",
  "confidence",
  "scores",
  "provider",
  "model",
  "tier",
]);

/** Keys that must NEVER appear anywhere in a persisted classifier artifact. */
export const FORBIDDEN_PERSISTED_KEYS = Object.freeze([
  "input",
  "inputs",
  "title",
  "textExcerpt",
  "text",
  "query",
  "queryId",
  "canonicalId",
  "canonicalUrl",
  "url",
  "authorId",
  "author",
  "rawDigest",
  "raw",
  "response",
  "headers",
  "authorization",
  "apiKey",
]);

/* ============================================================================
 * Errors
 * ==========================================================================*/

export class ClassifierCaptureRefusedError extends Error {
  constructor(captureId, reason) {
    super(`classification refused for capture '${captureId}': ${reason}`);
    this.name = "ClassifierCaptureRefusedError";
    this.captureId = captureId;
    this.reason = reason;
  }
}

export class ClassifierTooManyRecordsError extends Error {
  constructor(count) {
    super(
      `${count} eligible records exceed the Phase 5G.0 single-request limit of ${CLASSIFIER_MAX_INPUTS_PER_REQUEST} — ` +
        "refusing rather than silently truncating (multi-batch classification is not implemented).",
    );
    this.name = "ClassifierTooManyRecordsError";
    this.count = count;
  }
}

export class ClassifierNoEligibleRecordsError extends Error {
  constructor(captureId) {
    super(`capture '${captureId}' has no record with non-empty title/textExcerpt — nothing to classify.`);
    this.name = "ClassifierNoEligibleRecordsError";
    this.captureId = captureId;
  }
}

export class ClassifierExperimentExistsError extends Error {
  constructor(experimentId) {
    super(`classifier experiment '${experimentId}' already exists — classifier experiments are IMMUTABLE and never overwritten.`);
    this.name = "ClassifierExperimentExistsError";
    this.experimentId = experimentId;
  }
}

/* ============================================================================
 * Identity helpers
 * ==========================================================================*/

// Newest captures carry millisecond precision (`...SSmmmZ`); legacy captures
// (`...SSZ`) remain valid forever. Both parse.
const CAPTURE_ID_PATTERN = /^capture-\d{8}T\d{6}(?:\d{3})?Z$/;

export function isValidCaptureId(captureId) {
  return typeof captureId === "string" && CAPTURE_ID_PATTERN.test(captureId);
}

export function isValidClassifierExperimentId(experimentId) {
  return typeof experimentId === "string" && /^clexp-[A-Za-z0-9][A-Za-z0-9-]{0,80}$/.test(experimentId);
}

/** `clexp-<UTC stamp>-<8 hex of resultDigest>` — deterministic given the clock and the results. */
export function buildClassifierExperimentId({ now, resultDigest }) {
  const stamp = new Date(now).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `clexp-${stamp}-${String(resultDigest).slice(0, 8)}`;
}

export function classifierExperimentDir(outRoot, experimentId) {
  if (!isValidClassifierExperimentId(experimentId)) throw new Error(`invalid classifier experiment id '${experimentId}'`);
  return path.join(outRoot, CLASSIFIER_EXPERIMENTS_SUBDIR, experimentId);
}

function isInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** The classifier tree must never live inside the capture root (captures are immutable). */
export function assertOutsideCaptureRoot(captureRoot, outRoot) {
  if (isInside(captureRoot, outRoot) || isInside(outRoot, captureRoot)) {
    throw new Error("the classifier experiment root must be a SEPARATE tree from the capture root — never write inside a frozen capture directory");
  }
}

/* ============================================================================
 * Digests
 * ==========================================================================*/

/** Deterministic digest over the ORDERED classification records. */
export function resultDigestOf(records) {
  return digestOf(Array.isArray(records) ? records : []);
}

export function experimentDigestSubject(experiment) {
  const subject = { ...(experiment ?? {}) };
  delete subject.experimentDigest;
  return subject;
}

export function experimentDigestOf(experiment) {
  return digestOf(experimentDigestSubject(experiment));
}

/* ============================================================================
 * Preflight (NO network): capture integrity → deterministic projection
 * ==========================================================================*/

/**
 * Locate, verify and project a frozen capture. Never calls a provider, never
 * captures, never writes.
 *
 *   1. locate the frozen capture and its manifest
 *   2. require `immutable === true`
 *   3. require `finalized === true`
 *   4. run the existing capture integrity verification (refuse on failure)
 *   5. load the normalized frozen records
 *   6. build the classifier inputs locally
 *   7. refuse an empty or oversized set (never truncate)
 */
export async function prepareClassification({ captureRoot, captureId, classifierId = CLASSIFIER_ID } = {}) {
  classifierDefinitionFor(classifierId);
  if (!isValidCaptureId(captureId)) {
    throw new ClassifierCaptureRefusedError(
      String(captureId),
      "not a valid capture id (expected capture-YYYYMMDDTHHMMSSmmmZ, or the legacy capture-YYYYMMDDTHHMMSSZ)",
    );
  }

  const manifest = await readCaptureManifest(captureRoot, captureId);
  if (!manifest) throw new ClassifierCaptureRefusedError(captureId, "no capture manifest exists");
  if (manifest.immutable !== true) throw new ClassifierCaptureRefusedError(captureId, "the capture manifest is not immutable");
  if (manifest.finalized !== true) throw new ClassifierCaptureRefusedError(captureId, "the capture manifest is not finalized");

  const integrity = await verifyCapture(captureRoot, captureId);
  if (!integrity.ok) {
    throw new ClassifierCaptureRefusedError(captureId, `capture integrity verification failed (${integrity.reason ?? "bytes do not match the frozen manifest"})`);
  }

  let featureVersion;
  try {
    featureVersion = resolveCaptureFeatureVersion(manifest);
  } catch (error) {
    throw new ClassifierCaptureRefusedError(captureId, `the capture pins an unrecognised feature version (${error?.message ?? error})`);
  }

  const records = await loadCaptureRecords(captureRoot, captureId);
  const { items, skippedEmptyCount } = projectClassifierInputs(records);
  if (items.length === 0) throw new ClassifierNoEligibleRecordsError(captureId);
  if (items.length > CLASSIFIER_MAX_INPUTS_PER_REQUEST) throw new ClassifierTooManyRecordsError(items.length);

  return {
    captureId,
    manifest,
    captureManifestDigest: manifest.manifestDigest,
    recordsDigest: manifest.digests?.recordsDigest ?? null,
    captureSchemaVersion: Number.isFinite(manifest.captureSchemaVersion) ? manifest.captureSchemaVersion : Number.isFinite(manifest.schemaVersion) ? manifest.schemaVersion : null,
    featureVersion,
    syntheticIntelligence: manifest.syntheticIntelligence === true,
    recordCount: records.length,
    items,
    skippedEmptyCount,
  };
}

/* ============================================================================
 * Records + summary
 * ==========================================================================*/

/** Build the ordered, bounded classification records from a validated response. */
export function buildClassificationRecords({ items, response, provider = CLASSIFIER_DEV_PROVIDER }) {
  if (!Array.isArray(response?.results) || response.results.length !== items.length) {
    throw new Error("classification result count does not match the request input count");
  }
  return items.map((item, index) => {
    const result = response.results[index];
    return {
      recordDigest: item.recordDigest,
      inputProjectionVersion: INPUT_PROJECTION_VERSION,
      inputDigest: item.inputDigest,
      classifierId: CLASSIFIER_ID,
      classifierVersion: CLASSIFIER_VERSION,
      label: result.label,
      confidence: result.confidence,
      scores: { ...result.scores },
      provider,
      model: response.model ?? null,
      tier: response.tier,
    };
  });
}

function round6(value) {
  return Math.round(value * 1e6) / 1e6;
}

/** Descriptive counts only. Never a bullishness/return/quality/scam/trade number. */
export function summarizeClassifications(records, { latencyMs = null, returnedModel = null } = {}) {
  const labelCounts = Object.fromEntries(CLASSIFIER_LABELS.map((label) => [label, 0]));
  let confidenceSum = 0;
  for (const record of records) {
    labelCounts[record.label] += 1;
    confidenceSum += record.confidence;
  }
  return {
    classifiedCount: records.length,
    labelCounts,
    meanConfidence: records.length > 0 ? round6(confidenceSum / records.length) : null,
    returnedModel,
    apiVersion: CLASSIFIER_DEV_API_VERSION,
    latencyMs,
  };
}

/* ============================================================================
 * Run (ONE bounded request) + persistence
 * ==========================================================================*/

function serializeRecords(records) {
  return records.map((record) => JSON.stringify(record)).join("\n") + (records.length > 0 ? "\n" : "");
}

async function writeJson(target, value) {
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/**
 * Classify ONE frozen capture.
 *
 * @param {{
 *   captureRoot: string, outRoot: string, captureId: string, classifierId?: string,
 *   provider: { classify: Function, name: string },
 *   save?: boolean, now?: () => number,
 * }} options
 * @returns {Promise<
 *   | { ok: true, saved: boolean, experiment: object, records: object[], run: object, dir: string|null }
 *   | { ok: false, status: string, reason: string, httpStatus: number|null, attempts: object[], attemptCount: number }
 * >}
 */
export async function runClassification({
  captureRoot,
  outRoot,
  captureId,
  classifierId = CLASSIFIER_ID,
  provider,
  save = false,
  now = () => Date.now(),
} = {}) {
  if (!provider || typeof provider.classify !== "function") throw new Error("runClassification requires an explicit provider");
  if (provider.name !== CLASSIFIER_DEV_PROVIDER) throw new Error(`unknown classifier provider '${provider.name}'`);
  if (save) assertOutsideCaptureRoot(captureRoot, outRoot);

  // Everything that can refuse happens BEFORE the (single) network request.
  const prepared = await prepareClassification({ captureRoot, captureId, classifierId });

  const startedAt = new Date(now()).toISOString();
  const outcome = await provider.classify({ inputs: prepared.items.map((item) => item.input) });
  if (!outcome.ok) return outcome;
  const completedAt = new Date(now()).toISOString();

  const records = buildClassificationRecords({ items: prepared.items, response: outcome, provider: provider.name });
  const resultDigest = resultDigestOf(records);
  const createdAt = new Date(now()).toISOString();
  const experimentId = buildClassifierExperimentId({ now: Date.parse(createdAt), resultDigest });

  const run = {
    runId: "run-0001",
    experimentId,
    provider: provider.name,
    endpoint: CLASSIFIER_DEV_ENDPOINT,
    apiVersion: CLASSIFIER_DEV_API_VERSION,
    requestedTier: CLASSIFIER_DEV_TIER,
    returnedTier: outcome.tier,
    returnedModel: outcome.model,
    multi: false,
    inputCount: prepared.items.length,
    requestDigest: outcome.requestDigest,
    status: "CLASSIFIER_OK",
    attemptCount: outcome.attemptCount,
    attempts: outcome.attempts.map((attempt) => {
      const bounded = {};
      for (const field of CLASSIFIER_ATTEMPT_FIELDS) bounded[field] = attempt[field] ?? null;
      return bounded;
    }),
    usage: outcome.usage,
    latencyMs: outcome.latencyMs,
    startedAt,
    completedAt,
  };

  const experiment = {
    schemaVersion: CLASSIFIER_EXPERIMENT_SCHEMA_VERSION,
    phase: CLASSIFIER_PHASE,
    experimentId,
    captureId: prepared.captureId,
    captureManifestDigest: prepared.captureManifestDigest,
    recordsDigest: prepared.recordsDigest,
    captureSchemaVersion: prepared.captureSchemaVersion,
    featureVersion: prepared.featureVersion,
    syntheticIntelligence: prepared.syntheticIntelligence,
    classifierId: CLASSIFIER_DEFINITION.classifierId,
    classifierVersion: CLASSIFIER_DEFINITION.classifierVersion,
    classifierDefinitionDigest: CLASSIFIER_DEFINITION_DIGEST,
    inputProjectionVersion: INPUT_PROJECTION_VERSION,
    instructionsDigest: CLASSIFIER_INSTRUCTIONS_DIGEST,
    provider: provider.name,
    endpointVersion: CLASSIFIER_DEV_API_VERSION,
    requestedTier: CLASSIFIER_DEV_TIER,
    returnedTier: outcome.tier,
    returnedModel: outcome.model,
    multi: false,
    recordCount: prepared.recordCount,
    classifiedCount: records.length,
    skippedEmptyCount: prepared.skippedEmptyCount,
    resultDigest,
    summary: summarizeClassifications(records, { latencyMs: outcome.latencyMs, returnedModel: outcome.model }),
    providerRuns: [
      {
        runId: run.runId,
        file: path.posix.join("provider", "runs", `${run.runId}.json`),
        requestDigest: run.requestDigest,
        attemptCount: run.attemptCount,
        runDigest: digestOf(run),
      },
    ],
    createdAt,
    immutable: true,
    finalized: true,
    shadowOnly: true,
    paperOnly: true,
    note:
      "Frozen, DESCRIPTIVE and UNVERIFIED external classification of already-frozen public observations. " +
      "It has no authority over the Arena, evolution, gates, replication or deployment, and was routed nowhere.",
  };
  experiment.experimentDigest = experimentDigestOf(experiment);

  if (!save) return { ok: true, saved: false, experiment, records, run, dir: null };

  const dir = classifierExperimentDir(outRoot, experimentId);
  await mkdir(path.dirname(dir), { recursive: true });
  try {
    await mkdir(dir);
  } catch (error) {
    if (error?.code === "EEXIST") throw new ClassifierExperimentExistsError(experimentId);
    throw error;
  }
  await mkdir(path.join(dir, CLASSIFIER_PROVIDER_RUNS_DIR), { recursive: true });
  await writeFile(path.join(dir, CLASSIFIER_RESULTS_FILE), serializeRecords(records), "utf8");
  await writeJson(path.join(dir, CLASSIFIER_PROVIDER_RUNS_DIR, `${run.runId}.json`), run);
  // The experiment file is written LAST: it is the finalization record.
  await writeJson(path.join(dir, CLASSIFIER_EXPERIMENT_FILE), experiment);
  return { ok: true, saved: true, experiment, records, run, dir };
}

/* ============================================================================
 * Offline read-back: stats + replay (ZERO network)
 * ==========================================================================*/

async function readExperimentFiles(outRoot, experimentId) {
  const dir = classifierExperimentDir(outRoot, experimentId);
  const experiment = JSON.parse(await readFile(path.join(dir, CLASSIFIER_EXPERIMENT_FILE), "utf8"));
  const text = await readFile(path.join(dir, CLASSIFIER_RESULTS_FILE), "utf8");
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  const records = lines.map((line) => JSON.parse(line));
  return { dir, experiment, records, resultsText: text };
}

/** Every key path in a JSON value (used to prove no raw text field is persisted). */
function collectKeys(value, out = new Set()) {
  if (Array.isArray(value)) for (const entry of value) collectKeys(entry, out);
  else if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      out.add(key);
      collectKeys(entry, out);
    }
  }
  return out;
}

function recordShapeProblems(record, index) {
  const problems = [];
  if (!record || typeof record !== "object" || Array.isArray(record)) return [`record ${index} is not an object`];
  const keys = Object.keys(record).sort();
  const expected = [...CLASSIFICATION_RECORD_FIELDS].sort();
  if (keys.join(",") !== expected.join(",")) problems.push(`record ${index} keys differ from the whitelist`);
  if (typeof record.label !== "string" || !CLASSIFIER_LABELS.includes(record.label)) problems.push(`record ${index} label is outside the taxonomy`);
  if (typeof record.confidence !== "number" || !Number.isFinite(record.confidence) || record.confidence < 0 || record.confidence > 1) {
    problems.push(`record ${index} confidence is not a finite number in [0, 1]`);
  }
  if (!record.scores || typeof record.scores !== "object" || Array.isArray(record.scores)) problems.push(`record ${index} scores is not an object`);
  else {
    for (const [key, value] of Object.entries(record.scores)) {
      if (!CLASSIFIER_LABELS.includes(key)) problems.push(`record ${index} score key '${key}' is outside the taxonomy`);
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) problems.push(`record ${index} score '${key}' is not a finite number in [0, 1]`);
    }
  }
  return problems;
}

/**
 * Re-verify a stored classifier experiment OFFLINE. Makes zero network calls,
 * never reclassifies, never writes.
 */
export async function replayClassifierExperiment({ outRoot, captureRoot, experimentId } = {}) {
  const checks = {};
  const problems = [];
  const check = (name, ok, detail = null) => {
    checks[name] = ok === true;
    if (ok !== true) problems.push(detail ? `${name}: ${detail}` : name);
  };

  let files;
  try {
    files = await readExperimentFiles(outRoot, experimentId);
  } catch (error) {
    return { ok: false, experimentId, networkCalls: 0, checks: { experimentReadable: false }, problems: [`experimentReadable: ${error?.message ?? error}`] };
  }
  const { dir, experiment, records } = files;

  check("experimentDigest", experimentDigestOf(experiment) === experiment.experimentDigest, "experiment.json does not match its own digest");
  check("frozenFlags", experiment.immutable === true && experiment.finalized === true && experiment.shadowOnly === true && experiment.paperOnly === true);
  check("experimentId", experiment.experimentId === experimentId, "stored id differs from the directory name");

  check(
    "definition",
    experiment.classifierId === CLASSIFIER_ID &&
      experiment.classifierVersion === CLASSIFIER_VERSION &&
      experiment.instructionsDigest === CLASSIFIER_INSTRUCTIONS_DIGEST &&
      experiment.inputProjectionVersion === INPUT_PROJECTION_VERSION &&
      experiment.classifierDefinitionDigest === CLASSIFIER_DEFINITION_DIGEST,
    "the stored classifier identity no longer matches the frozen definition",
  );
  check("tier", experiment.requestedTier === CLASSIFIER_DEV_TIER && experiment.returnedTier === CLASSIFIER_DEV_TIER && experiment.multi === false);

  const shapeProblems = records.flatMap((record, index) => recordShapeProblems(record, index));
  check("recordShape", shapeProblems.length === 0, shapeProblems.slice(0, 3).join("; "));
  check(
    "recordProvenance",
    records.every(
      (record) =>
        record?.classifierId === experiment.classifierId &&
        record?.classifierVersion === experiment.classifierVersion &&
        record?.inputProjectionVersion === experiment.inputProjectionVersion &&
        record?.provider === experiment.provider &&
        record?.model === experiment.returnedModel &&
        record?.tier === experiment.returnedTier,
    ),
  );

  const recomputed = resultDigestOf(records);
  check("resultDigest", recomputed === experiment.resultDigest, "recomputed resultDigest differs from the stored one");
  check("classifiedCount", records.length === experiment.classifiedCount, "results.ndjson line count differs from classifiedCount");

  const persistedKeys = collectKeys([experiment, records]);
  const leaked = FORBIDDEN_PERSISTED_KEYS.filter((key) => persistedKeys.has(key));
  check("noRawText", leaked.length === 0, `forbidden keys persisted: ${leaked.join(", ")}`);

  // Provider runs: present, bounded, digest-consistent.
  let runsOk = Array.isArray(experiment.providerRuns) && experiment.providerRuns.length > 0;
  let runProblem = "no provider runs recorded";
  if (runsOk) {
    for (const ref of experiment.providerRuns) {
      try {
        const run = JSON.parse(await readFile(path.join(dir, ref.file), "utf8"));
        const runKeys = collectKeys(run);
        if (digestOf(run) !== ref.runDigest) {
          runsOk = false;
          runProblem = `${ref.file} does not match its recorded digest`;
        } else if (FORBIDDEN_PERSISTED_KEYS.some((key) => runKeys.has(key))) {
          runsOk = false;
          runProblem = `${ref.file} contains a forbidden key`;
        } else if ((run.attempts ?? []).some((attempt) => Object.keys(attempt).some((key) => !CLASSIFIER_ATTEMPT_FIELDS.includes(key)))) {
          runsOk = false;
          runProblem = `${ref.file} has an attempt field outside the whitelist`;
        }
      } catch (error) {
        runsOk = false;
        runProblem = `${ref.file} unreadable (${error?.message ?? error})`;
      }
    }
  }
  check("providerRuns", runsOk, runProblem);

  // Source capture identity + integrity + deterministic re-projection.
  let captureIdentityOk = false;
  let captureIntegrityOk = false;
  let projectionOk = false;
  let countsOk = false;
  let detail = null;
  try {
    const manifest = await readCaptureManifest(captureRoot, experiment.captureId);
    captureIdentityOk =
      Boolean(manifest) &&
      manifest.manifestDigest === experiment.captureManifestDigest &&
      (manifest.digests?.recordsDigest ?? null) === experiment.recordsDigest &&
      resolveCaptureFeatureVersion(manifest) === experiment.featureVersion;
    if (!manifest) detail = "the source capture is missing";
    const integrity = manifest ? await verifyCapture(captureRoot, experiment.captureId) : { ok: false };
    captureIntegrityOk = integrity.ok === true;
    if (manifest && captureIdentityOk && captureIntegrityOk) {
      const sourceRecords = await loadCaptureRecords(captureRoot, experiment.captureId);
      const { items, skippedEmptyCount } = projectClassifierInputs(sourceRecords);
      projectionOk =
        items.length === records.length &&
        items.every((item, index) => item.recordDigest === records[index]?.recordDigest && item.inputDigest === records[index]?.inputDigest);
      countsOk =
        sourceRecords.length === experiment.recordCount &&
        skippedEmptyCount === experiment.skippedEmptyCount &&
        items.length === experiment.classifiedCount &&
        experiment.recordCount === experiment.classifiedCount + experiment.skippedEmptyCount;
    }
  } catch (error) {
    detail = String(error?.message ?? error);
  }
  check("captureIdentity", captureIdentityOk, detail ?? "the source capture identity no longer matches the experiment");
  check("captureIntegrity", captureIntegrityOk, "the source capture no longer verifies");
  check("projection", projectionOk, "re-projecting the frozen capture no longer reproduces the stored record/input digests in order");
  check("counts", countsOk, "record/classified/skipped counts are inconsistent");

  const summary = summarizeClassifications(records, { latencyMs: experiment.summary?.latencyMs ?? null, returnedModel: experiment.returnedModel });
  check("summary", digestOf(summary) === digestOf(experiment.summary ?? null), "the stored summary differs from one recomputed from the stored records");

  return {
    ok: problems.length === 0,
    experimentId,
    captureId: experiment.captureId,
    resultDigest: recomputed,
    expectedResultDigest: experiment.resultDigest,
    classifiedCount: records.length,
    networkCalls: 0,
    checks,
    problems,
  };
}

/** Descriptive, read-only stats for one stored experiment. Zero network. */
export async function classifierExperimentStats({ outRoot, experimentId } = {}) {
  const { experiment, records } = await readExperimentFiles(outRoot, experimentId);
  const recomputed = resultDigestOf(records);
  return {
    experimentId,
    captureId: experiment.captureId,
    classifierId: experiment.classifierId,
    classifierVersion: experiment.classifierVersion,
    provider: experiment.provider,
    endpointVersion: experiment.endpointVersion,
    requestedTier: experiment.requestedTier,
    returnedTier: experiment.returnedTier,
    returnedModel: experiment.returnedModel,
    recordCount: experiment.recordCount,
    classifiedCount: records.length,
    skippedEmptyCount: experiment.skippedEmptyCount,
    resultDigest: recomputed,
    resultDigestOk: recomputed === experiment.resultDigest,
    summary: summarizeClassifications(records, { latencyMs: experiment.summary?.latencyMs ?? null, returnedModel: experiment.returnedModel }),
    createdAt: experiment.createdAt,
    networkCalls: 0,
  };
}

/** Every stored classifier experiment id (read-only). */
export async function listClassifierExperiments(outRoot) {
  try {
    return (await readdir(path.join(outRoot, CLASSIFIER_EXPERIMENTS_SUBDIR), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && isValidClassifierExperimentId(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}
