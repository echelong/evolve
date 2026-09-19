#!/usr/bin/env node
/**
 * EVOLVE Phase 5C.3 validation suite — canonical PER-WAVE freezes (PAPER ONLY).
 *
 * Covers: Wave 1's historical freeze and replication staying byte-identical, the
 * deterministic (clock- and commit-independent) `evaluationContractDigest`, the
 * documented include/exclude lists, the full freeze digest still containing the
 * commit, the proof that a commit-only change alters the full freeze but NOT the
 * evaluation contract, the proof that intelligence/Jev orchestration code is not
 * part of the contract's import graph, the per-wave freeze lifecycle
 * (`--write-freeze --wave`, `--verify-freeze --wave`), missing/stale freeze
 * fail-closed behaviour, historical waves never being re-run, canonical runs
 * without `--dev`, `--dev` staying NON_CANONICAL, cross-wave comparability
 * (different full freezes + matching contracts = comparable) and its refusal
 * (INCOMPARABLE_WAVES with explicit differing fields), and noncanonical runs
 * being excluded from the canonical meta-summary by default.
 *
 * Fully OFFLINE and deterministic: fixtures live in a temp directory, the only
 * "Arena" that ever runs is a stub that records its spawn and exits, no provider
 * is called, and no Wave 2 capture is ever read beyond its registry metadata.
 *
 * Run with: npm run validate:phase5c3
 */

import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { canonicalJson, digestOf } from "./lib/hash.mjs";
import {
  buildFreezeConfig,
  createFreeze,
  freezeDigest,
  freezeDigestSubject,
  readFreeze,
  writeFreeze,
} from "./replication/freeze.mjs";
import {
  CONTRACT_EXCLUDED_FIELDS,
  EVALUATION_CONTRACT_ID,
  buildEvaluationSemantics,
  compareEvaluationContracts,
  compareWaveEvaluationContracts,
  evaluationContractDigest,
  evaluationContractSubject,
} from "./replication/contract.mjs";
import { freezeCohorts, readFrozenCohort } from "./replication/cohorts.mjs";
import { evaluationKey, waveReplicationIdFor } from "./replication/identity.mjs";
import { planReplication } from "./replication/runner.mjs";
import { ACTION } from "./replication/mode.mjs";
import {
  CANONICAL_EVALUATION_CONTRACT_DIGEST,
  WAVE_1_DATASET_IDS,
  describeWaveManifest,
  WAVE_2_DATASET_FINGERPRINTS,
  WAVE_2_DATASET_IDS,
  WAVE_DEFINITIONS,
  WAVE_STATUS,
  bindWaveManifest,
  buildWaveManifest,
  isSafeFreezePath,
  readWaveManifest,
  resolveWaveFreezePath,
  waveDefinitionFor,
  waveDefinitionMatch,
  waveFreezeBound,
  waveManifestDigest,
  writeWaveManifest,
} from "./replication/waves.mjs";
import { loadMetaSummary, readRunCanonicality } from "./replication/meta-summary.mjs";

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

/* ============================================================================
 * Fixtures
 * ==========================================================================*/

const BASE_MS = 1789646400000; // 2026-09-17T12:00:00Z
const HOUR = 3_600_000;
const CLOCK = 1;

const FP = {
  a: "a".repeat(64),
  b: "b".repeat(64),
  c: "c".repeat(64),
  d: "d".repeat(64),
  e: "e".repeat(64),
};

const ctx = {
  tmp: null,
  repoDir: null,
  repDir: null,
  metaDir: null,
  historyRoot: null,
  arenasDir: null,
  cliLog: null,
  repoCommit: null,
  freeze: null,
  cohorts: null,
  manifests: null,
};

function manifestFor({
  datasetId,
  startMs,
  durationMinutes = 60,
  snapshotCount = 700,
  observations = 100_000,
  uniqueMints = 500,
  status = "complete",
  fingerprint = null,
}) {
  return {
    schemaVersion: 1,
    datasetId,
    status,
    createdAt: new Date(startMs).toISOString(),
    endedAt: status === "complete" ? new Date(startMs + durationMinutes * 60_000).toISOString() : null,
    source: "Jupiter Tokens V2",
    requestedMode: "live",
    effectiveMode: "live",
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
    dataClass: "live-only",
    containsLive: true,
    containsSynthetic: false,
    liveSnapshots: snapshotCount,
    syntheticSnapshots: 0,
    usableForRealMarketReplay: true,
    fingerprint: fingerprint ? { algorithm: "sha256", combined: fingerprint, covers: ["snapshots.ndjson"] } : null,
  };
}

async function writeDataset({ id, ...manifest }) {
  const dir = path.join(ctx.historyRoot, "2026-09-17", id);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "manifest.json"), `${JSON.stringify(manifestFor({ datasetId: id, ...manifest }), null, 2)}\n`, "utf8");
  await writeFile(path.join(dir, "snapshots.ndjson"), "{}\n{}\n", "utf8");
  return dir;
}

/** The predeclared fixture wave: unbound until `--write-freeze --wave` binds it. */
function fixtureWave2Definition(overrides = {}) {
  return {
    version: 1,
    waveId: "rc-wave-2",
    identityMode: "wave",
    historical: false,
    replicationId: null,
    freezePath: "freezes/rc-wave-2.json",
    freezeDigest: null,
    evaluationContractDigest: CANONICAL_EVALUATION_CONTRACT_DIGEST,
    mockCohortDigest: ctx.cohorts?.mock?.cohortDigest ?? null,
    deepseekCohortDigest: ctx.cohorts?.deepseek?.cohortDigest ?? null,
    datasetIds: ["ds-w2-a", "ds-w2-b", "ds-w2-c"],
    datasetFingerprints: { "ds-w2-a": FP.a, "ds-w2-b": FP.b, "ds-w2-c": FP.c },
    priorWaveIds: ["rc-wave-1"],
    excludedDatasetIds: ["ds-w1-a", "ds-w1-b"],
    jevInvolved: false,
    providerCallsRequired: false,
    status: WAVE_STATUS.PLANNED,
    notes: [],
    ...overrides,
  };
}

function fixtureWaveLegacyDefinition() {
  return {
    version: 1,
    waveId: "rc-wave-1",
    identityMode: "historical",
    historical: true,
    replicationId: "rep-historical",
    freezePath: "phase5c-freeze.json",
    freezeDigest: ctx.freeze.freezeDigest,
    evaluationContractDigest: evaluationContractDigest(ctx.freeze),
    mockCohortDigest: ctx.cohorts.mock.cohortDigest,
    deepseekCohortDigest: ctx.cohorts.deepseek.cohortDigest,
    datasetIds: ["ds-w1-a", "ds-w1-b"],
    datasetFingerprints: { "ds-w1-a": FP.d, "ds-w1-b": FP.e },
    priorWaveIds: [],
    excludedDatasetIds: [],
    jevInvolved: false,
    providerCallsRequired: false,
    status: WAVE_STATUS.COMPLETED,
    notes: [],
  };
}

const CLI_SCRIPT = path.resolve("scripts", "replicate-research.mjs");
const REAL_BASE = path.join(".evolve", "replication");

