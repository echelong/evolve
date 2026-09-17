/**
 * Champion genome archive.
 *
 * A champion is a genome that survived training, was ranked by *validation*
 * performance on unseen data, and was then frozen for a test window it never
 * influenced. The record stores the evidence behind that claim, including the
 * ways it could still be wrong.
 *
 * Rules encoded here:
 *   - a genome is never labelled a champion because it won one generation
 *   - insufficient evidence is recorded as INSUFFICIENT SAMPLE, not as a result
 *   - a test window that used the candidate for anything other than evaluation
 *     is a protocol violation, and the archive says so
 *   - the dataset fingerprint and seed are always stored, so a number can be
 *     traced back to the exact bytes and randomness that produced it
 *
 * Everything is PAPER: no champion record implies real trading capability.
 */

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { digestOf } from "../lib/hash.mjs";
import { RESULT_CLASS, evaluateEvidence } from "./metrics.mjs";

export const CHAMPION_SCHEMA_VERSION = 1;
export const DEFAULT_CHAMPIONS_DIR = path.join(".evolve", "champions");

/** Classify a candidate's out-of-sample journey. */
export function classifyChampion({ evidence, validation, test, minValidationRobustness = 0 }) {
  if (!evidence || evidence.sufficient !== true) {
    return {
      classification: RESULT_CLASS.INSUFFICIENT_SAMPLE,
      reason: `INSUFFICIENT SAMPLE: ${(evidence?.missing ?? [])
        .map((entry) => `${entry.label} ${entry.actual}/${entry.required}`)
        .join(", ") || "evidence not evaluated"}`,
      passedValidation: false,
      testCompleted: false,
    };
  }

  if (validation?.evidence?.sufficient !== true) {
    return {
      classification: RESULT_CLASS.INSUFFICIENT_SAMPLE,
      reason: "INSUFFICIENT SAMPLE: validation window did not produce enough evidence",
      passedValidation: false,
      testCompleted: false,
    };
  }

  const validationRobustness = validation.robustness;
  if (!Number.isFinite(validationRobustness) || validationRobustness < minValidationRobustness) {
    return {
      classification: RESULT_CLASS.FAILED_VALIDATION,
      reason: `validation robustness ${formatScore(validationRobustness)} below required ${minValidationRobustness}`,
      passedValidation: false,
      testCompleted: false,
    };
  }

  if (!test) {
    return {
      classification: RESULT_CLASS.PASSED_VALIDATION,
      reason: "passed validation; test window not run (or not yet run)",
      passedValidation: true,
      testCompleted: false,
    };
  }

  if (test.evidence?.sufficient !== true) {
    return {
      classification: RESULT_CLASS.INSUFFICIENT_SAMPLE,
      reason: "INSUFFICIENT SAMPLE: test window did not produce enough evidence",
      passedValidation: true,
      testCompleted: false,
    };
  }

  return {
    classification: RESULT_CLASS.TEST_COMPLETED,
    reason: "frozen genome evaluated on an unseen test window",
    passedValidation: true,
    testCompleted: true,
  };
}

function formatScore(value) {
  return Number.isFinite(value) ? value.toFixed(2) : "n/a";
}

/** Build the persisted champion record. */
export function buildChampionRecord({
  candidate,
  window: wfWindow,
  dataset,
  seeds,
  trainAggregate,
  validation,
  test,
  config,
  lineageChain = [],
  extra = {},
}) {
  const genomeDigest = digestOf(candidate.genome);
  const classification = classifyChampion({
    evidence: candidate.metrics?.evidence,
    validation,
    test,
    minValidationRobustness: config?.walkForward?.minValidationRobustness ?? 0,
  });

  const overfit =
    classification.testCompleted &&
    Number.isFinite(validation?.robustness) &&
    Number.isFinite(test?.robustness) &&
    test.robustness < validation.robustness - (config?.walkForward?.overfitMargin ?? 0.25);

  return {
    schemaVersion: CHAMPION_SCHEMA_VERSION,
    id: `champion-${wfWindow?.label ?? "W?"}-${genomeDigest.slice(0, 10)}`,
    genomeDigest,
    genome: candidate.genome,
    species: candidate.species,
    lineageId: candidate.lineageId ?? null,
    parentIds: candidate.parents ?? [],
    originatingGeneration: candidate.generation ?? null,
    sourceAgentId: candidate.agentId ?? null,

    datasetId: dataset?.datasetId ?? null,
    datasetFingerprint: dataset?.fingerprint ?? null,
    datasetClass: dataset?.classification ?? null,
    seeds,

    window: wfWindow
      ? {
          label: wfWindow.label,
          train: { start: wfWindow.train.start, end: wfWindow.train.end },
          validate: { start: wfWindow.validate.start, end: wfWindow.validate.end },
          test: { start: wfWindow.test.start, end: wfWindow.test.end },
        }
      : null,

    trainMetrics: trimMetrics(candidate.metrics),
    trainAggregate: trainAggregate ?? null,
    validationMetrics: trimMetrics(validation),
    testMetrics: trimMetrics(test),

    // Convenience rollups (all paper, all simulated).
    tradeCount: validation?.trades ?? candidate.metrics?.trades ?? 0,
    distinctMints: validation?.distinctMints ?? candidate.metrics?.distinctMints ?? 0,
    grossReturn: test?.grossReturn ?? validation?.grossReturn ?? candidate.metrics?.grossReturn ?? null,
    netReturn: test?.netReturn ?? validation?.netReturn ?? candidate.metrics?.netReturn ?? null,
    maxDrawdown: test?.maxDrawdown ?? validation?.maxDrawdown ?? candidate.metrics?.maxDrawdown ?? null,
    winRate: test?.winRate ?? validation?.winRate ?? candidate.metrics?.winRate ?? null,
    profitFactor: test?.profitFactor ?? validation?.profitFactor ?? candidate.metrics?.profitFactor ?? null,
    costs: (validation?.costs ?? 0) + (test?.costs ?? 0),
    robustness: validation?.robustness ?? null,
    robustnessDetail: validation?.robustnessDetail ?? null,

    classification: classification.classification,
    reason: classification.reason,
    passedValidation: classification.passedValidation,
    testCompleted: classification.testCompleted,
    overfitWarning: overfit,

    lineageChain,
    createdAt: new Date().toISOString(),
    paperOnly: true,
    note:
      "Simulated paper results only. Historical backtests and paper results do NOT guarantee future profitability.",
    ...extra,
  };
}

