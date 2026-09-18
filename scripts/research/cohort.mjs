/**
 * Research-cohort metrics (Phase 5A.2).
 *
 * Pure, dependency-free helpers shared by the research cycle (which enforces
 * genome uniqueness while compiling) and the Champion Arena (which assembles
 * the research cohort that actually consumes entrant slots). Keeping them in
 * one place means the uniqueness guard cannot drift between the two.
 *
 * The canonical identity of a research candidate is `digestOf(genome)` —
 * `.familyId` is proposal-scoped bookkeeping and is deliberately NOT used for
 * de-duplication.
 *
 * PAPER ONLY research machinery.
 */

import { digestOf } from "../lib/hash.mjs";

export const RESEARCH_COHORT_DEFAULTS = Object.freeze({
  // A requested 33-candidate cohort should be ~90% unique genomes.
  minUniqueRatio: 0.9,
  // No single species may consume more than this share of the cohort.
  maxSpeciesShare: 0.6,
});

/** Parse a ratio from an env var, clamped to [0,1]; invalid -> fallback. */
export function ratioEnv(value, fallback) {
  const parsed = Number.parseFloat(String(value ?? ""));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(1, Math.max(0, parsed));
}

/** The canonical genome digest of a compiled candidate or entrant. */
export function genomeDigestOf(entry) {
  if (typeof entry?.genomeDigest === "string" && entry.genomeDigest.length > 0) return entry.genomeDigest;
  if (entry?.genome && typeof entry.genome === "object") return digestOf(entry.genome);
  return null;
}

/**
 * De-duplicate compiled research candidates by genome digest, deterministically.
 * The FIRST occurrence of a digest in input order wins; every later occurrence
 * is reported as a duplicate and consumes no slot.
 *
 * @param {object[]} entries
 * @returns {{ unique: object[], duplicates: object[], uniqueDigests: string[] }}
 */
export function dedupeByGenomeDigest(entries = []) {
  const seen = new Set();
  const unique = [];
  const duplicates = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const digest = genomeDigestOf(entry);
    if (!digest) {
      duplicates.push({ entry, reason: "NO_GENOME" });
      continue;
    }
    if (seen.has(digest)) {
      duplicates.push({ entry, reason: "DUPLICATE_GENOME", digest });
      continue;
    }
    seen.add(digest);
    unique.push({ ...entry, genomeDigest: digest });
  }
  return { unique, duplicates, uniqueDigests: [...seen] };
}

/** `uniqueDigests / acceptedEntrants`, 0 when there are no entrants. */
export function uniqueGenomeRatio({ uniqueDigests = 0, acceptedEntrants = 0 } = {}) {
  const accepted = Math.max(0, Math.round(Number(acceptedEntrants) || 0));
  if (accepted === 0) return { ratio: 0, uniqueDigests: 0, acceptedEntrants: 0 };
  const unique = Math.max(0, Math.min(accepted, Math.round(Number(uniqueDigests) || 0)));
  return { ratio: unique / accepted, uniqueDigests: unique, acceptedEntrants: accepted };
}

/**
 * Uniqueness guard. Below the configured ratio the cohort is reported as
 * degraded — and, in strict mode, refused — rather than silently accepted.
 *
 * @returns {{ ok: boolean, ratio: number, threshold: number, warning: string|null, code: string|null }}
 */
export function cohortUniquenessVerdict({
  uniqueDigests = 0,
  acceptedEntrants = 0,
  minUniqueRatio = RESEARCH_COHORT_DEFAULTS.minUniqueRatio,
  strict = false,
} = {}) {
  const { ratio } = uniqueGenomeRatio({ uniqueDigests, acceptedEntrants });
  const threshold = Math.min(1, Math.max(0, Number(minUniqueRatio)));
  const ok = acceptedEntrants === 0 ? true : ratio >= threshold;
  return {
    ok,
    ratio,
    threshold,
    warning: ok
      ? null
      : `research cohort uniqueness ${(ratio * 100).toFixed(1)}% is below the configured minimum ${(threshold * 100).toFixed(0)}%`,
    code: ok ? null : strict ? "RESEARCH_UNIQUENESS_BELOW_MINIMUM" : "RESEARCH_UNIQUENESS_WARNING",
  };
}

/** Count occurrences by a key extractor; returns a plain object. */
export function distributionBy(entries, keyOf) {
  const out = {};
  for (const entry of Array.isArray(entries) ? entries : []) {
    const key = keyOf(entry);
    if (typeof key !== "string" || key.length === 0) continue;
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

export const speciesDistribution = (entries) => distributionBy(entries, (entry) => entry?.species ?? null);
export const familyDistribution = (entries) => distributionBy(entries, (entry) => entry?.family ?? entry?.researchFamily ?? null);
export const roleDistribution = (entries) => distributionBy(entries, (entry) => entry?.authorRole ?? null);

/**
 * Species-concentration guard. This is a DIVERSITY observation, never a
 * performance rule: it never changes a genome, never removes evidence, and
 * never weakens an Arena gate. When a single species exceeds the configured
 * share the cohort is flagged; the caller then tries alternative
 * evidence-supported proposals, and if none exist it preserves the proposals
 * and reports the concentration instead of fabricating diversity.
 *
 * @returns {{ ok: boolean, share: number, threshold: number, topSpecies: string|null, warning: string|null }}
 */
export function speciesConcentrationVerdict({
  entries = [],
  maxSpeciesShare = RESEARCH_COHORT_DEFAULTS.maxSpeciesShare,
  total = null,
} = {}) {
  const dist = speciesDistribution(entries);
  const denominator = Math.max(0, Math.round(Number(total ?? entries.length) || 0));
  const threshold = Math.min(1, Math.max(0, Number(maxSpeciesShare)));
  let topSpecies = null;
  let topCount = 0;
  for (const [species, count] of Object.entries(dist)) {
    if (count > topCount) {
      topCount = count;
      topSpecies = species;
    }
  }
  const share = denominator > 0 ? topCount / denominator : 0;
  const ok = denominator === 0 ? true : share <= threshold;
  return {
    ok,
    share,
    threshold,
    topSpecies,
    distribution: dist,
    warning: ok
      ? null
      : `research species concentration: ${topSpecies} holds ${(share * 100).toFixed(0)}% of the cohort (configured maximum ${(threshold * 100).toFixed(0)}%); proposals preserved, diversity NOT fabricated`,
  };
}
