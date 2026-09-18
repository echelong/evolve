/**
 * Phase 5C — experiment freeze (PAPER ONLY).
 *
 * A replication claim is only meaningful if the experiment is pinned first.
 * This module builds ONE versioned freeze artifact describing every immutable or
 * explicitly configured value the replication relies on:
 *
 *   Arena score/runner/cache/evaluator versions, generations, population,
 *   seeds, survivor/breeder fractions, mutation config, immigrant fractions,
 *   stress profiles, evidence gates, concentration bounds, no-catastrophic
 *   requirement, species-match mode, no-cloning policy, the mock provider
 *   config, the DeepSeek provider/model/reasoning, the prompt / proposal-schema
 *   / evidence-packet / compiler / watchdog versions, the frozen research
 *   experiment ids, the git commit SHA, and createdAt.
 *
 * The `freezeDigest` is DETERMINISTIC: it is the digest of the whole artifact
 * with `createdAt` (a wall-clock stamp) removed, so rebuilding the freeze at a
 * different second yields the same digest while any *configuration* change
 * changes it. Every replication run records it.
 *
 * `verifyFreeze` rebuilds the freeze from the LIVE code/config and compares
 * field-by-field: critical drift (score version, gates, prompt, compiler,
 * species-match algorithm, …) FAILS, so a different experiment can never run
 * under the same Phase 5C label.
 *
 * PAPER ONLY. No wallet, no signing, no execution path, no provider call.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { canonicalJson, digestOf } from "../lib/hash.mjs";
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
import { RESEARCH_PROVIDER_FORMAT_VERSION, DEEPSEEK_CLINE_MODEL, DEEPSEEK_CLINE_REASONING, DEEPSEEK_CLINE_PROFILE, DEFAULT_RESEARCH_PROVIDER, RESEARCH_PROVIDER } from "../research/provider-config.mjs";
import { RESEARCH_PROVIDER_VERSION } from "../research/provider.mjs";
import { PROVIDER_RUNTIME_VERSION } from "../research/provider-runtime.mjs";
import { RESEARCH_EXPERIMENT_VERSION } from "../research/experiment.mjs";
import { AB_COHORT } from "../research/ab-cohort.mjs";
import { RESEARCH_COHORT_DEFAULTS } from "../research/cohort.mjs";
import { readGitCommit, readWorkingTreeDirty } from "./git.mjs";
import { FROZEN_COHORT_SOURCES } from "./cohorts.mjs";
import {
  DEFAULT_FREEZE_VERSION,
  FROZEN_COHORT_KEYS,
  FROZEN_CONCENTRATION_BOUNDS,
  FROZEN_EVIDENCE_THRESHOLDS,
  FROZEN_RUN_CONFIG,
  PHASE,
  REPLICATION_DIR,
  FREEZE_FILE,
  REPLICATION_SCHEMA_VERSION,
} from "./constants.mjs";

/**
 * Field paths whose drift means "this is a DIFFERENT experiment".
 * Everything else is reported as an advisory (non-fatal) drift.
 */
export const CRITICAL_FREEZE_PATHS = Object.freeze([
  // A different code version is a different experiment.
  "commit",
  "arena.scoreVersion",
  "arena.runnerVersion",
  "arena.cacheVersion",
  "arena.evaluatorVersion",
  "arena.generations",
  "arena.population",
  "arena.seeds",
  "arena.stressProfiles",
  "arena.speciesMatchMode",
  "arena.noCloning",
  "arena.crossCohortCrossover",
  "gates",
  "evidenceThresholds",
  "concentrationBounds",
  "research.promptVersion",
  "research.proposalSchemaVersion",
  "research.evidencePacketVersion",
  "research.compilerVersion",
  "research.watchdogVersion",
  "research.providerFormatVersion",
  "providers.deepseek.model",
  "providers.deepseek.reasoning",
  "providers.deepseek.promptVersion",
  "replication.llmCallsRequired",
  "replication.unit",
]);

