#!/usr/bin/env node
/**
 * EVOLVE Phase 5C validation suite — multi-dataset replication (PAPER ONLY).
 *
 * Covers: the deterministic freeze artifact + digest, the frozen Mock and
 * DeepSeek cohort manifests and their immutability, dataset discovery /
 * classification / fingerprints / temporal overlap / eligibility / roles, the
 * leakage matrix, deterministic run identity, resume + rerun behavior, the
 * frozen-cohort staging (so historical artifacts are never written), the strict
 * species-matched A/B invariants still holding, per-dataset metrics, the paired
 * delta-of-deltas, cross-dataset aggregation at the DATASET level, descriptive
 * statistics + dataset-level bootstrap + leave-one-out sensitivity, the
 * replication status vocabulary, and the paper-only / no-execution guarantees.
 *
 * Fully OFFLINE and deterministic: fixtures are built in a temp directory and
 * the only "arena" that ever runs is a fake executor that writes a synthetic
 * A/B artifact. No provider is called; no real Arena is run.
 *
 * Run with: npm run validate:phase5c
 */

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { canonicalJson, digestOf } from "./lib/hash.mjs";
import { DEFAULT_DEPLOYMENT_GATES, ARENA_SCORE_VERSION, REGIMES } from "./arena/orchestrator.mjs";
import { ARENA_RUNNER_VERSION } from "./arena/tournament.mjs";
import { EVALUATOR_VERSION } from "./arena/evaluator.mjs";
import { RESEARCH_PROMPT_VERSION } from "./research/prompt.mjs";
import { PROPOSAL_COMPILER_VERSION } from "./research/compiler.mjs";
import { PROPOSAL_SCHEMA_VERSION } from "./research/proposal-schema.mjs";
import { EVIDENCE_PACKET_VERSION } from "./research/evidence-packet.mjs";
import { DEEPSEEK_CLINE_MODEL, DEEPSEEK_CLINE_REASONING, PROVIDER_STATUS, requireProviderName } from "./research/provider-config.mjs";
import { AB_COHORT, enforceSpeciesMatchInvariant, speciesMatchRequested } from "./research/ab-cohort.mjs";
import { PAPER_ONLY } from "./engine/paper.mjs";
import { METRIC_PATHS, readArenaRun } from "./research-compare.mjs";
import { genomeDigestOf } from "./research/cohort.mjs";

import * as constants from "./replication/constants.mjs";
const { DATASET_ROLE, ELIGIBILITY_CRITERIA } = constants;
import {
  buildFreezeConfig,
  freezeDigest,
  verifyFreeze,
  createFreeze,
  canonicalityVerdict,
  writeFreeze,
  readFreeze,
  ensureFreeze,
} from "./replication/freeze.mjs";
import {
  FROZEN_COHORT_SOURCES,
  buildCohortManifest,
  cohortDigestOf,
  freezeCohorts,
  readFrozenCohort,
  verifyFrozenCohort,
  inspectCohort,
  cohortDirFor,
} from "./replication/cohorts.mjs";
import {
  baseEligibility,
  buildLeakageMatrix,
  buildReplicationRegistry,
  collectArenaDatasetUsage,
  computeDatasetRegimes,
  discoverDatasetRecords,
  overlapMatrix,
  datasetRow,
  temporalOverlap,
} from "./replication/datasets.mjs";
import { evaluationKey, replicationIdFor, unitIdFor, describeIdentity } from "./replication/identity.mjs";
import {
  aggregateReplication,
  datasetBootstrap,
  leaveOneOut,
  meanOf,
  medianOf,
  pairUnits,
  replicationStatusFor,
} from "./replication/aggregate.mjs";
import { buildArenaUnitInvocation, planReplication, runReplication, loadRunManifest, runStatusFromUnits } from "./replication/runner.mjs";
import { formatCaptureGuidance, CAPTURE_COMMANDS } from "./replication/guidance.mjs";
import {
  buildStatusArtifact,
  formatCohortInspection,
  formatDatasetRegistry,
  formatFreezeVerification,
  formatReplicationSummary,
} from "./replication/report.mjs";
import { loadReplicationState } from "./lib/dashboard-state.mjs";

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}
function fail(message) {
  throw new Error(message);
}
function assert(condition, message) {
  if (!condition) fail(message);
}
function assertEqual(actual, expected, message) {
  if (actual !== expected) fail(`${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}
function assertDeepEqual(actual, expected, message) {
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    fail(`${message}\n  expected ${canonicalJson(expected)}\n  actual   ${canonicalJson(actual)}`);
  }
}
function assertClose(actual, expected, tolerance, message) {
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > tolerance) {
    fail(`${message} (expected ~${expected}, got ${actual})`);
  }
}

/* ============================================================================
 * Fixtures
 * ==========================================================================*/

const BASE_MS = 1789646400000; // 2026-09-17T12:00:00Z
const HOUR = 3_600_000;

const REAL_FINGERPRINT_A = "a".repeat(64);
const REAL_FINGERPRINT_B = "b".repeat(64);
const REAL_FINGERPRINT_C = "c".repeat(64);
const REAL_FINGERPRINT_D = "d".repeat(64);

const ctx = { root: null, historyRoot: null, arenasDir: null, baseDir: null };

function manifestFor({
  datasetId,
  startMs,
  durationMinutes,
  snapshotCount = 700,
  observations = 100_000,
  uniqueMints = 500,
  status = "complete",
  fingerprint = null,
  containsSynthetic = false,
  usableForRealMarketReplay = true,
}) {
  return {
    schemaVersion: 1,
    datasetId,
    status,
    createdAt: new Date(startMs).toISOString(),
    endedAt: status === "complete" ? new Date(startMs + durationMinutes * 60_000).toISOString() : null,
    source: containsSynthetic ? "Internal synthetic simulator" : "Jupiter Tokens V2",
    requestedMode: containsSynthetic ? "synthetic" : "live",
    effectiveMode: containsSynthetic ? "synthetic" : "live",
    captureMs: 5000,
    snapshotCount,
    eventCount: 1,
    uniqueMintCount: uniqueMints,
    totalTokenObservations: observations,
    firstObservedAt: startMs,
    lastObservedAt: startMs + durationMinutes * 60_000,
    durationMs: durationMinutes * 60_000,
    snapshotInterval: { count: snapshotCount - 1, minMs: 4998, maxMs: 5002, meanMs: 5000, medianMs: 5000 },
    feedErrors: 0,
    rateLimits: 0,
    stalePeriods: 0,
    dataClass: containsSynthetic ? "synthetic-only" : "live-only",
    containsLive: !containsSynthetic,
    containsSynthetic,
    liveSnapshots: containsSynthetic ? 0 : snapshotCount,
    syntheticSnapshots: containsSynthetic ? snapshotCount : 0,
    usableForRealMarketReplay,
    fingerprint: fingerprint ? { algorithm: "sha256", combined: fingerprint, covers: ["snapshots.ndjson"] } : null,
  };
}

async function writeDataset({ day = "2026-09-17", id, ...manifest }) {
  const dir = path.join(ctx.historyRoot, day, id);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "manifest.json"), `${JSON.stringify(manifestFor({ datasetId: id, ...manifest }), null, 2)}\n`, "utf8");
  await writeFile(path.join(dir, "snapshots.ndjson"), "{}\n{}\n", "utf8");
  await writeFile(path.join(dir, "events.ndjson"), "{}\n", "utf8");
  return dir;
}

async function buildFixtures() {
  ctx.root = await mkdtemp(path.join(tmpdir(), "evolve-phase5c-"));
  ctx.historyRoot = path.join(ctx.root, "history");
  ctx.arenasDir = path.join(ctx.root, "arenas");
  ctx.baseDir = path.join(ctx.root, "replication");
  await mkdir(ctx.historyRoot, { recursive: true });
  await mkdir(ctx.arenasDir, { recursive: true });

  // REAL, complete, independent captures.
  await writeDataset({ id: "ds-real-a", startMs: BASE_MS, durationMinutes: 60, fingerprint: REAL_FINGERPRINT_A });
  await writeDataset({ id: "ds-real-b", startMs: BASE_MS + 3 * HOUR, durationMinutes: 60, fingerprint: REAL_FINGERPRINT_B });
  await writeDataset({ id: "ds-real-c", startMs: BASE_MS + 6 * HOUR, durationMinutes: 60, fingerprint: REAL_FINGERPRINT_C });
  // Fingerprint-identical copy of ds-real-a (counts once).
  await writeDataset({ id: "ds-real-a-copy", startMs: BASE_MS + 12 * HOUR, durationMinutes: 60, fingerprint: REAL_FINGERPRINT_A });
  // Overlaps ds-real-a by 30 minutes (must never be independent).
  await writeDataset({ id: "ds-z-overlap", startMs: BASE_MS + 0.5 * HOUR, durationMinutes: 60, fingerprint: REAL_FINGERPRINT_D });
  // The development / original-benchmark dataset.
  await writeDataset({ id: "session-20260917T164922Z-live", startMs: BASE_MS + 8 * HOUR, durationMinutes: 60, fingerprint: "e".repeat(64) });
  // Incomplete capture (no fingerprint, recording status).
  await writeDataset({ id: "ds-incomplete", startMs: BASE_MS + 14 * HOUR, durationMinutes: 8, snapshotCount: 96, observations: 14_380, uniqueMints: 301, status: "recording" });
  // Too short to qualify.
  await writeDataset({ id: "ds-short", startMs: BASE_MS + 16 * HOUR, durationMinutes: 5, snapshotCount: 60, observations: 9_000, uniqueMints: 120, fingerprint: "f".repeat(64) });
  // Synthetic capture.
  await writeDataset({ id: "ds-synthetic", startMs: BASE_MS + 18 * HOUR, durationMinutes: 60, containsSynthetic: true, usableForRealMarketReplay: false, fingerprint: "1".repeat(64) });
  // Contaminated by a prior historical arena.
  await writeDataset({ id: "ds-contaminated", startMs: BASE_MS + 20 * HOUR, durationMinutes: 60, fingerprint: "2".repeat(64) });
  // Structurally invalid: a session directory with no manifest.
  await mkdir(path.join(ctx.historyRoot, "2026-09-17", "ds-manifest-missing"), { recursive: true });
  await writeFile(path.join(ctx.historyRoot, "2026-09-17", "ds-manifest-missing", "snapshots.ndjson"), "{}\n", "utf8");

  // A prior (non-replication) arena evaluated ds-contaminated.
  const arenaDir = path.join(ctx.arenasDir, "arena-historical-0001");
  await mkdir(arenaDir, { recursive: true });
  await writeFile(
    path.join(arenaDir, "summary.json"),
    `${JSON.stringify({ arenaId: "arena-historical-0001", datasets: [{ id: "ds-contaminated", fingerprint: "2".repeat(64) }] }, null, 2)}\n`,
    "utf8",
  );
}

async function disposeFixtures() {
  if (ctx.root && process.env.EVOLVE_KEEP_FIXTURES !== "1") {
    await rm(ctx.root, { recursive: true, force: true }).catch(() => {});
  }
}

async function buildFixtureRegistry({ arenaUsage } = {}) {
  const records = await discoverDatasetRecords(ctx.historyRoot);
  const usage = arenaUsage ?? (await collectArenaDatasetUsage(ctx.arenasDir));
  return buildReplicationRegistry({ records, cohorts: {}, arenaUsage: usage });
}

/* ---- fake arena artifacts -------------------------------------------------*/

const FAKE_VALUES = {
  mock: {
    "ds-real-a": { score: [71, 70], rank: [5, 8], net: [-0.001, -0.002], cost: [0.002, 0.001], dd: [0.01, 0.02], cl: [1, 0] },
    "ds-real-b": { score: [70, 69], rank: [10, 10], net: [-0.002, -0.001], cost: [0.002, 0.002], dd: [0.02, 0.02], cl: [0, 0] },
    "ds-real-c": { score: [70, 70], rank: [7, 7], net: [0, 0], cost: [0.001, 0.001], dd: [0.01, 0.01], cl: [0, 0] },
  },
  deepseek: {
    "ds-real-a": { score: [73, 70], rank: [6, 8], net: [-0.001, -0.002], cost: [0.001, 0.002], dd: [0.03, 0.02], cl: [0, 0] },
    "ds-real-b": { score: [68, 69], rank: [11, 10], net: [-0.003, -0.001], cost: [0.002, 0.002], dd: [0.02, 0.02], cl: [0, 0] },
    "ds-real-c": { score: [70, 70], rank: [7, 7], net: [0, 0], cost: [0.001, 0.001], dd: [0.01, 0.01], cl: [0, 0] },
  },
};

function cohortBlock(values) {
  return {
    arena: {
      entrants: 13,
      medianScore: values.score[0],
      medianRank: values.rank[0],
      bestScore: values.score[0] + 3,
      top10Count: 2,
      top25Count: 4,
      top50Count: 6,
      groupCount: 2,
      stressCount: 2,
      championLeagueCount: values.cl[0],
      deploymentCount: 0,
      gatePassedCount: 3,
      insufficientEvidenceCount: 0,
    },
    trading: {
      medianNetPaperReturn: values.net[0],
      medianGrossPaperReturn: values.net[0] + 0.0002,
      medianCostDrag: values.cost[0],
      medianDrawdown: values.dd[0],
      medianTrades: 12,
      medianDistinctMints: 4,
      medianTopMintNotionalShare: 0.3,
      totalOosRuns: 24,
    },
    robustness: { stressSurvivalCount: 10, medianPositiveRegimes: 1, medianOosWindows: 12, catastrophicCount: 0 },
    diversity: { cohortSize: 13, uniqueFinalGenomes: 13, genomeDiversity: 1, lineageConcentration: 0.8 },
    failedGates: {},
  };
}

export function fakeAbArtifact({ datasetId, fingerprint, provider }) {
  const values = FAKE_VALUES[provider][datasetId];
  const conventional = { ...values, score: [values.score[1], values.score[1]], rank: [values.rank[1], values.rank[1]], net: [values.net[1], values.net[1]], cost: [values.cost[1], values.cost[1]], dd: [values.dd[1], values.dd[1]], cl: [values.cl[1], 0] };
  return {
    schemaVersion: 1,
    phase: "5A.3",
    arenaId: `arena-fake-${provider}-${datasetId}`,
    generatedAt: new Date(0).toISOString(),
    paperOnly: true,
    researchMode: "ab",
    question: "fake",
    config: {},
    datasets: [{ id: datasetId, sourceType: "REAL", fingerprint }],
    cohortConstruction: { requestedPerCohort: 13, actualPerCohort: 13, clonedToFillSlots: 0, clonedToFillQuota: 0 },
    cohortSize: { research: 13, conventional: 13, equalSize: true },
    cohorts: { research: cohortBlock(values), conventional: cohortBlock(conventional) },
    comparison: {},
    species: { matched: true, research: { Momentum: 13 }, conventional: { Momentum: 13 }, deltas: {}, requestedMatchMode: "species-matched", effectiveMatchMode: "species-matched" },
    families: { research: {}, conventional: {} },
    roles: { seedDistribution: {} },
    lineage: {},
    statistics: { significance: null },
    limitations: [],
    note: "fake artifact for offline validation",
  };
}

/** Offline "arena": writes a synthetic A/B artifact and returns its path. */
function fakeExecutor({ calls }) {
  return async ({ datasetId, datasetFingerprint, provider, researchRoot, arenasDir, unitId }) => {
    calls.push({ datasetId, unitId, provider, researchRoot, arenasDir });
    const arenaId = `arena-fake-${provider}-${unitId}`;
    const dir = path.join(arenasDir, arenaId);
    await mkdir(dir, { recursive: true });
    const artifact = fakeAbArtifact({ datasetId, fingerprint: datasetFingerprint, provider });
    artifact.arenaId = arenaId;
    await writeFile(path.join(dir, "ab-comparison.json"), `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
    await writeFile(path.join(dir, "manifest.json"), `${JSON.stringify({ arenaId, paperOnly: true }, null, 2)}\n`, "utf8");
    return { arenaId, arenaDir: dir };
  };
}

