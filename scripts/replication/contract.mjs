/**
 * Phase 5C.3 — canonical per-wave freezes: the EVALUATION CONTRACT digest
 * (PAPER ONLY).
 *
 * Two questions must never be conflated when replication waves are combined:
 *
 *   1. FULL FREEZE CANONICALITY — "was THIS wave run under EXACTLY the freeze
 *      artifact that was frozen BEFORE it ran?" That is answered by the full
 *      `freezeDigest` (`./freeze.mjs`), which deliberately includes the git
 *      commit, `createdAt`, the freeze label and every other provenance field.
 *      A wave that ran under its own freeze is canonical against THAT freeze.
 *
 *   2. CROSS-WAVE COMPARABILITY — "do two canonically frozen waves describe the
 *      SAME experiment?" Two waves executed from two DIFFERENT commits (and
 *      therefore two different full freeze digests) are still comparable when
 *      the *evaluator semantics* they ran under are identical. That is what the
 *      `evaluationContractDigest` answers.
 *
 * Wave 1 (`rep-66884de4e460`) was frozen against historical freeze A
 * (commit `e7940e0…`). Wave 2 will be frozen against its own freeze B (the
 * commit that executes Wave 2). `freezeDigest(A) !== freezeDigest(B)` is
 * EXPECTED and does not by itself break comparability. What must hold is:
 *
 *   evaluationContractDigest(A) === evaluationContractDigest(B)
 *   mock cohort digest(A)       === mock cohort digest(B)
 *   deepseek cohort digest(A)   === deepseek cohort digest(B)
 *
 * This module computes the contract digest and compares two contract-carrying
 * artifacts. It is pure: no filesystem, no clock, no randomness, no network,
 * no provider, no signing path. Increasing the DIGEST's stability (never a
 * weakening of the full freeze) is the whole point.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS INSIDE THE CONTRACT (and therefore what can make two waves
 * INCOMPARABLE)
 * ---------------------------------------------------------------------------
 * INCLUDED — every field that can change an evaluation RESULT:
 *
 *   paperOnly                       PAPER-only setting
 *   arena.scoreVersion              Arena scoring version
 *   arena.runnerVersion             tournament/runner version
 *   arena.cacheVersion              evaluator cache version
 *   arena.evaluatorVersion          evaluator version
 *   arena.population                population size
 *   arena.researchShare             research/conventional split
 *   arena.generations               generations
 *   arena.workers                   worker count (determinism/equivalence class)
 *   arena.seeds                     evaluation seeds
 *   arena.stressProfiles            stress profiles
 *   arena.survivorFraction          survivor fraction
 *   arena.breederShare              breeder share
 *   arena.mutationScale             mutation configuration
 *   arena.crossoverRate             crossover configuration
 *   arena.immigrantRate             immigration configuration
 *   arena.randomImmigrantShare      random immigration configuration
 *   arena.championShare             champion immigration configuration
 *   arena.immigrantShare            immigrant share
 *   arena.speciesMatchMode          STRICT species matching
 *   arena.noCloning                 no-cloning semantics
 *   arena.crossCohortCrossover      cross-cohort crossover behaviour
 *   arena.equalStartingSlots        equal-resource A/B semantics
 *   arena.equalEvolutionaryRules    equal-resource A/B semantics
 *   arena.equalScoring              equal-resource A/B semantics
 *   arena.equalGates                equal-resource A/B semantics
 *   arena.scoringBonusForEitherCohort  no scoring bonus may be smuggled in
 *   arena.bootstrapIterations       bootstrap configuration
 *   arena.bootstrapSeed             bootstrap configuration
 *   arena.maxWindows                window cap
 *   arena.cohorts                   cohort roles (research/conventional)
 *   gates                           frozen gate definitions (incl. drawdown /
 *                                   concentration / catastrophic bounds)
 *   evidenceThresholds              evidence gates
 *   concentrationBounds             concentration bounds (minArenaScore,
 *                                   maxTopMintShare, maxDrawdown, ...)
 *   research.*                      research-provider format/version semantics
 *                                   used to EVALUATE the frozen cohorts
 *   providers.mock.*                frozen-provider evaluation semantics
 *                                   (deterministic, offline, no subprocess)
 *   providers.deepseek.*            the frozen external hypothesis source's
 *                                   identity/semantics (model, reasoning,
 *                                   profile, prompt/compiler versions)
 *   replication.mode                frozen-cohorts evaluation mode
 *   replication.llmCallsRequired    zero-LLM-at-evaluation-time semantics
 *   replication.cohortKeys          which frozen arms are evaluated
 *   replication.unit                dataset-as-unit aggregation
 *   replication.datasetLevelBootstrap  dataset-level bootstrap
 *   replication.descriptiveOnly     descriptive-only semantics
 *   replication.significance         always null — no significance claim
 *   replication.verdict              always null — no verdict
 *   replication.noTuningFromOutcomes   no tuning from outcomes
 *   replication.speciesMatchPerProviderDataset   per-provider-dataset matching
 *   semantics.*                     LIVE evaluator semantics that the freeze
 *                                   artifact does not carry as data: live
 *                                   version constants, the frozen run config,
 *                                   gate/threshold tables, paper bankroll +
 *                                   cost model, drawdown definition,
 *                                   concentration definition, regime handling,
 *                                   bootstrap configuration, A/B comparison
 *                                   semantics and frozen-provider semantics.
 *                                   Any code change to these alters the digest
 *                                   for EVERY wave, so a semantics change is
 *                                   detected instead of silently aggregated.
 *
 * EXCLUDED — orchestration/provenance only (documented, deliberate):
 *
 *   schemaVersion               artifact FORMAT version (not evaluator semantics)
 *   phase                       orchestration label ("5C")
 *   freezeVersion / label       artifact label (`phase5c`, `phase5c-freeze`)
 *   commit                      git commit that executed the wave (provenance;
 *                               it is inside the FULL freeze digest)
 *   dirtyWorkingTree            working-tree provenance
 *   createdAt                   wall clock
 *   freezeDigest                derived from the full freeze (self-reference)
 *   replication.cohortSources   artifact paths / experiment ids / canonical
 *                               arena ids — WHERE the cohorts came from. The
 *                               cohort IDENTITY is checked separately via the
 *                               frozen cohort digests, which DO gate
 *                               comparability.
 *   replication.cohorts         optional post-hoc back-reference filled in after
 *                               the cohorts are frozen (can be null on one wave
 *                               and populated on another; not semantics)
 *   any unknown/future field    never silently folded in: the subject is an
 *                               explicit projection, so a new field cannot
 *                               change the contract digest until it is added
 *                               here deliberately.
 */

