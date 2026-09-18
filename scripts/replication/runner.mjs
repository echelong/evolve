/**
 * Phase 5C — replication runner (PAPER ONLY).
 *
 * For EVERY eligible dataset it runs two internally species-matched
 * experiments under the SAME frozen configuration:
 *
 *   mock     : frozen mock research cohort      vs a fresh deterministic
 *              species-matched conventional control
 *   deepseek : frozen DeepSeek research cohort  vs a fresh deterministic
 *              species-matched conventional control
 *
 * The Mock and DeepSeek arms are NEVER made species-identical to each other:
 * each provider experiment is matched against its OWN control, which is what
 * keeps provider comparison honest.
 *
 * Execution is synchronous and self-contained:
 *   * one arena subprocess per unit, awaited;
 *   * the frozen cohort is COPIED into the unit's own research root, so the
 *     frozen artifact and the historical `.evolve/research` memory are never
 *     written to;
 *   * the run manifest is rewritten after every completed unit, so a multi-hour
 *     run can be resumed safely (and finished units are not redone);
 *   * no daemon, no background process, no research provider call.
 */

import { spawn } from "node:child_process";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { readArenaRun } from "../research-compare.mjs";
import { unitIdFor, evaluationKey } from "./identity.mjs";
import {
  RUN_ARENAS_DIR,
  RUN_MANIFEST_FILE,
  RUN_UNITS_DIR,
  TERMINAL_UNIT_STATUSES,
  UNIT_STATUS,
} from "./constants.mjs";

/* ============================================================================
 * Manifest persistence
 * ==========================================================================*/

async function writeJsonAtomic(target, value) {
  await mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  const { rename } = await import("node:fs/promises");
  await rename(tmp, target);
}

export function runManifestPath(runDir) {
  return path.join(runDir, RUN_MANIFEST_FILE);
}

export async function loadRunManifest(runDir) {
  try {
    return JSON.parse(await readFile(runManifestPath(runDir), "utf8"));
  } catch {
    return null;
  }
}

export async function writeRunManifest(runDir, manifest) {
  const record = { ...manifest, updatedAt: new Date().toISOString() };
  await writeJsonAtomic(runManifestPath(runDir), record);
  return record;
}

/** Overall run status derived from its units. */
export function runStatusFromUnits(units = []) {
  const statuses = units.map((unit) => unit.status);
  if (statuses.length === 0) return "EMPTY";
  const failed = statuses.filter((status) => status === UNIT_STATUS.FAILED).length;
  const completed = statuses.filter((status) => status === UNIT_STATUS.COMPLETED).length;
  const running = statuses.filter((status) => status === UNIT_STATUS.RUNNING || status === UNIT_STATUS.PENDING).length;
  if (running > 0) return completed > 0 ? "PARTIAL_RUNNING" : "RUNNING";
  if (failed === statuses.length) return "FAILED";
  if (failed > 0) return completed > 0 ? "PARTIAL_FAILED" : "FAILED";
  if (completed > 0) return "COMPLETED";
  return "SKIPPED";
}

/* ============================================================================
 * Planning
 * ==========================================================================*/

/**
 * Build the unit plan for a replication run. Pure: no filesystem writes and no
 * arena execution, so it can be inspected (and tested) offline.
 */
export function planReplication({ freeze, cohorts = {}, datasets = [], providers = ["mock", "deepseek"] } = {}) {
  const replicationId = freeze?.replicationId ?? null;
  const units = [];
  for (const provider of providers) {
    const cohort = cohorts[provider];
    if (!cohort) continue;
    for (const dataset of datasets) {
      const unitId = unitIdFor({
        replicationId,
        provider,
        datasetId: dataset.datasetId,
        datasetFingerprint: dataset.fingerprint,
        cohortDigest: cohort.cohortDigest,
      });
      units.push({
        unitId,
        provider,
        cohortKey: provider,
        cohortDigest: cohort.cohortDigest,
        cohortCount: cohort.count ?? null,
        datasetId: dataset.datasetId,
        datasetDir: dataset.dir,
        datasetFingerprint: dataset.fingerprint,
        status: UNIT_STATUS.PENDING,
      });
    }
  }
  units.sort((a, b) => a.unitId.localeCompare(b.unitId));
  return { replicationId, units };
}