export { readGitCommit, readWorkingTreeDirty };

/* ============================================================================
 * Build
 * ==========================================================================*/

/**
 * Build the freeze descriptor from the LIVE code/config.
 *
 * @param {{
 *   freezeVersion?: string,
 *   createdAt?: number,
 *   commit?: string|null,
 *   dirty?: boolean|null,
 *   cohortFreezes?: Record<string, {cohortDigest: string|null, count: number|null}>,
 * }} [options]
 */
export function buildFreezeConfig({
  freezeVersion = DEFAULT_FREEZE_VERSION,
  createdAt = Date.now(),
  commit = readGitCommit(),
  dirty = null,
  cohortFreezes = null,
} = {}) {
  const config = FROZEN_RUN_CONFIG;
  return {
    schemaVersion: REPLICATION_SCHEMA_VERSION,
    phase: PHASE,
    freezeVersion,
    label: `${freezeVersion}-freeze`,
    paperOnly: true,
    commit,
    dirtyWorkingTree: dirty,
    createdAt: new Date(createdAt).toISOString(),

    arena: {
      scoreVersion: ARENA_SCORE_VERSION,
      runnerVersion: ARENA_RUNNER_VERSION,
      cacheVersion: ARENA_CACHE_VERSION,
      evaluatorVersion: EVALUATOR_VERSION,
      population: config.population,
      researchShare: config.researchShare,
      generations: config.generations,
      workers: config.workers,
      seeds: [...config.seeds],
      stressProfiles: [...config.stressProfiles],
      survivorFraction: config.survivorFraction,
      breederShare: config.breederShare,
      mutationScale: config.mutationScale,
      crossoverRate: config.crossoverRate,
      immigrantRate: config.immigrantRate,
      randomImmigrantShare: config.randomImmigrantShare,
      championShare: config.championShare,
      immigrantShare: config.immigrantShare,
      speciesMatchMode: config.speciesMatchMode,
      noCloning: config.noCloning,
      crossCohortCrossover: config.crossCohortCrossover,
      equalStartingSlots: config.equalStartingSlots,
      equalEvolutionaryRules: config.equalEvolutionaryRules,
      equalScoring: config.equalScoring,
      equalGates: config.equalGates,
      scoringBonusForEitherCohort: config.scoringBonusForEitherCohort,
      bootstrapIterations: config.bootstrapIterations,
      bootstrapSeed: config.bootstrapSeed,
      maxWindows: config.maxWindows,
      cohorts: { research: AB_COHORT.RESEARCH, conventional: AB_COHORT.CONVENTIONAL },
    },

    // The frozen deployment gate table, verbatim from the Arena's own constant.
    gates: { ...DEFAULT_DEPLOYMENT_GATES },
    evidenceThresholds: { ...FROZEN_EVIDENCE_THRESHOLDS },
    concentrationBounds: { ...FROZEN_CONCENTRATION_BOUNDS },

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

    providers: {
      // The deterministic baseline. No subprocess, no network, no key.
      mock: {
        provider: RESEARCH_PROVIDER.MOCK ?? DEFAULT_RESEARCH_PROVIDER,
        deterministic: true,
        external: false,
        subprocess: false,
        network: false,
        model: null,
        reasoning: null,
        promptVersion: RESEARCH_PROMPT_VERSION,
        proposalSchemaVersion: PROPOSAL_SCHEMA_VERSION,
        evidencePacketVersion: EVIDENCE_PACKET_VERSION,
        compilerVersion: PROPOSAL_COMPILER_VERSION,
        watchdogVersion: WATCHDOG_VERSION,
      },
      // The external hypothesis source. FROZEN: Phase 5C never re-queries it.
      deepseek: {
        provider: RESEARCH_PROVIDER.DEEPSEEK_CLINE ?? "deepseek-cline",
        deterministic: false,
        external: true,
        subprocess: true,
        network: true,
        model: DEEPSEEK_CLINE_MODEL,
        reasoning: DEEPSEEK_CLINE_REASONING,
        profile: DEEPSEEK_CLINE_PROFILE,
        promptVersion: RESEARCH_PROMPT_VERSION,
        proposalSchemaVersion: PROPOSAL_SCHEMA_VERSION,
        evidencePacketVersion: EVIDENCE_PACKET_VERSION,
        compilerVersion: PROPOSAL_COMPILER_VERSION,
        watchdogVersion: WATCHDOG_VERSION,
        providerFormatVersion: RESEARCH_PROVIDER_FORMAT_VERSION,
      },
    },

    // The core Phase 5C property: frozen cohorts, zero LLM calls at eval time.
    replication: {
      mode: "frozen-cohorts",
      llmCallsRequired: false,
      cohortKeys: [...FROZEN_COHORT_KEYS],
      // WHERE each frozen cohort comes from (provider, source root, and the
      // research experiment id where one exists). The cohort DIGESTS themselves
      // are recorded in the cohort manifests and in every run artifact, and are
      // folded into the replication id — deliberately not into the freeze
      // digest, which would make the two artifacts circular.
      cohortSources: Object.fromEntries(
        Object.entries(FROZEN_COHORT_SOURCES).map(([key, source]) => [
          key,
          {
            provider: source.provider,
            root: source.root,
            experimentId: source.experimentId,
            canonicalArenaId: source.canonicalArenaId,
          },
        ]),
      ),
      unit: "dataset",
      datasetLevelBootstrap: true,
      descriptiveOnly: true,
      significance: null,
      verdict: null,
      noTuningFromOutcomes: true,
      speciesMatchPerProviderDataset: true,
      // Optional (may be filled in after the cohorts are frozen).
      cohorts: cohortFreezes ?? null,
    },
  };
}