import { digestOf } from "../lib/hash.mjs";
import { createMarketConfig } from "../market/config.mjs";
import {
  ARENA_CACHE_VERSION,
  ARENA_SCORE_VERSION,
  DEFAULT_DEPLOYMENT_GATES,
} from "../arena/orchestrator.mjs";
import { ARENA_RUNNER_VERSION } from "../arena/tournament.mjs";
import { EVALUATOR_VERSION } from "../arena/evaluator.mjs";
import { RESEARCH_PROMPT_VERSION } from "../research/prompt.mjs";
import { PROPOSAL_SCHEMA_VERSION } from "../research/proposal-schema.mjs";
import { EVIDENCE_PACKET_VERSION } from "../research/evidence-packet.mjs";
import { PROPOSAL_COMPILER_VERSION } from "../research/compiler.mjs";
import { WATCHDOG_VERSION } from "../research/watchdog.mjs";
import {
  DEEPSEEK_CLINE_MODEL,
  DEEPSEEK_CLINE_PROFILE,
  DEEPSEEK_CLINE_REASONING,
  DEFAULT_RESEARCH_PROVIDER,
  RESEARCH_PROVIDER,
  RESEARCH_PROVIDER_FORMAT_VERSION,
} from "../research/provider-config.mjs";
import { RESEARCH_PROVIDER_VERSION } from "../research/provider.mjs";
import { PROVIDER_RUNTIME_VERSION } from "../research/provider-runtime.mjs";
import { RESEARCH_EXPERIMENT_VERSION } from "../research/experiment.mjs";
import { AB_COHORT } from "../research/ab-cohort.mjs";
import { RESEARCH_COHORT_DEFAULTS } from "../research/cohort.mjs";
import {
  FROZEN_COHORT_KEYS,
  FROZEN_CONCENTRATION_BOUNDS,
  FROZEN_EVIDENCE_THRESHOLDS,
  FROZEN_RUN_CONFIG,
} from "./constants.mjs";

