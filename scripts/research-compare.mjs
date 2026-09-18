#!/usr/bin/env node
/**
 * Research-provider comparison (Phase 5B / 5A.3, PAPER ONLY).
 *
 *   npm run compare:research -- --mock arena-20260918T081727Z --deepseek <arena-id>
 *
 * Compares two controlled A/B arenas — the canonical deterministic mock control
 * and a DeepSeek experiment — WITHOUT manufacturing a verdict.
 *
 * The unit of comparison is the WITHIN-RUN delta:
 *
 *   delta(run) = Research ARM(run) − its OWN matched Conventional ARM(run)
 *
 * and the interesting quantity is the difference between those deltas. Raw
 * DeepSeek-Research against raw Mock-Research is deliberately NOT the headline:
 * if the two runs' matched control populations differ, that comparison measures
 * the controls, not the research provider.
 *
 * ARM vs ANCESTRY (Phase 5A.3.2 — the whole point of this audit)
 * -----------------------------------------------------------------
 * Two different questions exist and must never be conflated:
 *
 *   * A/B ARM membership — `cohort === "research"` / `cohort === "conventional"`
 *     — "which evolutionary sandbox did this genome evolve in?". This is what
 *     `ab-comparison.json` reports as `cohorts.research` / `cohorts.conventional`
 *     and it is the ONLY valid predicate for an A/B metric.
 *   * RESEARCH ANCESTRY — `isResearch === true/false` — "does this genome trace
 *     back to an actual research proposal?". An arm member can legitimately carry
 *     ZERO ancestry (an in-arm random immigrant, or a lineage that went extinct
 *     under selection), so ancestry counts are NOT arm sizes.
 *
 * Every A/B number below therefore comes from `ab-comparison.json`'s cohort
 * blocks (arm membership). The ancestry-based `summary.json.researchSummary`
 * block is used ONLY for research-generation characteristics (proposal/compile
 * counts, species/family/role mix of the generation process), never as a
 * substitute for an arm metric, and never as the A/B arm predicate.
 *
 * Nothing here claims significance, profitability, or deployment readiness.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseArgs } from "./lib/args.mjs";

export const RESEARCH_COMPARISON_VERSION = 2;
export const DEFAULT_ARENAS_DIR = path.join(".evolve", "arenas");
/** The canonical deterministic mock control arena (never mutated, never reinterpreted). */
export const MOCK_CONTROL_ARENA = "arena-20260918T081727Z";
/** The canonical DeepSeek Phase 5B A/B arena. */
export const DEEPSEEK_COMPARISON_ARENA = "arena-20260918T120841Z";
/** Label used for an arena with no recorded provider: the offline deterministic baseline. */
export const MOCK_PROVIDER = "mock";

/** A/B arm membership vocabulary — the ONLY valid arm predicate. */
export const COHORT_ARM = Object.freeze({ RESEARCH: "research", CONVENTIONAL: "conventional" });

const BOOLEAN_FLAGS = ["json", "help"];
const VALUE_FLAGS = ["mock", "deepseek", "arenas-dir", "label-a", "label-b"];

/**
 * Every A/B metric comes from `ab-comparison.json`'s per-arm cohort blocks
 * (`cohorts.research.<group>.<field>` / `cohorts.conventional.<group>.<field>`).
 *
 * `direction` is METADATA ONLY. The reported number is always the raw
 * mathematical delta `research − conventional`; a "lower is favourable" metric
 * is never silently sign-flipped, and no universal "positive = good" assumption
 * is encoded anywhere.
 */