/** The subject a freeze digest is computed over: everything except the clock. */
export function freezeDigestSubject(freeze) {
  const subject = { ...(freeze ?? {}) };
  delete subject.createdAt;
  delete subject.freezeDigest;
  delete subject.dirtyWorkingTree;
  return subject;
}

/** Deterministic digest of a freeze artifact (clock-independent). */
export function freezeDigest(freeze) {
  return digestOf(freezeDigestSubject(freeze));
}

/** Attach `freezeDigest` to a freeze artifact (non-mutating). */
export function withFreezeDigest(freeze) {
  const next = { ...freeze };
  next.freezeDigest = freezeDigest(freeze);
  return next;
}

/** Build + digest in one call. */
export function createFreeze(options = {}) {
  return withFreezeDigest(buildFreezeConfig(options));
}

/* ============================================================================
 * Persistence
 * ==========================================================================*/

export function freezePath(root = REPLICATION_DIR) {
  return path.join(root, FREEZE_FILE);
}

async function writeJsonAtomic(target, value) {
  await mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  const { rename } = await import("node:fs/promises");
  await rename(tmp, target);
}

export async function writeFreeze(freeze, { root = REPLICATION_DIR } = {}) {
  const record = withFreezeDigest(freeze);
  await writeJsonAtomic(freezePath(root), record);
  return record;
}

export async function readFreeze({ root = REPLICATION_DIR } = {}) {
  try {
    return JSON.parse(await readFile(freezePath(root), "utf8"));
  } catch {
    return null;
  }
}

/**
 * Load the freeze artifact, creating it when absent. Never silently rewrites an
 * existing artifact: a mismatch is reported by `verifyFreeze`.
 */
export async function ensureFreeze({ root = REPLICATION_DIR, ...options } = {}) {
  const existing = await readFreeze({ root });
  if (existing) return existing;
  const created = await writeFreeze(buildFreezeConfig(options), { root });
  return created;
}

/* ============================================================================
 * Verification
 * ==========================================================================*/