export const EVALUATION_CONTRACT_SCHEMA_VERSION = 1;
export const EVALUATION_CONTRACT_ID = "evaluation-contract-v1";

/**
 * The Arena fields carried INSIDE the freeze artifact that participate in the
 * contract. Kept in one place so the include list is auditable.
 */
export const CONTRACT_ARENA_FIELDS = Object.freeze([
  "scoreVersion",
  "runnerVersion",
  "cacheVersion",
  "evaluatorVersion",
  "population",
  "researchShare",
  "generations",
  "workers",
  "seeds",
  "stressProfiles",
  "survivorFraction",
  "breederShare",
  "mutationScale",
  "crossoverRate",
  "immigrantRate",
  "randomImmigrantShare",
  "championShare",
  "immigrantShare",
  "speciesMatchMode",
  "noCloning",
  "crossCohortCrossover",
  "equalStartingSlots",
  "equalEvolutionaryRules",
  "equalScoring",
  "equalGates",
  "scoringBonusForEitherCohort",
  "bootstrapIterations",
  "bootstrapSeed",
  "maxWindows",
  "cohorts",
]);

/** The `research` fields carried inside the freeze artifact. */
export const CONTRACT_RESEARCH_FIELDS = Object.freeze([
  "providerVersion",
  "runtimeVersion",
  "experimentVersion",
  "promptVersion",
  "proposalSchemaVersion",
  "evidencePacketVersion",
  "compilerVersion",
  "watchdogVersion",
  "providerFormatVersion",
  "minUniqueRatio",
  "maxSpeciesShare",
]);

/** The `replication` fields carried inside the freeze artifact. */
export const CONTRACT_REPLICATION_FIELDS = Object.freeze([
  "mode",
  "llmCallsRequired",
  "cohortKeys",
  "unit",
  "datasetLevelBootstrap",
  "descriptiveOnly",
  "significance",
  "verdict",
  "noTuningFromOutcomes",
  "speciesMatchPerProviderDataset",
]);

/** Per-provider fields carried inside the freeze artifact. */
export const CONTRACT_PROVIDER_FIELDS = Object.freeze([
  "provider",
  "deterministic",
  "external",
  "subprocess",
  "network",
  "model",
  "reasoning",
  "profile",
  "promptVersion",
  "proposalSchemaVersion",
  "evidencePacketVersion",
  "compilerVersion",
  "watchdogVersion",
  "providerFormatVersion",
]);

/**
 * The provenance/orchestration fields that are deliberately NOT part of the
 * contract. Documentation in machine-readable form: a regression test asserts
 * every one of these is absent from the contract subject.
 */
export const CONTRACT_EXCLUDED_FIELDS = Object.freeze([
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
]);

/** Pick a fixed field list from an object, defaulting absent fields to null. */
function pick(source, fields) {
  const out = {};
  for (const field of fields) {
    const value = source?.[field];
    out[field] = value === undefined ? null : value;
  }
  return out;
}

/**
 * LIVE evaluator semantics — computed from the code constants the evaluator
 * actually reads, NOT from the freeze artifact. This is what makes an Arena
 * scoring / gate / population / bankroll change visible to the contract even
 * when a wave was frozen earlier.
 *
 * `env` is accepted for tests/tools; production always calls it with `{}` so
 * the derived paper-accounting defaults are the documented defaults and never
 * depend on the operator's shell.
 */
