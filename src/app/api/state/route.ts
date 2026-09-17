import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";

import { sanitizeForPublic } from "../../../../scripts/lib/sanitize.mjs";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Public dashboard state.
 *
 * State isolation:
 *   live / synthetic engine -> .evolve/state.json
 *   historical replay       -> .evolve/replay-state.json
 *   experiment reports      -> .evolve/experiments/<id>/ (read-only, summarized)
 *   champion archive        -> .evolve/champions/index.json (read-only, summarized)
 *
 * The dashboard asks for a source (`?source=live|replay|auto`). A replay run can
 * therefore never overwrite what the live dashboard shows, and `auto` prefers a
 * fresh live state and falls back to replay.
 *
 * Security: the engine already writes a sanitized, secret-free snapshot, the API
 * key is a non-enumerable config property that never reaches state, and this
 * route re-runs the same sanitizer on the way out with the environment secrets
 * passed explicitly, so a hand-edited or older file still cannot leak a
 * credential, a non-finite number, or an unserializable value to the browser.
 *
 * Historical replay is raw observations replayed through the paper engine; it is
 * never presented as a prediction or as real profit.
 */

const sanitize = sanitizeForPublic as (
  value: unknown,
  options?: { secrets?: string[] },
) => unknown;

const STATE_FILES = {
  live: "state.json",
  replay: "replay-state.json",
} as const;

type StateSource = keyof typeof STATE_FILES;

const MAX_EXPERIMENT_WINDOWS = 12;
const MAX_CANDIDATES_PER_WINDOW = 8;
const MAX_CHAMPIONS = 24;
const MAX_BASELINE_ROWS = 24;

async function readJsonFile(file: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function fileInfo(file: string) {
  try {
    const info = await stat(file);
    return { exists: true, mtimeMs: info.mtimeMs, size: info.size };
  } catch {
    return { exists: false, mtimeMs: 0, size: 0 };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** One candidate row, trimmed to what the dashboard can render. */
function compactCandidate(candidate: unknown) {
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
function compactWindow(entry: unknown) {
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
async function loadLatestExperiment(root: string) {
  let entries: string[] = [];
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
    baselineMedianNetReturn:
      isRecord(summary.baselines) ? num(summary.baselines.medianNetReturn) : null,
    windowPlanScaled: isRecord(manifest) ? manifest.windowPlanScaled === true : false,
    windowsRun: asArray(windowsRaw).length,
    windowRows: asArray(windowsRaw)
      .slice(0, MAX_EXPERIMENT_WINDOWS)
      .map(compactWindow)
      .filter(Boolean),
    championRows: asArray(championsRaw).slice(0, MAX_CHAMPIONS).map((champion) =>
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
    ).filter(Boolean),
  };
}

/** Champion archive index, summarized (no genomes). */
async function loadChampionArchive(dir: string) {
  const index = await readJsonFile(path.join(dir, "index.json"));
  if (!isRecord(index)) {
    return { available: false, count: null, species: [], rows: [] };
  }
  const champions = asArray(index.champions);
  const counts = new Map<string, number>();
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
    rows: champions.slice(-MAX_CHAMPIONS).map((entry) =>
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
    ).filter(Boolean),
  };
}

export async function GET(request: Request) {
  const secrets = [process.env.JUPITER_API_KEY, process.env.HELIUS_API_KEY].filter(
    (value): value is string => typeof value === "string" && value.trim().length >= 4,
  );

  const root = path.join(process.cwd(), ".evolve");
  const requestedParam = new URL(request.url).searchParams.get("source");
  const configured = (process.env.EVOLVE_DASHBOARD_SOURCE ?? "auto").toLowerCase();
  const requested = (requestedParam ?? configured).toLowerCase();

  const info = {
    live: await fileInfo(path.join(root, STATE_FILES.live)),
    replay: await fileInfo(path.join(root, STATE_FILES.replay)),
  };

  const sourcesAvailable: StateSource[] = (Object.keys(STATE_FILES) as StateSource[]).filter(
    (key) => info[key].exists,
  );

  const freshLive =
    info.live.exists && Date.now() - info.live.mtimeMs <= 45_000;

  let chosen: StateSource | null = null;
  if (requested === "live" || requested === "replay") {
    chosen = info[requested as StateSource].exists ? (requested as StateSource) : null;
  } else if (freshLive) {
    chosen = "live";
  } else if (info.replay.exists) {
    chosen = "replay";
  } else if (info.live.exists) {
    chosen = "live";
  }

  if (!chosen) {
    return NextResponse.json(
      {
        error: "Engine state is not available yet.",
        hint: "Run npm run dev:all for the live paper engine, or npm run replay -- <dataset> for a historical replay.",
        paperOnly: true,
        stateSource: null,
        sources: {
          requested,
          available: sourcesAvailable,
        },
      },
      { status: 503, headers: { "cache-control": "no-store, max-age=0" } },
    );
  }

  try {
    const file = path.join(root, STATE_FILES[chosen]);
    const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;

    const experiment = await loadLatestExperiment(path.join(root, "experiments"));
    const champions = await loadChampionArchive(path.join(root, "champions"));

    const merged = isRecord(parsed)
      ? {
          ...parsed,
          stateSource: chosen,
          stateUpdatedAt: new Date(info[chosen].mtimeMs).toISOString(),
          sources: {
            requested,
            available: sourcesAvailable,
            live: { exists: info.live.exists, updatedAt: info.live.exists ? new Date(info.live.mtimeMs).toISOString() : null },
            replay: { exists: info.replay.exists, updatedAt: info.replay.exists ? new Date(info.replay.mtimeMs).toISOString() : null },
          },
          research: {
            ...(isRecord(parsed.research) ? parsed.research : {}),
            experiment,
            champions,
            paperOnly: true,
            disclaimer:
              "Historical backtests and paper results do NOT guarantee future profitability. Every value shown is simulated paper accounting.",
          },
        }
      : { error: "Unreadable engine state.", paperOnly: true, stateSource: chosen };

    const payload = sanitize(merged, { secrets });

    return NextResponse.json(payload, {
      headers: {
        "cache-control": "no-store, max-age=0",
        "x-evolve-mode": "paper-only",
        "x-evolve-state-source": chosen,
      },
    });
  } catch {
    return NextResponse.json(
      {
        error: "Engine state could not be read.",
        paperOnly: true,
        stateSource: chosen,
      },
      { status: 503, headers: { "cache-control": "no-store, max-age=0" } },
    );
  }
}
