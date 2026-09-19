#!/usr/bin/env node
/**
 * Phase 5C/5C.3 — multi-dataset replication CLI (PAPER ONLY).
 *
 *   npm run replicate:research -- --write-freeze
 *   npm run replicate:research -- --verify-freeze
 *   npm run replicate:research -- --cohorts
 *   npm run replicate:research -- --plan
 *   npm run replicate:research -- --summary
 *   npm run replicate:research -- --freeze phase5c --datasets auto
 *   npm run replicate:research -- --datasets session-A,session-B
 *
 * WAVE-SCOPED (Phase 5C.3 canonical per-wave freezes):
 *   npm run replicate:research -- --write-freeze  --wave wave-2   write ONLY wave-2's own freeze
 *   npm run replicate:research -- --verify-freeze --wave wave-2   verify wave-2's own freeze
 *   npm run replicate:research -- --wave wave-2 --plan            plan against wave-2's own freeze
 *   npm run replicate:research -- --wave wave-2                   run against wave-2's own freeze
 *
 * A wave without a bound freeze is NOT silently run against the historical
 * Wave 1 freeze (that would be a different experiment): missing/stale freezes
 * fail closed, and a run NEVER writes one.

 * DISPATCH
 * --------
 * Exactly ONE command mode runs per invocation, resolved by `resolveAction`
 * (`./replication/mode.mjs`) and dispatched through a single exclusive
 * `switch`:
 *
 *   --write-freeze   write/update the freeze artifact, print its digest/path,
 *                    and STOP. No cohort work, no dataset discovery, no plan,
 *                    no Arena subprocess, no replication unit.
 *   --verify-freeze  verify the stored freeze against the live code (read-only).
 *   --cohorts        inspect the frozen research cohorts (READ-ONLY: it never
 *                    creates or rewrites a frozen cohort artifact).
 *   --plan           discover/select datasets and print the deterministic plan.
 *   --summary        print the summary of existing artifacts (read-only).
 *   (no action flag) NORMAL RUN — the ONLY mode that may execute replication
 *                    units, and it requires an already-written freeze.
 *
 * Two or more action flags together are a hard error, not a silent pick.
 * `--rerun` / `--dev` only apply to the normal run.
 *
 * For each eligible REAL dataset the normal run executes the SAME strict
 * species-matched A/B experiment twice: once with the frozen MOCK research
 * cohort, once with the frozen DEEPSEEK research cohort, each against its own
 * freshly generated deterministic conventional control.
 *
 * COMPARABILITY: each wave is canonical against its OWN freeze artifact. Two
 * waves may only be combined when their `evaluationContractDigest` and both
 * frozen cohort digests match — the FULL freeze digests are expected to differ
 * (they include the commit). The meta-summary reports INCOMPARABLE_WAVES with
 * the differing fields instead of aggregating across contracts, and excludes
 * NON_CANONICAL (`--dev`) runs unless `--include-noncanonical` is passed.
 *
 * The Mock and DeepSeek arms are never made species-identical to each other.
 * Research cohorts are frozen, so Phase 5C makes ZERO LLM calls. Execution is
 * synchronous and resumable; there is no daemon and no background process.
 *
 * Nothing here trades, signs, or executes anything.
 */

import path from "node:path";

import { parseArgs } from "./lib/args.mjs";
import { createMarketConfig } from "./market/config.mjs";
import { formatCaptureGuidance } from "./replication/guidance.mjs";
import {
  DEFAULT_FREEZE_VERSION,
  FROZEN_COHORT_KEYS,
  MIN_CLEAN_TO_RUN,
  REPLICATION_DIR,
  RUN_STATUS_FILE,
  RUN_SUMMARY_FILE,
} from "./replication/constants.mjs";
import {
  buildFreezeConfig,
  canonicalityVerdict,
  freezePath,
  readFreeze,
  readGitCommit,
  readWorkingTreeDirty,
  verifyFreeze,
  writeFreeze,
} from "./replication/freeze.mjs";
import {
  compareEvaluationContracts,
  evaluationContractDigest,
} from "./replication/contract.mjs";
import { cohortDirFor, inspectCohort, loadFrozenCohorts, readFrozenCohort } from "./replication/cohorts.mjs";
import {
  buildReplicationRegistry,
  collectArenaDatasetUsage,
  computeDatasetRegimes,
  discoverDatasetRecords,
} from "./replication/datasets.mjs";
import { evaluationKey, replicationIdFor, waveReplicationIdFor } from "./replication/identity.mjs";
import { ACTION, resolveAction, resolveWaveOptions } from "./replication/mode.mjs";
import { aggregateReplication } from "./replication/aggregate.mjs";
import {
  CANONICAL_EVALUATION_CONTRACT_DIGEST,
  bindWaveManifest,
  describeWaveManifest,
  isHistoricalWave,
  isSafeFreezePath,
  listWaveManifests,
  readWaveManifest,
  validateWaveManifest,
  waveDefinitionFor,
  waveDefinitionMatch,
  waveFreezeBound,
  waveManifestPath,
  waveMembership,
  writeWaveManifest,
  WAVE_STATUS,
} from "./replication/waves.mjs";
import { formatMetaSummary, loadMetaSummary } from "./replication/meta-summary.mjs";
import { buildPlanStatus, datasetReadinessFor } from "./replication/plan-status.mjs";
import {
  buildStatusArtifact,
  formatCohortInspection,
  formatDatasetRegistry,
  formatFreezeVerification,
  formatPlanStatus,
  formatReplicationSummary,
  formatWaveHeader,
} from "./replication/report.mjs";
import { loadRunManifest, planReplication, runReplication, writeRunManifest } from "./replication/runner.mjs";

const BOOLEAN_FLAGS = [
  "json",
  "verify-freeze",
  "cohorts",
  "summary",
  "plan",
  "rerun",
  "dev",
  "write-freeze",
  "meta-summary",
  "include-noncanonical",
  "help",
];
const VALUE_FLAGS = ["freeze", "datasets", "providers", "out", "wave", "waves"];