export function buildEvaluationSemantics({ env = {} } = {}) {
  const paper = createMarketConfig(env, { loadEnv: false })?.paper ?? {};
  return {
    contractId: EVALUATION_CONTRACT_ID,
    semanticVersion: EVALUATION_CONTRACT_SCHEMA_VERSION,
    arena: {
      scoreVersion: ARENA_SCORE_VERSION,
      runnerVersion: ARENA_RUNNER_VERSION,
      cacheVersion: ARENA_CACHE_VERSION,
      evaluatorVersion: EVALUATOR_VERSION,
      cohortRoles: { research: AB_COHORT.RESEARCH, conventional: AB_COHORT.CONVENTIONAL },
    },
    runConfig: {
      population: FROZEN_RUN_CONFIG.population,
      researchShare: FROZEN_RUN_CONFIG.researchShare,
      generations: FROZEN_RUN_CONFIG.generations,
      workers: FROZEN_RUN_CONFIG.workers,
      seeds: [...FROZEN_RUN_CONFIG.seeds],
      stressProfiles: [...FROZEN_RUN_CONFIG.stressProfiles],
      survivorFraction: FROZEN_RUN_CONFIG.survivorFraction,
      breederShare: FROZEN_RUN_CONFIG.breederShare,
      mutationScale: FROZEN_RUN_CONFIG.mutationScale,
      crossoverRate: FROZEN_RUN_CONFIG.crossoverRate,
      immigrantRate: FROZEN_RUN_CONFIG.immigrantRate,
      randomImmigrantShare: FROZEN_RUN_CONFIG.randomImmigrantShare,
      championShare: FROZEN_RUN_CONFIG.championShare,
      immigrantShare: FROZEN_RUN_CONFIG.immigrantShare,
      speciesMatchMode: FROZEN_RUN_CONFIG.speciesMatchMode,
      noCloning: FROZEN_RUN_CONFIG.noCloning,
      crossCohortCrossover: FROZEN_RUN_CONFIG.crossCohortCrossover,
      equalStartingSlots: FROZEN_RUN_CONFIG.equalStartingSlots,
      equalEvolutionaryRules: FROZEN_RUN_CONFIG.equalEvolutionaryRules,
      equalScoring: FROZEN_RUN_CONFIG.equalScoring,
      equalGates: FROZEN_RUN_CONFIG.equalGates,
      scoringBonusForEitherCohort: FROZEN_RUN_CONFIG.scoringBonusForEitherCohort,
    },
    gates: { ...DEFAULT_DEPLOYMENT_GATES },
    evidenceThresholds: { ...FROZEN_EVIDENCE_THRESHOLDS },
    concentrationBounds: { ...FROZEN_CONCENTRATION_BOUNDS },
    bootstrap: {
      iterations: FROZEN_RUN_CONFIG.bootstrapIterations,
      seed: FROZEN_RUN_CONFIG.bootstrapSeed,
      unit: "dataset",
    },
    definition: {
      // Explicit, documented definitions of the aggregated quantities, so a
      // change to any of them is a contract change rather than an invisible
      // re-interpretation of the same numbers.
      drawdown: "per-agent max drawdown = max(1 - equity/peakEquity) over the evaluation horizon; aggregated as a median across the cohort",
      concentration: "maxTopMintShare = largest single-mint share of simulated volume; bounded by concentrationBounds.maxTopMintShare",
      normalizedBankroll: "netReturn = (finalEquity - startingCash) / startingCash per agent, aggregated as a median across the cohort",
      costModel: "simulated fee + slippage + liquidity-impact cost in basis points of notional (paper accounting only)",
      aggregation: "dataset-as-unit: one replication observation per (provider pair x dataset); walk-forward windows are never independent datasets",
      regimeHandling: "regimes are OPTIONAL descriptive context (EVOLVE_REPLICATION_REGIMES=1); they never gate a unit and never change a score",
      abComparison: "paired Research-vs-Conventional comparison per (provider x dataset), species-matched, equal starting slots, no cross-cohort crossover",
      paperOnly: true,
      frozenProviderEvaluation: "frozen compiled cohorts are re-evaluated; the provider is never called at evaluation time",
      llmCallsAtEvaluationTime: false,
    },
    providers: {
      mock: {
        provider: RESEARCH_PROVIDER.MOCK ?? DEFAULT_RESEARCH_PROVIDER,
        deterministic: true,
        external: false,
        subprocess: false,
        network: false,
      },
      deepseek: {
        provider: RESEARCH_PROVIDER.DEEPSEEK_CLINE ?? "deepseek-cline",
        model: DEEPSEEK_CLINE_MODEL,
        reasoning: DEEPSEEK_CLINE_REASONING,
        profile: DEEPSEEK_CLINE_PROFILE,
        external: true,
        subprocess: true,
        network: true,
      },
    },
    research: {
      providerVersion: RESEARCH_PROVIDER_VERSION,
      runtimeVersion: PROVIDER_RUNTIME_VERSION,
      experimentVersion: RESEARCH_EXPERIMENT_VERSION,
      promptVersion: RESEARCH_PROMPT_VERSION,
      proposalSchemaVersion: PROPOSAL_SCHEMA_VERSION,
      evidencePacketVersion: EVIDENCE_PACKET_VERSION,
      compilerVersion: PROPOSAL_COMPILER_VERSION,
      watchdogVersion: WATCHDOG_VERSION,
      providerFormatVersion: RESEARCH_PROVIDER_FORMAT_VERSION,
      minUniqueRatio: RESEARCH_COHORT_DEFAULTS.minUniqueRatio,
      maxSpeciesShare: RESEARCH_COHORT_DEFAULTS.maxSpeciesShare,
    },
    reproduction: {
      cohortKeys: [...FROZEN_COHORT_KEYS],
      unit: "dataset",
      llmCallsRequired: false,
    },
    paperAccounting: {
      startingCash: paper.startingCash ?? null,
      baseFeeBps: paper.baseFeeBps ?? null,
      minSlippageBps: paper.minSlippageBps ?? null,
      slippageImpact: paper.slippageImpact ?? null,
      slippageCapBps: paper.slippageCapBps ?? null,
      adverseBufferBps: paper.adverseBufferBps ?? null,
      maxLiquidityFraction: paper.maxLiquidityFraction ?? null,
      maxPositionFraction: paper.maxPositionFraction ?? null,
    },
  };
}