/* ============================================================================
 * 1-6: freeze artifact
 * ==========================================================================*/

test("1. freeze artifact is deterministic for the same code/config", () => {
  const a = buildFreezeConfig({ createdAt: 1_000_000, commit: "deadbeef" });
  const b = buildFreezeConfig({ createdAt: 9_999_999, commit: "deadbeef" });
  assertEqual(canonicalJson({ ...a, createdAt: null }), canonicalJson({ ...b, createdAt: null }), "the artifact must be clock-independent");
  assertEqual(a.createdAt === b.createdAt, false, "createdAt is still recorded (and differs)");
});

test("2. freeze digest is deterministic and clock-independent", () => {
  const a = createFreeze({ createdAt: 1_000_000, commit: "deadbeef" });
  const b = createFreeze({ createdAt: 4_000_000, commit: "deadbeef" });
  assertEqual(a.freezeDigest, b.freezeDigest, "the same config must produce the same digest");
  assert(/^[0-9a-f]{64}$/.test(a.freezeDigest), "the digest must be a SHA-256 hex string");
  const changed = createFreeze({ createdAt: 1_000_000, commit: "deadbeef" });
  changed.arena.generations = changed.arena.generations + 1;
  assert(freezeDigest(changed) !== a.freezeDigest, "a configuration change must change the digest");
});

test("3. the freeze artifact includes the critical Arena configuration", () => {
  const freeze = createFreeze({ commit: "deadbeef" });
  assertEqual(freeze.arena.scoreVersion, ARENA_SCORE_VERSION, "Arena score version is frozen");
  assertEqual(freeze.arena.runnerVersion, ARENA_RUNNER_VERSION, "Arena runner version is frozen");
  assertEqual(freeze.arena.evaluatorVersion, EVALUATOR_VERSION, "evaluator version is frozen");
  assertEqual(freeze.arena.population, 200, "population is frozen");
  assertEqual(freeze.arena.generations, 30, "generations are frozen");
  assertDeepEqual(freeze.arena.seeds, ["evolve", "evolve-2"], "worker-independent seeds are frozen");
  assertDeepEqual(freeze.arena.stressProfiles, ["mild", "moderate"], "stress profiles are frozen");
  assertEqual(freeze.arena.survivorFraction, 0.3, "survivor fraction is frozen");
  assertEqual(freeze.arena.breederShare, 0.35, "breeder fraction is frozen");
  assertEqual(freeze.arena.mutationScale, 0.07, "mutation scale is frozen");
});

test("4. the freeze artifact includes the gate configuration unchanged", () => {
  const freeze = createFreeze({ commit: "deadbeef" });
  assertDeepEqual(freeze.gates, { ...DEFAULT_DEPLOYMENT_GATES }, "the deployment gate table is frozen verbatim");
  assertEqual(freeze.gates.minDistinctMints, 4, "minDistinctMints is frozen at 4");
  assertEqual(freeze.gates.minTrades, 20, "min trades is frozen at 20");
  assertEqual(freeze.gates.requireNoCatastrophic, true, "the no-catastrophic requirement is frozen");
  assertEqual(freeze.evidenceThresholds.minDistinctMints, 4, "the evidence threshold is frozen");
  assertEqual(freeze.concentrationBounds.maxTopMintShare, 0.5, "the concentration bound is frozen");
});

test("5. the freeze artifact includes the provider configuration", () => {
  const freeze = createFreeze({ commit: "deadbeef" });
  assertEqual(freeze.providers.mock.provider, "mock", "the mock provider is recorded");
  assertEqual(freeze.providers.mock.deterministic, true, "the mock provider is deterministic");
  assertEqual(freeze.providers.mock.subprocess, false, "the mock provider has no subprocess");
  assertEqual(freeze.providers.deepseek.provider, "deepseek-cline", "the DeepSeek provider is recorded");
  assertEqual(freeze.providers.deepseek.model, DEEPSEEK_CLINE_MODEL, "the DeepSeek model is frozen");
  assertEqual(freeze.providers.deepseek.reasoning, DEEPSEEK_CLINE_REASONING, "the DeepSeek reasoning level is frozen");
});

test("6. the DeepSeek promptVersion and research versions are frozen", () => {
  const freeze = createFreeze({ commit: "deadbeef" });
  assertEqual(freeze.research.promptVersion, RESEARCH_PROMPT_VERSION, "the prompt version is frozen from the live contract");
  assertEqual(freeze.research.proposalSchemaVersion, PROPOSAL_SCHEMA_VERSION, "the proposal schema version is frozen");
  assertEqual(freeze.research.evidencePacketVersion, EVIDENCE_PACKET_VERSION, "the evidence packet version is frozen");
  assertEqual(freeze.research.compilerVersion, PROPOSAL_COMPILER_VERSION, "the compiler version is frozen");
  assertEqual(freeze.providers.deepseek.promptVersion, RESEARCH_PROMPT_VERSION, "the DeepSeek provider records the prompt version");
  assertEqual(freeze.replication.llmCallsRequired, false, "Phase 5C replication requires no LLM call");
});

test("freeze round-trips through disk with a stable digest", async () => {
  const written = await writeFreeze(buildFreezeConfig({ commit: "deadbeef", createdAt: 1 }), { root: ctx.baseDir });
  const read = await readFreeze({ root: ctx.baseDir });
  assertEqual(read.freezeDigest, written.freezeDigest, "the persisted artifact keeps its digest");
  const ensured = await ensureFreeze({ root: ctx.baseDir });
  assertEqual(ensured.freezeDigest, written.freezeDigest, "ensureFreeze never rewrites an existing artifact");
});