function usage() {
  return [
    "EVOLVE Phase 5C multi-dataset replication (PAPER ONLY)",
    "",
    "Actions — mutually exclusive, exactly one per invocation:",
    "  npm run replicate:research -- --write-freeze     write/update the freeze artifact, print its digest, and STOP",
    "  npm run replicate:research -- --write-freeze --wave wave-2   write ONLY that wave's own canonical freeze, bind its manifest, and STOP",
    "  npm run replicate:research -- --verify-freeze    verify the stored freeze against the live code (read-only)",
    "  npm run replicate:research -- --verify-freeze --wave wave-2  verify THAT wave's own freeze (read-only)",
    "  npm run replicate:research -- --cohorts          inspect the frozen research cohorts (read-only)",
    "  npm run replicate:research -- --plan             discover datasets, print the deterministic plan (no execution)",
    "  npm run replicate:research -- --summary          print the summary of existing artifacts (read-only)",
    "  npm run replicate:research -- --meta-summary     read-only cross-wave meta-summary (no execution, NOT cross-validation)",
    "",
    "Wave-scoped (Phase 5C.2/5C.3) — membership is predeclared by a wave manifest and each\nwave is canonical against its OWN freeze artifact:",
    "  npm run replicate:research -- --wave wave-2 --plan          plan the predeclared wave, execute nothing",
    "  npm run replicate:research -- --wave wave-2 --summary       summarize the wave's own run artifacts",
    "  npm run replicate:research -- --wave wave-2                 run the wave canonically (no --dev needed once the wave's own freeze exists)",
    "  npm run replicate:research -- --meta-summary --waves wave-1,wave-2",
    "",
    "Comparability: a meta-summary combines waves only when their evaluationContractDigest\nand both frozen cohort digests match; otherwise it reports INCOMPARABLE_WAVES with the\ndiffering fields and refuses to aggregate. NON_CANONICAL (--dev) runs are excluded\nunless --include-noncanonical is passed.",
    "",
    "Normal replication run — the ONLY mode that executes replication units:",
    "  npm run replicate:research -- --freeze phase5c --datasets auto",
    "",
    "Options:",
    `  --freeze <name>       freeze version label (default ${DEFAULT_FREEZE_VERSION})`,
    "  --datasets <auto|ids> comma-separated dataset ids, or `auto` for every eligible dataset (run mode)",
    "                        (mutually exclusive with --wave: a wave's membership is predeclared)",
    "  --wave <id>           scope --plan/--summary/the run to one predeclared replication wave",
    "  --waves <ids>         scope --meta-summary to a subset of waves (default: every wave)",
    "  --providers <list>    providers to run (default mock,deepseek)",
    "  --out <dir>           replication root (default .evolve/replication)",
    "  --rerun               normal run only: explicitly re-execute units that already COMPLETED (labelled)",
    "  --dev                 normal run only: allow a run whose commit/tree does not match the freeze; evidence is labelled NON_CANONICAL",
    "  --include-noncanonical  --meta-summary only: also include NON_CANONICAL (--dev) runs in the meta-summary",
    "  --json                machine-readable output",
    "",
    "The unit of replication is the DATASET. Synthetic datasets are never counted",
    "as real, overlapping captures are never treated as independent, and no",
    "walk-forward window is ever counted as a separate dataset.",
  ].join("\n");
}