export const METRIC_PATHS = Object.freeze([
  // ---- Arena outcome -------------------------------------------------------
  { key: "medianArenaScore", group: "arena", path: ["arena", "medianScore"], direction: "higher-better" },
  { key: "medianRank", group: "arena", path: ["arena", "medianRank"], direction: "lower-better" },
  { key: "bestScore", group: "arena", path: ["arena", "bestScore"], direction: "higher-better" },
  // ---- top-N / funnel ------------------------------------------------------
  { key: "top10Count", group: "arena", path: ["arena", "top10Count"], direction: "higher-better" },
  { key: "top25Count", group: "arena", path: ["arena", "top25Count"], direction: "higher-better" },
  { key: "top50Count", group: "arena", path: ["arena", "top50Count"], direction: "higher-better" },
  { key: "groupCount", group: "arena", path: ["arena", "groupCount"], direction: "higher-better" },
  { key: "stressCount", group: "arena", path: ["arena", "stressCount"], direction: "higher-better" },
  { key: "championLeagueCount", group: "arena", path: ["arena", "championLeagueCount"], direction: "higher-better" },
  { key: "deploymentCount", group: "arena", path: ["arena", "deploymentCount"], direction: "higher-better" },
  { key: "gatePassedCount", group: "arena", path: ["arena", "gatePassedCount"], direction: "higher-better" },
  { key: "insufficientEvidenceCount", group: "arena", path: ["arena", "insufficientEvidenceCount"], direction: "neutral" },
  // ---- paper trading -------------------------------------------------------
  { key: "medianNetPaperReturn", group: "trading", path: ["trading", "medianNetPaperReturn"], direction: "higher-better" },
  { key: "medianGrossPaperReturn", group: "trading", path: ["trading", "medianGrossPaperReturn"], direction: "higher-better" },
  { key: "medianCostDrag", group: "trading", path: ["trading", "medianCostDrag"], direction: "lower-better" },
  { key: "medianDrawdown", group: "trading", path: ["trading", "medianDrawdown"], direction: "lower-better" },
  { key: "medianTrades", group: "trading", path: ["trading", "medianTrades"], direction: "higher-better" },
  { key: "medianDistinctMints", group: "trading", path: ["trading", "medianDistinctMints"], direction: "higher-better" },
  { key: "medianTopMintNotionalShare", group: "trading", path: ["trading", "medianTopMintNotionalShare"], direction: "lower-better" },
  { key: "totalOosRuns", group: "trading", path: ["trading", "totalOosRuns"], direction: "neutral" },
  // ---- robustness ----------------------------------------------------------
  { key: "stressSurvivalCount", group: "robustness", path: ["robustness", "stressSurvivalCount"], direction: "higher-better" },
  { key: "medianPositiveRegimes", group: "robustness", path: ["robustness", "medianPositiveRegimes"], direction: "higher-better" },
  { key: "medianOosWindows", group: "robustness", path: ["robustness", "medianOosWindows"], direction: "neutral" },
  { key: "catastrophicCount", group: "robustness", path: ["robustness", "catastrophicCount"], direction: "lower-better" },
]);

/** Human label for a direction. Never applied to the number, only printed beside it. */
export function directionNote(direction) {
  if (direction === "higher-better") return "higher is generally favourable";
  if (direction === "lower-better") return "lower is generally favourable";
  return "direction not ranked";
}

function usage() {
  return [
    "EVOLVE research-provider comparison (PAPER ONLY)",
    "",
    "  npm run compare:research -- --mock <arena-id> --deepseek <arena-id>",
    "",
    "Options:",
    `  --mock <id>         control arena (default ${MOCK_CONTROL_ARENA})`,
    "  --deepseek <id>     provider-experiment arena to compare against the control",
    "  --label-a <text>    display label for the control (default: the arena id)",
    "  --label-b <text>    display label for the comparison run",
    "  --arenas-dir <dir>  arena directory (default .evolve/arenas)",
    "  --json              machine-readable output",
    "",
    "Every A/B metric uses ARM MEMBERSHIP from ab-comparison.json",
    "(cohort === research vs cohort === conventional) — never the ancestry",
    "predicate `isResearch`. Deltas are computed WITHIN each run",
    "(Research arm − its own matched Conventional arm), then the deltas are",
    "compared. No verdict, no significance claim, no profitability claim.",
  ].join("\n");
}

function pick(object, keys) {
  let current = object;
  for (const key of keys) {
    if (current === null || current === undefined) return null;
    current = current[key];
  }
  return Number.isFinite(current) ? current : null;
}

function round6(value) {
  return Number.isFinite(value) ? Math.round(value * 1e6) / 1e6 : null;
}