/* ============================================================================
 * 7-11: frozen cohorts
 * ==========================================================================*/

test("7. the mock research cohort is frozen with the canonical unique genomes", async () => {
  const manifest = await buildCohortManifest({ key: "mock", freezeDigest: "f".repeat(64), createdAt: 1 });
  assert(manifest.count >= 1, "the mock cohort must contain at least one genome");
  assertEqual(manifest.provider, "mock", "the cohort is attributed to the mock provider");
  assert(/^[0-9a-f]{64}$/.test(manifest.cohortDigest), "the cohort digest is a SHA-256 hex string");
  assertEqual(new Set(manifest.entries.map((entry) => entry.genomeDigest)).size, manifest.count, "every frozen genome digest is unique");
  assert(manifest.entries.every((entry) => entry.lineageSeedId && entry.roleAncestry.length >= 0), "each entry carries a lineage seed id");
});

test("8. the DeepSeek research cohort is frozen from the recorded experiment", async () => {
  const manifest = await buildCohortManifest({ key: "deepseek", createdAt: 1 });
  assertEqual(manifest.provider, "deepseek-cline", "the cohort is attributed to the DeepSeek provider");
  assertEqual(manifest.origin.experimentId, FROZEN_COHORT_SOURCES.deepseek.experimentId, "the originating experiment id is recorded");
  assertEqual(manifest.count, 12, "the DeepSeek experiment compiled 12 unique genomes");
  assertEqual(new Set(manifest.entries.map((entry) => entry.genomeDigest)).size, 12, "the frozen genomes are unique");
});

test("9. the cohort digest is deterministic and order-independent", () => {
  const entries = [
    { genomeDigest: "a".repeat(64), species: "Momentum", family: "F1", familyId: "F-1", proposalId: "P-1", authorRole: "signal-researcher" },
    { genomeDigest: "b".repeat(64), species: "Reversal", family: "F2", familyId: "F-2", proposalId: "P-2", authorRole: "risk-researcher" },
  ];
  const first = cohortDigestOf({ provider: "mock", entries });
  const second = cohortDigestOf({ provider: "mock", entries: [...entries].reverse() });
  assertEqual(first, second, "entry order must not change the cohort digest");
  const changed = cohortDigestOf({ provider: "mock", entries: [{ ...entries[0], species: "Liquidity" }, entries[1]] });
  assert(changed !== first, "a changed species must change the cohort digest");
});