/**
 * The exact subject the evaluation-contract digest is computed over: an
 * explicit projection of evaluator semantics (from the freeze artifact) plus
 * the live evaluator-semantics block. Unknown fields are never folded in.
 *
 * @param {object|null} freeze a freeze artifact (stored or freshly built)
 * @param {{ env?: Record<string, string> }} [options]
 */
export function evaluationContractSubject(freeze, { env = {} } = {}) {
  const arena = pick(freeze?.arena, CONTRACT_ARENA_FIELDS);
  return {
    contractId: EVALUATION_CONTRACT_ID,
    contractSchemaVersion: EVALUATION_CONTRACT_SCHEMA_VERSION,
    paperOnly: freeze?.paperOnly === true,
    arena,
    gates: freeze?.gates === undefined ? null : { ...(freeze.gates ?? {}) },
    evidenceThresholds:
      freeze?.evidenceThresholds === undefined ? null : { ...(freeze.evidenceThresholds ?? {}) },
    concentrationBounds:
      freeze?.concentrationBounds === undefined ? null : { ...(freeze.concentrationBounds ?? {}) },
    research: pick(freeze?.research, CONTRACT_RESEARCH_FIELDS),
    providers: {
      mock: pick(freeze?.providers?.mock, CONTRACT_PROVIDER_FIELDS),
      deepseek: pick(freeze?.providers?.deepseek, CONTRACT_PROVIDER_FIELDS),
    },
    replication: pick(freeze?.replication, CONTRACT_REPLICATION_FIELDS),
    semantics: buildEvaluationSemantics({ env }),
  };
}

/**
 * Deterministic evaluation-contract digest of a freeze artifact.
 *
 * Wave 1's value is derived from the STORED historical Wave 1 freeze (never a
 * regenerated one); Wave 2's value from its own newly written freeze.
 */
export function evaluationContractDigest(freeze, options = {}) {
  return digestOf(evaluationContractSubject(freeze, options));
}