function fail(message) {
  console.error(`[replicate:research] ${message}`);
  process.exitCode = 1;
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

function providersFromArgs(args) {
  return String(args.providers ?? "mock,deepseek")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

/* ============================================================================
 * Shared loaders
 * ==========================================================================*/

/**
 * Load the STORED freeze artifact. Read-only: no mode except `--write-freeze`
 * ever writes one, so a normal run can never self-certify against a freeze it
 * just created.
 */
async function requireFreeze({ baseDir, freezeVersion, action }) {
  const freeze = await readFreeze({ root: baseDir });
  if (!freeze) {
    fail(
      `no freeze artifact at ${freezePath(baseDir)} — run \`npm run replicate:research -- --write-freeze\` first ` +
        `(--${action} never writes one)`,
    );
    return null;
  }
  if (freeze.freezeVersion !== freezeVersion) {
    console.warn(
      `[replicate:research] WARNING: stored freeze is '${freeze.freezeVersion}' but '${freezeVersion}' was requested — using the stored artifact.`,
    );
  }
  return freeze;
}

/**
 * READ-ONLY frozen-cohort load, shared by EVERY command (including the normal
 * run). None of them can create or rewrite a frozen cohort: a frozen cohort is
 * immutable evidence, and a wave that only REFERENCES the frozen Mock/DeepSeek
 * cohorts never rewrites their manifests. Returns the manifests that exist plus
 * the missing keys, so the caller fails closed with an explicit reason.
 */
async function loadCohorts(baseDir) {
  return loadFrozenCohorts({ baseDir, keys: [...FROZEN_COHORT_KEYS] });
}

function cohortDigestsOf(cohorts) {
  return Object.fromEntries(
    Object.entries(cohorts).map(([key, manifest]) => [key, manifest?.cohortDigest ?? null]),
  );
}

/**
 * Load the freeze a WAVE is canonical against (Phase 5C.3).
 *
 * A wave owns its own freeze artifact (`freezePath`, relative to the
 * replication root). The historical Wave 1 points at the root freeze; Wave 2
 * points at `freezes/wave-2.json`. FAILS CLOSED on every failure mode:
 *
 *   * no `freezePath` / an unsafe path        -> refuse
 *   * not bound yet (no `freezeDigest`)      -> refuse (run --write-freeze --wave <id>)
 *   * freeze file missing                    -> refuse
 *   * freeze digest != manifest pin (STALE)  -> refuse
 *   * evaluation contract != manifest pin     -> refuse (not comparable)
 */
async function loadWaveFreeze({ baseDir, waveId, manifest, freezeVersion }) {
  if (!manifest) {
    fail(`no replication-wave manifest '${waveId}' was loaded`);
    return null;
  }
  if (!isSafeFreezePath(manifest.freezePath)) {
    fail(
      `wave '${waveId}' records no safe per-wave freezePath (got ${JSON.stringify(manifest.freezePath ?? null)}) — refusing to continue`,
    );
    return null;
  }
  const file = manifest.freezePath;
  const target = path.join(baseDir, file);
  if (!waveFreezeBound(manifest)) {
    fail(
      `wave '${waveId}' has NO canonical per-wave freeze yet (freezePath ${file}). A wave is never run against another wave's freeze: ` +
        `commit the implementing code, then run \`npm run replicate:research -- --write-freeze --wave ${waveId}\` (missing/stale freezes fail closed, and a run never writes one).`,
    );
    return null;
  }
  const freeze = await readFreeze({ root: baseDir, file });
  if (!freeze) {
    fail(
      `the per-wave freeze for '${waveId}' is missing at ${target} — the manifest pins freezeDigest ${manifest.freezeDigest}. ` +
        `Run \`npm run replicate:research -- --write-freeze --wave ${waveId}\` after committing the implementing code.`,
    );
    return null;
  }
  if (freeze.freezeDigest !== manifest.freezeDigest) {
    fail(
      `the per-wave freeze for '${waveId}' is STALE: stored digest ${freeze.freezeDigest} does not match the manifest pin ${manifest.freezeDigest} ` +
        `(${target}). Re-freeze from the intended commit instead of running against a stale artifact.`,
    );
    return null;
  }
  if (freeze.freezeVersion !== freezeVersion) {
    console.warn(
      `[replicate:research] WARNING: wave '${waveId}' freeze is '${freeze.freezeVersion}' but '${freezeVersion}' was requested — using the wave's own artifact.`,
    );
  }
  const contract = evaluationContractDigest(freeze);
  if (contract !== manifest.evaluationContractDigest) {
    const comparison = compareEvaluationContracts(
      { waveId, freezeDigest: freeze.freezeDigest, evaluationContractDigest: contract },
      {
        waveId: "wave-1 (historical)",
        evaluationContractDigest: CANONICAL_EVALUATION_CONTRACT_DIGEST,
      },
    );
    fail(
      `wave '${waveId}' is NOT COMPARABLE with the historical canonical wave: evaluation contract ${contract} does not match the manifest pin ` +
        `${manifest.evaluationContractDigest ?? "none"} (differing field(s): ${comparison.differences.map((row) => row.field).join(", ") || "none"}). ` +
        "Fix the evaluator semantics before freezing; waves with different evaluation contracts are never combined.",
    );
    return null;
  }
  return freeze;
}

/**
 * Resolve the identity inputs needed by `--cohorts`, `--plan`, `--summary` and
 * the normal run: the freeze the command is canonical against, the frozen
 * cohorts, and the deterministic replication id. Never discovers datasets and
 * never builds a plan.
 *
 * Phase 5C.3: for a wave-scoped command the freeze is the WAVE'S OWN artifact
 * (loaded fail-closed above), never the historical root freeze.
 */
async function resolveContext({ baseDir, freezeVersion, providers, action, waveId = null }) {
  const waveManifest = waveId ? await readWaveManifest(baseDir, waveId) : null;
  if (waveId && !waveManifest) {
    fail(
      `no replication-wave manifest '${waveId}' at ${waveManifestPath(baseDir, waveId)} — waves are ` +
        `predeclared; a wave without a manifest cannot be planned, run or summarized (fail closed).`,
    );
    return null;
  }

  const freeze = waveManifest
    ? await loadWaveFreeze({ baseDir, waveId, manifest: waveManifest, freezeVersion })
    : await requireFreeze({ baseDir, freezeVersion, action });
  if (!freeze) return null;

  // READ-ONLY. A frozen cohort is immutable evidence, so no command — not even
  // the normal run — may create or refresh one here. Missing cohorts fail closed
  // rather than being silently created by a read-only command.
  const { manifests: cohorts, missing } = await loadCohorts(baseDir);
  if (missing.length > 0) {
    fail(
      `no frozen cohort manifest for ${missing.join(", ")} under ${path.join(baseDir, "cohorts")} — ` +
        `--${action} only READS the immutable frozen cohorts; they are created once by the explicit freeze-creation lifecycle ` +
        `(\`freezeCohorts\`), never by a plan/summary/run.`,
    );
    return null;
  }

  const cohortDigests = cohortDigestsOf(cohorts);

  // Phase 5C.2/5C.3: a wave-scoped command binds its identity to the
  // PREDECLARED wave manifest (its digest pins membership + fingerprints +
  // cohorts + the wave's OWN freeze digest), so it can never be confused with
  // the canonical Wave 1 replication id or with any other wave. A wave-less
  // command keeps the original identity, byte for byte.
  let manifest = waveManifest;
  let replicationId = null;
  if (waveId) {
    replicationId = manifest.replicationId ?? waveReplicationIdFor({
      freezeDigest: freeze.freezeDigest,
      cohortDigests,
      providers,
      evaluation: evaluationKey(freeze),
      waveId: manifest.waveId,
      manifestDigest: manifest.manifestDigest,
    });
  } else {
    replicationId = replicationIdFor({
      freezeDigest: freeze.freezeDigest,
      cohortDigests,
      providers,
      evaluation: evaluationKey(freeze),
    });
  }

  return {
    freeze,
    cohorts,
    cohortDigests,
    replicationId,
    manifest,
    waveId,
    frozen: { ...freeze, replicationId, cohortDigests },
  };
}

/**
 * Validate a predeclared wave manifest against the live registry, the stored
 * freeze and the frozen cohorts. FAILS CLOSED: any failed invariant aborts the
 * command before a plan is built and before any unit could run.
 */
async function loadWaveFor({ baseDir, waveId, manifest, registry, freeze, cohorts }) {
  if (!manifest) {
    fail(`no replication-wave manifest '${waveId}' was loaded`);
    return null;
  }
  const priorWaves = (await listWaveManifests(baseDir)).filter((wave) => wave.waveId !== manifest.waveId);
  const validation = validateWaveManifest({ manifest, registry, frozen: freeze, cohorts, priorWaves });
  if (!validation.ok) {
    fail(`wave '${waveId}' failed validation (${validation.failures.length} invariant(s)) — refusing to continue:`);
    for (const row of validation.failures) console.error(`[replicate:research]   - ${row.check}: ${row.message}`);
    return null;
  }
  const membership = waveMembership({ manifest, registry });
  if (membership.unknown.length > 0 || membership.mismatched.length > 0) {
    fail(
      `wave '${waveId}' membership could not be resolved: unknown [${membership.unknown.join(", ")}] ` +
        `mismatched [${membership.mismatched.map((row) => row.datasetId).join(", ")}]`,
    );
    return null;
  }
  return { manifest, validation, membership, priorWaves };
}

/** Dataset registry discovery. Only `--plan`, `--summary` and the run use it. */
async function buildRegistryFor({ baseDir, cohorts }) {
  const config = createMarketConfig(
    { ...process.env, EVOLVE_MARKET_MODE: process.env.EVOLVE_MARKET_MODE ?? "synthetic" },
    { loadEnv: true },
  );
  const historyRoot = config.historyRoot ?? path.join(".evolve", "history");
  const arenasDir = process.env.EVOLVE_ARENAS_DIR ?? path.join(".evolve", "arenas");
  const [records, arenaUsage] = await Promise.all([
    discoverDatasetRecords(historyRoot),
    collectArenaDatasetUsage(arenasDir),
  ]);
  const registry = buildReplicationRegistry({ records, cohorts, arenaUsage });
  registry.baseDir = baseDir;
  registry.freezeDigest = null;
  registry.historyRoot = historyRoot;
  return { registry, config, historyRoot, arenasDir };
}

/** Explicit `--datasets <ids>` selection or `auto` over the eligible sample. */
function selectDatasets(registry, args) {
  const requestedIds = args.datasets === undefined ? "auto" : String(args.datasets);
  const explicit = requestedIds.trim().toLowerCase() === "auto"
    ? null
    : requestedIds.split(",").map((value) => value.trim()).filter(Boolean);
  const selection = explicit
    ? {
        mode: "explicit",
        datasetIds: explicit.filter((id) => registry.roles[id] === "REPLICATION"),
        datasets: registry.records.filter(
          (record) => explicit.includes(record.datasetId) && registry.roles[record.datasetId] === "REPLICATION",
        ),
        unknown: explicit.filter((id) => !registry.records.some((record) => record.datasetId === id)),
        ineligible: explicit
          .filter((id) => registry.records.some((record) => record.datasetId === id) && registry.roles[id] !== "REPLICATION")
          .map((id) => ({ datasetId: id, role: registry.roles[id], reasons: registry.eligibility[id]?.reasons ?? [] })),
      }
    : { mode: "auto", datasetIds: [...registry.selectedIds], datasets: [...registry.selected], unknown: [], ineligible: [] };

  if (selection.unknown.length > 0) fail(`unknown dataset id(s): ${selection.unknown.join(", ")}`);
  return selection;
}

/** Aggregate the EXISTING run artifacts for a replication id. Read-only. */
async function summarizeExisting({ baseDir, context, registry, providers }) {
  const runDir = path.join(baseDir, context.replicationId);
  const existingManifest = await loadRunManifest(runDir);
  const summary = aggregateReplication({
    replicationId: context.replicationId,
    freezeDigest: context.freeze.freezeDigest,
    units: existingManifest?.units ?? [],
    registry,
    datasetRegimes: existingManifest?.regimes ?? {},
    providers: providers.length >= 2 ? ["mock", "deepseek"] : providers,
  });
  return { runDir, existingManifest, summary };
}

/* ============================================================================
 * Actions
 * ==========================================================================*/

/**
 * `--write-freeze`: build/update the freeze artifact, print it, and STOP.
 *
 * It deliberately does NOT: freeze cohorts, discover datasets, build a plan,
 * spawn an Arena subprocess, or execute a single replication unit.
 */
async function writeFreezeOnly({ args, baseDir, freezeVersion, waveId }) {
  if (waveId) return writeWaveFreezeOnly({ args, baseDir, freezeVersion, waveId });
  const target = freezePath(baseDir);
  const previous = await readFreeze({ root: baseDir });
  const freeze = await writeFreeze(
    buildFreezeConfig({
      freezeVersion,
      commit: readGitCommit(),
      dirty: readWorkingTreeDirty(),
    }),
    { root: baseDir },
  );

  if (args.json === true) {
    printJson({
      action: ACTION.WRITE_FREEZE,
      path: target,
      freezeVersion: freeze.freezeVersion,
      freezeDigest: freeze.freezeDigest,
      previousFreezeDigest: previous?.freezeDigest ?? null,
      digestChanged: Boolean(previous) && previous.freezeDigest !== freeze.freezeDigest,
      commit: freeze.commit,
      dirtyWorkingTree: freeze.dirtyWorkingTree,
      unitsExecuted: 0,
    });
  } else {
    console.log(`[replicate:research] freeze artifact: ${target}`);
    console.log(`[replicate:research] freeze digest:   ${freeze.freezeDigest}`);
    if (previous && previous.freezeDigest !== freeze.freezeDigest) {
      console.log(
        `[replicate:research] note: the stored freeze digest changed (${previous.freezeDigest} -> ${freeze.freezeDigest})`,
      );
    }
    console.log(
      "[replicate:research] freeze written — stopping. No cohorts were frozen, no datasets were discovered, " +
        "no plan was built, and no replication unit was executed.",
    );
  }
  // `--write-freeze` is an ACTION, not a modifier. This is the end of the command.
  return;
}

/**
 * `--write-freeze --wave <id>` (Phase 5C.3): write ONLY that wave's own freeze,
 * bind its manifest, and STOP.
 *
 * Invariants enforced here:
 *   * a CLEAN git worktree is required (a freeze must describe pushed, exact code);
 *   * the current HEAD is captured as the wave's commit;
 *   * the freeze is built from the LIVE evaluator semantics — no config override;
 *   * the frozen Mock and DeepSeek cohorts must already exist with the digests the
 *     wave manifest pins (they are REUSED, never re-frozen);
 *   * the new freeze's evaluation contract must equal the wave's pinned contract,
 *     otherwise the wave would not be comparable and the freeze is REFUSED;
 *   * only `<baseDir>/<manifest.freezePath>` and the wave manifest are written;
 *   * zero Arena units, zero Jev calls, zero DeepSeek/provider calls.
 */
async function writeWaveFreezeOnly({ args, baseDir, freezeVersion, waveId }) {
  const manifest = await readWaveManifest(baseDir, waveId);
  if (!manifest) {
    fail(`no replication-wave manifest '${waveId}' at ${waveManifestPath(baseDir, waveId)} — waves are predeclared (fail closed).`);
    return;
  }
  if (isHistoricalWave(manifest)) {
    fail(`wave '${waveId}' is HISTORICAL — its freeze (${manifest.freezePath}) is permanent evidence and is never rewritten.`);
    return;
  }
  if (!isSafeFreezePath(manifest.freezePath)) {
    fail(`wave '${waveId}' records no safe per-wave freezePath (got ${JSON.stringify(manifest.freezePath ?? null)}).`);
    return;
  }
  const definition = waveDefinitionFor(manifest.waveId);
  const match = waveDefinitionMatch({ manifest, definition });
  if (!match.ok) {
    fail(
      `wave '${waveId}' no longer matches its predeclared definition (drifted: ${match.drifted.join(", ")}) — refusing to freeze a tampered wave.`,
    );
    return;
  }

  const dirty = readWorkingTreeDirty();
  if (dirty !== false) {
    fail(
      `the working tree is ${dirty === true ? "dirty" : "not verifiable as clean"} — a canonical per-wave freeze requires a CLEAN git worktree ` +
        "(commit and push the implementing code first). Nothing was written.",
    );
    return;
  }
  const commit = readGitCommit();
  if (!commit) {
    fail("no git commit could be read — a canonical per-wave freeze requires a committed revision. Nothing was written.");
    return;
  }

  // The frozen cohorts are REUSED: they must already exist and match the pins.
  const cohorts = {};
  for (const key of ["mock", "deepseek"]) {
    const frozen = await readFrozenCohort(baseDir, key);
    const pinned = key === "mock" ? manifest.mockCohortDigest : manifest.deepseekCohortDigest;
    if (!frozen || frozen.cohortDigest !== pinned) {
      fail(
        `the frozen ${key} cohort does not match the wave pin (${frozen?.cohortDigest ?? "none"} vs ${pinned ?? "none"}) — ` +
          "the frozen cohorts are created once by the explicit freeze-creation lifecycle and are never rewritten by a per-wave freeze. Nothing was written.",
      );
      return;
    }
    cohorts[key] = frozen;
  }

  const previous = await readFreeze({ root: baseDir, file: manifest.freezePath });
  const freeze = await writeFreeze(
    buildFreezeConfig({ freezeVersion, commit, dirty: false }),
    { root: baseDir, file: manifest.freezePath },
  );
  const contract = evaluationContractDigest(freeze);
  if (manifest.evaluationContractDigest && contract !== manifest.evaluationContractDigest) {
    fail(
      `the new freeze's evaluation contract ${contract} does not match the wave's pinned contract ${manifest.evaluationContractDigest}. ` +
        "The wave would not be comparable with the historical canonical wave, so the freeze is REFUSED (the artifact was written; do not run until the evaluator semantics are restored or the contract is deliberately re-pinned).",
    );
    process.exitCode = 1;
    return;
  }

  const cohortDigests = Object.fromEntries(Object.entries(cohorts).map(([key, value]) => [key, value.cohortDigest]));
  const bound = bindWaveManifest({
    manifest,
    freezePath: manifest.freezePath,
    freezeDigest: freeze.freezeDigest,
    evaluationContractDigest: contract,
    status: manifest.status,
  });
  const withId = bindWaveManifest({
    manifest: bound,
    freezePath: bound.freezePath,
    freezeDigest: bound.freezeDigest,
    evaluationContractDigest: bound.evaluationContractDigest,
    replicationId: waveReplicationIdFor({
      freezeDigest: freeze.freezeDigest,
      cohortDigests,
      providers: ["mock", "deepseek"],
      evaluation: evaluationKey(freeze),
      waveId: bound.waveId,
      manifestDigest: bound.manifestDigest,
    }),
  });
  const stored = await writeWaveManifest(baseDir, withId, { overwrite: true });

  if (args.json === true) {
    printJson({
      action: ACTION.WRITE_FREEZE,
      waveId,
      path: path.join(baseDir, stored.freezePath),
      freezeVersion: freeze.freezeVersion,
      freezeDigest: freeze.freezeDigest,
      previousFreezeDigest: previous?.freezeDigest ?? null,
      digestChanged: Boolean(previous) && previous.freezeDigest !== freeze.freezeDigest,
      evaluationContractDigest: contract,
      commit: freeze.commit,
      dirtyWorkingTree: freeze.dirtyWorkingTree,
      manifestDigest: stored.manifestDigest,
      replicationId: stored.replicationId,
      historicalFreezeUntouched: true,
      cohortsReused: cohortDigests,
      unitsExecuted: 0,
      jevCalls: 0,
      providerCalls: 0,
    });
  } else {
    console.log(`[replicate:research] wave ${waveId} freeze artifact: ${path.join(baseDir, stored.freezePath)}`);
    console.log(`[replicate:research] wave ${waveId} freeze digest:   ${freeze.freezeDigest}`);
    console.log(`[replicate:research] evaluation contract:          ${contract}`);
    console.log(`[replicate:research] commit:                       ${freeze.commit}`);
    console.log(`[replicate:research] manifest digest:              ${stored.manifestDigest}`);
    console.log(`[replicate:research] replication id:               ${stored.replicationId}`);
    if (previous && previous.freezeDigest !== freeze.freezeDigest) {
      console.log(`[replicate:research] note: the wave freeze digest changed (${previous.freezeDigest} -> ${freeze.freezeDigest})`);
    }
    console.log(
      "[replicate:research] per-wave freeze written and manifest bound — stopping. The historical Wave 1 freeze was NOT touched; " +
        "no cohort was re-frozen, no dataset was discovered, no plan was built, and no replication unit was executed.",
    );
  }
  // `--write-freeze --wave` is an ACTION, not a modifier. End of command.
  return;
}

/** `--verify-freeze`: verify only. Read-only, zero replication execution. */
async function verifyFreezeOnly({ args, baseDir, freezeVersion, waveId }) {
  // A wave verification targets the wave's OWN freeze; the historical freeze
  // version only applies to the wave-less form.
  if (waveId) return verifyWaveFreezeOnly({ args, baseDir, waveId });
  const freeze = await requireFreeze({ baseDir, freezeVersion, action: ACTION.VERIFY_FREEZE });
  if (!freeze) return;
  const verify = verifyFreeze(freeze);
  if (args.json === true) {
    printJson({ ...verify, action: ACTION.VERIFY_FREEZE, unitsExecuted: 0 });
  } else {
    console.log(formatFreezeVerification(verify, { frozenDigest: freeze?.freezeDigest ?? null }));
  }
  if (!verify.ok) process.exitCode = 1;
  return;
}

/**
 * `--verify-freeze --wave <id>` (Phase 5C.3): verify the wave's OWN freeze
 * against the live code plus the manifest's identity pins. Read-only.
 */
async function verifyWaveFreezeOnly({ args, baseDir, waveId }) {
  const manifest = await readWaveManifest(baseDir, waveId);
  if (!manifest) {
    fail(`no replication-wave manifest '${waveId}' at ${waveManifestPath(baseDir, waveId)} (fail closed).`);
    return;
  }
  const freeze = waveFreezeBound(manifest)
    ? await readFreeze({ root: baseDir, file: manifest.freezePath })
    : null;
  if (!freeze) {
    fail(
      `wave '${waveId}' has no per-wave freeze at ${path.join(baseDir, manifest.freezePath ?? "<none>")} — ` +
        `run \`npm run replicate:research -- --write-freeze --wave ${waveId}\` after committing the implementing code.`,
    );
    return;
  }
  const verify = verifyFreeze(freeze);
  const contract = evaluationContractDigest(freeze);
  const identity = {
    waveId,
    freezePath: manifest.freezePath,
    freezeDigest: freeze.freezeDigest,
    manifestPinMatchesStored: freeze.freezeDigest === manifest.freezeDigest,
    evaluationContractDigest: contract,
    evaluationContractMatchesPin: contract === manifest.evaluationContractDigest,
    comparableWithHistoricalContract: contract === CANONICAL_EVALUATION_CONTRACT_DIGEST,
    replicationId: manifest.replicationId ?? null,
  };
  if (args.json === true) {
    printJson({ ...verify, action: ACTION.VERIFY_FREEZE, ...identity, unitsExecuted: 0 });
  } else {
    console.log(formatFreezeVerification(verify, { frozenDigest: freeze.freezeDigest }));
    console.log("");
    console.log(`[replicate:research] wave ${waveId} freeze path:        ${path.join(baseDir, manifest.freezePath)}`);
    console.log(`[replicate:research] manifest pin matches stored: ${identity.manifestPinMatchesStored}`);
    console.log(`[replicate:research] evaluation contract:        ${contract}`);
    console.log(`[replicate:research] contract matches wave pin:   ${identity.evaluationContractMatchesPin}`);
  }
  if (!verify.ok || identity.manifestPinMatchesStored !== true || identity.evaluationContractMatchesPin !== true) {
    process.exitCode = 1;
  }
  return;
}

/**
 * `--cohorts`: inspect the frozen cohorts. READ-ONLY: it loads the immutable
 * frozen cohorts and never creates or rewrites one, never plans a unit and
 * never executes a unit.
 */
async function cohortsOnly({ args, baseDir, freezeVersion, providers }) {
  const context = await resolveContext({ baseDir, freezeVersion, providers, action: ACTION.COHORTS });
  if (!context) return;
  if (args.json === true) {
    printJson({
      action: ACTION.COHORTS,
      replicationId: context.replicationId,
      cohorts: Object.fromEntries(
        Object.entries(context.cohorts).map(([key, manifest]) => [key, inspectCohort(manifest)]),
      ),
      unitsExecuted: 0,
    });
  } else {
    console.log(formatCohortInspection(context.cohorts));
  }
  return;
}

/** `--plan`: discover/select datasets and print the deterministic plan. */
async function planOnly({ args, baseDir, freezeVersion, providers, waveId }) {
  const context = await resolveContext({ baseDir, freezeVersion, providers, action: ACTION.PLAN, waveId });
  if (!context) return;

  const { registry } = await buildRegistryFor({ baseDir, cohorts: context.cohorts });
  registry.freezeDigest = context.freeze.freezeDigest;
  let wave = null;
  if (waveId) {
    wave = await loadWaveFor({ baseDir, waveId, manifest: context.manifest, registry, freeze: context.freeze, cohorts: context.cohorts });
    if (!wave) return;
  }
  const selection = wave
    ? { mode: "wave", datasetIds: [...wave.membership.datasetIds], datasets: [...wave.membership.datasets], unknown: [], ineligible: [] }
    : selectDatasets(registry, args);
  const plan = planReplication({
    freeze: context.frozen,
    cohorts: context.cohorts,
    datasets: selection.datasets,
    providers,
  });
  const { existingManifest, summary } = await summarizeExisting({ baseDir, context, registry, providers });

  // Phase 5C: `--plan` executes NOTHING, so its status comes from the datasets
  // this command SELECTED (readiness) and from the units already RECORDED for
  // this replication id (execution). The number of completed clean datasets is
  // reported as EVIDENCE — never as readiness — so a three-dataset plan can no
  // longer be reported as "insufficient independent datasets" just because no
  // unit has run yet.
  const status = buildPlanStatus({
    selectedDatasetIds: selection.datasetIds,
    units: plan.units,
    recordedUnits: existingManifest?.units ?? [],
    completedCleanDatasets: summary.datasetCoverage?.cleanCompletedDatasets ?? 0,
  });

  if (args.json === true) {
    printJson({
      action: ACTION.PLAN,
      replicationId: context.replicationId,
      freezeDigest: context.freeze.freezeDigest,
      wave: wave ? describeWaveManifest(wave.manifest) : null,
      waveValidation: wave ? wave.validation.checks : null,
      datasetIds: selection.datasetIds,
      units: plan.units,
      ...status,
      unitsExecuted: 0,
    });
  } else {
    if (wave) {
      console.log(formatWaveHeader(wave.manifest));
      console.log("");
    }
    console.log(formatDatasetRegistry(registry));
    console.log("");
    console.log(`Planned replication ${context.replicationId} — ${plan.units.length} unit(s):`);
    for (const unit of plan.units) console.log(`  ${unit.unitId}  ${unit.provider.padEnd(9)} ${unit.datasetId}`);
    console.log("");
    console.log(formatPlanStatus(status, { waveId: wave?.manifest?.waveId ?? null }));
    console.log("");
    console.log("[replicate:research] plan only — no Arena subprocess was started and no unit was executed.");
    // The guidance is about a genuinely short SELECTION, not about a plan that
    // has simply not executed yet.
    if (status.sufficientSelectedDatasets !== true) {
      console.log("");
      console.log(formatCaptureGuidance(registry, { selection }));
    }
  }
  return;
}

/** `--summary`: read existing artifacts only. Zero Arena execution. */
async function summaryOnly({ args, baseDir, freezeVersion, providers, waveId }) {
  const context = await resolveContext({
    baseDir,
    freezeVersion,
    providers,
    action: ACTION.SUMMARY,
    waveId,
  });
  if (!context) return;

  const { registry } = await buildRegistryFor({ baseDir, cohorts: context.cohorts });
  registry.freezeDigest = context.freeze.freezeDigest;
  let wave = null;
  if (waveId) {
    wave = await loadWaveFor({ baseDir, waveId, manifest: context.manifest, registry, freeze: context.freeze, cohorts: context.cohorts });
    if (!wave) return;
  }
  const { summary } = await summarizeExisting({ baseDir, context, registry, providers });

  if (args.json === true) {
    printJson({
      ...summary,
      action: ACTION.SUMMARY,
      wave: wave ? describeWaveManifest(wave.manifest) : null,
      unitsExecuted: 0,
    });
  } else {
    if (wave) {
      console.log(formatWaveHeader(wave.manifest));
      console.log("");
    }
    console.log(formatReplicationSummary(summary));
    if (summary.datasetAvailability.status === "INSUFFICIENT_INDEPENDENT_REAL_DATASETS") {
      console.log("");
      console.log(formatCaptureGuidance(registry));
    }
    console.log("");
    console.log("[replicate:research] summary only — no Arena subprocess was started and no unit was executed.");
  }
  return;
}

/**
 * `--meta-summary`: a READ-ONLY cross-wave meta-summary. It reads the already
 * written wave manifests and the `summary.json` artifacts of completed waves,
 * and never executes a replication unit. This is not cross-validation.
 *
 * Phase 5C.3: it refuses to combine waves whose evaluation contracts differ
 * (INCOMPARABLE_WAVES with the differing fields) and excludes NON_CANONICAL
 * (`--dev`) runs unless `--include-noncanonical` is passed.
 */
async function metaSummaryOnly({ args, baseDir, waveIds }) {
  const meta = await loadMetaSummary({
    baseDir,
    waveIds,
    includeNoncanonical: args["include-noncanonical"] === true,
  });
  if (meta.unknownWaveIds.length > 0) {
    fail(`unknown replication wave id(s): ${meta.unknownWaveIds.join(", ")} (known: ${meta.waves.map((row) => row.waveId).join(", ") || "none"})`);
    return;
  }
  if (args.json === true) {
    printJson({ action: ACTION.META_SUMMARY, unitsExecuted: 0, ...meta });
  } else {
    console.log(formatMetaSummary(meta));
    console.log("");
    console.log("[replicate:research] meta-summary only — no Arena subprocess was started and no unit was executed.");
  }
  if (meta.comparability && meta.comparability.status === "INCOMPARABLE_WAVES") {
    fail(
      "INCOMPARABLE_WAVES: the selected waves do not share one evaluation contract, so they were NOT aggregated " +
        `(differing field(s): ${meta.comparability.differences.map((row) => row.field).join(", ") || "none"}).`,
    );
    return;
  }
  return;
}

/**
 * NORMAL RUN — the only mode that may execute replication units. Requires the
 * freeze artifact to already exist (written by `--write-freeze`), so a run can
 * never certify itself against a freeze it just created.
 */
async function runReplicationCommand({ args, baseDir, freezeVersion, providers, waveId }) {
  const context = await resolveContext({ baseDir, freezeVersion, providers, action: ACTION.RUN, waveId });
  if (!context) return;
  const { freeze, cohorts, replicationId } = context;

  const { registry, config } = await buildRegistryFor({ baseDir, cohorts });
  registry.freezeDigest = freeze.freezeDigest;

  let wave = null;
  if (waveId) {
    wave = await loadWaveFor({ baseDir, waveId, manifest: context.manifest, registry, freeze, cohorts });
    if (!wave) return;
    // A historical wave is permanent evidence: it is never re-run. Wave 1 in
    // particular must stay byte-identical, and re-executing it would produce a
    // second, differently-labelled run under the historical replication id.
    if (isHistoricalWave(wave.manifest)) {
      fail(
        `wave '${waveId}' is HISTORICAL (already evaluated as ${wave.manifest.replicationId ?? "an existing replication"}) — ` +
          "historical waves are never re-run. Nothing was executed.",
      );
      return;
    }
    if (args.json !== true) console.log(formatWaveHeader(wave.manifest));
  }
  // A wave's dataset selection comes ONLY from its predeclared manifest —
  // `--datasets auto` is refused for a wave (see resolveWaveOptions).
  const selection = wave
    ? { mode: "wave", datasetIds: [...wave.membership.datasetIds], datasets: [...wave.membership.datasets], unknown: [], ineligible: [] }
    : selectDatasets(registry, args);

  const noEligible = selection.datasets.length === 0;
  if (!noEligible && selection.datasets.length < MIN_CLEAN_TO_RUN) {
    console.warn(
      `[replicate:research] only ${selection.datasets.length} eligible CLEAN dataset(s): primary multi-dataset replication requires ${MIN_CLEAN_TO_RUN}.`,
    );
  }

  const plan = planReplication({ freeze, cohorts, datasets: selection.datasets, providers });

  // Not enough ELIGIBLE datasets selected: report instead of executing anything.
  // The refusal is a READINESS statement (the selection is short), so it is
  // derived from the selection — never from "zero units have completed yet".
  if (noEligible || selection.datasets.length < MIN_CLEAN_TO_RUN) {
    const { summary } = await summarizeExisting({ baseDir, context, registry, providers });
    const readiness = datasetReadinessFor({ selectedCleanDatasets: selection.datasets.length });
    if (args.json === true) {
      printJson({
        ...summary,
        action: ACTION.RUN,
        ran: false,
        datasetReadiness: readiness.status,
        sufficientSelectedDatasets: readiness.sufficient,
        unitsExecuted: 0,
      });
    } else {
      console.log(formatReplicationSummary(summary));
      if (readiness.sufficient !== true) {
        console.log("");
        console.log(formatCaptureGuidance(registry, { selection }));
      }
    }
    console.log("");
    console.log(
      `[replicate:research] not running: ${selection.datasets.length} eligible CLEAN dataset(s) is below the required ${MIN_CLEAN_TO_RUN}. No unit was executed.`,
    );
    return;
  }

  const runDir = path.join(baseDir, replicationId);

  const canonicality = canonicalityVerdict({
    frozen: freeze,
    commit: readGitCommit(),
    dirty: readWorkingTreeDirty(),
    devOverride: args.dev === true,
  });
  if (!canonicality.clean && args.dev !== true) {
    console.error(`[replicate:research] NON-CANONICAL RUN REFUSED: ${canonicality.reasons.join("; ")}`);
    console.error("[replicate:research] pass --dev to run anyway; the resulting evidence is permanently labelled NON_CANONICAL.");
    process.exitCode = 1;
    return;
  }

  const existingManifest = await loadRunManifest(runDir);
  if (existingManifest?.replicationId === replicationId) {
    const allTerminal = plan.units.every((unit) =>
      (existingManifest.units ?? []).some(
        (row) =>
          row.unitId === unit.unitId &&
          ["COMPLETED", "FAILED", "SKIPPED", "INVALID_DATASET", "CONTAMINATED"].includes(row.status),
      ),
    );
    if (allTerminal && args.rerun !== true) {
      console.log(
        `[replicate:research] existing identical run detected: ${replicationId} — resuming (nothing to do). Use --rerun to re-execute completed units.`,
      );
    }
  }

  const regimes = {};
  if (process.env.EVOLVE_REPLICATION_REGIMES === "1") {
    for (const dataset of selection.datasets) {
      try {
        regimes[dataset.datasetId] = await computeDatasetRegimes(dataset.dir, config);
      } catch (error) {
        regimes[dataset.datasetId] = {
          datasetId: dataset.datasetId,
          composition: null,
          unavailable: String(error?.message ?? error),
        };
      }
    }
  }

  const frozenCohortDirs = Object.fromEntries(Object.keys(cohorts).map((key) => [key, cohortDirFor(baseDir, key)]));
  const result = await runReplication({
    runDir,
    freeze,
    replicationId,
    units: plan.units,
    frozenCohortDirs,
    rerun: args.rerun === true,
    canonicality,
    onProgress: (message) => console.log(message),
  });

  if (Object.keys(regimes).length > 0) {
    await writeRunManifest(runDir, { ...result.manifest, regimes });
    result.manifest.regimes = regimes;
  }

  // Phase 5C.2: annotate the run with the predeclared wave it belongs to, and
  // flip the wave manifest's lifecycle status once it has genuinely completed.
  // `status` is not digested, so this never changes the wave's identity.
  if (wave) {
    result.manifest = await writeRunManifest(runDir, {
      ...result.manifest,
      wave: describeWaveManifest(wave.manifest),
      waveManifestDigest: wave.manifest.manifestDigest,
    });
    if (result.manifest.status === "COMPLETED") {
      await writeWaveManifest(baseDir, { ...wave.manifest, status: WAVE_STATUS.COMPLETED }, { overwrite: true });
    }
  }

  const summary = aggregateReplication({
    replicationId,
    freezeDigest: freeze.freezeDigest,
    units: result.manifest.units,
    registry,
    datasetRegimes: regimes,
    providers: ["mock", "deepseek"],
  });
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path.join(runDir, RUN_SUMMARY_FILE), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  // A tiny projection of the same numbers, so the dashboard never has to load
  // the full summary artifact.
  await writeFile(
    path.join(runDir, RUN_STATUS_FILE),
    `${JSON.stringify(buildStatusArtifact(summary, { manifest: result.manifest }), null, 2)}\n`,
    "utf8",
  );

  if (args.json === true) {
    console.log(JSON.stringify({ manifest: result.manifest, summary }, null, 2));
  } else {
    console.log("");
    console.log(formatReplicationSummary(summary));
    console.log("");
    console.log(`Run manifest: ${path.join(runDir, "manifest.json")}`);
    console.log(`Summary:      ${path.join(runDir, RUN_SUMMARY_FILE)}`);
  }
}

/* ============================================================================
 * Dispatch
 * ==========================================================================*/

async function main() {
  const args = parseArgs(process.argv.slice(2), { booleanFlags: BOOLEAN_FLAGS, valueFlags: VALUE_FLAGS });
  if (args.help === true) {
    console.log(usage());
    return;
  }

  // One action per invocation. Ambiguous or impossible combinations fail here,
  // before anything is written or executed.
  const resolved = resolveAction(args);
  if (!resolved.ok) {
    fail(resolved.error);
    console.error("");
    console.error(usage());
    return;
  }

  // Phase 5C.2 wave selectors. Impossible combinations (a wave on a non-wave
  // mode, `--wave` with `--datasets`, waves on anything but --meta-summary)
  // are rejected before a handler runs, so nothing is planned or executed.
  const waveOptions = resolveWaveOptions(args, resolved.action);
  if (!waveOptions.ok) {
    fail(waveOptions.errors.join("; "));
    console.error("");
    console.error(usage());
    return;
  }

  const context = {
    args,
    baseDir: path.resolve(String(args.out ?? process.env.EVOLVE_REPLICATION_DIR ?? REPLICATION_DIR)),
    freezeVersion: String(args.freeze ?? DEFAULT_FREEZE_VERSION),
    providers: providersFromArgs(args),
    waveId: waveOptions.waveId,
    waveIds: waveOptions.waveIds,
  };

  switch (resolved.action) {
    case ACTION.WRITE_FREEZE:
      return writeFreezeOnly(context);
    case ACTION.VERIFY_FREEZE:
      return verifyFreezeOnly(context);
    case ACTION.COHORTS:
      return cohortsOnly(context);
    case ACTION.PLAN:
      return planOnly(context);
    case ACTION.SUMMARY:
      return summaryOnly(context);
    case ACTION.META_SUMMARY:
      return metaSummaryOnly(context);
    case ACTION.RUN:
      return runReplicationCommand(context);
    default:
      fail(`unknown command mode '${resolved.action}'`);
      return;
  }
}

main().catch((error) => {
  console.error(`[replicate:research] failed: ${error?.message ?? error}`);
  process.exitCode = 1;
});