test("10. frozen genomes are unchanged (payload verifies against the manifest)", async () => {
  await freezeCohorts({ baseDir: ctx.baseDir, freezeDigest: "f".repeat(64), keys: ["mock"], createdAt: 1 });
  const verified = await verifyFrozenCohort(ctx.baseDir, "mock");
  assertEqual(verified.ok, true, "the frozen payload must verify");
  const manifest = await readFrozenCohort(ctx.baseDir, "mock");
  const tampered = { ...manifest, entries: [{ ...manifest.entries[0], species: "Experimental" }, ...manifest.entries.slice(1)] };
  await writeFile(path.join(cohortDirFor(ctx.baseDir, "mock"), "cohort-manifest.json"), `${JSON.stringify(tampered, null, 2)}\n`, "utf8");
  const after = await verifyFrozenCohort(ctx.baseDir, "mock");
  assertEqual(after.ok, false, "a tampered manifest must fail verification");
  await writeFile(path.join(cohortDirFor(ctx.baseDir, "mock"), "cohort-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
});

test("11. refreezing the same sources is idempotent and never overwrites with a different cohort", async () => {
  const first = await freezeCohorts({ baseDir: ctx.baseDir, freezeDigest: "f".repeat(64), keys: ["mock", "deepseek"], createdAt: 1 });
  const second = await freezeCohorts({ baseDir: ctx.baseDir, freezeDigest: "f".repeat(64), keys: ["mock", "deepseek"], createdAt: 2 });
  assertEqual(first.mock.cohortDigest, second.mock.cohortDigest, "the mock cohort digest is stable");
  assertEqual(first.deepseek.cohortDigest, second.deepseek.cohortDigest, "the DeepSeek cohort digest is stable");
  const inspected = inspectCohort(first.mock);
  assertEqual(inspected.count, first.mock.count, "inspection reports the frozen count");
  const dir = cohortDirFor(ctx.baseDir, "mock");
  const files = await readdir(path.join(dir, "compiled"));
  assertEqual(files.length, first.mock.count, "the Arena-readable payload has one compiled file per frozen genome");
});

/* ============================================================================
 * 12-23: dataset discovery, overlap, eligibility, leakage
 * ==========================================================================*/

test("12. dataset discovery finds the real datasets and validates contents", async () => {
  const records = await discoverDatasetRecords(ctx.historyRoot);
  const real = records.filter((record) => record.classification === "REAL");
  assertEqual(real.length, 9, "nine REAL captures are discovered (invalid and synthetic are excluded from REAL)");
  assert(real.every((record) => record.fingerprintValid), "every REAL capture has a valid fingerprint");
  assert(real.every((record) => Number.isFinite(record.durationMs)), "every REAL capture reports a duration");
  assert(real.every((record) => Number.isFinite(record.snapshotCount)), "every REAL capture reports snapshots");
  assert(real.every((record) => Number.isFinite(record.uniqueMints)), "every REAL capture reports unique mints");
  assertEqual(records.find((record) => record.datasetId === "ds-real-a").feedErrors, 0, "feed errors are captured");
  assertEqual(records.find((record) => record.datasetId === "ds-real-a").captureMs, 5000, "the capture interval is captured");
});

test("13. synthetic datasets are separated and never counted as real", async () => {
  const registry = await buildFixtureRegistry();
  const synthetic = registry.records.find((record) => record.datasetId === "ds-synthetic");
  assertEqual(synthetic.classification, "SYNTHETIC", "synthetic data is classified SYNTHETIC");
  assertEqual(registry.roles["ds-synthetic"], DATASET_ROLE.NON_REAL, "synthetic data is never a replication dataset");
  assertEqual(registry.eligibility["ds-synthetic"].eligible, false, "synthetic data is not eligible");
  assert(!registry.selectedIds.includes("ds-synthetic"), "synthetic data never enters the primary sample");
});

test("14. fingerprint-identical datasets are detected and count once", async () => {
  const registry = await buildFixtureRegistry();
  assertEqual(registry.duplicates.groups.length, 1, "one duplicate fingerprint group exists");
  assertDeepEqual(registry.duplicates.groups[0].datasetIds, ["ds-real-a", "ds-real-a-copy"], "the duplicate pair is identified");
  assert(!registry.selectedIds.includes("ds-real-a-copy"), "the duplicate never consumes a second dataset slot");
  assert(
    registry.eligibility["ds-real-a-copy"].reasons.some((reason) => reason.includes("counts once")),
    "the duplicate exclusion is explained",
  );
});

test("15. temporal overlap between REAL captures is detected", async () => {
  const records = await discoverDatasetRecords(ctx.historyRoot);
  const a = records.find((record) => record.datasetId === "ds-real-a");
  const overlapping = records.find((record) => record.datasetId === "ds-z-overlap");
  const row = temporalOverlap(a, overlapping);
  assertEqual(row.overlapMs, 30 * 60_000, "the overlap duration is exact");
  assertEqual(row.independent, false, "an overlapping capture is NOT independent");
  const matrix = overlapMatrix(records);
  const pair = matrix.find((entry) => entry.a === "ds-real-a" && entry.b === "ds-z-overlap");
  assertEqual(pair.status, "NOT_INDEPENDENT", "the overlap matrix labels the pair NOT_INDEPENDENT");
});

test("16. overlap fractions are computed in both directions", async () => {
  const records = await discoverDatasetRecords(ctx.historyRoot);
  const a = records.find((record) => record.datasetId === "ds-real-a");
  const overlapping = records.find((record) => record.datasetId === "ds-z-overlap");
  const row = temporalOverlap(a, overlapping);
  assertClose(row.overlapFractionAtoB, 0.5, 1e-9, "overlap fraction A→B is overlap / duration(A)");
  assertClose(row.overlapFractionBtoA, 0.5, 1e-9, "overlap fraction B→A is overlap / duration(B)");
  const disjoint = temporalOverlap(a, records.find((record) => record.datasetId === "ds-real-b"));
  assertEqual(disjoint.overlapMs, 0, "non-overlapping captures have zero overlap");
  assertEqual(disjoint.independent, true, "non-overlapping captures are independent");
});

test("17. the original development dataset is classified DEVELOPMENT, not replication", async () => {
  const registry = await buildFixtureRegistry();
  assertEqual(registry.roles["session-20260917T164922Z-live"], DATASET_ROLE.DEVELOPMENT, "the development dataset is labelled DEVELOPMENT");
  assert(!registry.selectedIds.includes("session-20260917T164922Z-live"), "the development dataset is never a primary replication dataset");
  assert(
    registry.eligibility["session-20260917T164922Z-live"].reasons.some((reason) => reason.includes("development")),
    "the exclusion is explained in plain language",
  );
  assertEqual(registry.leakage["session-20260917T164922Z-live"].overall, "DEVELOPMENT", "the leakage matrix marks it DEVELOPMENT");
});

test("18. independent CLEAN captures are classified CLEAN_REPLICATION and selected", async () => {
  const registry = await buildFixtureRegistry();
  for (const id of ["ds-real-a", "ds-real-b", "ds-real-c"]) {
    assertEqual(registry.roles[id], DATASET_ROLE.REPLICATION, `${id} is a replication dataset`);
    assertEqual(registry.leakage[id].overall, "CLEAN_REPLICATION", `${id} has clean leakage`);
    assertEqual(registry.eligibility[id].eligible, true, `${id} is eligible`);
  }
  assertDeepEqual(registry.selectedIds, ["ds-real-a", "ds-real-b", "ds-real-c"], "exactly the clean captures are selected");
});

test("19. a dataset used by a prior arena is classified CONTAMINATED", async () => {
  const registry = await buildFixtureRegistry();
  assertEqual(registry.roles["ds-contaminated"], DATASET_ROLE.CONTAMINATED, "a previously-evaluated dataset is CONTAMINATED");
  assertEqual(registry.leakage["ds-contaminated"].overall, "CONTAMINATED", "the leakage matrix marks it CONTAMINATED");
  assert(
    registry.leakage["ds-contaminated"].perCohort.mock.flags.usedForArenaGateTuning === true,
    "the arena-tuning flag is set explicitly",
  );
  assert(
    registry.leakage["ds-contaminated"].perCohort.mock.arenaIds.includes("arena-historical-0001"),
    "the contaminating arena is named",
  );
  assert(!registry.selectedIds.includes("ds-contaminated"), "a contaminated dataset is never selected");
});

test("20. unavailable provenance yields a conservative UNKNOWN leakage class", async () => {
  const records = await discoverDatasetRecords(ctx.historyRoot);
  const matrix = buildLeakageMatrix({
    records,
    cohorts: {},
    arenaUsage: { recordsAvailable: false, usage: new Map(), fingerprints: new Map() },
  });
  assertEqual(matrix["ds-real-a"].overall, "UNKNOWN", "without provenance records the class is UNKNOWN");
  const registry = buildReplicationRegistry({
    records,
    cohorts: {},
    arenaUsage: { recordsAvailable: false, usage: new Map(), fingerprints: new Map() },
  });
  assertEqual(registry.roles["ds-real-a"], DATASET_ROLE.UNKNOWN, "UNKNOWN datasets are not replication datasets");
  assertEqual(registry.eligibility["ds-real-a"].eligible, false, "UNKNOWN leakage is never eligible for a primary claim");
});

test("21. eligibility is performance-blind", async () => {
  const records = await discoverDatasetRecords(ctx.historyRoot);
  const record = records.find((entry) => entry.datasetId === "ds-real-a");
  const plain = baseEligibility(record);
  const withMetrics = baseEligibility({
    ...record,
    arenaScore: 99,
    netPaperReturn: 5,
    finalRank: 1,
    gateStatus: "GATES_PASSED",
    deploymentEligible: true,
  });
  assertDeepEqual(withMetrics, plain, "strategy metrics cannot change an eligibility decision");
  assertEqual(ELIGIBILITY_CRITERIA.performanceBlind, true, "the criteria declare performance blindness");
  const source = await readFile("scripts/replication/datasets.mjs", "utf8");
  assert(!/netPaperReturn|arenaScore|finalRank|gateStatus/.test(source), "the dataset module never reads a strategy metric");
});

test("22. one dataset cannot count twice", async () => {
  const registry = await buildFixtureRegistry();
  const fingerprints = registry.selectedIds.map((id) => registry.records.find((record) => record.datasetId === id).fingerprint);
  assertEqual(new Set(fingerprints).size, fingerprints.length, "no two selected datasets share a fingerprint");
  const duplicateRows = registry.records.filter((record) => registry.roles[record.datasetId] === DATASET_ROLE.REPLICATION);
  assertEqual(new Set(duplicateRows.map((row) => row.fingerprint)).size, duplicateRows.length, "selected datasets are fingerprint-distinct");
});

test("23. walk-forward windows are never independent datasets", async () => {
  const records = await discoverDatasetRecords(ctx.historyRoot);
  const sessionDirs = await readdir(path.join(ctx.historyRoot, "2026-09-17"));
  assertEqual(records.length, sessionDirs.length, "discovery returns exactly one record per session directory");
  const source = await readFile("scripts/replication/datasets.mjs", "utf8");
  assert(records.every((record) => !("windows" in record)), "a discovered dataset carries no per-window enumeration");
  assert(records.every((record) => typeof record.fingerprint !== "object"), "a discovered dataset has exactly one fingerprint identity");
  assert(/not independent|cannot count|never counted as separate datasets/i.test(source), "the module states that windows are not independent datasets");
  assertEqual(ELIGIBILITY_CRITERIA_TEXT_HAS_WINDOWS(), true, "the eligibility text explains the window rule");
});

function ELIGIBILITY_CRITERIA_TEXT_HAS_WINDOWS() {
  return Object.values(constants.ELIGIBILITY_CRITERIA_TEXT).some((text) => /independent/i.test(text));
}

/* ============================================================================
 * 24-36: run identity, resume, frozen cohorts, equality of resources
 * ==========================================================================*/

test("24. the replication id is deterministic and dataset-independent", () => {
  const freeze = createFreeze({ commit: "deadbeef" });
  const cohortDigests = { mock: "1".repeat(64), deepseek: "2".repeat(64) };
  const a = replicationIdFor({ freezeDigest: freeze.freezeDigest, cohortDigests, providers: ["mock", "deepseek"], evaluation: evaluationKey(freeze) });
  const b = replicationIdFor({ freezeDigest: freeze.freezeDigest, cohortDigests, providers: ["deepseek", "mock"], evaluation: evaluationKey(freeze) });
  assertEqual(a, b, "provider order must not change the id");
  assert(/^rep-[0-9a-f]{12}$/.test(a), "the id is rep-<digest>");
  const other = replicationIdFor({ freezeDigest: "0".repeat(64), cohortDigests, providers: ["mock", "deepseek"], evaluation: evaluationKey(freeze) });
  assert(a !== other, "a different freeze digest changes the replication id");
});

test("25. unit ids are stable for the same experiment and differ per dataset/provider", () => {
  const base = { replicationId: "rep-abc", cohortDigest: "1".repeat(64) };
  const a = unitIdFor({ ...base, provider: "mock", datasetId: "d1", datasetFingerprint: "a".repeat(64) });
  const b = unitIdFor({ ...base, provider: "mock", datasetId: "d1", datasetFingerprint: "a".repeat(64) });
  const c = unitIdFor({ ...base, provider: "deepseek", datasetId: "d1", datasetFingerprint: "a".repeat(64) });
  const d = unitIdFor({ ...base, provider: "mock", datasetId: "d2", datasetFingerprint: "b".repeat(64) });
  assertEqual(a, b, "rerunning the identical experiment yields the same unit id");
  assert(a !== c && a !== d, "provider and dataset both take part in the unit identity");
  assert(/^unit-[0-9a-f]{12}$/.test(a), "the unit id is unit-<digest>");
});

test("26. planning is deterministic and produces one unit per provider x dataset", async () => {
  const registry = await buildFixtureRegistry();
  const cohorts = { mock: { cohortDigest: "1".repeat(64), count: 13 }, deepseek: { cohortDigest: "2".repeat(64), count: 12 } };
  const freeze = createFreeze({ commit: "deadbeef" });
  const planA = planReplication({ freeze: { ...freeze, replicationId: "rep-x" }, cohorts, datasets: registry.selected, providers: ["mock", "deepseek"] });
  const planB = planReplication({ freeze: { ...freeze, replicationId: "rep-x" }, cohorts, datasets: registry.selected, providers: ["mock", "deepseek"] });
  assertEqual(planA.units.length, registry.selected.length * 2, "one unit per provider × dataset");
  assertDeepEqual(planA.units.map((unit) => unit.unitId), planB.units.map((unit) => unit.unitId), "planning is deterministic");
});

test("27-28. execution stages the frozen cohort and never writes into it", async () => {
  const registry = await buildFixtureRegistry();
  const cohorts = await freezeCohorts({ baseDir: ctx.baseDir, freezeDigest: "f".repeat(64), keys: ["mock", "deepseek"], createdAt: 1 });
  const freeze = { ...createFreeze({ commit: "deadbeef" }), replicationId: "rep-stage" };
  const runDir = path.join(ctx.root, "run-stage");
  const calls = [];
  const before = digestOf(await listingDigest(cohortDirFor(ctx.baseDir, "mock")));

  await runReplication({
    runDir,
    freeze,
    replicationId: freeze.replicationId,
    units: planReplication({ freeze, cohorts, datasets: [registry.selected[0]], providers: ["mock"] }).units,
    frozenCohortDirs: { mock: cohortDirFor(ctx.baseDir, "mock") },
    executor: fakeExecutor({ calls }),
  });

  const after = digestOf(await listingDigest(cohortDirFor(ctx.baseDir, "mock")));
  assertEqual(after, before, "the frozen cohort directory is byte-identical after a run");
  assertEqual(calls.length, 1, "the executor ran once");
  assert(calls[0].researchRoot.startsWith(runDir), "the Arena is pointed at a staged, unit-private research root");
  const staged = await readdir(path.join(calls[0].researchRoot, "compiled"));
  const manifest = await readFrozenCohort(ctx.baseDir, "mock");
  assertEqual(staged.length, manifest.count, "every frozen genome was staged for the Arena");
});

async function listingDigest(dir) {
  const names = (await readdir(dir, { recursive: true })).sort();
  const out = [];
  for (const name of names) {
    const target = path.join(dir, name);
    try {
      out.push([name, await readFile(target, "utf8")]);
    } catch {
      out.push([name, "dir"]);
    }
  }
  return out;
}

test("29. the Mock arm evaluates the frozen mock research genomes", async () => {
  const registry = await buildFixtureRegistry();
  const cohorts = await freezeCohorts({ baseDir: ctx.baseDir, freezeDigest: "f".repeat(64), keys: ["mock"], createdAt: 1 });
  const freeze = { ...createFreeze({ commit: "deadbeef" }), replicationId: "rep-mock-arm" };
  const calls = [];
  await runReplication({
    runDir: path.join(ctx.root, "run-mock"),
    freeze,
    replicationId: freeze.replicationId,
    units: planReplication({ freeze, cohorts, datasets: [registry.selected[0]], providers: ["mock"] }).units,
    frozenCohortDirs: { mock: cohortDirFor(ctx.baseDir, "mock") },
    executor: fakeExecutor({ calls }),
  });
  const staged = await readdir(path.join(calls[0].researchRoot, "compiled"));
  const digests = new Set();
  for (const name of staged) {
    const record = JSON.parse(await readFile(path.join(calls[0].researchRoot, "compiled", name), "utf8"));
    digests.add(genomeDigestOf(record));
  }
  const expected = new Set(cohorts.mock.entries.map((entry) => entry.genomeDigest));
  assertEqual(digests.size, expected.size, "the staged genomes are exactly the frozen cohort");
  for (const digest of expected) assert(digests.has(digest), `staged cohort is missing ${digest}`);
});

test("30. the DeepSeek arm evaluates the frozen DeepSeek research genomes", async () => {
  const registry = await buildFixtureRegistry();
  const cohorts = await freezeCohorts({ baseDir: ctx.baseDir, freezeDigest: "f".repeat(64), keys: ["deepseek"], createdAt: 1 });
  const freeze = { ...createFreeze({ commit: "deadbeef" }), replicationId: "rep-ds-arm" };
  const calls = [];
  await runReplication({
    runDir: path.join(ctx.root, "run-ds"),
    freeze,
    replicationId: freeze.replicationId,
    units: planReplication({ freeze, cohorts, datasets: [registry.selected[0]], providers: ["deepseek"] }).units,
    frozenCohortDirs: { deepseek: cohortDirFor(ctx.baseDir, "deepseek") },
    executor: fakeExecutor({ calls }),
  });
  const staged = await readdir(path.join(calls[0].researchRoot, "compiled"));
  assertEqual(staged.length, cohorts.deepseek.count, "the DeepSeek cohort is staged in full");
  const artifact = JSON.parse(await readFile(path.join(calls[0].arenasDir, (await readdir(calls[0].arenasDir))[0], "ab-comparison.json"), "utf8"));
  assertEqual(artifact.species.matched, true, "the DeepSeek arm runs under a verified species match");
});

test("31. conventional controls are generated fresh by the Arena, never copied from the freeze", async () => {
  const freeze = createFreeze({ commit: "deadbeef" });
  const invocation = buildArenaUnitInvocation({
    datasetDir: "/tmp/ds",
    researchRoot: "/tmp/run/units/u1/research",
    arenasDir: "/tmp/run/units/u1/arenas",
    freeze,
    env: {},
  });
  assertEqual(invocation.env.EVOLVE_ARENA_RESEARCH_MODE, "ab", "the unit runs the matched A/B mode");
  assertEqual(invocation.env.EVOLVE_RESEARCH_ROOT, "/tmp/run/units/u1/research", "only the frozen research cohort is supplied");
  assert(!JSON.stringify(invocation).includes("conventional"), "no conventional cohort is supplied from the freeze — the Arena builds it fresh");
  assertDeepEqual(invocation.argv, ["scripts/arena.mjs", "--research-mode", "ab", "/tmp/ds"], "the argv is exactly one A/B arena for the dataset");
});

test("32. strict species matching is enforced for every replication unit", () => {
  const freeze = createFreeze({ commit: "deadbeef" });
  assertEqual(freeze.arena.speciesMatchMode, "species-matched", "the frozen configuration is species-matched");
  const invocation = buildArenaUnitInvocation({ datasetDir: "/tmp/ds", researchRoot: "/r", arenasDir: "/a", freeze, env: {} });
  assertEqual(invocation.env.EVOLVE_ARENA_AB_SPECIES_MATCHED, "1", "the unit forces the strict species-matched control");
  const enforcement = enforceSpeciesMatchInvariant({
    research: [{ species: "Momentum" }, { species: "Liquidity" }],
    conventional: [{ species: "Momentum" }, { species: "Liquidity" }],
    expectedCounts: { Momentum: 1, Liquidity: 1 },
    requested: true,
  });
  assertEqual(enforcement.ok, true, "a matching pair satisfies the invariant");
  const broken = enforceSpeciesMatchInvariant({
    research: [{ species: "Momentum" }, { species: "Liquidity" }],
    conventional: [{ species: "Momentum" }, { species: "Momentum" }],
    expectedCounts: { Momentum: 1, Liquidity: 1 },
    requested: true,
  });
  assertEqual(broken.ok, false, "a mismatch fails loudly (so no species-matched claim can be made)");
});

test("33. the no-cloning policy is preserved", async () => {
  const registry = await buildFixtureRegistry();
  assertEqual(constants.FROZEN_RUN_CONFIG.noCloning, true, "the frozen config forbids cloning");
  assertEqual(constants.FROZEN_RUN_CONFIG.crossCohortCrossover, false, "cross-cohort crossover is disabled");
  assertEqual(registry.duplicates.groups.length, 1, "a duplicate seed digest consumes no slot");
  const cohorts = { mock: await buildCohortManifest({ key: "mock", createdAt: 1 }), deepseek: await buildCohortManifest({ key: "deepseek", createdAt: 1 }) };
  for (const manifest of Object.values(cohorts)) {
    assertEqual(new Set(manifest.entries.map((entry) => entry.genomeDigest)).size, manifest.count, `${manifest.cohortKey} has no cloned genome`);
  }
});

test("34. Mock and DeepSeek arms receive equal resources", () => {
  const freeze = createFreeze({ commit: "deadbeef" });
  assertEqual(freeze.arena.equalStartingSlots, true, "equal starting slots");
  assertEqual(freeze.arena.equalEvolutionaryRules, true, "equal evolutionary rules");
  assertEqual(freeze.arena.equalScoring, true, "equal scoring");
  assertEqual(freeze.arena.equalGates, true, "equal gates");
  assertEqual(freeze.arena.scoringBonusForEitherCohort, 0, "no cohort bonus exists");
  assertEqual(freeze.arena.crossCohortCrossover, false, "cohorts stay isolated");
  assertDeepEqual(freeze.arena.cohorts, { research: AB_COHORT.RESEARCH, conventional: AB_COHORT.CONVENTIONAL }, "the arm vocabulary matches the Arena");
});

test("35-36. every completed unit records the freeze digest and the dataset fingerprint", async () => {
  const registry = await buildFixtureRegistry();
  const cohorts = await freezeCohorts({ baseDir: ctx.baseDir, freezeDigest: "f".repeat(64), keys: ["mock", "deepseek"], createdAt: 1 });
  const freeze = { ...createFreeze({ commit: "deadbeef" }), replicationId: "rep-provenance" };
  const runDir = path.join(ctx.root, "run-provenance");
  const { manifest } = await runReplication({
    runDir,
    freeze,
    replicationId: freeze.replicationId,
    units: planReplication({ freeze, cohorts, datasets: registry.selected.slice(0, 2), providers: ["mock", "deepseek"] }).units,
    frozenCohortDirs: { mock: cohortDirFor(ctx.baseDir, "mock"), deepseek: cohortDirFor(ctx.baseDir, "deepseek") },
    executor: fakeExecutor({ calls: [] }),
  });
  assertEqual(manifest.units.length, 4, "four units were planned");
  for (const unit of manifest.units) {
    assertEqual(unit.status, "COMPLETED", `${unit.unitId} completed`);
    assertEqual(unit.freezeDigest, freeze.freezeDigest, "the freeze digest is recorded on the unit");
    const record = registry.records.find((entry) => entry.datasetId === unit.datasetId);
    assertEqual(unit.datasetFingerprint, record.fingerprint, "the dataset fingerprint is recorded on the unit");
    assertEqual(unit.cohortDigest, cohorts[unit.provider].cohortDigest, "the cohort digest is recorded on the unit");
  }
});

/* ============================================================================
 * 37-47: per-dataset metrics and paired delta-of-deltas
 * ==========================================================================*/

let sharedRun = null;

async function getSharedRun() {
  if (sharedRun) return sharedRun;
  const registry = await buildFixtureRegistry();
  const cohorts = await freezeCohorts({ baseDir: ctx.baseDir, freezeDigest: "f".repeat(64), keys: ["mock", "deepseek"], createdAt: 1 });
  const freeze = { ...createFreeze({ commit: "deadbeef" }), replicationId: "rep-shared" };
  const runDir = path.join(ctx.root, "run-shared");
  const { manifest } = await runReplication({
    runDir,
    freeze,
    replicationId: freeze.replicationId,
    units: planReplication({ freeze, cohorts, datasets: registry.selected, providers: ["mock", "deepseek"] }).units,
    frozenCohortDirs: { mock: cohortDirFor(ctx.baseDir, "mock"), deepseek: cohortDirFor(ctx.baseDir, "deepseek") },
    executor: fakeExecutor({ calls: [] }),
  });
  const summary = aggregateReplication({
    replicationId: freeze.replicationId,
    freezeDigest: freeze.freezeDigest,
    units: manifest.units,
    registry,
    providers: ["mock", "deepseek"],
  });
  sharedRun = { registry, cohorts, freeze, manifest, summary, runDir };
  return sharedRun;
}

test("37. the within-run Arena delta is Research arm minus its own control", async () => {
  const { summary } = await getSharedRun();
  const row = summary.perDataset.find((entry) => entry.datasetId === "ds-real-a");
  assertEqual(row.mock.deltas.medianArenaScore, 1, "mock: 71 − 70 = 1");
  assertEqual(row.deepseek.deltas.medianArenaScore, 3, "deepseek: 73 − 70 = 3");
  assertEqual(row.paired.deltaOfDeltas.medianArenaScore, 2, "delta-of-deltas: 3 − 1 = 2");
});

test("38-40. net-return, cost-drag and drawdown deltas are computed raw", async () => {
  const { summary } = await getSharedRun();
  const row = summary.perDataset.find((entry) => entry.datasetId === "ds-real-a");
  assertClose(row.deepseek.deltas.medianNetPaperReturn, 0.001, 1e-9, "net paper return delta");
  assertClose(row.deepseek.deltas.medianCostDrag, -0.001, 1e-9, "cost drag delta keeps its own sign");
  assertClose(row.deepseek.deltas.medianDrawdown, 0.01, 1e-9, "drawdown delta");
  assertClose(summary.metrics.medianCostDrag.deltaOfDeltas.median, 0, 1e-9, "cost-drag DoD median across datasets");
});

test("41. a lower-is-better final rank keeps its raw sign (never flipped)", async () => {
  const { summary } = await getSharedRun();
  const row = summary.perDataset.find((entry) => entry.datasetId === "ds-real-a");
  assertEqual(row.mock.deltas.medianRank, -3, "mock rank delta is raw: 5 − 8 = −3");
  assertEqual(row.deepseek.deltas.medianRank, -2, "deepseek rank delta is raw: 6 − 8 = −2");
  assertEqual(row.paired.deltaOfDeltas.medianRank, 1, "DoD is raw: −2 − (−3) = +1");
  assert(summary.metrics.medianRank.deltaOfDeltas.median > 0, "the raw median keeps the unfavourable direction rather than being rewritten");
});

test("42. lower-is-better metadata never mutates the raw number", async () => {
  const { summary } = await getSharedRun();
  const metric = summary.metrics.medianCostDrag;
  assertEqual(metric.direction, "lower-better", "cost drag is labelled lower-is-better");
  const row = metric.perDataset.deltaOfDeltas.find((entry) => entry.datasetId === "ds-real-a");
  assertEqual(row.value, -0.002, "the raw DoD is reported unchanged (−0.002)");
  assert(/raw/i.test(metric.directionNote), "the direction note explains the raw convention");
});

test("43. pairing requires the same dataset on both sides", async () => {
  const { manifest } = await getSharedRun();
  const mockUnit = manifest.units.find((unit) => unit.provider === "mock" && unit.datasetId === "ds-real-a");
  const dsUnit = manifest.units.find((unit) => unit.provider === "deepseek" && unit.datasetId === "ds-real-a");
  const paired = pairUnits(mockUnit, dsUnit);
  assertEqual(paired.paired, true, "identical datasets pair");
  assertEqual(paired.sameDataset, true, "the pairing is marked same-dataset");
  assertEqual(paired.deltaOfDeltas.medianArenaScore, 2, "the DoD formula is deepseek − mock");
});

test("44. mismatched datasets cannot produce a delta-of-deltas", async () => {
  const { manifest } = await getSharedRun();
  const mockUnit = manifest.units.find((unit) => unit.provider === "mock" && unit.datasetId === "ds-real-a");
  const otherUnit = manifest.units.find((unit) => unit.provider === "deepseek" && unit.datasetId === "ds-real-b");
  const paired = pairUnits(mockUnit, otherUnit);
  assertEqual(paired.paired, false, "different datasets do not pair");
  assertDeepEqual(paired.deltaOfDeltas, {}, "no DoD is fabricated from a mismatched join");
  const fingerprintMismatch = pairUnits(mockUnit, { ...otherUnit, datasetId: "ds-real-a", datasetFingerprint: "9".repeat(64) });
  assertEqual(fingerprintMismatch.paired, false, "a fingerprint mismatch also blocks pairing");
});

test("45. the delta-of-deltas formula is exactly deepseekDelta − mockDelta", async () => {
  const { summary } = await getSharedRun();
  for (const metric of METRIC_PATHS) {
    const row = summary.metrics[metric.key].perDataset.deltaOfDeltas.find((entry) => entry.datasetId === "ds-real-b");
    if (!row || !Number.isFinite(row.value)) continue;
    const mockDelta = summary.metrics[metric.key].perDataset.mockResearchMinusControl.find((entry) => entry.datasetId === "ds-real-b").value;
    const dsDelta = summary.metrics[metric.key].perDataset.deepseekResearchMinusControl.find((entry) => entry.datasetId === "ds-real-b").value;
    assertClose(row.value, dsDelta - mockDelta, 1e-6, `${metric.key} DoD is b − a`);
  }
});

test("46. the unit of aggregation is the dataset", async () => {
  const { summary } = await getSharedRun();
  assertEqual(summary.unitOfReplication, "dataset", "the summary declares the dataset as the replication unit");
  assertEqual(summary.statistics.unit, "dataset", "the statistics block says dataset");
  assertEqual(summary.metrics.medianArenaScore.n, 3, "n is the number of CLEAN datasets, not genomes or entrants");
  assertEqual(summary.perDataset.length, 3, "one aggregate row per dataset");
});

test("47. individual genomes are never treated as replication units", async () => {
  const { summary } = await getSharedRun();
  assertEqual(summary.cleanDatasets.length, 3, "three datasets are clean");
  assertEqual(summary.metrics.medianArenaScore.perDataset.deltaOfDeltas.length, 3, "exactly one DoD row per dataset");
  assert(!summary.metrics.medianArenaScore.perDataset.deltaOfDeltas.some((row) => "genomeDigest" in row), "no genome rows leak into the aggregation");
  const source = await readFile("scripts/replication/aggregate.mjs", "utf8");
  assert(!/listCompiledCandidates|entrants\.push|candidates\b/.test(source), "the aggregation never reads entropy-level genome rows");
});

/* ============================================================================
 * 48-55: cross-dataset statistics
 * ==========================================================================*/

test("48. positive / negative / zero counts are correct", async () => {
  const { summary } = await getSharedRun();
  const metric = summary.metrics.medianArenaScore.deltaOfDeltas;
  assertEqual(metric.positive, 1, "one dataset favours DeepSeek");
  assertEqual(metric.negative, 1, "one dataset favours mock");
  assertEqual(metric.zero, 1, "one dataset is equal");
  const consistency = summary.metrics.medianArenaScore.consistency;
  assertEqual(consistency.deepseekGreaterThanMock, 1, "the consistency block counts 1/3 greater");
  assertEqual(consistency.deepseekLessThanMock, 1, "the consistency block counts 1/3 less");
  assertEqual(consistency.equal, 1, "the consistency block counts 1/3 equal");
});

test("49. the cross-dataset median delta is correct", async () => {
  const { summary } = await getSharedRun();
  assertEqual(summary.metrics.medianArenaScore.deltaOfDeltas.median, 0, "median of [−2, 0, 2]");
  assertEqual(medianOf([2, -2, 0]), 0, "median is order-independent");
  assertEqual(medianOf([1, 2, 3, 4]), 3, "the upper-median convention is used");
});

test("50. the cross-dataset mean / min / max / quartiles are correct", async () => {
  const { summary } = await getSharedRun();
  const metric = summary.metrics.medianArenaScore.deltaOfDeltas;
  assertClose(metric.mean, 0, 1e-9, "the mean of [−2, 0, 2] is 0");
  assertEqual(metric.min, -2, "min is −2");
  assertEqual(metric.max, 2, "max is 2");
  assertEqual(metric.q1, 0, "nearest-rank q1");
  assertEqual(metric.q3, 2, "nearest-rank q3");
  assertClose(meanOf([1, 2, 3]), 2, 1e-9, "meanOf is exact");
});

test("51. the dataset-level bootstrap is deterministic", async () => {
  const { summary } = await getSharedRun();
  const values = [2, -2, 0];
  const a = datasetBootstrap(values, { iterations: 200, seed: "test-seed" });
  const b = datasetBootstrap(values, { iterations: 200, seed: "test-seed" });
  assertDeepEqual(a, b, "the same seed reproduces the interval byte-for-byte");
  assertEqual(a.unit, "dataset", "resampling happens at the dataset level");
  assertEqual(a.stable, false, "three datasets is an unstable estimate");
  assertClose(a.point, 0, 1e-9, "the bootstrap point estimate is the observed median");
  assertEqual(summary.metrics.medianArenaScore.bootstrap.iterations, 2000, "the frozen iteration count is used");
});

test("52. no significance claim is made anywhere", async () => {
  const { summary } = await getSharedRun();
  assertEqual(summary.significance, null, "summary.significance is null");
  assertEqual(summary.statistics.significance, null, "statistics.significance is null");
  assert(/no significance|not a significance/i.test(summary.statistics.significanceNote), "the note explains the absence of a test");
  for (const metric of Object.values(summary.metrics)) {
    assertEqual(metric.bootstrap.significance, null, `${metric.key} makes no significance claim`);
  }
});

test("53. the verdict stays null", async () => {
  const { summary } = await getSharedRun();
  assertEqual(summary.verdict, null, "no winner is declared");
  assertEqual(summary.paperOnly, true, "the summary is paper-only");
  assertEqual(summary.noTuningFromOutcomes, true, "the summary records that nothing is tuned from the outcome");
});

test("54. leave-one-dataset-out sensitivity is correct", async () => {
  const { summary } = await getSharedRun();
  const loo = summary.metrics.medianArenaScore.leaveOneOut;
  assertEqual(loo.available, true, "three datasets enable LOO");
  assertEqual(loo.rows.length, 3, "one row per removed dataset");
  const withoutA = loo.rows.find((row) => row.removed === "ds-real-a");
  assertEqual(withoutA.median, 0, "removing the +2 dataset leaves median([−2, 0]) = 0");
  const withoutB = loo.rows.find((row) => row.removed === "ds-real-b");
  assertEqual(withoutB.median, 2, "removing the −2 dataset leaves median([2, 0]) = 2");
  assertEqual(loo.medianSpread.min, 0, "the spread lower bound is recorded");
  assertEqual(loo.medianSpread.max, 2, "the spread upper bound is recorded");
  assert(/not cross-validation/i.test(loo.note), "it is labelled sensitivity analysis, not cross-validation");
});

test("55. leave-one-out is disabled for insufficient n", () => {
  const loo = leaveOneOut([2, -2], ["a", "b"]);
  assertEqual(loo.available, false, "two datasets cannot support LOO");
  assertEqual(loo.required, 3, "the requirement is explicit");
  assert(/sensitivity analysis, not cross-validation/i.test(loo.note), "the note is still honest");
});

/* ============================================================================
 * 56-61: regime context and replication status
 * ==========================================================================*/

test("56. regime context is read-only descriptive context", async () => {
  const regimesBefore = canonicalJson(REGIMES);
  const { summary } = await getSharedRun();
  assertEqual(canonicalJson(REGIMES), regimesBefore, "the regime classifier vocabulary is unchanged");
  assertEqual(summary.regimeContext.length, 3, "one regime row per clean dataset");
  for (const row of summary.regimeContext) {
    assertEqual(row.regimesAvailable, false, "regimes were not computed in this offline run");
    assert(/no threshold is fitted/i.test(row.note), "the row states no threshold is fitted");
    assertDeepEqual(
      Object.keys(row).sort(),
      ["datasetId", "deltaOfDeltas", "note", "regimes", "regimesAvailable"],
      "the regime row carries no fitted parameter",
    );
  }
  assertEqual(typeof computeDatasetRegimes, "function", "the existing classifier is the only regime source");
});

test("57-60. the replication status vocabulary is descriptive and correct", () => {
  assertEqual(replicationStatusFor(0), "NO_REPLICATION_EVIDENCE", "0 clean datasets");
  assertEqual(replicationStatusFor(1), "SINGLE_REPLICATION", "1 clean dataset");
  assertEqual(replicationStatusFor(2), "LIMITED_REPLICATION", "2 clean datasets");
  assertEqual(replicationStatusFor(3), "MULTI_DATASET_REPLICATION", "3 clean datasets");
  assertEqual(replicationStatusFor(9), "MULTI_DATASET_REPLICATION", "3+ clean datasets");
});

test("60b. the aggregate status is derived from completed clean datasets", async () => {
  const { summary } = await getSharedRun();
  assertEqual(summary.replicationStatus, "MULTI_DATASET_REPLICATION", "three completed clean datasets");
  assertEqual(summary.datasetAvailability.status, "MULTI_DATASET_REPLICATION", "the availability status agrees");
  assertEqual(summary.datasetAvailability.sufficient, true, "the sample is sufficient for a descriptive summary");
});

test("61. the insufficient-dataset message is explicit and actionable", async () => {
  const registry = await buildFixtureRegistry();
  const empty = aggregateReplication({ replicationId: "rep-none", freezeDigest: null, units: [], registry, providers: ["mock", "deepseek"] });
  assertEqual(empty.datasetAvailability.status, "INSUFFICIENT_INDEPENDENT_REAL_DATASETS", "an empty run reports insufficient datasets");
  assertEqual(empty.replicationStatus, "NO_REPLICATION_EVIDENCE", "and no replication evidence");
  const guidance = formatCaptureGuidance(registry);
  assert(guidance.includes("INSUFFICIENT_INDEPENDENT_REAL_DATASETS"), "the guidance names the status");
  assert(guidance.includes(CAPTURE_COMMANDS[0]), "the guidance prints the exact capture command");
  assert(/read-only/i.test(guidance), "the guidance states market observation is read-only");
  assert(/walk-forward windows/i.test(guidance), "the guidance forbids pseudo-independent slicing");
});

/* ============================================================================
 * 62-70: integrity, regressions, safety, output agreement
 * ==========================================================================*/

const CANONICAL_FILES = [
  ".evolve/arenas/arena-20260918T081727Z/ab-comparison.json",
  ".evolve/arenas/arena-20260918T081727Z/summary.json",
  ".evolve/arenas/arena-20260918T081727Z/manifest.json",
  ".evolve/arenas/arena-20260918T120841Z/ab-comparison.json",
  ".evolve/arenas/arena-20260918T120841Z/summary.json",
  ".evolve/arenas/arena-20260918T120841Z/research-experiment.json",
];

async function canonicalDigests() {
  const out = {};
  for (const file of CANONICAL_FILES) out[file] = digestOf(await readFile(file, "utf8"));
  const dir = ".evolve/research/experiments/exp-20260918T115857Z-deepseek-cline-a7abe2";
  const names = (await readdir(path.join(dir, "compiled"))).sort();
  for (const name of names) out[`${dir}/compiled/${name}`] = digestOf(await readFile(path.join(dir, "compiled", name), "utf8"));
  return out;
}

test("62. the canonical Phase 5B artifacts are never modified", async () => {
  const before = await canonicalDigests();
  const records = await discoverDatasetRecords(".evolve/history");
  const usage = await collectArenaDatasetUsage(".evolve/arenas");
  const registry = buildReplicationRegistry({ records, cohorts: {}, arenaUsage: usage });
  aggregateReplication({ replicationId: "rep-integrity", units: [], registry, providers: ["mock", "deepseek"] });
  await readArenaRun("arena-20260918T081727Z");
  await readArenaRun("arena-20260918T120841Z");
  const after = await canonicalDigests();
  assertDeepEqual(after, before, "the canonical mock arena, DeepSeek arena, and DeepSeek experiment are byte-identical");
});

test("63. compare:research still works and still refuses to declare a winner", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/research-compare.mjs", "--mock", "arena-20260918T081727Z", "--deepseek", "arena-20260918T120841Z", "--json"],
    { encoding: "utf8" },
  );
  assertEqual(result.status, 0, `compare:research exits 0 (stderr: ${result.stderr})`);
  const report = JSON.parse(result.stdout);
  assertEqual(report.significance ?? null, null, "the Phase 5B comparison still makes no significance claim");
  assertEqual(report.verdict ?? null, null, "and still declares no winner");
  assert(Array.isArray(METRIC_PATHS) && METRIC_PATHS.length >= 20, "the shared metric definitions are intact");
});