function flatten(value, prefix = "", out = {}) {
  if (value === null || value === undefined) {
    out[prefix || "$"] = null;
    return out;
  }
  if (Array.isArray(value)) {
    out[prefix || "$"] = canonicalJson(value);
    return out;
  }
  if (typeof value === "object") {
    for (const key of Object.keys(value).sort()) {
      flatten(value[key], prefix ? `${prefix}.${key}` : key, out);
    }
    return out;
  }
  out[prefix || "$"] = value;
  return out;
}

function isCritical(pathKey) {
  return CRITICAL_FREEZE_PATHS.some((prefix) => pathKey === prefix || pathKey.startsWith(`${prefix}.`));
}

/**
 * Compare a stored freeze against the live code/config.
 *
 * @returns {{
 *   ok: boolean,
 *   freezeDigest: string|null,
 *   currentDigest: string,
 *   digestMatches: boolean,
 *   criticalDrift: Array<{path: string, frozen: unknown, current: unknown, critical: true}>,
 *   advisoryDrift: Array<{path: string, frozen: unknown, current: unknown, critical: false}>,
 *   commitChanged: boolean,
 *   frozenCommit: string|null,
 *   currentCommit: string|null,
 * }}
 */
export function verifyFreeze(frozen, { current = buildFreezeConfig() } = {}) {
  const frozenFlat = flatten(freezeDigestSubject(frozen));
  const currentFlat = flatten(freezeDigestSubject(current));
  const keys = [...new Set([...Object.keys(frozenFlat), ...Object.keys(currentFlat)])].sort();

  const criticalDrift = [];
  const advisoryDrift = [];
  for (const key of keys) {
    const a = frozenFlat[key];
    const b = currentFlat[key];
    if (canonicalJson(a) === canonicalJson(b)) continue;
    const row = { path: key, frozen: a ?? null, current: b ?? null, critical: isCritical(key) };
    if (row.critical) criticalDrift.push(row);
    else advisoryDrift.push(row);
  }

  return {
    ok: criticalDrift.length === 0,
    freezeDigest: frozen ? freezeDigest(frozen) : null,
    currentDigest: freezeDigest(current),
    digestMatches: frozen ? freezeDigest(frozen) === freezeDigest(current) : false,
    criticalDrift,
    advisoryDrift,
    frozenCommit: frozen?.commit ?? null,
    currentCommit: current?.commit ?? null,
    commitChanged: Boolean(frozen?.commit) && frozen?.commit !== current?.commit,
  };
}

/**
 * Canonical/noncanonical label for an actual replication run's evidence
 * (Phase 5C, section AA). Development runs are allowed, but are marked so
 * nobody mistakes them for canonical evidence.
 */
export function canonicalityVerdict({
  frozen = null,
  commit = readGitCommit(),
  dirty = readWorkingTreeDirty(),
  devOverride = false,
} = {}) {
  const reasons = [];
  if (!frozen?.commit) reasons.push("the freeze artifact records no commit SHA");
  else if (frozen.commit !== commit) reasons.push(`current commit ${short(commit)} differs from the frozen commit ${short(frozen.commit)}`);
  if (dirty === true) reasons.push("the working tree is dirty");
  if (!frozen) reasons.push("no freeze artifact is loaded");
  const clean = reasons.length === 0;
  return {
    canonical: clean,
    clean,
    devOverride: devOverride === true,
    label: clean ? "CANONICAL" : "NON_CANONICAL",
    reasons,
    commit: commit ?? null,
    frozenCommit: frozen?.commit ?? null,
    dirty: dirty === true,
    note: clean
      ? "the run matches the frozen commit and a clean working tree"
      : devOverride === true
        ? "development override in effect: evidence is labelled NON_CANONICAL and is not a canonical replication result"
        : "this run does NOT match the frozen freeze artifact; do not present it as a canonical Phase 5C result (pass --dev to run anyway and label it NON_CANONICAL)",
  };
}

function short(value) {
  return typeof value === "string" ? value.slice(0, 8) : "n/a";
}