/* ============================================================================
 * Frozen-cohort staging
 * ==========================================================================*/

/**
 * Copy the frozen cohort payload into a unit-private research root.
 *
 * The Arena's promotion step writes research memory under the research root it
 * is pointed at. Staging a copy means the frozen cohort (and the historical
 * `.evolve/research` memory) is never mutated by a replication run.
 */
export async function stageFrozenCohort({ frozenDir, destination }) {
  await mkdir(destination, { recursive: true });
  for (const entry of ["compiled", "experiment.json"]) {
    const source = path.join(frozenDir, entry);
    try {
      await cp(source, path.join(destination, entry), { recursive: true, force: true });
    } catch {
      // `experiment.json` is optional (the canonical mock cohort has none).
    }
  }
  return destination;
}

/* ============================================================================
 * Arena execution
 * ==========================================================================*/

/**
 * Default unit executor: one synchronous `scripts/arena.mjs --research-mode ab`
 * subprocess, awaited. The frozen cohort is supplied via `EVOLVE_RESEARCH_ROOT`,
 * strict species matching is forced on, and the provider is pinned to the
 * deterministic `mock` so no external provider is even resolvable — replication
 * itself needs zero LLM calls.
 */
/** The exact environment + argv a replication unit runs the Arena with. */
export function buildArenaUnitInvocation({ datasetDir, researchRoot, arenasDir, freeze, env = process.env } = {}) {
  const arena = freeze?.arena ?? {};
  return {
    argv: ["scripts/arena.mjs", "--research-mode", "ab", datasetDir],
    env: {
      ...env,
      EVOLVE_ARENA_DIR: arenasDir,
      EVOLVE_HALL_OF_FAME_DIR: path.join(path.dirname(arenasDir), "hall-of-fame"),
      EVOLVE_RESEARCH_ROOT: researchRoot,
      EVOLVE_ARENA_RESEARCH_MODE: "ab",
      EVOLVE_ARENA_AB_SPECIES_MATCHED: "1",
      EVOLVE_ARENA_AB_EXPAND: "0",
      EVOLVE_ARENA_POPULATION: String(arena.population ?? 200),
      EVOLVE_ARENA_GENERATIONS: String(arena.generations ?? 30),
      EVOLVE_ARENA_WORKERS: String(arena.workers ?? 8),
      EVOLVE_ARENA_AB_BOOTSTRAP_ITERATIONS: String(arena.bootstrapIterations ?? 2000),
      EVOLVE_ARENA_AB_BOOTSTRAP_SEED: String(arena.bootstrapSeed ?? "evolve-ab-bootstrap-v1"),
      EVOLVE_EVAL_SEEDS: [...(arena.seeds ?? ["evolve"])].join(","),
      // Fail-closed determinism: the deterministic provider is the only one
      // resolvable here, and it is never actually called in A/B mode.
      EVOLVE_RESEARCH_PROVIDER: "mock",
    },
  };
}

export async function defaultArenaExecutor({
  datasetDir,
  researchRoot,
  arenasDir,
  freeze,
  env = process.env,
  scriptPath = path.join(process.cwd(), "scripts", "arena.mjs"),
  log = null,
} = {}) {
  const invocation = buildArenaUnitInvocation({ datasetDir, researchRoot, arenasDir, freeze, env });
  const childEnv = invocation.env;

  await mkdir(arenasDir, { recursive: true });
  const before = new Set((await readdir(arenasDir).catch(() => [])).sort());

  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, "--research-mode", "ab", datasetDir], {
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (log) for (const line of chunk.toString().split("\n")) if (line.trim()) log(line.trim());
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });

  const after = (await readdir(arenasDir).catch(() => [])).sort();
  const created = after.filter((name) => !before.has(name));
  const arenaId = created.length === 1 ? created[0] : created[created.length - 1] ?? null;

  if (exitCode?.code !== 0 || !arenaId) {
    const error = new Error(
      `arena subprocess failed (exit ${exitCode?.code ?? "signal"}): ${(exitCode?.stderr ?? "").trim().slice(-500) || "no diagnostic"}`,
    );
    error.stdout = exitCode?.stdout ?? "";
    error.stderr = exitCode?.stderr ?? "";
    throw error;
  }

  return { arenaId, arenaDir: path.join(arenasDir, arenaId), stdout: exitCode.stdout };
}