test("64. the Phase 5B research-provider invariants still hold (regression)", async () => {
  assertEqual(RESEARCH_PROMPT_VERSION, "5b.3", "the prompt version is unchanged");
  assertEqual(PROVIDER_STATUS.OK, "PROVIDER_OK", "the provider status vocabulary is unchanged");
  assertEqual(speciesMatchRequested({}), false, "species matching is still opt-in by default");
  assertEqual(PAPER_ONLY, true, "the paper-only guarantee is intact");
  assertEqual(ARENA_SCORE_VERSION, 1, "the Arena score version is unchanged");
  let threw = false;
  try {
    requireProviderName("deepseek-clnie");
  } catch {
    threw = true;
  }
  assertEqual(threw, true, "provider selection is still fail-closed");
  const suite = await readFile("scripts/validate-phase5b.mjs", "utf8");
  assert(/export \{ cases \}/.test(suite), "the Phase 5B suite is still present");
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  assert(pkg.scripts.validate.includes("validate:phase5b"), "the Phase 5B suite is still wired into npm run validate");
});

test("65. the strict A/B invariants still hold (regression)", async () => {
  assertEqual(AB_COHORT.RESEARCH, "research", "the research arm name is unchanged");
  assertEqual(AB_COHORT.CONVENTIONAL, "conventional", "the conventional arm name is unchanged");
  assertEqual(DEFAULT_DEPLOYMENT_GATES.minDistinctMints, 4, "the distinct-mint gate is unchanged");
  assert(Object.isFrozen(DEFAULT_DEPLOYMENT_GATES), "the gate table is still frozen");
  const suite = await readFile("scripts/validate-phase5a3.mjs", "utf8");
  assert(/export \{ cases \}/.test(suite), "the strict A/B suite is still present");
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  assert(pkg.scripts.validate.includes("validate:phase5a3"), "the strict A/B suite is still wired into npm run validate");
  assert(pkg.scripts.validate.includes("validate:phase5a31"), "the strict species-match suite is still wired into npm run validate");
});