function trimMetrics(metrics) {
  if (!metrics) return null;
  return {
    netReturn: metrics.netReturn,
    grossReturn: metrics.grossReturn,
    netPnl: metrics.netPnl,
    costs: metrics.costs,
    costDrag: metrics.costDrag,
    trades: metrics.trades,
    distinctMints: metrics.distinctMints,
    winRate: metrics.winRate,
    profitFactor: metrics.profitFactor,
    maxDrawdown: metrics.maxDrawdown,
    consistency: metrics.consistency,
    topMintShare: metrics.topMintShare,
    topTradeShare: metrics.topTradeShare,
    downsideDeviation: metrics.downsideDeviation,
    exposureTicks: metrics.exposureTicks,
    observations: metrics.observations,
    robustness: metrics.robustness,
    classification: metrics.classification,
    evidence: metrics.evidence
      ? {
          sufficient: metrics.evidence.sufficient,
          label: metrics.evidence.label,
          missing: metrics.evidence.missing,
        }
      : null,
  };
}

/** Persist a champion to the archive. Never overwrites: ids are content-based. */
export async function saveChampion(record, { dir = DEFAULT_CHAMPIONS_DIR } = {}) {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${record.id}.json`);
  await writeFile(file, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  await updateIndex(dir, record);
  return file;
}

async function updateIndex(dir, record) {
  const indexPath = path.join(dir, "index.json");
  let index = { schemaVersion: CHAMPION_SCHEMA_VERSION, champions: [] };

  try {
    index = JSON.parse(await readFile(indexPath, "utf8"));
    if (!Array.isArray(index.champions)) index.champions = [];
  } catch {
    // first champion in this archive
  }

  index.champions = index.champions.filter((entry) => entry.id !== record.id);
  index.champions.push({
    id: record.id,
    genomeDigest: record.genomeDigest,
    species: record.species,
    lineageId: record.lineageId,
    datasetId: record.datasetId,
    datasetFingerprint: record.datasetFingerprint,
    window: record.window?.label ?? null,
    seeds: record.seeds,
    classification: record.classification,
    validationRobustness: record.validationMetrics?.robustness ?? null,
    testNetReturn: record.testMetrics?.netReturn ?? null,
    overfitWarning: record.overfitWarning === true,
    createdAt: record.createdAt,
  });
  index.champions.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  index.updatedAt = new Date().toISOString();

  await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  return index;
}

export async function loadChampionIndex({ dir = DEFAULT_CHAMPIONS_DIR } = {}) {
  try {
    return JSON.parse(await readFile(path.join(dir, "index.json"), "utf8"));
  } catch {
    return { schemaVersion: CHAMPION_SCHEMA_VERSION, champions: [], updatedAt: null };
  }
}

export async function listChampionFiles({ dir = DEFAULT_CHAMPIONS_DIR } = {}) {
  try {
    const entries = await readdir(dir);
    return entries.filter((name) => name.startsWith("champion-") && name.endsWith(".json"));
  } catch {
    return [];
  }
}

/** Species-level survival summary across a champion set. */
export function championSpeciesDistribution(champions) {
  const counts = new Map();
  for (const champion of champions) {
    const key = champion.species ?? "unknown";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([species, count]) => ({ species, count }))
    .sort((a, b) => b.count - a.count || a.species.localeCompare(b.species));
}

export { evaluateEvidence, RESULT_CLASS };