/** Read a unit's arena artifacts into a compact, reportable record. */
export async function collectUnitMetrics({ arenasDir, arenaId, provider, datasetId }) {
  const run = await readArenaRun(arenaId, { arenasDir });
  if (!run?.available) {
    return { available: false, arenaId, reason: run?.reason ?? "arena artifact unavailable" };
  }
  const datasetRefs = (run.datasets ?? []).map((row) => row?.id ?? row?.fingerprint ?? null).filter(Boolean);
  return {
    available: true,
    arenaId,
    provider,
    datasetId,
    datasets: run.datasets ?? [],
    datasetIds: datasetRefs,
    // The unit's own dataset must be the ONLY dataset in its arena artifacts.
    datasetMatchesUnit: datasetRefs.length === 1 && datasetRefs[0] === datasetId,
    cohort: run.cohort ?? null,
    absolute: run.absolute ?? null,
    deltas: run.deltas ?? null,
    artifactDifferences: run.artifactDifferences ?? null,
    providerRecorded: run.provider ?? null,
    statistics: run.statistics ?? null,
    limitations: run.limitations ?? [],
    speciesMatched: run.cohort?.speciesMatched === true,
    crossCohortCrossover: run.artifactDifferences ? null : null,
  };
}

/* ============================================================================
 * Run
 * ==========================================================================*/

/**
 * Execute (or resume) a replication run.
 *
 * @param {{
 *   runDir: string,
 *   freeze: object,
 *   replicationId: string,
 *   units: object[],
 *   frozenCohortDirs: Record<string, string>,
 *   executor?: Function,
 *   rerun?: boolean,
 *   canonicality?: object,
 *   onProgress?: Function,
 *   now?: () => number,
 * }} options
 */