test("66. no wallet, signing, or write-RPC path exists in any Phase 5C module", async () => {
  const files = [
    "replication/constants.mjs",
    "replication/freeze.mjs",
    "replication/cohorts.mjs",
    "replication/datasets.mjs",
    "replication/identity.mjs",
    "replication/runner.mjs",
    "replication/aggregate.mjs",
    "replication/report.mjs",
    "replication/guidance.mjs",
    "replicate-research.mjs",
    "datasets-research.mjs",
  ];
  const forbidden = [
    /Keypair/,
    /signTransaction/i,
    /sendTransaction/i,
    /sendRawTransaction/i,
    /swapTransaction/i,
    /createTransaction/i,
    /confirmTransaction/i,
    /privateKey/,
    /mnemonic/i,
    /secretKey/,
  ];
  for (const file of files) {
    const source = await readFile(path.join("scripts", file), "utf8");
    for (const pattern of forbidden) {
      assert(!pattern.test(source), `${file} must not contain ${pattern}`);
    }
    assert(/PAPER ONLY|paper-only|paper only/i.test(source), `${file} states the paper-only guarantee`);
  }
});

test("67. replication never invokes the provider executable and always pins the deterministic provider", async () => {
  const runner = await readFile("scripts/replication/runner.mjs", "utf8");
  assert(runner.includes('EVOLVE_RESEARCH_PROVIDER: "mock"'), "the unit environment pins the deterministic provider");
  assert(!/cline/i.test(runner), "the replication runner never references the Cline CLI");
  assertEqual((runner.match(/spawn\(/g) ?? []).length, 1, "a single spawn exists, and only for the Arena script itself");
  assert(/spawn\(process\.execPath/.test(runner), "the only subprocess is the project's own Arena CLI via node");
  const artifact = fakeAbArtifact({ datasetId: "ds-real-a", fingerprint: "a".repeat(64), provider: "mock" });
  assertEqual(artifact.paperOnly, true, "the archived A/B artifact remains paper-only");
  const freeze = createFreeze({ commit: "deadbeef" });
  assertEqual(freeze.replication.llmCallsRequired, false, "the freeze records that replication needs no LLM call");
  for (const file of ["freeze.mjs", "cohorts.mjs", "aggregate.mjs", "datasets.mjs", "identity.mjs", "report.mjs", "guidance.mjs", "constants.mjs"]) {
    const source = await readFile(path.join("scripts", "replication", file), "utf8");
    assert(!/child_process|spawn|execSync|execFile/.test(source), `${file} must not shell out at all`);
  }
});

test("68. freeze drift is detected, critically where it matters", () => {
  const frozen = createFreeze({ commit: "deadbeef" });
  const same = buildFreezeConfig({ commit: "deadbeef" });
  assertEqual(verifyFreeze(frozen, { current: same }).ok, true, "identical config verifies");

  const promptChanged = buildFreezeConfig({ commit: "deadbeef" });
  promptChanged.arena.generations = 31;
  const critical = verifyFreeze(frozen, { current: promptChanged });
  assertEqual(critical.ok, false, "a generation change is critical drift");
  assert(critical.criticalDrift.some((row) => row.path === "arena.generations"), "the changed path is named");

  const advisory = buildFreezeConfig({ commit: "deadbeef" });
  advisory.arena.workers = 4;
  const soft = verifyFreeze(frozen, { current: advisory });
  assertEqual(soft.ok, true, "a worker-count change is advisory, not fatal");
  assert(soft.advisoryDrift.some((row) => row.path === "arena.workers"), "the advisory change is still reported");
  assertEqual(soft.digestMatches, false, "any change is visible in the digest");

  const compilerChanged = buildFreezeConfig({ commit: "deadbeef" });
  compilerChanged.research.compilerVersion = 999;
  assertEqual(verifyFreeze(frozen, { current: compilerChanged }).ok, false, "a compiler change is critical drift");

  const commitChanged = buildFreezeConfig({ commit: "cafebabe" });
  const commitVerify = verifyFreeze(frozen, { current: commitChanged });
  assertEqual(commitVerify.commitChanged, true, "a commit change is reported");
  assertEqual(commitVerify.ok, false, "a commit change is critical (it is a different code version)");

  const text = formatFreezeVerification(critical);
  assert(text.includes("RESULT: FAIL"), "the text report fails loudly");
});

test("69. a dirty tree / mismatched commit is labelled NON_CANONICAL", () => {
  const frozen = createFreeze({ commit: "deadbeef" });
  const clean = canonicalityVerdict({ frozen, commit: "deadbeef", dirty: false });
  assertEqual(clean.label, "CANONICAL", "a clean matching tree is canonical");
  assertEqual(clean.clean, true, "and reported as clean");

  const dirty = canonicalityVerdict({ frozen, commit: "deadbeef", dirty: true });
  assertEqual(dirty.label, "NON_CANONICAL", "a dirty tree is non-canonical");
  assert(dirty.reasons.some((reason) => /dirty/i.test(reason)), "the reason is explicit");
  assert(/NON_CANONICAL/.test(dirty.note), "the note says the evidence is non-canonical");

  const dev = canonicalityVerdict({ frozen, commit: "deadbeef", dirty: true, devOverride: true });
  assertEqual(dev.label, "NON_CANONICAL", "a development override still labels the evidence NON_CANONICAL");
  assert(/development override/i.test(dev.note), "the override is recorded, not hidden");

  const moved = canonicalityVerdict({ frozen, commit: "cafebabe", dirty: false });
  assertEqual(moved.clean, false, "a moved commit is not canonical");
  assert(moved.reasons.some((reason) => /commit/i.test(reason)), "the commit mismatch is explained");
});

test("70. the text summary agrees with the JSON summary", async () => {
  const { summary } = await getSharedRun();
  const text = formatReplicationSummary(summary);
  const arenaScore = summary.metrics.medianArenaScore;
  assert(text.includes(`median ${arenaScore.deltaOfDeltas.median}`), "the JSON median appears in the text");
  for (const row of arenaScore.perDataset.deltaOfDeltas) {
    const line = new RegExp(`^\\s*${row.datasetId}\\s+(\\S+)$`, "m").exec(text);
    assert(line, `the text lists ${row.datasetId} in the delta-of-deltas section`);
    assertClose(Number(line[1]), row.value, 1e-9, `text and JSON agree for ${row.datasetId}`);
  }
  assert(text.includes(summary.datasetAvailability.status), "the replication status appears in the text");
  assert(text.includes("verdict: null"), "the text reports a null verdict");
  assert(text.includes("significance: null"), "the text reports null significance");
});

/* ============================================================================
 * Extra: registry/report/identity surfaces
 * ==========================================================================*/

test("71. the dataset registry report renders every required field", async () => {
  const registry = await buildFixtureRegistry();
  const text = formatDatasetRegistry(registry);
  for (const id of ["ds-real-a", "ds-synthetic", "ds-incomplete", "ds-manifest-missing", "ds-contaminated"]) {
    assert(text.includes(id), `the report lists ${id}`);
  }
  assert(text.includes("REAL") && text.includes("SYNTHETIC"), "the report separates real from synthetic");
  assert(text.includes("fingerprint"), "the report prints fingerprints");
  const row = datasetRow(registry.records.find((record) => record.datasetId === "ds-real-a"), registry);
  assertEqual(row.classification, "REAL", "the row carries the classification");
  assertEqual(row.role, "REPLICATION", "the row carries the role");
  assertEqual(row.leakage, "CLEAN_REPLICATION", "the row carries the leakage class");
  assertEqual(row.eligible, true, "the row carries eligibility");
  assert(Number.isFinite(row.durationMinutes), "the row carries the duration");
});

test("72. an invalid/incomplete dataset is never silently accepted", async () => {
  const registry = await buildFixtureRegistry();
  assertEqual(registry.roles["ds-manifest-missing"], DATASET_ROLE.INVALID, "a session directory without a manifest is INVALID");
  assert(registry.records.find((record) => record.datasetId === "ds-incomplete").complete === false, "an interrupted capture is not complete");
  assertEqual(registry.roles["ds-incomplete"], DATASET_ROLE.INELIGIBLE, "an interrupted capture is not eligible");
  assert(!registry.selectedIds.includes("ds-incomplete"), "an interrupted capture is not selected");
  assert(!registry.selectedIds.includes("ds-short"), "a too-short capture is not selected");
  assert(
    registry.eligibility["ds-short"].reasons.some((reason) => reason.includes("duration")),
    "the short capture is excluded for duration",
  );
});

test("73. run status is derived from unit statuses and resume survives a crash", async () => {
  assertEqual(runStatusFromUnits([]), "EMPTY", "no units");
  assertEqual(runStatusFromUnits([{ status: "COMPLETED" }]), "COMPLETED", "all completed");
  assertEqual(runStatusFromUnits([{ status: "FAILED" }]), "FAILED", "all failed");
  assertEqual(runStatusFromUnits([{ status: "COMPLETED" }, { status: "FAILED" }]), "PARTIAL_FAILED", "partial failure");
  assertEqual(runStatusFromUnits([{ status: "COMPLETED" }, { status: "PENDING" }]), "PARTIAL_RUNNING", "resumable");

  const registry = await buildFixtureRegistry();
  const cohorts = await freezeCohorts({ baseDir: ctx.baseDir, freezeDigest: "f".repeat(64), keys: ["mock"], createdAt: 1 });
  const freeze = { ...createFreeze({ commit: "deadbeef" }), replicationId: "rep-resume" };
  const runDir = path.join(ctx.root, "run-resume");
  const units = planReplication({ freeze, cohorts, datasets: registry.selected.slice(0, 3), providers: ["mock"] }).units;
  const frozenCohortDirs = { mock: cohortDirFor(ctx.baseDir, "mock") };

  // First pass: the executor fails permanently — nothing is left RUNNING.
  const failing = async () => {
    throw new Error("stimulated arena crash");
  };
  const first = await runReplication({ runDir, freeze, replicationId: freeze.replicationId, units, frozenCohortDirs, executor: failing });
  assertEqual(first.manifest.units.every((unit) => unit.status === "FAILED"), true, "a failed unit is recorded as FAILED, never RUNNING");
  assertEqual(first.manifest.status, "FAILED", "the run status reflects the failures");

  // Second pass: a working executor resumes only the failed units.
  const calls = [];
  const second = await runReplication({ runDir, freeze, replicationId: freeze.replicationId, units, frozenCohortDirs, executor: fakeExecutor({ calls }) });
  assertEqual(calls.length, 3, "every previously-failed unit is retried exactly once");
  assertEqual(second.manifest.units.every((unit) => unit.status === "COMPLETED"), true, "the resumed run completes");

  // Third pass: completed units are not re-executed.
  const thirdCalls = [];
  const third = await runReplication({ runDir, freeze, replicationId: freeze.replicationId, units, frozenCohortDirs, executor: fakeExecutor({ calls: thirdCalls }) });
  assertEqual(thirdCalls.length, 0, "a resumed run never redoes a completed unit");
  assertEqual(third.manifest.units.every((unit) => unit.resumed === true), true, "completed units are marked as resumed");
});

test("74. an explicit rerun is possible and labelled", async () => {
  const registry = await buildFixtureRegistry();
  const cohorts = await freezeCohorts({ baseDir: ctx.baseDir, freezeDigest: "f".repeat(64), keys: ["mock"], createdAt: 1 });
  const freeze = { ...createFreeze({ commit: "deadbeef" }), replicationId: "rep-rerun" };
  const runDir = path.join(ctx.root, "run-rerun");
  const units = planReplication({ freeze, cohorts, datasets: registry.selected.slice(0, 1), providers: ["mock"] }).units;
  const frozenCohortDirs = { mock: cohortDirFor(ctx.baseDir, "mock") };
  await runReplication({ runDir, freeze, replicationId: freeze.replicationId, units, frozenCohortDirs, executor: fakeExecutor({ calls: [] }) });
  const calls = [];
  const rerun = await runReplication({ runDir, freeze, replicationId: freeze.replicationId, units, frozenCohortDirs, executor: fakeExecutor({ calls }), rerun: true });
  assertEqual(calls.length, 1, "an explicit rerun re-executes the completed unit");
  assertEqual(rerun.manifest.units[0].rerunOf, units[0].unitId, "the rerun is labelled with the unit it replaces");
});

test("75. the run manifest is persisted after every unit and is resumable from disk", async () => {
  const registry = await buildFixtureRegistry();
  const cohorts = await freezeCohorts({ baseDir: ctx.baseDir, freezeDigest: "f".repeat(64), keys: ["mock"], createdAt: 1 });
  const freeze = { ...createFreeze({ commit: "deadbeef" }), replicationId: "rep-manifest" };
  const runDir = path.join(ctx.root, "run-manifest");
  const units = planReplication({ freeze, cohorts, datasets: registry.selected.slice(0, 1), providers: ["mock"] }).units;
  await runReplication({
    runDir,
    freeze,
    replicationId: freeze.replicationId,
    units,
    frozenCohortDirs: { mock: cohortDirFor(ctx.baseDir, "mock") },
    executor: fakeExecutor({ calls: [] }),
  });
  const manifest = await loadRunManifest(runDir);
  assert(manifest, "the manifest exists on disk");
  assertEqual(manifest.replicationId, freeze.replicationId, "the manifest records the replication id");
  assertEqual(manifest.freezeDigest, freeze.freezeDigest, "the manifest records the freeze digest");
  assertEqual(manifest.units.length, 1, "the manifest records the unit");
  assert(manifest.units[0].metrics.available === true, "the unit carries the Arena metrics");
  assertEqual(manifest.units[0].metrics.datasetMatchesUnit, true, "the unit artifact belongs to this dataset");
  const identity = describeIdentity({ replicationId: freeze.replicationId, freezeDigest: freeze.freezeDigest, cohortDigests: { mock: cohorts.mock.cohortDigest }, providers: ["mock"], evaluation: evaluationKey(freeze) });
  assertEqual(identity.deterministic, true, "the identity block declares determinism");
  assert(identity.identityBasis.includes("unitId"), "the identity basis is documented");
});

test("76. the guidance and cohort inspection surfaces are stable", async () => {
  const registry = await buildFixtureRegistry();
  const text = formatDatasetRegistry(registry);
  assert(text.length > 0, "the registry report renders");
  const cohorts = await freezeCohorts({ baseDir: ctx.baseDir, freezeDigest: "f".repeat(64), keys: ["mock", "deepseek"], createdAt: 1 });
  const cohortText = formatCohortInspection(cohorts);
  assert(cohortText.includes(cohorts.mock.cohortDigest), "the cohort report prints the cohort digest");
  assert(cohortText.includes("genome(s)"), "the cohort report prints counts");
  assert(cohortText.includes("roles:"), "the cohort report prints role ancestry");
  const guidance = formatCaptureGuidance(registry);
  assert(guidance.includes("record:market"), "the guidance prints the capture command");
  assert(guidance.includes("Do not alter capture behavior"), "the guidance forbids tuning the capture to change results");
  assertEqual(CAPTURE_COMMANDS.length >= 1, true, "the capture commands are exported");
});

test("77. the compact replication status artifact is small, secret-free and paper-only", async () => {
  const { summary, manifest } = await getSharedRun();
  const status = buildStatusArtifact(summary, { manifest });
  assertEqual(status.paperOnly, true, "the status artifact is paper-only");
  assertEqual(status.freezeDigest, summary.freezeDigest, "it carries the freeze digest");
  assertEqual(status.significance, null, "it makes no significance claim");
  assertEqual(status.verdict, null, "it declares no winner");
  assert(!("metrics" in status) && !("perDataset" in status), "it carries no large per-dataset tables");
  assertEqual(status.units.completed, 6, "six provider×dataset units completed");
  assertEqual(status.units.failed, 0, "no unit failed");
  assertEqual(status.cleanReplicationDatasets, 3, "three clean replication datasets");
  assert(!/wallet|keypair|secret|jupiter_api_key/i.test(JSON.stringify(status)), "no credential-shaped content");
});

test("78. the dashboard replication state is bounded and reads the frozen artifacts", async () => {
  const state = await loadReplicationState(path.join(process.cwd(), ".evolve"));
  assertEqual(state.available, true, "the replication block is available");
  assertEqual(state.paperOnly, true, "the block is paper-only");
  assert(/^[0-9a-f]{64}$/.test(state.freezeDigest), "it exposes the freeze digest");
  assertEqual(state.cohorts.mock.count, 13, "the mock cohort count is exposed");
  assertEqual(state.cohorts.deepseek.count, 12, "the DeepSeek cohort count is exposed");
  assertEqual(state.significance, null, "no significance claim");
  assertEqual(state.verdict, null, "no verdict");
  assert(!("metrics" in state), "the dashboard block never loads the big summary tables");
});

/* ============================================================================
 * Runner
 * ==========================================================================*/

async function run() {
  let passed = 0;
  const failures = [];
  const started = Date.now();

  try {
    await buildFixtures();
  } catch (error) {
    console.error("could not build Phase 5C fixtures:", error?.stack ?? error);
    process.exitCode = 1;
    return;
  }
  const fixtureMs = Date.now() - started;

  for (const testCase of cases) {
    const caseStart = Date.now();
    try {
      await testCase.fn();
      passed += 1;
      console.log(`  ✓ ${testCase.name} (${Date.now() - caseStart}ms)`);
    } catch (error) {
      failures.push({ name: testCase.name, error });
      console.log(`  ✗ ${testCase.name}`);
      console.log(`      ${error?.message ?? error}`);
    }
  }

  await disposeFixtures();

  console.log(`\nfixtures built in ${fixtureMs}ms`);
  console.log(`EVOLVE Phase 5C replication validation: ${passed}/${cases.length} checks passed`);

  if (failures.length > 0) {
    console.log("Failed checks:");
    for (const failure of failures) console.log(`  - ${failure.name}`);
    process.exitCode = 1;
  } else {
    console.log("All Phase 5C checks passed. Replication is descriptive, dataset-level, and paper-only.");
    console.log("No replication status is a profitability claim, and no winner is declared.");
  }
}

run().catch((error) => {
  console.error("phase 5C validation runner crashed:", error);
  process.exitCode = 1;
});

export { cases };