async function buildFixtures() {
  ctx.tmp = await mkdtemp(path.join(tmpdir(), "evolve-phase5c3-"));
  ctx.repoDir = path.join(ctx.tmp, "repo");
  ctx.repDir = path.join(ctx.tmp, "replication");
  ctx.metaDir = path.join(ctx.tmp, "meta");
  ctx.historyRoot = path.join(ctx.tmp, "history");
  ctx.arenasDir = path.join(ctx.tmp, "arenas");
  ctx.cliLog = path.join(ctx.tmp, "cli-arena-spawns.log");

  await mkdir(path.join(ctx.repoDir, "scripts"), { recursive: true });
  await mkdir(path.join(ctx.repoDir, ".evolve"), { recursive: true });
  await symlink(path.resolve(".evolve", "research"), path.join(ctx.repoDir, ".evolve", "research"), "dir");
  // The only "Arena" that can ever run: a stub that records its spawn and exits.
  await writeFile(
    path.join(ctx.repoDir, "scripts", "arena.mjs"),
    [
      'import { appendFileSync } from "node:fs";',
      "appendFileSync(process.env.EVOLVE_CLI_STUB_LOG, `spawn ${process.env.EVOLVE_ARENA_DIR ?? \"n/a\"}\\n`);",
      "process.exit(0);",
      "",
    ].join("\n"),
    "utf8",
  );
  // A real (throwaway) git repository, so commit/dirty semantics are exercised
  // exactly as they are in production.
  const git = (...args) =>
    spawnSync("git", args, { cwd: ctx.repoDir, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("-c", "user.email=fixture@example.com", "-c", "user.name=fixture", "commit", "-q", "-m", "fixture");
  ctx.repoCommit = git("rev-parse", "HEAD").stdout.trim();

  await mkdir(ctx.historyRoot, { recursive: true });
  await mkdir(ctx.arenasDir, { recursive: true });
  await mkdir(ctx.repDir, { recursive: true });
  await mkdir(ctx.metaDir, { recursive: true });

  await writeDataset({ id: "ds-w2-a", startMs: BASE_MS, fingerprint: FP.a });
  await writeDataset({ id: "ds-w2-b", startMs: BASE_MS + 3 * HOUR, fingerprint: FP.b });
  await writeDataset({ id: "ds-w2-c", startMs: BASE_MS + 6 * HOUR, fingerprint: FP.c });
  await writeDataset({ id: "ds-w1-a", startMs: BASE_MS + 9 * HOUR, fingerprint: FP.d });
  await writeDataset({ id: "ds-w1-b", startMs: BASE_MS + 12 * HOUR, fingerprint: FP.e });

  // The historical root freeze (never rewritten) and the wave's OWN freeze,
  // built from the temp repo's commit: different full digests, one contract.
  ctx.freeze = await writeFreeze(buildFreezeConfig({ commit: "deadbeef", createdAt: CLOCK }), { root: ctx.repDir });
  // No per-wave freeze is pre-created: the suite proves the CLI creates it.

  ctx.cohorts = await freezeCohorts({
    baseDir: ctx.repDir,
    freezeDigest: ctx.freeze.freezeDigest,
    keys: ["mock", "deepseek"],
    createdAt: CLOCK,
  });

  const legacy = await writeWaveManifest(ctx.repDir, buildWaveManifest(fixtureWaveLegacyDefinition(), { createdAt: CLOCK }), { overwrite: true });
  const unbound = await writeWaveManifest(ctx.repDir, buildWaveManifest(fixtureWave2Definition(), { createdAt: CLOCK }), { overwrite: true });
  ctx.manifests = { legacy, unbound };
}

async function disposeFixtures() {
  if (ctx.tmp && process.env.EVOLVE_KEEP_FIXTURES !== "1") {
    await rm(ctx.tmp, { recursive: true, force: true }).catch(() => {});
  }
}

function runCli({ actionArgs = [], out, cwd = ctx.repoDir, env = {} }) {
  const result = spawnSync(process.execPath, [CLI_SCRIPT, ...actionArgs, "--out", out], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      EVOLVE_HISTORY_ROOT: ctx.historyRoot,
      EVOLVE_ARENAS_DIR: ctx.arenasDir,
      EVOLVE_CLI_STUB_LOG: ctx.cliLog,
      ...env,
    },
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

async function arenaSpawns() {
  try {
    return (await readFile(ctx.cliLog, "utf8")).split("\n").map((line) => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

async function resetArenaSpawns() {
  await rm(ctx.cliLog, { force: true });
}

async function dirDigest(dir) {
  try {
    const names = (await readdir(dir, { recursive: true })).map((name) => String(name)).sort();
    const out = [];
    for (const name of names) {
      try {
        out.push([name, digestOf(await readFile(path.join(dir, name), "utf8"))]);
      } catch {
        out.push([name, "dir"]);
      }
    }
    return digestOf(out);
  } catch {
    return null;
  }
}

async function fileDigest(file) {
  try {
    return digestOf(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

/* ---- Real (canonical) artifacts, captured read-only ---------------------- */

const CANONICAL_FREEZE_DIGEST = "4959974d1b78635e63c0d9038c582c9ceb5a7411366d9c95c82e7ee3bac3f500";
const CANONICAL_REPLICATION_ID = "rep-66884de4e460";
let realBaseline = null;

async function realSnapshot() {
  return {
    freeze: await fileDigest(path.join(REAL_BASE, "phase5c-freeze.json")),
    replication: await dirDigest(path.join(REAL_BASE, CANONICAL_REPLICATION_ID)),
    cohorts: await dirDigest(path.join(REAL_BASE, "cohorts")),
    wave1: await fileDigest(path.join(REAL_BASE, "waves", "wave-1.json")),
    wave2: await fileDigest(path.join(REAL_BASE, "waves", "wave-2.json")),
    wave2FreezePresent: await fileDigest(path.join(REAL_BASE, "freezes", "wave-2.json")),
  };
}

/** Static import graph of a module, following relative `from "…"` specifiers. */
async function importGraph(entry) {
  const seen = new Set();
  const queue = [path.resolve(entry)];
  while (queue.length > 0) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    let source = "";
    try {
      source = await readFile(file, "utf8");
    } catch {
      continue;
    }
    for (const match of source.matchAll(/from\s+["']([^"']+)["']/g)) {
      const specifier = match[1];
      if (!specifier.startsWith(".")) continue;
      queue.push(path.resolve(path.dirname(file), specifier));
    }
    for (const match of source.matchAll(/import\s+["']([^"']+)["']/g)) {
      const specifier = match[1];
      if (!specifier.startsWith(".")) continue;
      queue.push(path.resolve(path.dirname(file), specifier));
    }
  }
  return [...seen].map((file) => path.relative(process.cwd(), file).split(path.sep).join("/")).sort();
}

/* ============================================================================
 * 1-3: Wave 1 historical evidence and its evaluation contract
 * ==========================================================================*/

test("1. the Wave 1 freeze is byte-identical, its full digest is unchanged, and the commit stays inside the digested subject", async () => {
  const now = await realSnapshot();
  assertEqual(now.freeze, realBaseline.freeze, "phase5c-freeze.json did not change while the suite ran");
  assertEqual(now.wave2FreezePresent, null, "no real Wave 2 freeze was created in this session");

  const freeze = await readFreeze({ root: REAL_BASE });
  assert(freeze, "the historical freeze artifact exists");
  assertEqual(freeze.freezeDigest, CANONICAL_FREEZE_DIGEST, "the stored freeze digest is the canonical digest");
  assertEqual(freezeDigest(freeze), CANONICAL_FREEZE_DIGEST, "recomputing the full digest from stored bytes reproduces it");
  assertEqual(freeze.commit, "e7940e0ee3596cd4752de462d9bcd1d8096d1509", "the historical commit is untouched");
  assert(
    Object.hasOwn(freezeDigestSubject(freeze), "commit"),
    "the commit is STILL part of the full freeze digest (integrity was not weakened)",
  );
  assertEqual(freeze.freezeVersion, "phase5c", "the historical freeze keeps its label");
});

test("2. the canonical Wave 1 replication and both frozen cohorts are byte-identical", async () => {
  const now = await realSnapshot();
  assertEqual(now.replication, realBaseline.replication, `${CANONICAL_REPLICATION_ID} did not change`);
  assertEqual(now.cohorts, realBaseline.cohorts, "the frozen cohorts did not change");
  assertEqual(now.wave1, realBaseline.wave1, "the Wave 1 wave manifest did not change while the suite ran");
  assertEqual(now.wave2, realBaseline.wave2, "the Wave 2 wave manifest did not change while the suite ran");

  const mock = await readFrozenCohort(REAL_BASE, "mock");
  const deepseek = await readFrozenCohort(REAL_BASE, "deepseek");
  assertEqual(mock.cohortDigest, "b26d63a2a0787e954ed7e4e63e668fe4664e58059508145345214facc4e12858", "the Mock cohort digest is unchanged");
  assertEqual(deepseek.cohortDigest, "13c7c93d707b26f8b92042d488ff0a63f5de3f9f81b8145be4eac7a70cc550a8", "the DeepSeek cohort digest is unchanged");
});

test("3. the Wave 1 evaluation contract is derived from the STORED freeze, deterministic and clock-independent", async () => {
  const stored = await readFreeze({ root: REAL_BASE });
  const first = evaluationContractDigest(stored);
  const second = evaluationContractDigest(stored);
  assertEqual(first, second, "the contract digest is deterministic");
  assertEqual(first, CANONICAL_EVALUATION_CONTRACT_DIGEST, "it equals the published Wave 1 contract pin");
  assert(/^[0-9a-f]{64}$/.test(first), "the contract digest is a SHA-256 hex string");
  assertEqual(
    evaluationContractSubject(stored).contractId,
    EVALUATION_CONTRACT_ID,
    "the subject names the contract id",
  );
  // A different registered freeze version/clock must not move the contract.
  assertEqual(
    evaluationContractDigest({ ...stored, createdAt: new Date(0).toISOString(), freezeVersion: "phase5c", label: "phase5c-freeze" }),
    first,
    "the contract ignores createdAt, the label and the freeze version",
  );
  // The LIVE build (what a per-wave freeze would record) is the same contract.
  assertEqual(
    evaluationContractDigest(buildFreezeConfig({ commit: null, createdAt: CLOCK })),
    first,
    "a freeze built from current code shares the Wave 1 evaluation contract",
  );
});

test("4. the contract subject includes the documented evaluator-semantics fields", async () => {
  const subject = evaluationContractSubject(await readFreeze({ root: REAL_BASE }));
  const required = [
    "paperOnly",
    "arena.scoreVersion",
    "arena.runnerVersion",
    "arena.cacheVersion",
    "arena.evaluatorVersion",
    "arena.population",
    "arena.generations",
    "arena.workers",
    "arena.seeds",
    "arena.stressProfiles",
    "arena.survivorFraction",
    "arena.breederShare",
    "arena.mutationScale",
    "arena.crossoverRate",
    "arena.immigrantRate",
    "arena.speciesMatchMode",
    "arena.noCloning",
    "arena.crossCohortCrossover",
    "arena.bootstrapIterations",
    "arena.bootstrapSeed",
    "arena.cohorts",
    "gates.minTrades",
    "gates.maxDrawdown",
    "evidenceThresholds.minObservations",
    "concentrationBounds.maxTopMintShare",
    "research.promptVersion",
    "research.compilerVersion",
    "research.providerFormatVersion",
    "providers.mock.provider",
    "providers.deepseek.model",
    "providers.deepseek.reasoning",
    "replication.mode",
    "replication.llmCallsRequired",
    "replication.cohortKeys",
    "replication.unit",
    "replication.datasetLevelBootstrap",
    "replication.speciesMatchPerProviderDataset",
    "semantics.arena.scoreVersion",
    "semantics.runConfig.population",
    "semantics.runConfig.speciesMatchMode",
    "semantics.gates.minTrades",
    "semantics.bootstrap.unit",
    "semantics.definition.drawdown",
    "semantics.definition.concentration",
    "semantics.definition.normalizedBankroll",
    "semantics.definition.costModel",
    "semantics.definition.regimeHandling",
    "semantics.definition.abComparison",
    "semantics.definition.paperOnly",
    "semantics.paperAccounting.startingCash",
    "semantics.paperAccounting.baseFeeBps",
    "semantics.paperAccounting.minSlippageBps",
  ];
  const get = (object, dotted) => dotted.split(".").reduce((value, key) => (value == null ? undefined : value[key]), object);
  for (const dotted of required) {
    assert(get(subject, dotted) !== undefined && get(subject, dotted) !== null, `${dotted} is part of the contract subject`);
  }
});

test("5. the contract subject EXCLUDES every documented provenance/orchestration field", async () => {
  const stored = await readFreeze({ root: REAL_BASE });
  const subject = evaluationContractSubject(stored);
  assertDeepEqual(
    CONTRACT_EXCLUDED_FIELDS,
    [
      "schemaVersion",
      "phase",
      "freezeVersion",
      "label",
      "commit",
      "dirtyWorkingTree",
      "createdAt",
      "freezeDigest",
      "replication.cohortSources",
      "replication.cohorts",
    ],
    "the documented exclude list is exactly as published",
  );
  for (const field of ["schemaVersion", "phase", "freezeVersion", "label", "commit", "dirtyWorkingTree", "createdAt", "freezeDigest"]) {
    assert(!Object.hasOwn(subject, field), `${field} is absent from the contract subject`);
  }
  assert(!Object.hasOwn(subject.replication, "cohortSources"), "artifact paths (cohortSources) are absent");
  assert(!Object.hasOwn(subject.replication, "cohorts"), "the post-hoc cohort back-reference is absent");
  const serialized = canonicalJson(subject);
  assert(!serialized.includes("e7940e0ee3596cd4752de462d9bcd1d8096d1509"), "the historical commit literally cannot appear inside the contract");
  assert(!serialized.includes("exp-20260918T115857Z"), "no experiment artifact path appears inside the contract");
});

test("6. a commit-only change alters the FULL freeze digest but NOT the evaluation contract", () => {
  const base = createFreeze({ commit: "aaaa", createdAt: CLOCK });
  const other = createFreeze({ commit: "bbbb", createdAt: CLOCK });
  assert(base.freezeDigest !== other.freezeDigest, "a different commit changes the full freeze digest");
  assertEqual(
    evaluationContractDigest(base),
    evaluationContractDigest(other),
    "a commit-only change does not change the evaluation contract",
  );
  assertEqual(
    evaluationContractDigest({ ...base, dirtyWorkingTree: true }),
    evaluationContractDigest({ ...base, dirtyWorkingTree: false }),
    "the working-tree flag does not change the contract",
  );
  assertEqual(
    base.freezeDigest,
    createFreeze({ commit: "aaaa", createdAt: CLOCK + 5 }).freezeDigest,
    "the full freeze digest ignores the clock (the contract likewise)",
  );
});

/* ============================================================================
 * 7-14: what MAY and MAY NOT change the evaluation contract
 * ==========================================================================*/

test("7. an Arena scoring/version change alters the evaluation contract", async () => {
  const stored = await readFreeze({ root: REAL_BASE });
  const baseline = evaluationContractDigest(stored);
  const bumped = { ...stored, arena: { ...stored.arena, scoreVersion: stored.arena.scoreVersion + 1 } };
  assert(evaluationContractDigest(bumped) !== baseline, "a scoring version change changes the contract");
  for (const field of ["runnerVersion", "cacheVersion", "evaluatorVersion"]) {
    const mutated = { ...stored, arena: { ...stored.arena, [field]: (stored.arena[field] ?? 0) + 1 } };
    assert(evaluationContractDigest(mutated) !== baseline, `a ${field} change changes the contract`);
  }
});

test("8. a gate / threshold / concentration change alters the evaluation contract", async () => {
  const stored = await readFreeze({ root: REAL_BASE });
  const baseline = evaluationContractDigest(stored);
  assert(
    evaluationContractDigest({ ...stored, gates: { ...stored.gates, minTrades: stored.gates.minTrades + 1 } }) !== baseline,
    "a gate change changes the contract",
  );
  assert(
    evaluationContractDigest({ ...stored, evidenceThresholds: { ...stored.evidenceThresholds, minObservations: 201 } }) !== baseline,
    "an evidence-threshold change changes the contract",
  );
  assert(
    evaluationContractDigest({ ...stored, concentrationBounds: { ...stored.concentrationBounds, maxTopMintShare: 0.6 } }) !== baseline,
    "a concentration-bound change changes the contract",
  );
});

test("9. population / generation / seed / species-matching / cloning / crossover changes alter the contract", async () => {
  const stored = await readFreeze({ root: REAL_BASE });
  const baseline = evaluationContractDigest(stored);
  const arenaMutations = {
    population: stored.arena.population + 1,
    generations: stored.arena.generations + 1,
    seeds: [...stored.arena.seeds, "extra-seed"],
    stressProfiles: [...stored.arena.stressProfiles, "severe"],
    survivorFraction: 0.5,
    breederShare: 0.5,
    mutationScale: 0.5,
    crossoverRate: 0.9,
    immigrantRate: 0.9,
    speciesMatchMode: "open",
    noCloning: false,
    crossCohortCrossover: true,
    bootstrapIterations: 1,
    bootstrapSeed: "other",
  };
  for (const [field, value] of Object.entries(arenaMutations)) {
    const mutated = { ...stored, arena: { ...stored.arena, [field]: value } };
    assert(evaluationContractDigest(mutated) !== baseline, `an arena.${field} change changes the contract`);
  }
  assert(
    evaluationContractDigest({ ...stored, replication: { ...stored.replication, llmCallsRequired: true } }) !== baseline,
    "a frozen-provider evaluation semantic change changes the contract",
  );
  assert(
    evaluationContractDigest({ ...stored, providers: { ...stored.providers, deepseek: { ...stored.providers.deepseek, model: "other/model" } } }) !== baseline,
    "a frozen DeepSeek identity change changes the contract",
  );
});

test("10. LIVE evaluator semantics (bankroll + cost model) are inside the contract", async () => {
  const stored = await readFreeze({ root: REAL_BASE });
  const baseline = evaluationContractDigest(stored);
  const semantics = buildEvaluationSemantics();
  assertEqual(semantics.paperAccounting.startingCash, 100, "the normalized starting bankroll is captured");
  assertEqual(semantics.paperAccounting.baseFeeBps, 10, "the base fee is captured");
  assertEqual(semantics.paperAccounting.minSlippageBps, 20, "the minimum slippage is captured");
  assertEqual(semantics.bootstrap.unit, "dataset", "the dataset-level bootstrap semantics are captured");
  assertEqual(semantics.definition.paperOnly, true, "paper-only is captured");
  assertEqual(semantics.definition.regimeHandling.includes("OPTIONAL"), true, "regime handling is documented in the contract");

  // A different paper bankroll is a different cost/bankroll semantics, so the
  // contract must move (this is the `env` hook used only by tests/tools).
  assert(
    evaluationContractDigest(stored, { env: { EVOLVE_PAPER_STARTING_CASH: "250" } }) !== baseline,
    "a bankroll change changes the contract",
  );
  assert(
    evaluationContractDigest(stored, { env: { EVOLVE_PAPER_BASE_FEE_BPS: "40" } }) !== baseline,
    "a cost-model change changes the contract",
  );
});

test("11. a cohort change blocks comparability, while a different full freeze does not", () => {
  const wave1 = {
    waveId: "wave-1",
    freezeDigest: "1".repeat(64),
    evaluationContractDigest: CANONICAL_EVALUATION_CONTRACT_DIGEST,
    mockCohortDigest: "b26d63a2a0787e954ed7e4e63e668fe4664e58059508145345214facc4e12858",
    deepseekCohortDigest: "13c7c93d707b26f8b92042d488ff0a63f5de3f9f81b8145be4eac7a70cc550a8",
  };
  const wave2 = { ...wave1, waveId: "wave-2", freezeDigest: "2".repeat(64) };
  const sameContract = compareEvaluationContracts(wave1, wave2);
  assertEqual(sameContract.comparable, true, "two DIFFERENT full freeze digests with one contract are comparable");
  assertEqual(sameContract.differences.length, 0, "no differing field is reported");

  const otherCohort = compareEvaluationContracts(wave1, { ...wave2, mockCohortDigest: "0".repeat(64) });
  assertEqual(otherCohort.comparable, false, "a different frozen Mock cohort is NOT comparable");
  assertEqual(otherCohort.differences[0].field, "mockCohortDigest", "the differing field is named");

  const otherContract = compareEvaluationContracts(wave1, { ...wave2, evaluationContractDigest: "3".repeat(64) });
  assertEqual(otherContract.comparable, false, "a different evaluation contract is NOT comparable");
  assertEqual(otherContract.differences[0].field, "evaluationContractDigest", "the contract difference is named first");

  const set = compareWaveEvaluationContracts([wave1, wave2]);
  assertEqual(set.status, "COMPARABLE_WAVES", "the whole set is comparable");
  assertEqual(compareWaveEvaluationContracts([wave1, { ...wave2, deepseekCohortDigest: "4".repeat(64) }]).status, "INCOMPARABLE_WAVES", "the set is refused when a cohort differs");
  assertEqual(compareWaveEvaluationContracts([wave1]).status, "SINGLE_WAVE", "one wave has nothing to combine");
});

test("12. the contract's import graph excludes orchestration (intelligence + Jev) modules", async () => {
  const graph = await importGraph(path.join("scripts", "replication", "contract.mjs"));
  const forbidden = graph.filter(
    (file) => file.startsWith("scripts/intelligence/") || file.startsWith("scripts/jev/"),
  );
  assertDeepEqual(forbidden, [], "no intelligence/Jev module is reachable from the contract module");
  assert(graph.some((file) => file.startsWith("scripts/arena/")), "the contract does read the Arena/evaluator constants it governs");
  assert(graph.includes("scripts/replication/constants.mjs"), "the contract reads the frozen run config");

  // The full freeze, by contrast, digests the commit — which is exactly why an
  // added orchestration file (changing the commit) moves the FULL digest while
  // the contract stays put.
  const stored = await readFreeze({ root: REAL_BASE });
  const before = evaluationContractDigest(stored);
  const probe = path.join("scripts", "intelligence", ".phase5c3-import-probe.mjs");
  await mkdir(path.dirname(probe), { recursive: true });
  await writeFile(probe, "export const phase5c3Probe = true;\n", "utf8");
  try {
    assertEqual(evaluationContractDigest(stored), before, "adding an intelligence orchestration file does not change the contract");
  } finally {
    await rm(probe, { force: true });
  }
  assertEqual(evaluationContractDigest(stored), before, "removing it does not change the contract either");
});

/* ============================================================================
 * 13-16: Wave 2's predeclared identity and per-wave freeze
 * ==========================================================================*/

test("13. the Wave 2 definition pins exactly the three captures, their fingerprints, and excludes Wave 1", () => {
  const definition = waveDefinitionFor("wave-2");
  assert(definition, "the Wave 2 definition is registered");
  assertDeepEqual([...definition.datasetIds], [...WAVE_2_DATASET_IDS], "membership is exactly the three prospective captures");
  assertEqual(definition.datasetIds.length, 3, "exactly three datasets");
  assertDeepEqual({ ...definition.datasetFingerprints }, { ...WAVE_2_DATASET_FINGERPRINTS }, "the fingerprints are the pinned values");
  assertDeepEqual([...definition.excludedDatasetIds], [...WAVE_1_DATASET_IDS], "Wave 1 ids are explicitly excluded");
  assertDeepEqual([...definition.priorWaveIds], ["wave-1"], "Wave 1 is the declared prior wave");
  for (const id of WAVE_1_DATASET_IDS) assert(!definition.datasetIds.includes(id), `${id} never enters the Wave 2 membership`);
  assertEqual(definition.freezeDigest, null, "the definition declares NO borrowed freeze digest");
  assertEqual(definition.freezePath, "freezes/wave-2.json", "the definition declares its own freeze path");
  assertEqual(definition.evaluationContractDigest, CANONICAL_EVALUATION_CONTRACT_DIGEST, "the definition pins the Wave 1 contract up front");
  assertEqual(definition.identityMode, "wave", "the wave is not historical");
  assertEqual(definition.jevInvolved, false, "no Jev participation");
});

test("14. the stored Wave 2 manifest is unbound, pins its own freeze path and is comparable by construction", async () => {
  const stored = await readWaveManifest(REAL_BASE, "wave-2");
  assert(stored, "the stored manifest exists");
  assertEqual(stored.manifestDigest, buildWaveManifest(WAVE_DEFINITIONS[1], { createdAt: CLOCK }).manifestDigest, "it matches the predeclared definition");
  assertEqual(stored.freezeDigest, null, "its freeze digest is unbound (never borrowed from Wave 1)");
  assertEqual(stored.replicationId, null, "its replication id is provisional until the freeze is bound");
  assertEqual(stored.evaluationContractDigest, CANONICAL_EVALUATION_CONTRACT_DIGEST, "its contract pin equals Wave 1's contract");
  assertEqual(waveFreezeBound(stored), false, "the wave is reported as unbound");
  assertEqual(isSafeFreezePath(stored.freezePath), true, "the freeze path is safe");
  assertEqual(resolveWaveFreezePath(REAL_BASE, stored.freezePath), path.join(REAL_BASE, "freezes", "wave-2.json"), "it resolves under the replication root");
  assertEqual(isSafeFreezePath("../outside.json"), false, "a path escape is rejected");
  assertEqual(isSafeFreezePath("/etc/passwd"), false, "an absolute path is rejected");
});

test("15. a bound wave manifest is a different definition with a deterministic replication id", async () => {
  const stored = await readWaveManifest(REAL_BASE, "wave-2");
  const bound = bindWaveManifest({ manifest: stored, freezeDigest: CANONICAL_FREEZE_DIGEST, evaluationContractDigest: CANONICAL_EVALUATION_CONTRACT_DIGEST });
  assertEqual(bound.freezeDigest, CANONICAL_FREEZE_DIGEST, "the freeze digest is bound");
  assert(waveFreezeBound(bound), "the bound wave reports itself as bound");
  assert(bound.manifestDigest !== stored.manifestDigest, "binding changes the wave's identity (and therefore its digest)");
  assertEqual(waveManifestDigest(bound), bound.manifestDigest, "the bound manifest digest is self-consistent");
  const withId = { ...bound, replicationId: waveReplicationIdFor({
    freezeDigest: bound.freezeDigest,
    cohortDigests: { mock: bound.mockCohortDigest, deepseek: bound.deepseekCohortDigest },
    providers: ["mock", "deepseek"],
    evaluation: evaluationKey({ arena: (await readFreeze({ root: REAL_BASE })).arena }),
    waveId: bound.waveId,
    manifestDigest: bound.manifestDigest,
  }) };
  assert(/^rep-[0-9a-f]{12}$/.test(withId.replicationId), "the bound identity keeps the rep-<12hex> shape");
  assert(withId.replicationId !== CANONICAL_REPLICATION_ID, "it is never the canonical Wave 1 id");
  const described = describeWaveManifest(bound);
  assertEqual(described.freezePath, stored.freezePath, "the descriptor carries the freeze path");
  assertEqual(described.freezeBound, true, "the descriptor reports the bound state");
});

test("16. a tampered wave manifest is caught (definition drift + digest drift)", async () => {
  const stored = await readWaveManifest(REAL_BASE, "wave-2");
  const tampered = { ...stored, datasetFingerprints: { ...stored.datasetFingerprints, "session-20260919T040641Z-live": "f".repeat(64) } };
  assertEqual(waveManifestDigest(tampered) === tampered.manifestDigest, false, "the stored digest no longer matches the edited definition");
  const match = waveDefinitionMatch({ manifest: tampered, definition: waveDefinitionFor("wave-2") });
  assertEqual(match.ok, false, "the predeclared-definition check fails");
  assert(match.drifted.includes("datasetFingerprints"), "the drifted field is named");
  assertEqual(waveDefinitionMatch({ manifest: stored, definition: waveDefinitionFor("wave-2") }).ok, true, "the real manifest still matches");
  // An unregistered wave id cannot be checked against a definition.
  assertEqual(waveDefinitionMatch({ manifest: { waveId: "local-fixture" }, definition: null }).checked, false, "an unregistered wave is reported as unchecked, not silently valid");
});

/* ============================================================================
 * 17-25: the per-wave freeze lifecycle (CLI, isolated temp git repo)
 * ==========================================================================*/

test("17. a wave with NO per-wave freeze fails closed (plan and run, zero spawns)", async () => {
  await resetArenaSpawns();
  for (const action of [["--plan"], []]) {
    const run = runCli({ actionArgs: ["--wave", "rc-wave-2", ...action], out: ctx.repDir });
    assertEqual(run.status, 1, `--wave rc-wave-2 ${action.join(" ")} exits 1`);
    assert(/NO canonical per-wave freeze/.test(run.stderr), `the failure explains the missing freeze (stderr: ${run.stderr.slice(0, 200)})`);
  }
  // The CLI must NOT have created a freeze while failing.
  assertEqual(await fileDigest(path.join(ctx.repDir, "freezes", "rc-wave-2.json")), null, "a failed command never writes a freeze");
  assertEqual((await arenaSpawns()).length, 0, "zero Arena subprocesses");
  const stored = await readWaveManifest(ctx.repDir, "rc-wave-2");
  assertEqual(stored.freezeDigest, null, "the manifest is still unbound");
});

test("18. a STALE per-wave freeze fails closed (stored digest != manifest pin)", async () => {
  await resetArenaSpawns();
  const definition = fixtureWave2Definition({
    waveId: "rc-wave-stale",
    freezePath: "freezes/rc-wave-stale.json",
    datasetIds: ["ds-w2-a", "ds-w2-b"],
    datasetFingerprints: { "ds-w2-a": FP.a, "ds-w2-b": FP.b },
    excludedDatasetIds: [],
  });
  const built = buildWaveManifest(definition, { createdAt: CLOCK });
  await writeWaveManifest(ctx.repDir, { ...built, freezeDigest: "9".repeat(64), replicationId: "rep-stale-fake" }, { overwrite: true });
  await writeFreeze(buildFreezeConfig({ commit: "deadbeef", createdAt: CLOCK }), { root: ctx.repDir, file: "freezes/rc-wave-stale.json" });
  const run = runCli({ actionArgs: ["--wave", "rc-wave-stale", "--plan"], out: ctx.repDir });
  assertEqual(run.status, 1, "a stale freeze exits 1");
  assert(/STALE/.test(run.stderr), `the failure names the stale artifact (stderr: ${run.stderr.slice(0, 240)})`);
  assertEqual((await arenaSpawns()).length, 0, "zero Arena subprocesses");
});

test("19. --write-freeze --wave requires a CLEAN worktree and writes nothing when it refuses", async () => {
  await resetArenaSpawns();
  const probe = path.join(ctx.repoDir, "dirty-probe.txt");
  await writeFile(probe, "uncommitted\n", "utf8");
  try {
    const run = runCli({ actionArgs: ["--write-freeze", "--wave", "rc-wave-2"], out: ctx.repDir });
    assertEqual(run.status, 1, "a dirty worktree refuses the canonical freeze");
    assert(/CLEAN git worktree/.test(run.stderr), `the failure explains the requirement (stderr: ${run.stderr.slice(0, 240)})`);
    assertEqual(await fileDigest(path.join(ctx.repDir, "freezes", "rc-wave-2.json")), null, "no freeze was written");
    assertEqual((await arenaSpawns()).length, 0, "zero Arena subprocesses");
  } finally {
    await rm(probe, { force: true });
  }
});

test("20. --write-freeze --wave writes ONLY its own freeze, binds the manifest, and leaves the historical freeze byte-identical", async () => {
  await resetArenaSpawns();
  const historicalBefore = await fileDigest(path.join(ctx.repDir, "phase5c-freeze.json"));
  const cohortsBefore = await dirDigest(path.join(ctx.repDir, "cohorts"));
  const run = runCli({ actionArgs: ["--write-freeze", "--wave", "rc-wave-2", "--json"], out: ctx.repDir });
  assertEqual(run.status, 0, `the per-wave freeze exits 0 (stderr: ${run.stderr})`);
  const payload = JSON.parse(run.stdout);
  assertEqual(payload.action, ACTION.WRITE_FREEZE, "the JSON names the write-freeze action");
  assertEqual(payload.unitsExecuted, 0, "zero units executed");
  assertEqual(payload.providerCalls, 0, "zero provider calls");
  assertEqual(payload.waveId, "rc-wave-2", "the wave is named");
  assertEqual(payload.path, path.join(ctx.repDir, "freezes", "rc-wave-2.json"), "only the wave's own freeze path was written");
  assertEqual(payload.commit, ctx.repoCommit, "the current HEAD was captured");
  assertEqual(payload.dirtyWorkingTree, false, "the freeze records a clean tree");
  assertEqual(payload.evaluationContractDigest, CANONICAL_EVALUATION_CONTRACT_DIGEST, "the new freeze keeps the canonical contract");

  const freeze = await readFreeze({ root: ctx.repDir, file: "freezes/rc-wave-2.json" });
  assertEqual(freeze.freezeDigest, payload.freezeDigest, "the printed digest matches the persisted artifact");
  assert(freeze.freezeDigest !== CANONICAL_FREEZE_DIGEST, "the wave's full freeze digest differs from Wave 1's (different commit)");
  assertEqual(evaluationContractDigest(freeze), CANONICAL_EVALUATION_CONTRACT_DIGEST, "but the evaluation contract is identical");

  assertEqual(await fileDigest(path.join(ctx.repDir, "phase5c-freeze.json")), historicalBefore, "the historical root freeze was NOT touched");
  assertEqual(await dirDigest(path.join(ctx.repDir, "cohorts")), cohortsBefore, "the frozen cohorts were NOT rewritten");
  assertEqual((await arenaSpawns()).length, 0, "zero Arena subprocesses");

  const bound = await readWaveManifest(ctx.repDir, "rc-wave-2");
  assertEqual(bound.freezeDigest, freeze.freezeDigest, "the manifest is bound to the new freeze");
  assertEqual(bound.evaluationContractDigest, CANONICAL_EVALUATION_CONTRACT_DIGEST, "the manifest records the contract");
  assertEqual(bound.replicationId, payload.replicationId, "the manifest records the new replication id");
  assert(/^rep-[0-9a-f]{12}$/.test(bound.replicationId ?? ""), "the replication id keeps its shape");
  assert(bound.manifestDigest !== ctx.manifests.unbound.manifestDigest, "binding changed the wave's manifest digest");

  // Idempotent: writing again yields the same digests and still stops.
  const second = runCli({ actionArgs: ["--write-freeze", "--wave", "rc-wave-2", "--json"], out: ctx.repDir });
  assertEqual(second.status, 0, "a second per-wave freeze exits 0");
  const again = JSON.parse(second.stdout);
  assertEqual(again.digestChanged, false, "the freeze digest is unchanged");
  assertEqual(again.replicationId, payload.replicationId, "the replication id is unchanged");
  assertEqual(await fileDigest(path.join(ctx.repDir, "phase5c-freeze.json")), historicalBefore, "the historical freeze is still untouched");
});

test("21. --verify-freeze --wave passes on the bound freeze and fails on a contract mismatch", async () => {
  await resetArenaSpawns();
  const run = runCli({ actionArgs: ["--verify-freeze", "--wave", "rc-wave-2", "--json"], out: ctx.repDir });
  assertEqual(run.status, 0, `the wave verification exits 0 (stderr: ${run.stderr})`);
  const report = JSON.parse(run.stdout);
  assertEqual(report.action, ACTION.VERIFY_FREEZE, "the JSON names the verify-freeze action");
  assertEqual(report.ok, true, "no critical drift is reported");
  assertEqual(report.manifestPinMatchesStored, true, "the manifest pin matches the stored freeze");
  assertEqual(report.evaluationContractMatchesPin, true, "the contract matches the manifest pin");
  assertEqual(report.comparableWithHistoricalContract, true, "the wave is comparable with the historical contract");

  // Tamper with the manifest's contract pin: the wave must be refused, loudly.
  const stored = await readWaveManifest(ctx.repDir, "rc-wave-2");
  const tampered = { ...stored, evaluationContractDigest: "7".repeat(64) };
  await writeWaveManifest(ctx.repDir, tampered, { overwrite: true });
  const refused = runCli({ actionArgs: ["--verify-freeze", "--wave", "rc-wave-2"], out: ctx.repDir });
  assertEqual(refused.status, 1, "a contract mismatch exits 1");
  assert(/contract matches wave pin:\s+false/.test(refused.stdout), "the report states the mismatch");
  // Restore the true pin.
  await writeWaveManifest(ctx.repDir, stored, { overwrite: true });
  assertEqual((await arenaSpawns()).length, 0, "zero Arena subprocesses");
});

test("22. the per-wave plan uses the wave's OWN freeze and its bound replication id", async () => {
  await resetArenaSpawns();
  const bound = await readWaveManifest(ctx.repDir, "rc-wave-2");
  const run = runCli({ actionArgs: ["--wave", "rc-wave-2", "--plan", "--json"], out: ctx.repDir });
  assertEqual(run.status, 0, `the wave plan exits 0 (stderr: ${run.stderr})`);
  const payload = JSON.parse(run.stdout);
  assertEqual(payload.unitsExecuted, 0, "the plan executes zero units");
  assertEqual(payload.units.length, 6, "three datasets x two providers");
  assertDeepEqual(payload.datasetIds, ["ds-w2-a", "ds-w2-b", "ds-w2-c"], "exactly the predeclared membership");
  assertEqual(payload.freezeDigest, bound.freezeDigest, "the plan is bound to the wave's own freeze");
  assertEqual(payload.replicationId, bound.replicationId, "the plan uses the wave-bound replication id");
  assertEqual(payload.units.filter((unit) => unit.datasetId.startsWith("ds-w1")).length, 0, "no other wave's dataset appears");
  assert(Object.values(payload.waveValidation).every(Boolean), `every wave validation check passed (${JSON.stringify(payload.waveValidation)})`);
  assertEqual((await arenaSpawns()).length, 0, "the plan spawns no Arena");

  const plan = planReplication({
    freeze: { ...(await readFreeze({ root: ctx.repDir, file: bound.freezePath })), replicationId: bound.replicationId, cohortDigests: bound.cohortDigests },
    cohorts: { mock: await readFrozenCohort(ctx.repDir, "mock"), deepseek: await readFrozenCohort(ctx.repDir, "deepseek") },
    datasets: [
      { datasetId: "ds-w2-a", fingerprint: FP.a },
      { datasetId: "ds-w2-b", fingerprint: FP.b },
      { datasetId: "ds-w2-c", fingerprint: FP.c },
    ],
    providers: ["mock", "deepseek"],
  });
  assertDeepEqual(plan.units.map((unit) => unit.unitId), payload.units.map((unit) => unit.unitId), "the plan is reproducible offline");
});

test("23. the canonical wave run needs NO --dev and records CANONICAL", async () => {
  await resetArenaSpawns();
  const bound = await readWaveManifest(ctx.repDir, "rc-wave-2");
  const run = runCli({ actionArgs: ["--wave", "rc-wave-2"], out: ctx.repDir });
  assertEqual(run.status, 0, `the canonical wave run exits 0 (stderr: ${run.stderr.slice(-300)})`);
  const spawns = await arenaSpawns();
  assertEqual(spawns.length, 6, "three datasets x two providers were executed against the stub Arena");
  assert(spawns.every((line) => line.startsWith("spawn ")), "every spawn came from the stub");

  const manifest = JSON.parse(await readFile(path.join(ctx.repDir, bound.replicationId, "manifest.json"), "utf8"));
  assertEqual(manifest.replicationId, bound.replicationId, "the run belongs to the wave-bound replication id");
  assertEqual(manifest.freezeDigest, bound.freezeDigest, "the run records the wave's own freeze digest");
  assertEqual(manifest.canonicality?.label, "CANONICAL", "the run is labelled CANONICAL without --dev");
  assertEqual(manifest.canonicality?.canonical, true, "the canonicality verdict is canonical");
  assertEqual(manifest.wave?.waveId, "rc-wave-2", "the run is annotated with its wave");
  assertEqual(manifest.waveManifestDigest, bound.manifestDigest, "the run records the bound wave manifest digest");
  assertEqual(manifest.units.length, 6, "six units are recorded");
});

test("24. a --dev run stays NON_CANONICAL even when the freeze matches", async () => {
  await resetArenaSpawns();
  const bound = await readWaveManifest(ctx.repDir, "rc-wave-2");
  const devRoot = path.join(ctx.tmp, "dev-replication");
  await cp(ctx.repDir, devRoot, { recursive: true });
  const probe = path.join(ctx.repoDir, "dev-dirty-probe.txt");
  await writeFile(probe, "dirty\n", "utf8");
  try {
    const run = runCli({ actionArgs: ["--wave", "rc-wave-2", "--dev"], out: devRoot });
    assertEqual(run.status, 0, `the --dev run exits 0 (stderr: ${run.stderr.slice(-200)})`);
    const manifest = JSON.parse(await readFile(path.join(devRoot, bound.replicationId, "manifest.json"), "utf8"));
    assertEqual(manifest.canonicality?.label, "NON_CANONICAL", "--dev evidence is labelled NON_CANONICAL");
    assertEqual(manifest.canonicality?.canonical, false, "--dev evidence is never canonical");
    assertEqual(manifest.canonicality?.devOverride, true, "the development override is recorded");
    assert(
      (manifest.canonicality?.reasons ?? []).some((reason) => /dirty/.test(reason)),
      "the reason names the dirty working tree",
    );
  } finally {
    await rm(probe, { force: true });
    await rm(devRoot, { recursive: true, force: true });
  }
});

test("25. a historical wave is NEVER re-run", async () => {
  await resetArenaSpawns();
  const run = runCli({ actionArgs: ["--wave", "rc-wave-1"], out: ctx.repDir });
  assertEqual(run.status, 1, "running a historical wave exits 1");
  assert(/HISTORICAL/.test(run.stderr), `the failure explains why (stderr: ${run.stderr.slice(0, 240)})`);
  assertEqual((await arenaSpawns()).length, 0, "zero Arena subprocesses");
  // The real Wave 1 is refused too, read-only, against the real registry
  // (metadata only: the historical guard fires before anything is read).
  const real = runCli({
    actionArgs: ["--wave", "wave-1"],
    out: REAL_BASE,
    cwd: process.cwd(),
    env: {
      EVOLVE_HISTORY_ROOT: path.join(process.cwd(), ".evolve", "history"),
      EVOLVE_ARENAS_DIR: path.join(process.cwd(), ".evolve", "arenas"),
    },
  });
  assertEqual(real.status, 1, "the real Wave 1 is refused too");
  assert(/HISTORICAL/.test(real.stderr), "with the same explicit reason");
});

/* ============================================================================
 * 26-30: cross-wave comparability, noncanonical filtering, regressions
 * ==========================================================================*/

function fakeSummary(replicationId, datasets) {
  const perDataset = datasets.map((row) => ({
    datasetId: row.datasetId,
    datasetFingerprint: row.fingerprint,
    clean: true,
    role: "REPLICATION",
    leakage: "CLEAN_REPLICATION",
    paired: { paired: true, deltaOfDeltas: { medianArenaScore: row.value } },
    mock: { status: "COMPLETED", deltas: { medianArenaScore: 60 } },
    deepseek: { status: "COMPLETED", deltas: { medianArenaScore: 60 + row.value } },
  }));
  return { replicationId, cleanDatasets: datasets.map((row) => row.datasetId), perDataset };
}

async function writeMetaFixture(root, waves) {
  await mkdir(root, { recursive: true });
  for (const wave of waves) {
    const replicationId = `rep-${wave.waveId.replace(/[^a-z0-9]/gi, "").slice(0, 8)}`;
    const manifest = {
      schemaVersion: 1,
      phase: "5C.2",
      paperOnly: true,
      version: 1,
      waveId: wave.waveId,
      identityMode: "wave",
      historical: false,
      replicationId,
      freezePath: `freezes/${wave.waveId}.json`,
      freezeDigest: wave.freezeDigest,
      evaluationContractDigest: wave.contract,
      mockCohortDigest: wave.mockCohortDigest,
      deepseekCohortDigest: wave.deepseekCohortDigest,
      cohortDigests: { mock: wave.mockCohortDigest, deepseek: wave.deepseekCohortDigest },
      datasetIds: wave.datasets.map((row) => row.datasetId),
      datasetFingerprints: Object.fromEntries(wave.datasets.map((row) => [row.datasetId, row.fingerprint])),
      priorWaveIds: [],
      excludedDatasetIds: [],
      jevInvolved: false,
      providerCallsRequired: false,
      status: "COMPLETED",
      notes: [],
      createdAt: new Date(CLOCK).toISOString(),
    };
    await writeWaveManifest(root, manifest, { overwrite: true });
    const runDir = path.join(root, replicationId);
    await mkdir(runDir, { recursive: true });
    await writeFile(path.join(runDir, "summary.json"), `${JSON.stringify(fakeSummary(replicationId, wave.datasets), null, 2)}\n`, "utf8");
    await writeFile(
      path.join(runDir, "manifest.json"),
      `${JSON.stringify({ replicationId, canonicality: { canonical: wave.canonical !== false, label: wave.canonical === false ? "NON_CANONICAL" : "CANONICAL", devOverride: wave.canonical === false } }, null, 2)}\n`,
      "utf8",
    );
  }
}

const MOCK_COHORT = "b26d63a2a0787e954ed7e4e63e668fe4664e58059508145345214facc4e12858";
const DEEPSEEK_COHORT = "13c7c93d707b26f8b92042d488ff0a63f5de3f9f81b8145be4eac7a70cc550a8";

test("26. the meta-summary accepts different full freezes with matching evaluation contracts", async () => {
  const root = path.join(ctx.metaDir, "comparable");
  await writeMetaFixture(root, [
    {
      waveId: "w-a",
      freezeDigest: "1".repeat(64),
      contract: CANONICAL_EVALUATION_CONTRACT_DIGEST,
      mockCohortDigest: MOCK_COHORT,
      deepseekCohortDigest: DEEPSEEK_COHORT,
      datasets: [
        { datasetId: "d1", fingerprint: FP.a, value: 10 },
        { datasetId: "d2", fingerprint: FP.b, value: -2 },
      ],
    },
    {
      waveId: "w-b",
      freezeDigest: "2".repeat(64),
      contract: CANONICAL_EVALUATION_CONTRACT_DIGEST,
      mockCohortDigest: MOCK_COHORT,
      deepseekCohortDigest: DEEPSEEK_COHORT,
      datasets: [{ datasetId: "d3", fingerprint: FP.c, value: 4 }],
    },
  ]);

  const meta = await loadMetaSummary({ baseDir: root, generatedAt: CLOCK });
  assertEqual(meta.comparability.status, "COMPARABLE_WAVES", "different full freezes with one contract are comparable");
  assertEqual(meta.comparability.comparable, true, "comparability is reported as true");
  assertEqual(meta.totalCleanDatasets, 3, "both waves contribute dataset-level observations");
  assertDeepEqual(meta.datasetsPerWave, { "w-a": 2, "w-b": 1 }, "the per-wave counts are preserved");
  assertEqual(meta.significance, null, "still no significance claim");
  assertEqual(meta.verdict, null, "still no verdict");
  assert(meta.waves.every((row) => row.freezeDigest !== meta.waves[0].freezeDigest || row.waveId === "w-a"), "the waves genuinely carry different freeze digests");

  await resetArenaSpawns();
  const cli = runCli({ actionArgs: ["--meta-summary", "--waves", "w-a,w-b", "--json"], out: root });
  assertEqual(cli.status, 0, `the CLI meta-summary exits 0 (stderr: ${cli.stderr})`);
  assertEqual(JSON.parse(cli.stdout).comparability.status, "COMPARABLE_WAVES", "the CLI reports the same verdict");
  assertEqual((await arenaSpawns()).length, 0, "zero Arena subprocesses");
});

test("27. the meta-summary REFUSES to combine waves with different evaluation contracts", async () => {
  const root = path.join(ctx.metaDir, "incomparable");
  await writeMetaFixture(root, [
    {
      waveId: "w-a",
      freezeDigest: "1".repeat(64),
      contract: CANONICAL_EVALUATION_CONTRACT_DIGEST,
      mockCohortDigest: MOCK_COHORT,
      deepseekCohortDigest: DEEPSEEK_COHORT,
      datasets: [{ datasetId: "d1", fingerprint: FP.a, value: 10 }],
    },
    {
      waveId: "w-b",
      freezeDigest: "2".repeat(64),
      contract: "0".repeat(64),
      mockCohortDigest: MOCK_COHORT,
      deepseekCohortDigest: DEEPSEEK_COHORT,
      datasets: [{ datasetId: "d3", fingerprint: FP.c, value: 4 }],
    },
  ]);

  const meta = await loadMetaSummary({ baseDir: root, generatedAt: CLOCK });
  assertEqual(meta.comparability.status, "INCOMPARABLE_WAVES", "the status names the refusal");
  assertEqual(meta.comparability.comparable, false, "it is not comparable");
  assert(
    meta.comparability.differences.some((row) => row.field === "evaluationContractDigest"),
    "the differing field is named explicitly",
  );
  assert(
    meta.limitations.some((row) => /INCOMPARABLE_WAVES/.test(row)),
    "the limitations state that the combination is refused",
  );

  await resetArenaSpawns();
  const cli = runCli({ actionArgs: ["--meta-summary", "--waves", "w-a,w-b"], out: root });
  assertEqual(cli.status, 1, "the CLI exits 1 instead of silently aggregating");
  assert(/INCOMPARABLE_WAVES/.test(cli.stderr), `the failure is explicit (stderr: ${cli.stderr.slice(0, 240)})`);
  assert(/evaluationContractDigest/.test(cli.stderr), "the differing field is named on stderr");
  assertEqual((await arenaSpawns()).length, 0, "zero Arena subprocesses");
});

test("28. NON_CANONICAL (--dev) runs are excluded from the meta-summary by default", async () => {
  const root = path.join(ctx.metaDir, "noncanonical");
  await writeMetaFixture(root, [
    {
      waveId: "w-a",
      freezeDigest: "1".repeat(64),
      contract: CANONICAL_EVALUATION_CONTRACT_DIGEST,
      mockCohortDigest: MOCK_COHORT,
      deepseekCohortDigest: DEEPSEEK_COHORT,
      datasets: [{ datasetId: "d1", fingerprint: FP.a, value: 10 }],
      canonical: true,
    },
    {
      waveId: "w-b",
      freezeDigest: "2".repeat(64),
      contract: CANONICAL_EVALUATION_CONTRACT_DIGEST,
      mockCohortDigest: MOCK_COHORT,
      deepseekCohortDigest: DEEPSEEK_COHORT,
      datasets: [{ datasetId: "d3", fingerprint: FP.c, value: 4 }],
      canonical: false,
    },
  ]);

  const canonical = await loadMetaSummary({ baseDir: root, generatedAt: CLOCK });
  assertEqual(canonical.totalCleanDatasets, 1, "only the canonical wave contributes");
  assertDeepEqual(canonical.excludedNoncanonical.map((row) => row.waveId), ["w-b"], "the noncanonical wave is listed as excluded");
  assertDeepEqual(canonical.aggregatedWaveIds, ["w-a"], "only the canonical wave is aggregated");
  assertEqual((await readRunCanonicality(root, "rep-wb")).canonical, false, "the run label is read from the run manifest");

  const included = await loadMetaSummary({ baseDir: root, generatedAt: CLOCK, includeNoncanonical: true });
  assertEqual(included.totalCleanDatasets, 2, "--include-noncanonical opts the dev evidence back in");
  assertDeepEqual(included.excludedNoncanonical, [], "nothing is excluded when explicitly included");
  assertEqual(included.includeNoncanonical, true, "the report states the override");

  await resetArenaSpawns();
  const cli = runCli({ actionArgs: ["--meta-summary", "--waves", "w-a,w-b", "--json"], out: root });
  assertEqual(cli.status, 0, `the CLI exits 0 (stderr: ${cli.stderr})`);
  assertEqual(JSON.parse(cli.stdout).totalCleanDatasets, 1, "the CLI excludes the noncanonical wave by default");
});

test("29. the wave-LESS --write-freeze still writes only the historical root freeze", async () => {
  await resetArenaSpawns();
  const out = path.join(ctx.tmp, "waveless-freeze");
  const run = runCli({ actionArgs: ["--write-freeze", "--json"], out });
  assertEqual(run.status, 0, `the wave-less freeze exits 0 (stderr: ${run.stderr})`);
  const payload = JSON.parse(run.stdout);
  assertEqual(payload.path, path.join(out, "phase5c-freeze.json"), "the historical root path is unchanged");
  assertDeepEqual((await readdir(out, { recursive: true })).map(String).sort(), ["phase5c-freeze.json"], "ONLY the root freeze artifact was written");
  assertEqual((await arenaSpawns()).length, 0, "zero Arena subprocesses");
  assertEqual(await fileDigest(path.join(out, "freezes", "wave-2.json")), null, "no per-wave freeze was created");
});

test("30. the real artifacts and the Wave 2 captures are untouched by the whole suite", async () => {
  const now = await realSnapshot();
  assertDeepEqual(now, realBaseline, "the canonical freeze, replication, cohorts and wave manifests are byte-identical");
  const meta = JSON.parse(await readFile(path.join(REAL_BASE, CANONICAL_REPLICATION_ID, "manifest.json"), "utf8"));
  assertEqual(meta.freezeDigest, CANONICAL_FREEZE_DIGEST, "the canonical replication still binds the canonical freeze");
  assertEqual(meta.units.length, 6, "it still holds six units");
  for (const id of WAVE_2_DATASET_IDS) {
    const manifest = JSON.parse(
      await readFile(path.join(".evolve", "history", "2026-09-19", id, "manifest.json"), "utf8"),
    );
    assertEqual(manifest.fingerprint.combined, WAVE_2_DATASET_FINGERPRINTS[id], `${id} still matches its pinned fingerprint (metadata only)`);
  }
  assertEqual(
    await fileDigest(path.join("scripts", "intelligence", ".phase5c3-import-probe.mjs")),
    null,
    "the temporary import-graph probe was removed",
  );
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
    realBaseline = await realSnapshot();
  } catch (error) {
    console.error("could not build Phase 5C.3 fixtures:", error?.stack ?? error);
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
  console.log(`EVOLVE Phase 5C.3 per-wave-freeze validation: ${passed}/${cases.length} checks passed`);

  if (failures.length > 0) {
    console.log("Failed checks:");
    for (const failure of failures) console.log(`  - ${failure.name}`);
    process.exitCode = 1;
  } else {
    console.log("All Phase 5C.3 checks passed. Each wave is canonical against its OWN freeze;");
    console.log("cross-wave comparability is decided by the evaluation contract plus both frozen cohort digests.");
    console.log("Wave 1, its freeze, its cohorts and its replication were never modified.");
  }
}

run().catch((error) => {
  console.error("phase 5C.3 validation runner crashed:", error);
  process.exitCode = 1;
});
