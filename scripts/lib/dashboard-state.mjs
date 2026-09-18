/**
 * Dashboard state contract (Phase 5A.1).
 *
 * This module owns everything `/api/state` does with `.evolve/`: which state
 * file is selected for a requested source, which read-only research artifacts
 * are attached, and — the Phase 5A.1 fix — the separation of the two concepts
 * that used to share one ambiguous `research` key:
 *
 *   researchSwarm       the CURRENT Phase 5A controlled research swarm
 *                       (propose -> validate -> compile -> inject -> watchdog ->
 *                       memory), written into the live engine snapshot by
 *                       `evolve-engine.mjs` as `researchSwarm`
 *
 *   historicalResearch  Phase 3/4 historical + replay reference data: the replay
 *                       document's own metadata, the newest walk-forward
 *                       experiment report, the champion archive, the newest
 *                       arena run, the Hall of Fame, and the Live Shadow League
 *
 * Why it moved out of the route: the Phase 5A live run's `/api/state` response
 * showed a stale Phase 3 synthetic `session-demo` replay under `research` while
 * the live swarm summary was nowhere in the document. Two independent defects
 * caused that: (1) `auto` source selection preferred an existing *replay*
 * document over an existing (merely stale) live one, so the whole dashboard
 * flipped to an old replay file that has no swarm summary at all; and (2) the
 * API field named `research` meant "historical replay reference data", not the
 * swarm. The contract here fixes both, and being a plain module it is directly
 * exercisable by the offline validation suite (see `validate-phase5a.mjs`, cases
 * 64+, and `npm run smoke:swarm`).
 *
 * PAPER ONLY. This module reads files and builds a response body; it has no
 * network access, no credentials, and no execution path. The route still runs
 * the public sanitizer over the result on the way out.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

export const DASHBOARD_STATE_CONTRACT_VERSION = 2;

export const STATE_FILES = Object.freeze({
  live: "state.json",
  replay: "replay-state.json",
});

/** A live snapshot older than this renders the dashboard's stale-strip. */
export const LIVE_FRESH_MS = 45_000;

const MAX_EXPERIMENT_WINDOWS = 12;
const MAX_CANDIDATES_PER_WINDOW = 8;
const MAX_CHAMPIONS = 24;
const MAX_BASELINE_ROWS = 24;
const MAX_ARENA_LEADERBOARD = 12;
const MAX_HOF_ROWS = 16;
const MAX_SHADOW_CANDIDATES = 16;

const RESEARCH_DISCLAIMER =
  "Historical backtests and paper results do NOT guarantee future profitability. Every value shown is simulated paper accounting.";