function count(value) {
  return Number.isFinite(value) ? value : null;
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Read one arena's authoritative A/B artifact (`ab-comparison.json`) plus the
 * research-generation artifacts (`summary.json` researchSummary and, when
 * present, `research-experiment.json`).
 *
 * The A/B numbers come from `ab-comparison.json`'s cohort blocks only. This
 * function never reads an `isResearch` field to decide arm membership.
 */
export async function readArenaRun(arenaId, { arenasDir = DEFAULT_ARENAS_DIR } = {}) {
  const dir = path.join(arenasDir, arenaId);
  const comparison = await readJson(path.join(dir, "ab-comparison.json"));
  if (!comparison) {
    return {
      arenaId,
      dir,
      available: false,
      source: "ab-comparison.json",
      reason: `no ab-comparison.json in ${dir}`,
    };
  }
  const summary = await readJson(path.join(dir, "summary.json"));
  const experiment = await readJson(path.join(dir, "research-experiment.json"));

  // A/B ARM membership — the only valid arm source. `cohorts.research` /
  // `cohorts.conventional` ARE the two arms (cohort membership), not ancestry.
  const research = comparison.cohorts?.research ?? {};
  const conventional = comparison.cohorts?.conventional ?? {};

  const absolute = Object.fromEntries(
    METRIC_PATHS.map((metric) => [
      metric.key,
      { research: pick(research, metric.path), conventional: pick(conventional, metric.path) },
    ]),
  );
  const deltas = Object.fromEntries(
    METRIC_PATHS.map((metric) => {
      const r = pick(research, metric.path);
      const c = pick(conventional, metric.path);
      return [metric.key, r !== null && c !== null ? round6(r - c) : null];
    }),
  );

  return {
    arenaId,
    dir,
    available: true,
    source: "ab-comparison.json",
    researchMode: comparison.researchMode ?? null,
    generatedAt: comparison.generatedAt ?? null,
    question: comparison.question ?? null,
    paperOnly: comparison.paperOnly ?? null,
    datasets: comparison.datasets ?? [],
    provider: {
      provider: experiment?.provider ?? null,
      model: experiment?.model ?? null,
      reasoning: experiment?.reasoning ?? null,
      promptVersion: experiment?.promptVersion ?? null,
      evidenceDigest: experiment?.evidenceDigest ?? null,
      experimentId: experiment?.experimentId ?? null,
      status: experiment?.status ?? null,
      counters: experiment?.counters ?? null,
      source: experiment ? "research-experiment.json" : null,
      recorded: experiment !== null,
    },
    // ---- A/B ARM membership ------------------------------------------------
    cohort: {
      // Arm SIZES: `cohorts.<arm>.arena.entrants` — membership, never ancestry.
      armResearch: count(research.arena?.entrants),
      armConventional: count(conventional.arena?.entrants),
      equalSize: comparison.cohortSize?.equalSize ?? null,
      uniqueResearchSeeds: comparison.cohortConstruction?.uniqueResearchSeeds ?? null,
      uniqueConventionalSeeds: comparison.cohortConstruction?.uniqueConventionalSeeds ?? null,
      startingResearchSeeds: comparison.cohortConstruction?.startingResearchSeeds ?? null,
      startingConventionalSeeds: comparison.cohortConstruction?.startingConventionalSeeds ?? null,
      clonedToFillQuota: comparison.cohortConstruction?.clonedToFillQuota ?? null,
      requestedPopulation: comparison.cohortConstruction?.requested ?? null,
      requestedPerCohort: comparison.cohortConstruction?.requestedPerCohort ?? null,
      requestedMatchMode: comparison.cohortConstruction?.requestedMatchMode ?? null,
      effectiveMatchMode: comparison.cohortConstruction?.effectiveMatchMode ?? null,
      // species-match invariant + per-arm composition (arm membership)
      speciesMatched: comparison.species?.matched ?? null,
      speciesMatchMode: comparison.species?.effectiveMatchMode ?? null,
      speciesCountsResearch: comparison.species?.research ?? null,
      speciesCountsConventional: comparison.species?.conventional ?? null,
      speciesDeltas: comparison.species?.deltas ?? null,
      speciesInvariantSatisfied: comparison.species?.invariant?.satisfied ?? null,
      // Family attribution per ARM (a genome with no research lineage counts as
      // "none"); this is arm membership, not the ancestry-only researchSummary.
      familyDistributionResearchArm: comparison.families?.research ?? null,
      familyDistributionConventionalArm: comparison.families?.conventional ?? null,
      familiesResearch: Object.keys(comparison.families?.research ?? {}).length,
      familiesConventional: Object.keys(comparison.families?.conventional ?? {}).length,
      roleSeeds: comparison.roles?.seedDistribution ?? null,
    },
    // Per-arm absolute values and within-run deltas (research − conventional).
    absolute,
    deltas,
    // The artifact's own precomputed differences (median + mean + bootstrap),
    // kept for provenance; the tool's deltas above are recomputed from the same
    // canonical cohort medians so they are auditable against the artifact.
    artifactDifferences: comparison.comparison ?? null,
    // ---- accounting blocks -------------------------------------------------
    accounting: {
      championLeague: {
        research: count(research.arena?.championLeagueCount),
        conventional: count(conventional.arena?.championLeagueCount),
      },
      topN: {
        research: {
          top10: count(research.arena?.top10Count),
          top25: count(research.arena?.top25Count),
          top50: count(research.arena?.top50Count),
        },
        conventional: {
          top10: count(conventional.arena?.top10Count),
          top25: count(conventional.arena?.top25Count),
          top50: count(conventional.arena?.top50Count),
        },
      },
      funnel: {
        research: {
          group: count(research.arena?.groupCount),
          stress: count(research.arena?.stressCount),
          championLeague: count(research.arena?.championLeagueCount),
          deployment: count(research.arena?.deploymentCount),
          gatePassed: count(research.arena?.gatePassedCount),
          insufficientEvidence: count(research.arena?.insufficientEvidenceCount),
        },
        conventional: {
          group: count(conventional.arena?.groupCount),
          stress: count(conventional.arena?.stressCount),
          championLeague: count(conventional.arena?.championLeagueCount),
          deployment: count(conventional.arena?.deploymentCount),
          gatePassed: count(conventional.arena?.gatePassedCount),
          insufficientEvidence: count(conventional.arena?.insufficientEvidenceCount),
        },
      },
      gates: {
        research: research.failedGates ?? null,
        conventional: conventional.failedGates ?? null,
      },
      oos: {
        // A per-arm OOS survivor count is not published by the A/B artifact;
        // only the run TOTALS and the median OOS window count are. Both are
        // reported verbatim, labelled as run-level, never as an arm survivor count.
        research: {
          totalOosRuns: count(research.trading?.totalOosRuns),
          medianOosWindows: count(research.robustness?.medianOosWindows),
        },
        conventional: {
          totalOosRuns: count(conventional.trading?.totalOosRuns),
          medianOosWindows: count(conventional.robustness?.medianOosWindows),
        },
        perArmSurvivorCountAvailable: false,
      },
    },
    failedGatesResearch: research.failedGates ?? null,
    failedGatesConventional: conventional.failedGates ?? null,
    distinctMintDiagnostics: comparison.distinctMintDiagnostics ?? null,
    statistics: comparison.statistics ?? null,
    limitations: comparison.limitations ?? [],
    // Research-generation characteristics (ancestry/cohort construction), kept
    // SEPARATE from every Arena outcome metric above.
    researchSummary: summary?.researchSummary ?? null,
    seedCounts: summary?.seeds ?? null,
  };
}

/** Compare two runs by their within-run deltas (never raw-vs-raw as headline). */
export function compareRuns(runA, runB) {
  const deltaOfDeltas = {};
  for (const metric of METRIC_PATHS) {
    const a = runA?.deltas?.[metric.key];
    const b = runB?.deltas?.[metric.key];
    // Raw mathematics only: (research − conventional) then (b − a). Lower-is-
    // better metrics are NOT sign-flipped.
    deltaOfDeltas[metric.key] = Number.isFinite(a) && Number.isFinite(b) ? round6(b - a) : null;
  }
  return {
    metricGroups: Object.fromEntries(METRIC_PATHS.map((metric) => [metric.key, metric.group])),
    metricDirections: Object.fromEntries(METRIC_PATHS.map((metric) => [metric.key, metric.direction])),
    deltaOfDeltas,
    sameDataset:
      JSON.stringify((runA?.datasets ?? []).map((row) => row?.fingerprint ?? row?.id)) ===
      JSON.stringify((runB?.datasets ?? []).map((row) => row?.fingerprint ?? row?.id)),
    sameRequestedPopulation:
      runA?.cohort?.requestedPopulation !== null &&
      runA?.cohort?.requestedPopulation === runB?.cohort?.requestedPopulation,
    bothSpeciesMatched: runA?.cohort?.speciesMatched === true && runB?.cohort?.speciesMatched === true,
  };
}

/**
 * Provider provenance for one side of the comparison.
 *
 * The mock side is labelled `mock` because of the comparison tool's own role
 * (`--mock`), NOT because a field in its artifact says so — the canonical
 * control predates per-experiment provider provenance. That fact is stated
 * explicitly rather than inferred silently. Nothing is written back to the
 * artifact.
 */
export function buildProviderMetadata(run, { role } = {}) {
  const recorded = run?.provider ?? {};
  const recordedProvider = recorded.provider ?? null;
  const provider = recordedProvider ?? (role === "mock" ? MOCK_PROVIDER : null);
  const source = recorded.source ?? null;
  return {
    role: role ?? null,
    arenaId: run?.arenaId ?? null,
    provider,
    recordedProvider,
    providerSource: source,
    deterministic: provider === MOCK_PROVIDER,
    model: recorded.model ?? null,
    reasoning: recorded.reasoning ?? null,
    promptVersion: recorded.promptVersion ?? null,
    evidenceDigest: recorded.evidenceDigest ?? null,
    experimentId: recorded.experimentId ?? null,
    status: recorded.status ?? null,
    note: recordedProvider
      ? null
      : role === "mock"
        ? "No provider provenance is recorded in this artifact (the canonical deterministic control predates per-experiment provenance). It is labelled `mock` by the comparison tool's --mock role, not by an artifact field; nothing is inferred into the artifact."
        : "No provider provenance is recorded in this arena (no research-experiment.json), so provider/model/reasoning are reported as unknown rather than assumed.",
  };
}

/**
 * Research-generation characteristics: what the research process PRODUCED
 * (proposal/compile counts, species/family/role mix). These describe the
 * generation process and are explicitly NOT Arena outcome metrics, and are
 * never used as A/B arm sizes.
 *
 * Preference order: the experiment counters (per-experiment, compiled-cohort
 * basis) then `summary.json`'s `researchSummary` (ancestry basis).
 */
export function buildResearchGeneration(run) {
  const counters = run?.provider?.counters ?? null;
  const rs = run?.researchSummary ?? null;
  if (counters) {
    return {
      source: "research-experiment.json.counters",
      basis: "compiled-cohort",
      ancestryBased: false,
      proposalsRequested: count(counters.proposalsRequested),
      proposalsAvailable: count(counters.proposalsReturned),
      compiledArtifacts: count(counters.compilerAccepted),
      uniqueCompiledGenomes: count(counters.uniqueGenomes),
      duplicateCompiledGenomes: count(counters.duplicateGenomes),
      speciesDistribution: counters.speciesDistribution ?? null,
      familyDistribution: counters.familyDistribution ?? null,
      roleDistribution: counters.roleDistribution ?? null,
      watchdog: counters.watchdog ?? null,
    };
  }
  if (rs) {
    return {
      source: "summary.json.researchSummary",
      basis: "research-ancestry",
      ancestryBased: true,
      proposalsRequested: null,
      proposalsAvailable: count(rs.proposalsAvailable),
      compiledArtifacts: count(rs.compiledArtifacts),
      uniqueCompiledGenomes: count(rs.uniqueCompiledGenomes),
      duplicateCompiledGenomes: count(rs.duplicateCompiledGenomes),
      speciesDistribution: rs.speciesDistribution ?? null,
      familyDistribution: rs.familyDistribution ?? null,
      roleDistribution: rs.roleDistribution ?? null,
      watchdog: null,
      note:
        "These are RESEARCH-ANCESTRY characteristics of the generation process, not A/B arm metrics. An arm entrant may carry zero research ancestry; the A/B arm sizes above come from ab-comparison.json's cohort blocks.",
    };
  }
  return {
    source: null,
    basis: null,
    ancestryBased: null,
    proposalsRequested: null,
    proposalsAvailable: null,
    compiledArtifacts: null,
    uniqueCompiledGenomes: null,
    duplicateCompiledGenomes: null,
    speciesDistribution: null,
    familyDistribution: null,
    roleDistribution: null,
    watchdog: null,
  };
}

/** Cross-experiment cohort comparability (species matching within, not between). */
export function buildComparability(runA, runB) {
  const mockSpecies = runA?.cohort?.speciesCountsResearch ?? null;
  const deepseekSpecies = runB?.cohort?.speciesCountsResearch ?? null;
  const sameSpecies = JSON.stringify(mockSpecies) === JSON.stringify(deepseekSpecies);
  return {
    mock: {
      armResearch: runA?.cohort?.armResearch ?? null,
      armConventional: runA?.cohort?.armConventional ?? null,
      speciesMatchedWithinRun: runA?.cohort?.speciesMatched === true,
      speciesCountsResearch: mockSpecies,
      speciesCountsConventional: runA?.cohort?.speciesCountsConventional ?? null,
    },
    deepseek: {
      armResearch: runB?.cohort?.armResearch ?? null,
      armConventional: runB?.cohort?.armConventional ?? null,
      speciesMatchedWithinRun: runB?.cohort?.speciesMatched === true,
      speciesCountsResearch: deepseekSpecies,
      speciesCountsConventional: runB?.cohort?.speciesCountsConventional ?? null,
    },
    speciesMatchedWithinBothRuns:
      runA?.cohort?.speciesMatched === true && runB?.cohort?.speciesMatched === true,
    sameSpeciesCompositionAcrossRuns: sameSpecies,
    speciesCompositionDiffersAcrossRuns: !sameSpecies,
    note:
      "Each experiment is internally species-matched (its Research and Conventional arms hold identical species counts). The species COMPOSITION differs BETWEEN experiments, so raw cross-run Research scores are not controlled for species mix — which is exactly why the primary comparison is the within-run A/B delta, not a raw Research score.",
  };
}

/** Comparison-level limitations. Descriptive only; no verdict, no significance. */
export function buildLimitations(runA, runB) {
  return {
    mock: runA?.limitations ?? [],
    deepseek: runB?.limitations ?? [],
    comparison: [
      "PAPER ONLY: every number is simulated paper accounting over recorded/observed historical windows. Nothing here is a profitability or deployment claim.",
      "No significance test is performed and no p-value is claimed. Any bootstrap interval is descriptive only.",
      "The comparison unit is the WITHIN-RUN A/B delta (Research arm − its own matched Conventional arm), then the difference between those deltas. Raw cross-run Research scores are not the headline and are not controlled for species mix.",
      "Each experiment is internally species-matched, but the species composition differs BETWEEN experiments, so cross-run raw values are not directly comparable.",
      "Sample sizes are small (the canonical mock run has 13 per arm; the canonical DeepSeek run has 12 per arm). Each seed is one deterministic replay, not an independent market draw.",
      "A null or worse result is a valid outcome, and a difference here can reflect cohort composition rather than the research provider.",
    ],
  };
}

/** Assemble the full comparison report (used by the CLI and by tests). */
export function buildReport({ mock, deepseek, mockId, deepseekId }) {
  const comparison = deepseek ? compareRuns(mock, deepseek) : null;
  return {
    schemaVersion: RESEARCH_COMPARISON_VERSION,
    comparison: "research-provider",
    paperOnly: true,
    units: "deltas are computed WITHIN each run (Research arm − its own matched Conventional arm), then compared",
    armPredicate: "cohort === research vs cohort === conventional (ab-comparison.json cohort membership); `isResearch` ancestry is NOT used",
    controlArenaId: mockId ?? mock?.arenaId ?? null,
    comparisonArenaId: deepseekId ?? deepseek?.arenaId ?? null,
    mock: mock ?? null,
    deepseek: deepseek ?? null,
    withinRunDeltas: {
      mock: mock?.deltas ?? null,
      deepseek: deepseek?.deltas ?? null,
    },
    deltaOfDeltas: comparison ? comparison.deltaOfDeltas : null,
    deltaOfDeltasProperties: comparison
      ? {
          metricGroups: comparison.metricGroups,
          metricDirections: comparison.metricDirections,
          sameDataset: comparison.sameDataset,
          sameRequestedPopulation: comparison.sameRequestedPopulation,
          bothSpeciesMatched: comparison.bothSpeciesMatched,
        }
      : null,
    cohortMetadata: {
      mock: mock?.cohort ?? null,
      deepseek: deepseek?.cohort ?? null,
      comparability: buildComparability(mock, deepseek),
    },
    providerMetadata: {
      mock: mock ? buildProviderMetadata(mock, { role: "mock" }) : null,
      deepseek: deepseek ? buildProviderMetadata(deepseek, { role: "comparison" }) : null,
    },
    researchGeneration: {
      mock: mock ? buildResearchGeneration(mock) : null,
      deepseek: deepseek ? buildResearchGeneration(deepseek) : null,
    },
    limitations: buildLimitations(mock, deepseek),
    verdict: null,
    significance: null,
    verdictNote:
      "No verdict is produced and no significance is claimed. A null or worse result is a valid outcome; provider differences can also come from cohort composition, not the provider. Read deltaOfDeltas as an observation with the sample size and limitations shown, not as a result.",
  };
}

function formatMetrics(deltas, indent = "    ") {
  const lines = [];
  for (const metric of METRIC_PATHS) {
    const value = deltas?.[metric.key];
    const shown = value === null || value === undefined ? "n/a" : value;
    lines.push(`${indent}${metric.key.padEnd(26)} ${String(shown).padEnd(12)} (${directionNote(metric.direction)})`);
  }
  return lines;
}

function formatRun(run, label, { providerLabel = null } = {}) {
  if (!run?.available) {
    return [`${label}: UNAVAILABLE (${run?.reason ?? "unknown"})`];
  }
  const provider = run.provider ?? {};
  const cohort = run.cohort ?? {};
  const providerShown = providerLabel ?? provider.provider ?? "unknown";
  const lines = [
    `${label} — ${run.arenaId}`,
    `  provider              ${providerShown}${provider.model ? ` / ${provider.model}` : ""}${provider.reasoning ? ` (${provider.reasoning})` : ""}`,
    `  research experiment   ${provider.experimentId ?? "n/a"}   status ${provider.status ?? "n/a"}`,
    `  prompt version        ${provider.promptVersion ?? "n/a"}`,
    `  match mode            ${cohort.effectiveMatchMode ?? "n/a"} (requested ${cohort.requestedMatchMode ?? "n/a"})   species matched within run ${cohort.speciesMatched === true}`,
    `  A/B arms (membership) research ${cohort.armResearch ?? "?"} vs conventional ${cohort.armConventional ?? "?"}   equalSize ${cohort.equalSize === true}`,
    `  unique seeds          research ${cohort.uniqueResearchSeeds ?? "?"} / conventional ${cohort.uniqueConventionalSeeds ?? "?"}   clonedToFillQuota ${cohort.clonedToFillQuota ?? "n/a"}`,
    `  species (research arm) ${JSON.stringify(cohort.speciesCountsResearch ?? {})}   conventional arm ${JSON.stringify(cohort.speciesCountsConventional ?? {})}`,
    `  failed gates          research ${JSON.stringify(run.failedGatesResearch ?? {})}   conventional ${JSON.stringify(run.failedGatesConventional ?? {})}`,
    "  within-run deltas (Research arm − its own matched Conventional arm; raw, never sign-flipped):",
  ];
  for (const line of formatMetrics(run.deltas)) lines.push(line);
  return lines;
}

/** Human-readable comparison: metadata → mock A/B → DeepSeek A/B → deltas → generation → limitations. */
export function formatReport(report, { labelA, labelB } = {}) {
  const lines = [
    "EVOLVE research-provider comparison (PAPER ONLY)",
    "=".repeat(72),
    "1. EXPERIMENT METADATA",
    `  mock arena            ${report.controlArenaId ?? "n/a"}`,
    `  deepseek arena        ${report.comparisonArenaId ?? "n/a"}`,
    `  mock provider         ${report.providerMetadata?.mock?.provider ?? "unknown"}${report.providerMetadata?.mock?.deterministic ? " (deterministic baseline)" : ""}`,
    `  deepseek provider     ${report.providerMetadata?.deepseek?.provider ?? "unknown"} / ${report.providerMetadata?.deepseek?.model ?? "n/a"}${report.providerMetadata?.deepseek?.reasoning ? ` (${report.providerMetadata.deepseek.reasoning})` : ""}`,
    `  deepseek prompt       ${report.providerMetadata?.deepseek?.promptVersion ?? "n/a"}`,
    `  deepseek experiment   ${report.providerMetadata?.deepseek?.experimentId ?? "n/a"}`,
    `  arm predicate         ${report.armPredicate}`,
    "",
    "2. MOCK WITHIN-RUN A/B",
  ];
  for (const line of formatRun(report.mock, labelA ?? `control (${report.controlArenaId})`, {
    providerLabel: report.providerMetadata?.mock?.provider ?? null,
  })) {
    lines.push(line);
  }

  lines.push("", "3. DEEPSEEK WITHIN-RUN A/B");
  if (!report.deepseek) {
    lines.push("  No comparison arena supplied. Re-run with --deepseek <arena-id>.");
  } else {
    for (const line of formatRun(report.deepseek, labelB ?? `provider run (${report.comparisonArenaId})`, {
      providerLabel: report.providerMetadata?.deepseek?.provider ?? null,
    })) {
      lines.push(line);
    }
  }

  lines.push("", "4. DELTA-OF-DELTAS (DeepSeek within-run delta − Mock within-run delta)");
  if (!report.deltaOfDeltas) {
    lines.push("  n/a — no comparison arena supplied.");
  } else {
    for (const metric of METRIC_PATHS) {
      const value = report.deltaOfDeltas[metric.key];
      lines.push(
        `  ${metric.key.padEnd(26)} ${String(value === null ? "n/a" : value).padEnd(12)} (${directionNote(metric.direction)})`,
      );
    }
    lines.push(
      `  properties: sameDataset ${report.deltaOfDeltasProperties.sameDataset} · sameRequestedPopulation ${report.deltaOfDeltasProperties.sameRequestedPopulation} · bothSpeciesMatched ${report.deltaOfDeltasProperties.bothSpeciesMatched}`,
    );
  }

  lines.push("", "5. RESEARCH-GENERATION CHARACTERISTICS (generation process, NOT Arena outcomes)");
  for (const side of ["mock", "deepseek"]) {
    const generation = report.researchGeneration?.[side];
    if (!generation) continue;
    lines.push(
      `  ${side.padEnd(8)} source ${generation.source ?? "n/a"}   basis ${generation.basis ?? "n/a"}`,
      `           proposals ${generation.proposalsAvailable ?? "?"} · compiled ${generation.compiledArtifacts ?? "?"} · unique ${generation.uniqueCompiledGenomes ?? "?"} · duplicates ${generation.duplicateCompiledGenomes ?? "?"}`,
      `           species ${JSON.stringify(generation.speciesDistribution ?? {})}   families ${JSON.stringify(generation.familyDistribution ?? {})}`,
      `           roles ${JSON.stringify(generation.roleDistribution ?? {})}`,
    );
  }

  lines.push("", "6. COHORT COMPARABILITY");
  const comparability = report.cohortMetadata?.comparability;
  if (comparability) {
    lines.push(
      `  mock      arms ${comparability.mock.armResearch}/${comparability.mock.armConventional}   species ${JSON.stringify(comparability.mock.speciesCountsResearch)}   matched-within ${comparability.mock.speciesMatchedWithinRun}`,
      `  deepseek  arms ${comparability.deepseek.armResearch}/${comparability.deepseek.armConventional}   species ${JSON.stringify(comparability.deepseek.speciesCountsResearch)}   matched-within ${comparability.deepseek.speciesMatchedWithinRun}`,
      `  species matched within BOTH runs ${comparability.speciesMatchedWithinBothRuns}; composition differs ACROSS runs ${comparability.speciesCompositionDiffersAcrossRuns}`,
    );
  }

  lines.push("", "7. LIMITATIONS");
  for (const limitation of report.limitations?.comparison ?? []) lines.push(`  - ${limitation}`);

  lines.push("", report.verdictNote);
  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2), { booleanFlags: BOOLEAN_FLAGS, valueFlags: VALUE_FLAGS });
  if (args.help === true) {
    console.log(usage());
    return;
  }
  const arenasDir = String(args["arenas-dir"] ?? DEFAULT_ARENAS_DIR);
  const mockId = String(args.mock ?? MOCK_CONTROL_ARENA);
  const deepseekId = args.deepseek ? String(args.deepseek) : null;
  const labelA = String(args["label-a"] ?? `control (${mockId})`);
  const labelB = String(args["label-b"] ?? (deepseekId ? `provider run (${deepseekId})` : "provider run"));

  const runA = await readArenaRun(mockId, { arenasDir });
  const runB = deepseekId ? await readArenaRun(deepseekId, { arenasDir }) : null;

  const report = buildReport({ mock: runA, deepseek: runB, mockId, deepseekId });

  if (args.json === true) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatReport(report, { labelA, labelB }));
  }

  if (!runA.available) process.exitCode = 2;
}

// Only run the CLI when this file is executed directly: the Phase 5B validator
// imports `readArenaRun` / `compareRuns` from this module, and importing it must
// never print a report or exit.
const invokedDirectly =
  typeof process.argv[1] === "string" && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((error) => {
    console.error("[compare:research] comparison failed:", error?.message ?? error);
    process.exitCode = 1;
  });
}