/** The subject's short identity, for reports that must not print the whole thing. */
export function describeEvaluationContract(freeze, options = {}) {
  return {
    contractId: EVALUATION_CONTRACT_ID,
    contractSchemaVersion: EVALUATION_CONTRACT_SCHEMA_VERSION,
    evaluationContractDigest: evaluationContractDigest(freeze, options),
    included: {
      arena: [...CONTRACT_ARENA_FIELDS],
      gates: true,
      evidenceThresholds: true,
      concentrationBounds: true,
      research: [...CONTRACT_RESEARCH_FIELDS],
      providers: [...CONTRACT_PROVIDER_FIELDS],
      replication: [...CONTRACT_REPLICATION_FIELDS],
      semantics: "live evaluator semantics (versions, run config, gates, bootstrap, bankroll + cost model, definitions)",
    },
    excluded: [...CONTRACT_EXCLUDED_FIELDS],
  };
}

/**
 * Compare two contract-carrying identities for CROSS-WAVE COMPARABILITY.
 *
 * Comparability is NOT canonicality: each side may be canonical against its own
 * (different) freeze. What must match is the evaluator contract plus the two
 * frozen cohort identities.
 *
 * @param {{
 *   waveId?: string|null,
 *   freezeDigest?: string|null,
 *   evaluationContractDigest?: string|null,
 *   mockCohortDigest?: string|null,
 *   deepseekCohortDigest?: string|null,
 * }} a
 * @param {object} b
 */
export function compareEvaluationContracts(a = {}, b = {}) {
  const rows = [
    ["evaluationContractDigest", a.evaluationContractDigest ?? null, b.evaluationContractDigest ?? null],
    ["mockCohortDigest", a.mockCohortDigest ?? null, b.mockCohortDigest ?? null],
    ["deepseekCohortDigest", a.deepseekCohortDigest ?? null, b.deepseekCohortDigest ?? null],
  ];
  const differences = rows
    .filter(([, left, right]) => left !== right || left === null || right === null)
    .map(([field, left, right]) => ({
      field,
      a: left,
      b: right,
      reason:
        left === null || right === null
          ? "one side does not record this identity yet"
          : "the two waves do not describe the same experiment",
    }));
  return {
    comparable: differences.length === 0,
    differences,
    compared: {
      aWaveId: a.waveId ?? null,
      aFreezeDigest: a.freezeDigest ?? null,
      bWaveId: b.waveId ?? null,
      bFreezeDigest: b.freezeDigest ?? null,
    },
    note:
      "FULL FREEZE CANONICALITY and CROSS-WAVE COMPARABILITY are separate: two different full freeze digests are expected, while a matching evaluationContractDigest plus matching frozen cohort digests are REQUIRED before waves may be combined.",
  };
}

/**
 * Comparability of a whole SET of waves (used by the meta-summary). Returns a
 * status the meta-summary reports instead of silently aggregating.
 */
export function compareWaveEvaluationContracts(rows = []) {
  const waves = rows.map((row) => ({
    waveId: row?.waveId ?? null,
    freezeDigest: row?.freezeDigest ?? null,
    evaluationContractDigest: row?.evaluationContractDigest ?? null,
    mockCohortDigest: row?.mockCohortDigest ?? null,
    deepseekCohortDigest: row?.deepseekCohortDigest ?? null,
  }));

  if (waves.length < 2) {
    return {
      status: "SINGLE_WAVE",
      comparable: true,
      waves,
      pairs: [],
      differences: [],
      note: "Fewer than two waves: nothing to compare, and nothing is combined across waves.",
    };
  }

  const reference = waves[0];
  const pairs = [];
  const differences = [];
  for (const wave of waves.slice(1)) {
    const comparison = compareEvaluationContracts(reference, wave);
    pairs.push({ a: reference.waveId, b: wave.waveId, ...comparison });
    for (const difference of comparison.differences) {
      differences.push({ between: [reference.waveId, wave.waveId], ...difference });
    }
  }

  return {
    status: differences.length === 0 ? "COMPARABLE_WAVES" : "INCOMPARABLE_WAVES",
    comparable: differences.length === 0,
    waves,
    pairs,
    differences,
    note:
      differences.length === 0
        ? "Different full freeze digests are allowed; the evaluation contract and both frozen cohort identities match."
        : "Waves with different evaluation contracts are NEVER combined. Fix the contract (or evaluate under one contract) instead of aggregating.",
  };
}