export async function runReplication({
  runDir,
  freeze,
  replicationId,
  units = [],
  frozenCohortDirs = {},
  executor = defaultArenaExecutor,
  rerun = false,
  canonicality = null,
  onProgress = null,
  now = () => Date.now(),
} = {}) {
  const report = onProgress ?? (() => {});
  const existing = await loadRunManifest(runDir);
  const byUnitId = new Map((existing?.units ?? []).map((unit) => [unit.unitId, unit]));

  let manifest = {
    schemaVersion: 1,
    phase: "5C",
    replicationId,
    freezeDigest: freeze?.freezeDigest ?? null,
    cohorts: Object.fromEntries(
      Object.entries(frozenCohortDirs).map(([key, dir]) => [key, { dir, cohortDigest: freeze?.cohortDigests?.[key] ?? null }]),
    ),
    evaluation: evaluationKey(freeze),
    canonicality: canonicality ?? null,
    original: existing?.original ?? {
      replayDetection: null,
      canonicality: canonicality ?? null,
      units: (existing?.units ?? []).map((unit) => ({ unitId: unit.unitId, status: unit.status })),
    },
    createdAt: existing?.createdAt ?? new Date(now()).toISOString(),
    updatedAt: new Date(now()).toISOString(),
    status: "RUNNING",
    units: [],
  };

  const results = [];
  for (const planned of units) {
    const prior = byUnitId.get(planned.unitId) ?? null;
    const priorTerminal = prior && TERMINAL_UNIT_STATUSES.includes(prior.status);

    if (priorTerminal && !rerun) {
      manifest.units.push({ ...prior, resumed: true });
      results.push({ unit: { ...prior, resumed: true }, executed: false, reason: `already ${prior.status}` });
      report(`[replicate] ${planned.provider} × ${planned.datasetId}: ${prior.status} (resumed, not re-run)`);
      continue;
    }

    const frozenDir = frozenCohortDirs[planned.cohortKey];
    if (!frozenDir) {
      const record = {
        ...planned,
        status: UNIT_STATUS.SKIPPED,
        reason: `no frozen cohort staged for provider '${planned.cohortKey}'`,
        completedAt: new Date(now()).toISOString(),
      };
      manifest.units.push(record);
      results.push({ unit: record, executed: false, reason: record.reason });
      continue;
    }

    const unitDir = path.join(runDir, RUN_UNITS_DIR, planned.unitId);
    const arenasDir = path.join(unitDir, RUN_ARENAS_DIR);
    const researchRoot = path.join(unitDir, "research");

    const rerunOf = prior?.status === UNIT_STATUS.COMPLETED ? prior.unitId : null;
    manifest.units.push({ ...planned, status: UNIT_STATUS.RUNNING, startedAt: new Date(now()).toISOString(), rerunOf });
    manifest = await writeRunManifest(runDir, manifest);

    try {
      report(`[replicate] ${planned.provider} × ${planned.datasetId}: running (${planned.unitId})`);
      await stageFrozenCohort({ frozenDir, destination: researchRoot });
      const executed = await executor({
        datasetDir: planned.datasetDir,
        datasetId: planned.datasetId,
        datasetFingerprint: planned.datasetFingerprint,
        provider: planned.provider,
        cohortKey: planned.cohortKey,
        cohortDigest: planned.cohortDigest,
        researchRoot,
        arenasDir,
        freeze,
        unitId: planned.unitId,
      });

      const metrics = await collectUnitMetrics({
        arenasDir,
        arenaId: executed.arenaId,
        provider: planned.provider,
        datasetId: planned.datasetId,
      });

      const record = {
        ...planned,
        status: metrics.available ? UNIT_STATUS.COMPLETED : UNIT_STATUS.FAILED,
        rerunOf: rerunOf ?? null,
        arenaId: executed.arenaId,
        arenaDir: executed.arenaDir,
        startedAt: manifest.units[manifest.units.length - 1].startedAt,
        completedAt: new Date(now()).toISOString(),
        freezeDigest: freeze?.freezeDigest ?? null,
        datasetFingerprint: planned.datasetFingerprint,
        cohortDigest: planned.cohortDigest,
        metrics,
        error: metrics.available ? null : (metrics.reason ?? "no arena artifact"),
      };
      await writeJsonAtomic(path.join(unitDir, "unit.json"), record);
      manifest.units[manifest.units.length - 1] = record;
      manifest = await writeRunManifest(runDir, manifest);
      results.push({ unit: record, executed: true });
      report(`[replicate] ${planned.provider} × ${planned.datasetId}: ${record.status}`);
    } catch (error) {
      const record = {
        ...planned,
        status: UNIT_STATUS.FAILED,
        rerunOf: rerunOf ?? null,
        startedAt: manifest.units[manifest.units.length - 1].startedAt,
        completedAt: new Date(now()).toISOString(),
        freezeDigest: freeze?.freezeDigest ?? null,
        error: String(error?.message ?? error).slice(0, 800),
        metrics: null,
      };
      await writeJsonAtomic(path.join(unitDir, "unit.json"), record);
      manifest.units[manifest.units.length - 1] = record;
      manifest = await writeRunManifest(runDir, manifest);
      results.push({ unit: record, executed: true });
      report(`[replicate] ${planned.provider} × ${planned.datasetId}: FAILED (${record.error})`);
    }
  }

  manifest.status = runStatusFromUnits(manifest.units);
  manifest.completedAt = manifest.status.startsWith("COMPLETED") || manifest.status === "FAILED" ? new Date(now()).toISOString() : null;
  manifest = await writeRunManifest(runDir, manifest);
  return { manifest, results };
}
