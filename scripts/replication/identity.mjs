/**
 * Phase 5C — deterministic run identity (PAPER ONLY).
 *
 * Two identities exist and must not be conflated:
 *
 *   replicationId (rep-<digest>)  the multi-dataset REPLICATION EXPERIMENT:
 *                                 freeze digest + the frozen cohort digests +
 *                                 the providers + the frozen evaluation config.
 *   unitId (unit-<digest>)        one (provider × dataset) experiment:
 *                                 replicationId + dataset fingerprint +
 *                                 the cohort digest for that provider.
 *
 * Identity is a pure function of those inputs, so re-running the exact same
 * experiment reproduces the same ids, and a rerun is DETECTED (an existing
 * unit with the same id) rather than silently replaced by a different one.
 */

import { digestOf } from "../lib/hash.mjs";
import { RUN_ARENAS_DIR } from "./constants.mjs";

/** Stable, secret-free description of the frozen evaluation config. */
export function evaluationKey(freeze) {
  const arena = freeze?.arena ?? {};
  return {
    scoreVersion: arena.scoreVersion ?? null,
    runnerVersion: arena.runnerVersion ?? null,
    population: arena.population ?? null,
    researchShare: arena.researchShare ?? null,
    generations: arena.generations ?? null,
    seeds: [...(arena.seeds ?? [])],
    stressProfiles: [...(arena.stressProfiles ?? [])],
    speciesMatchMode: arena.speciesMatchMode ?? null,
    bootstrapIterations: arena.bootstrapIterations ?? null,
    bootstrapSeed: arena.bootstrapSeed ?? null,
    maxWindows: arena.maxWindows ?? null,
  };
}

/** Deterministic id of the whole replication experiment (`rep-<12hex>`). */
export function replicationIdFor({ freezeDigest, cohortDigests = {}, providers = [], evaluation = {} } = {}) {
  const subject = {
    freezeDigest: freezeDigest ?? null,
    cohorts: Object.fromEntries(
      Object.entries(cohortDigests)
        .filter(([, value]) => Boolean(value))
        .sort((a, b) => a[0].localeCompare(b[0])),
    ),
    providers: [...providers].filter(Boolean).sort(),
    evaluation,
  };
  return `rep-${digestOf(subject).slice(0, 12)}`;
}

/** Deterministic id of one (provider × dataset) experiment (`unit-<12hex>`). */
export function unitIdFor({ replicationId, provider, datasetId, datasetFingerprint, cohortDigest } = {}) {
  const subject = {
    replicationId: replicationId ?? null,
    provider: provider ?? null,
    datasetId: datasetId ?? null,
    datasetFingerprint: datasetFingerprint ?? null,
    cohortDigest: cohortDigest ?? null,
  };
  return `unit-${digestOf(subject).slice(0, 12)}`;
}

/** Where one unit's own artifacts live inside a run directory. */
export function unitPaths(runDir, unitId) {
  return {
    dir: `${runDir}/units/${unitId}`,
    researchRoot: `${runDir}/units/${unitId}/research`,
    record: `${runDir}/units/${unitId}/unit.json`,
    arenasDir: `${runDir}/units/${unitId}/${RUN_ARENAS_DIR}`,
  };
}

/** Compact identity block for manifests and reports. */
export function describeIdentity({ replicationId, freezeDigest, cohortDigests, providers, evaluation }) {
  return {
    replicationId,
    freezeDigest,
    cohortDigests: { ...cohortDigests },
    providers: [...providers],
    evaluation: { ...evaluation },
    identityBasis:
      "replicationId = digest(freezeDigest, cohort digests, providers, frozen evaluation config); unitId = digest(replicationId, provider, dataset fingerprint, cohort digest)",
    deterministic: true,
  };
}