export async function readJsonFile(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

export async function fileInfo(file) {
  try {
    const info = await stat(file);
    return { exists: true, mtimeMs: info.mtimeMs, size: info.size };
  } catch {
    return { exists: false, mtimeMs: 0, size: 0 };
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function num(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Which isolated state document `/api/state` serves.
 *
 * - an explicitly requested source is honored (and yields null when that file
 *   does not exist, so the caller can return a 503 with a hint);
 * - `auto` uses **live whenever the live state file exists**, even when it is
 *   stale: a stale live snapshot is still the current live run, whereas the
 *   replay document is a separate, older artifact. Letting a stale replay win
 *   is exactly what made the dashboard show a Phase 3 `session-demo` replay
 *   instead of the live Phase 5A swarm. `auto` only falls back to replay when
 *   there is no live state at all.
 */
export function selectStateSource({ requested = "auto", live = { exists: false }, replay = { exists: false } } = {}) {
  const normalized = String(requested ?? "auto").trim().toLowerCase();
  if (normalized === "live") return live.exists ? "live" : null;
  if (normalized === "replay") return replay.exists ? "replay" : null;
  if (live.exists) return "live";
  if (replay.exists) return "replay";
  return null;
}

/** One candidate row, trimmed to what the dashboard can render. */
export function compactCandidate(candidate) {
  if (!isRecord(candidate)) return null;
  const validation = isRecord(candidate.validation) ? candidate.validation : null;
  const test = isRecord(candidate.test) ? candidate.test : null;
  const train = isRecord(candidate.train) ? candidate.train : null;

  return {
    // `candidateId`, not `key`: the shared sanitizer drops credential-looking
    // field names, and this identifier must reach the browser.
    candidateId: candidate.candidateId ?? null,
    species: candidate.species ?? null,
    lineageId: candidate.lineageId ?? null,
    seeds: asArray(candidate.seeds),
    classification: candidate.classification ?? null,
    reason: candidate.reason ?? null,
    overfitWarning: candidate.overfitWarning === true,
    train: train
      ? { netReturn: num(train.netReturn), robustness: num(train.robustness), trades: num(train.trades) }
      : null,
    validation: validation
      ? {
          netReturn: num(validation.netReturn),
          robustness: num(validation.robustness),
          maxDrawdown: num(validation.maxDrawdown),
          trades: num(validation.trades),
          distinctMints: num(validation.distinctMints),
          costs: num(validation.costs),
          classification: validation.classification ?? null,
          evidence: isRecord(validation.evidence)
            ? { sufficient: validation.evidence.sufficient === true, label: validation.evidence.label ?? null, missing: asArray(validation.evidence.missing) }
            : null,
        }
      : null,
    test: test
      ? {
          netReturn: num(test.netReturn),
          robustness: num(test.robustness),
          maxDrawdown: num(test.maxDrawdown),
          trades: num(test.trades),
          distinctMints: num(test.distinctMints),
          costs: num(test.costs),
          classification: test.classification ?? null,
          evidence: isRecord(test.evidence)
            ? { sufficient: test.evidence.sufficient === true, label: test.evidence.label ?? null, missing: asArray(test.evidence.missing) }
            : null,
        }
      : null,
  };
}

/** Trim a walk-forward window record for the browser (no market data, no audits). */
export function compactWindow(entry) {
  if (!isRecord(entry)) return null;
  const window = isRecord(entry.window) ? entry.window : null;
  return {
    label: entry.label ?? null,
    index: num(entry.index),
    note: entry.note ?? null,
    window: window
      ? {
          train: window.train ?? null,
          validate: window.validate ?? null,
          test: window.test ?? null,
        }
      : null,
    trainRuns: asArray(entry.trainRuns).map((run) =>
      isRecord(run)
        ? {
            seed: run.seed ?? null,
            ticks: num(run.ticks),
            generations: num(run.generations),
            candidates: num(run.candidates),
            eligible: num(run.eligible),
            considered: num(run.considered),
            excludedForEvidence: num(run.excludedForEvidence),
            freezeAudit: run.freezeAudit ?? null,
          }
        : null,
    ),
    survivors: asArray(entry.survivors),
    candidates: asArray(entry.candidates)
      .slice(0, MAX_CANDIDATES_PER_WINDOW)
      .map(compactCandidate)
      .filter(Boolean),
    candidateCount: asArray(entry.candidates).length,
    // Baselines are trimmed to the fields the dashboard renders: the full
    // metrics objects would dominate the response for every window.
    baselines: asArray(entry.baselines).map((baseline) =>
      isRecord(baseline) && isRecord(baseline.metrics)
        ? {
            id: baseline.id ?? null,
            netReturn: num(baseline.metrics.netReturn),
            robustness: num(baseline.metrics.robustness),
            trades: num(baseline.metrics.trades),
            maxDrawdown: num(baseline.metrics.maxDrawdown),
            classification: baseline.metrics.classification ?? null,
            usesFutureData: baseline.usesFutureData === true,
          }
        : null,
    ),
  };
}

/** The newest experiment report, summarized. Never the raw windows.json. */
export async function loadLatestExperiment(root) {
  let entries = [];
  try {
    entries = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return null;
  }
  if (entries.length === 0) return null;

  // Newest by directory timestamp name, with mtime as a tie-breaker.
  let latest = entries[entries.length - 1];
  let latestMtime = 0;
  for (const name of entries.slice(-6)) {
    const info = await fileInfo(path.join(root, name, "summary.json"));
    if (info.exists && info.mtimeMs >= latestMtime) {
      latestMtime = info.mtimeMs;
      latest = name;
    }
  }

  const dir = path.join(root, latest);
  const manifest = await readJsonFile(path.join(dir, "manifest.json"));
  const summary = await readJsonFile(path.join(dir, "summary.json"));
  if (!isRecord(summary)) return null;

  const windowsRaw = await readJsonFile(path.join(dir, "windows.json"));
  const championsRaw = await readJsonFile(path.join(dir, "champions.json"));

  const baselines = isRecord(summary.baselines) ? asArray(summary.baselines.rows) : [];

  return {
    id: isRecord(manifest) ? manifest.experimentId ?? latest : latest,
    dir,
    createdAt: isRecord(manifest) ? manifest.createdAt ?? null : null,
    endedAt: isRecord(manifest) ? manifest.endedAt ?? null : null,
    durationMs: isRecord(manifest) ? num(manifest.durationMs) : null,
    dataset: isRecord(summary.dataset) ? summary.dataset : null,
    seeds: asArray(summary.seeds),
    windows: num(summary.windows),
    windowsWithCandidates: num(summary.windowsWithCandidates),
    champions: num(summary.champions),
    resultCounts: isRecord(summary.resultCounts) ? summary.resultCounts : null,
    outOfSample: isRecord(summary.outOfSample) ? summary.outOfSample : null,
    classifications: isRecord(summary.classifications) ? summary.classifications : null,
    species: asArray(summary.species),
    baselineRows: baselines.slice(0, MAX_BASELINE_ROWS),
    baselineMedianNetReturn: isRecord(summary.baselines) ? num(summary.baselines.medianNetReturn) : null,
    windowPlanScaled: isRecord(manifest) ? manifest.windowPlanScaled === true : false,
    windowsRun: asArray(windowsRaw).length,
    windowRows: asArray(windowsRaw)
      .slice(0, MAX_EXPERIMENT_WINDOWS)
      .map(compactWindow)
      .filter(Boolean),
    championRows: asArray(championsRaw)
      .slice(0, MAX_CHAMPIONS)
      .map((champion) =>
        isRecord(champion)
          ? {
              id: champion.id ?? null,
              species: champion.species ?? null,
              lineageId: champion.lineageId ?? null,
              window: isRecord(champion.window) ? champion.window.label ?? null : null,
              seeds: asArray(champion.seeds),
              classification: champion.classification ?? null,
              reason: champion.reason ?? null,
              overfitWarning: champion.overfitWarning === true,
              netReturn: num(champion.netReturn),
              maxDrawdown: num(champion.maxDrawdown),
              tradeCount: num(champion.tradeCount),
              distinctMints: num(champion.distinctMints),
              costs: num(champion.costs),
              robustness: num(champion.robustness),
              genomeDigest: champion.genomeDigest ?? null,
              datasetFingerprint: champion.datasetFingerprint ?? null,
              createdAt: champion.createdAt ?? null,
              lineageChain: asArray(champion.lineageChain).slice(0, 12),
            }
          : null,
      )
      .filter(Boolean),
  };
}

/** Champion archive index, summarized (no genomes). */
export async function loadChampionArchive(dir) {
  const index = await readJsonFile(path.join(dir, "index.json"));
  if (!isRecord(index)) {
    return { available: false, count: null, species: [], rows: [] };
  }
  const champions = asArray(index.champions);
  const counts = new Map();
  for (const entry of champions) {
    if (!isRecord(entry)) continue;
    const species = typeof entry.species === "string" ? entry.species : "unknown";
    counts.set(species, (counts.get(species) ?? 0) + 1);
  }

  return {
    available: true,
    count: champions.length,
    updatedAt: index.updatedAt ?? null,
    species: [...counts.entries()].map(([species, count]) => ({ species, count })).sort((a, b) => b.count - a.count),
    rows: champions
      .slice(-MAX_CHAMPIONS)
      .map((entry) =>
        isRecord(entry)
          ? {
              id: entry.id ?? null,
              species: entry.species ?? null,
              window: entry.window ?? null,
              classification: entry.classification ?? null,
              overfitWarning: entry.overfitWarning === true,
              validationRobustness: num(entry.validationRobustness),
              testNetReturn: num(entry.testNetReturn),
              datasetId: entry.datasetId ?? null,
              genomeDigest: entry.genomeDigest ?? null,
              createdAt: entry.createdAt ?? null,
            }
          : null,
      )
      .filter(Boolean),
  };
}

/** The most recently completed arena run, summarized (no genomes). PAPER ONLY. */
export async function loadLatestArena(root) {
  let entries = [];
  try {
    entries = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return null;
  }
  if (entries.length === 0) return null;

  let latest = entries[entries.length - 1];
  let latestMtime = 0;
  for (const name of entries.slice(-6)) {
    const info = await fileInfo(path.join(root, name, "summary.json"));
    if (info.exists && info.mtimeMs >= latestMtime) {
      latestMtime = info.mtimeMs;
      latest = name;
    }
  }

  const dir = path.join(root, latest);
  const manifest = await readJsonFile(path.join(dir, "manifest.json"));
  const summary = await readJsonFile(path.join(dir, "summary.json"));
  if (!isRecord(summary)) return null;

  const funnel = isRecord(summary.funnel) ? summary.funnel : {};
  const funnelRows = Object.entries(funnel).map(([stage, row]) => ({
    stage,
    entered: isRecord(row) ? num(row.entered) ?? 0 : 0,
    survivors: isRecord(row) ? num(row.survivors) ?? 0 : 0,
    rule: isRecord(row) && typeof row.rule === "string" ? row.rule : null,
  }));

  const shortDigest = (value) => (typeof value === "string" ? value.slice(0, 12) : null);

  return {
    arenaId: isRecord(manifest) ? manifest.arenaId ?? latest : latest,
    createdAt: isRecord(manifest) ? manifest.createdAt ?? null : null,
    durationMs: num(summary.durationMs),
    entrants: num(summary.entrants),
    datasets: asArray(summary.datasets)
      .map((entry) => (isRecord(entry) ? { id: entry.id ?? null, sourceType: entry.sourceType ?? null } : null))
      .filter(Boolean),
    seeds: asArray(summary.seeds),
    stressProfiles: asArray(summary.stressProfiles),
    funnel: funnelRows,
    leaderboard: asArray(summary.leaderboard)
      .slice(0, MAX_ARENA_LEADERBOARD)
      .map((row) =>
        isRecord(row)
          ? {
              digest: shortDigest(row.digest),
              species: row.species ?? null,
              origin: row.origin ?? null,
              score: num(row.score),
              status: row.status ?? null,
              failedGates: asArray(row.failedGates).filter((gate) => typeof gate === "string"),
            }
          : null,
      )
      .filter(Boolean),
    deploymentCandidates: asArray(summary.deploymentCandidates)
      .map((row) => (isRecord(row) ? { digest: shortDigest(row.digest), species: row.species ?? null, score: num(row.score) } : null))
      .filter(Boolean),
    diversity: isRecord(summary.diversity)
      ? {
          populationSize: num(summary.diversity.populationSize),
          uniqueGenomes: num(summary.diversity.uniqueGenomes),
          genomeDiversity: num(summary.diversity.genomeDiversity),
          lineageConcentration: num(summary.diversity.lineageConcentration),
        }
      : null,
    diversityVerdict: isRecord(summary.diversityVerdict)
      ? { healthy: summary.diversityVerdict.healthy === true, action: summary.diversityVerdict.action ?? null }
      : null,
    adaptiveMutation: isRecord(summary.adaptiveMutation)
      ? {
          scale: num(summary.adaptiveMutation.scale),
          previousScale: num(summary.adaptiveMutation.previousScale),
          reason: summary.adaptiveMutation.reason ?? null,
        }
      : null,
    note: summary.note ?? null,
    paperOnly: true,
  };
}

/** Hall of Fame index, summarized. Membership never implies deployment eligibility. */
export async function loadHallOfFame(dir) {
  const index = await readJsonFile(path.join(dir, "index.json"));
  if (!isRecord(index)) {
    return { available: false, count: 0, updatedAt: null, note: null, rows: [] };
  }
  const members = asArray(index.members);
  return {
    available: true,
    count: members.length,
    updatedAt: index.updated ?? null,
    note: index.note ?? null,
    rows: members
      .slice(0, MAX_HOF_ROWS)
      .map((entry) =>
        isRecord(entry)
          ? {
              digest: typeof entry.digest === "string" ? entry.digest.slice(0, 12) : null,
              species: entry.species ?? null,
              arenaAppearances: num(entry.arenaAppearances),
              titleDefenses: num(entry.titleDefenses),
              eliminations: num(entry.eliminations),
              bestArenaScore: num(entry.bestArenaScore),
              latestArenaScore: num(entry.latestArenaScore),
              bestStatus: entry.bestStatus ?? null,
            }
          : null,
      )
      .filter(Boolean),
  };
}

/** Live Shadow League candidates, summarized. Always paper-only; genomes never included. */
export async function loadShadowLeague(dir) {
  let files = [];
  try {
    files = (await readdir(dir)).filter((name) => name.endsWith(".json"));
  } catch {
    return { available: false, count: 0, rows: [] };
  }

  const rows = [];
  for (const name of files.slice(0, MAX_SHADOW_CANDIDATES)) {
    const record = await readJsonFile(path.join(dir, name));
    if (!isRecord(record)) continue;
    rows.push({
      candidateId: record.candidateId ?? null,
      digest: typeof record.digest === "string" ? record.digest.slice(0, 12) : null,
      species: record.species ?? null,
      status: record.status ?? null,
      qualified: record.qualified === true,
      startTimestamp: num(record.startTimestamp),
      runtimeMs: num(record.runtimeMs),
      bankroll: num(record.bankroll),
      netPnl: num(record.netPnl),
      drawdown: num(record.drawdown),
      trades: num(record.trades),
      distinctMints: num(record.distinctMints),
      activePositions: num(record.activePositions),
      marketSource: record.marketSource ?? null,
      durationMilestones: isRecord(record.durationMilestones)
        ? Object.fromEntries(Object.entries(record.durationMilestones).map(([key, value]) => [key, value === true]))
        : null,
    });
  }
  return { available: rows.length > 0, count: rows.length, rows };
}

/**
 * Compact Phase 5C replication status (PAPER ONLY, read-only).
 *
 * Reads only tiny artifacts: the freeze digest, the frozen cohort manifests,
 * and the newest run's compact `status.json` (plus the run manifest's unit
 * statuses). It never loads the large per-dataset summary tables, so the
 * once-per-second dashboard poll stays cheap. No credentials, no genome rows.
 */
export async function loadReplicationState(root = path.join(process.cwd(), ".evolve")) {
  const baseDir = path.join(root, "replication");
  const freeze = await readJsonFile(path.join(baseDir, "phase5c-freeze.json"));
  const cohorts = {};
  for (const key of ["mock", "deepseek"]) {
    const manifest = await readJsonFile(path.join(baseDir, "cohorts", key, "cohort-manifest.json"));
    if (manifest) cohorts[key] = { count: manifest.count ?? null, cohortDigest: manifest.cohortDigest ?? null, provider: manifest.provider ?? null };
  }

  let dirs = [];
  try {
    dirs = (await readdir(baseDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("rep-"))
      .map((entry) => entry.name)
      .sort();
  } catch {
    dirs = [];
  }
  const newest = dirs.length > 0 ? dirs[dirs.length - 1] : null;

  let statusRecord = null;
  let unitCounts = null;
  if (newest) {
    statusRecord = await readJsonFile(path.join(baseDir, newest, "status.json"));
    const manifest = await readJsonFile(path.join(baseDir, newest, "manifest.json"));
    if (manifest) {
      const units = asArray(manifest.units);
      const count = (value) => units.filter((unit) => unit.status === value).length;
      unitCounts = {
        total: units.length,
        completed: count("COMPLETED"),
        pending: count("PENDING") + count("RUNNING"),
        failed: count("FAILED"),
        skipped: count("SKIPPED") + count("INVALID_DATASET") + count("CONTAMINATED"),
      };
    }
  }

  if (!freeze && !statusRecord) {
    return {
      available: false,
      paperOnly: true,
      note: "No Phase 5C replication run has been prepared in this workspace yet (npm run replicate:research).",
    };
  }

  return {
    available: true,
    paperOnly: true,
    freezeVersion: freeze?.freezeVersion ?? null,
    freezeDigest: freeze?.freezeDigest ?? null,
    cohorts,
    replicationId: statusRecord?.replicationId ?? newest ?? null,
    status: statusRecord?.status ?? null,
    replicationStatus: statusRecord?.replicationStatus ?? null,
    realDatasets: statusRecord?.realDatasets ?? null,
    cleanReplicationDatasets: statusRecord?.cleanReplicationDatasets ?? null,
    eligibleReplicationDatasets: statusRecord?.eligibleReplicationDatasets ?? null,
    developmentDatasets: statusRecord?.developmentDatasets ?? null,
    contaminatedDatasets: statusRecord?.contaminatedDatasets ?? null,
    unknownLeakageDatasets: statusRecord?.unknownLeakageDatasets ?? null,
    syntheticDatasets: statusRecord?.syntheticDatasets ?? null,
    duplicateFingerprintGroups: statusRecord?.duplicateFingerprintGroups ?? null,
    units: unitCounts ?? statusRecord?.units ?? null,
    significance: null,
    verdict: null,
    note:
      statusRecord?.note ??
      "Frozen research cohorts are re-evaluated against independent real datasets. Descriptive only — no winner and no profitability claim.",
  };
}

/**
 * Assemble the two-mode research state.
 *
 * `researchSwarm` is the CURRENT Phase 5A swarm summary. It is taken from the
 * selected document when that document carries one, and otherwise from the live
 * state file — so viewing a historical replay never blanks the swarm panel, and
 * an old replay/experiment document can never masquerade as the current swarm.
 *
 * `historicalResearch` is the Phase 3/4 reference data. It is always labelled as
 * historical, and it never overwrites anything in `researchSwarm`.
 */
export function buildResearchState({ document, source, liveDocument = null, historical = {}, swarmUpdatedAt = null } = {}) {
  const swarmFromDocument = isRecord(document?.researchSwarm) ? document.researchSwarm : null;
  const swarmFromLive = isRecord(liveDocument?.researchSwarm) ? liveDocument.researchSwarm : null;
  const swarm = swarmFromDocument ?? swarmFromLive ?? null;
  const swarmSource = swarmFromDocument ? source : swarmFromLive ? "live" : null;

  return {
    researchSwarm: swarm
      ? {
          ...swarm,
          // Provenance, so the dashboard can say exactly which document the
          // swarm summary came from and when it was written.
          source: swarmSource,
          sourceUpdatedAt: swarmSource === source ? swarmUpdatedAt : null,
          paperOnly: true,
          disclaimer:
            "Research agents propose. Deterministic EVOLVE machinery evaluates. The Champion Arena decides. Paper only — never a profitability claim.",
        }
      : null,
    historicalResearch: {
      // Replay-document metadata (mode/banner/stage/dataset/progress) when the
      // selected document is a replay; absent for a live snapshot.
      ...(isRecord(document?.research) ? document.research : {}),
      ...historical,
      kind: "historical",
      note:
        "Historical/replay reference data (Phase 3/4). This is NOT the current research swarm — see researchSwarm.",
      paperOnly: true,
      disclaimer: RESEARCH_DISCLAIMER,
    },
  };
}

/**
 * Read `.evolve/` and build the full dashboard state body. Returns
 * `{ status, body }`; the caller (the API route) is responsible for running the
 * public sanitizer with the environment secrets before sending it.
 */
export async function readDashboardState({ root = path.join(process.cwd(), ".evolve"), requested = "auto", now = Date.now() } = {}) {
  const info = {
    live: await fileInfo(path.join(root, STATE_FILES.live)),
    replay: await fileInfo(path.join(root, STATE_FILES.replay)),
  };
  const sourcesAvailable = Object.keys(STATE_FILES).filter((key) => info[key].exists);
  const normalizedRequest = String(requested ?? "auto").trim().toLowerCase();
  const chosen = selectStateSource({ requested: normalizedRequest, live: info.live, replay: info.replay });

  if (!chosen) {
    return {
      status: 503,
      body: {
        error: "Engine state is not available yet.",
        hint: "Run npm run dev:all for the live paper engine, or npm run replay -- <dataset> for a historical replay.",
        paperOnly: true,
        stateSource: null,
        stateContractVersion: DASHBOARD_STATE_CONTRACT_VERSION,
        sources: { requested: normalizedRequest, available: sourcesAvailable },
      },
    };
  }

  try {
    const document = JSON.parse(await readFile(path.join(root, STATE_FILES[chosen]), "utf8"));
    const liveDocument =
      chosen === "live" ? document : await readJsonFile(path.join(root, STATE_FILES.live));

    const experiment = await loadLatestExperiment(path.join(root, "experiments"));
    const champions = await loadChampionArchive(path.join(root, "champions"));
    const arena = await loadLatestArena(path.join(root, "arenas"));
    const hallOfFame = await loadHallOfFame(path.join(root, "hall-of-fame"));
    const shadow = await loadShadowLeague(path.join(root, "shadow"));
    const replication = await loadReplicationState(root);

    const researchState = buildResearchState({
      document,
      source: chosen,
      liveDocument,
      historical: { experiment, champions, arena, hallOfFame, shadow },
      swarmUpdatedAt: new Date(info[chosen].mtimeMs).toISOString(),
    });

    const body = isRecord(document)
      ? {
          ...document,
          stateSource: chosen,
          stateUpdatedAt: new Date(info[chosen].mtimeMs).toISOString(),
          stateStale: chosen === "live" ? now - info.live.mtimeMs > LIVE_FRESH_MS : false,
          stateContractVersion: DASHBOARD_STATE_CONTRACT_VERSION,
          sources: {
            requested: normalizedRequest,
            available: sourcesAvailable,
            live: {
              exists: info.live.exists,
              updatedAt: info.live.exists ? new Date(info.live.mtimeMs).toISOString() : null,
              stale: info.live.exists ? now - info.live.mtimeMs > LIVE_FRESH_MS : null,
            },
            replay: {
              exists: info.replay.exists,
              updatedAt: info.replay.exists ? new Date(info.replay.mtimeMs).toISOString() : null,
            },
          },
          // The two distinct concepts, side by side and never merged.
          researchSwarm: researchState.researchSwarm,
          historicalResearch: researchState.historicalResearch,
          // Phase 5C: compact, read-only multi-dataset replication status.
          replication,
        }
      : {
          error: "Unreadable engine state.",
          paperOnly: true,
          stateSource: chosen,
          stateContractVersion: DASHBOARD_STATE_CONTRACT_VERSION,
        };

    return { status: 200, body };
  } catch {
    return {
      status: 503,
      body: {
        error: "Engine state could not be read.",
        paperOnly: true,
        stateSource: chosen,
        stateContractVersion: DASHBOARD_STATE_CONTRACT_VERSION,
      },
    };
  }
}
