/**
 * Matched A/B research cohort construction (Phase 5A.3).
 *
 * Phase 5A.2's fair mode was a step forward but not a controlled comparison:
 * research ancestry ended up representing ~84.5% of the final entrant
 * population (200 entrants, 169 research descendants, 31 conventional), so
 * "research did well" could not be separated from "research was most of the
 * population". Phase 5A.3 adds a genuinely matched A/B mode.
 *
 * The rules this module enforces, in code:
 *
 *   1. TWO cohorts — `research` and `conventional` — receive the SAME number
 *      of starting slots.
 *   2. NO CLONING. A duplicate seed digest may never occupy a second slot. If
 *      only N unique research seeds exist, the matched comparison size is N
 *      (and the conventional cohort is trimmed to N too), never N vs 100.
 *   3. Cohorts stay identifiable through evolution: every seed and every
 *      descendant carries its cohort, lineage id, original seed digest, parent
 *      lineage ids, generation, and exact-original vs descendant identity.
 *   4. CROSS-COHORT CROSSOVER IS DISABLED for the benchmark. `childLineage`
 *      reports `crossCohort: true` if it is ever asked to merge two cohorts,
 *      and the arena separates the cohorts' pre-evolution so that never
 *      happens.
 *
 * Nothing here trades, signs, or executes anything. PAPER ONLY.
 */

import { digestOf } from "../lib/hash.mjs";
import { createSeededRandom } from "../lib/random.mjs";
import { randomGenome, SPECIES } from "../engine/genome.mjs";
import { genomeDigestOf } from "./cohort.mjs";

export const AB_COHORT = Object.freeze({
  RESEARCH: "research",
  CONVENTIONAL: "conventional",
});

/** How a cohort member came to exist. */
export const COHORT_FOUNDER_KIND = Object.freeze({
  SEED: "seed",
  IMMIGRANT: "immigrant",
  DESCENDANT: "descendant",
});

export const COHORT_IDENTITY = Object.freeze({
  EXACT_ORIGINAL: "exact-original",
  DESCENDANT: "descendant",
});

export const AB_DEFAULTS = Object.freeze({
  /** 50/50 by default: a two-arm test should start symmetric. */
  researchShare: 0.5,
  /** Deterministic bootstrap iterations / seed for the statistical summary. */
  bootstrapIterations: 2000,
  bootstrapSeed: "evolve-ab-bootstrap-v1",
  /** Descendant expansion is opt-in; see below. */
  expandDescendants: false,
});

/** Stable, digest-derived lineage id — never index-derived. */
export function seedLineageId(cohort, digest) {
  const short = typeof digest === "string" && digest.length > 0 ? digest.slice(0, 16) : "unknown";
  return `L-${cohort}-${short}`;
}

/**
 * De-duplicate a list of seed entrants by canonical genome digest. The FIRST
 * occurrence wins. Duplicates consume no slot and are reported.
 *
 * @param {object[]} entries
 * @returns {{ unique: object[], duplicates: object[], uniqueDigests: string[] }}
 */
export function dedupeSeedEntrants(entries = []) {
  const seen = new Set();
  const unique = [];
  const duplicates = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const digest = genomeDigestOf(entry);
    if (!digest) {
      duplicates.push({ reason: "NO_GENOME", digest: null, origin: entry?.origin ?? null });
      continue;
    }
    if (seen.has(digest)) {
      duplicates.push({ reason: "DUPLICATE_SEED_DIGEST", digest, origin: entry?.origin ?? null });
      continue;
    }
    seen.add(digest);
    unique.push({ ...entry, digest, genomeDigest: digest });
  }
  return { unique, duplicates, uniqueDigests: [...seen] };
}

/**
 * Tag a starting seed with its cohort + lineage provenance. Deterministic: the
 * lineage id is derived from the cohort and the seed digest, so re-running the
 * same cohort construction yields byte-identical lineage ids.
 */
export function tagSeedLineage(entrant, { cohort } = {}) {
  const resolvedCohort = cohort ?? entrant?.cohort ?? null;
  if (resolvedCohort !== AB_COHORT.RESEARCH && resolvedCohort !== AB_COHORT.CONVENTIONAL) {
    throw new Error(`tagSeedLineage requires cohort research|conventional (got ${String(cohort)})`);
  }
  const digest = genomeDigestOf(entrant) ?? digestOf(entrant?.genome ?? {});
  const lineageId = entrant?.lineageId ?? seedLineageId(resolvedCohort, digest);
  const research = entrant?.research ?? null;
  return {
    ...entrant,
    cohort: resolvedCohort,
    lineageId,
    lineage: {
      cohort: resolvedCohort,
      lineageId,
      seedDigest: digest,
      seedDigests: [digest],
      parentLineageIds: [],
      generation: 0,
      identity: COHORT_IDENTITY.EXACT_ORIGINAL,
      founderKind: COHORT_FOUNDER_KIND.SEED,
      researchFamily: research?.researchFamily ?? null,
      familyId: research?.familyId ?? null,
      proposalId: research?.proposalId ?? null,
      authorRole: research?.authorRole ?? null,
      researchFamilies: research?.researchFamily ? [research.researchFamily] : [],
      roles: research?.authorRole ? [research.authorRole] : [],
      crossCohort: false,
    },
  };
}

/**
 * Lineage for a BRED child of one or more lineage-carrying parents.
 * Returns `null` when no parent carries lineage, so ordinary (non-A/B) pools
 * are completely unaffected.
 *
 * A child's `lineageId` is the lineage of its first lineage-carrying parent:
 * crossing two members of the same cohort does not invent a new lineage. The
 * full set of parents is recorded in `parentLineageIds`.
 */
export function childLineage(...parents) {
  const carriers = (Array.isArray(parents) ? parents : []).filter((parent) => parent?.lineage);
  if (carriers.length === 0) return null;
  const cohorts = new Set(carriers.map((parent) => parent.lineage.cohort).filter(Boolean));
  const cohort = carriers[0].lineage.cohort ?? null;
  const lineageIds = new Set();
  const seedDigests = new Set();
  const researchFamilies = new Set();
  const roles = new Set();
  for (const parent of carriers) {
    const lineage = parent.lineage;
    if (lineage.lineageId) lineageIds.add(lineage.lineageId);
    if (lineage.seedDigest) seedDigests.add(lineage.seedDigest);
    for (const id of lineage.seedDigests ?? []) seedDigests.add(id);
    for (const id of lineage.parentLineageIds ?? []) lineageIds.add(id);
    for (const family of lineage.researchFamilies ?? []) researchFamilies.add(family);
    for (const role of lineage.roles ?? []) roles.add(role);
    if (lineage.researchFamily) researchFamilies.add(lineage.researchFamily);
    if (lineage.authorRole) roles.add(lineage.authorRole);
  }
  return {
    cohort,
    lineageId: carriers[0].lineage.lineageId ?? seedLineageId(cohort, [...seedDigests][0] ?? "unknown"),
    seedDigest: carriers[0].lineage.seedDigest ?? [...seedDigests][0] ?? null,
    seedDigests: [...seedDigests].sort(),
    parentLineageIds: [...lineageIds].sort(),
    generation: Math.max(...carriers.map((parent) => parent.lineage.generation ?? 0)) + 1,
    identity: COHORT_IDENTITY.DESCENDANT,
    founderKind: COHORT_FOUNDER_KIND.DESCENDANT,
    researchFamily: null,
    familyId: null,
    proposalId: null,
    authorRole: null,
    researchFamilies: [...researchFamilies].sort(),
    roles: [...roles].sort(),
    // True only if a child would merge two different cohorts. The A/B benchmark
    // never allows this; the flag exists so it can never happen silently.
    crossCohort: cohorts.size > 1,
  };
}

/**
 * Lineage for a COHORT IMMIGRANT: a fresh random genome introduced inside one
 * cohort's own evolutionary budget. It is its own founder (generation 0, no
 * parents, no research ancestry), but it still belongs to exactly one cohort,
 * so A/B attribution stays complete. Random immigrants are NOT descendants of
 * any seed and carry no research role.
 */
export function immigrantLineage(cohort, digest) {
  const resolvedCohort = cohort;
  const lineageId = seedLineageId(resolvedCohort, digest);
  return {
    cohort: resolvedCohort,
    lineageId,
    seedDigest: digest,
    seedDigests: digest ? [digest] : [],
    parentLineageIds: [],
    generation: 0,
    identity: COHORT_IDENTITY.EXACT_ORIGINAL,
    founderKind: COHORT_FOUNDER_KIND.IMMIGRANT,
    researchFamily: null,
    familyId: null,
    proposalId: null,
    authorRole: null,
    researchFamilies: [],
    roles: [],
    crossCohort: false,
  };
}

/** Normalize lineage provenance from an entrant / candidate / leaderboard row. */
export function normalizeLineage(row) {
  const lineage = row?.lineage ?? null;
  const cohort =
    row?.cohort ??
    lineage?.cohort ??
    (row?.origin === AB_COHORT.RESEARCH || row?.research?.isResearch === true ? AB_COHORT.RESEARCH : null);
  const identity =
    lineage?.identity ??
    (cohort === AB_COHORT.RESEARCH
      ? row?.research?.identity === "descendant"
        ? COHORT_IDENTITY.DESCENDANT
        : row?.research?.identity === "exact"
          ? COHORT_IDENTITY.EXACT_ORIGINAL
          : null
      : cohort === AB_COHORT.CONVENTIONAL
        ? row?.origin === "immigrant" || row?.origin === "evolved"
          ? COHORT_IDENTITY.DESCENDANT
          : row?.origin === "champion"
            ? COHORT_IDENTITY.EXACT_ORIGINAL
            : null
        : null);
  return {
    cohort,
    lineageId: lineage?.lineageId ?? row?.lineageId ?? null,
    seedDigest: lineage?.seedDigest ?? null,
    seedDigests: [...(lineage?.seedDigests ?? (lineage?.seedDigest ? [lineage.seedDigest] : []))],
    parentLineageIds: [...(lineage?.parentLineageIds ?? [])],
    generation: Number.isFinite(lineage?.generation) ? lineage.generation : null,
    identity,
    founderKind: lineage?.founderKind ?? null,
    researchFamilies: [
      ...(lineage?.researchFamilies ?? (lineage?.researchFamily ? [lineage.researchFamily] : [])),
    ],
    roles: [...(lineage?.roles ?? (lineage?.authorRole ? [lineage.authorRole] : []))],
    crossCohort: lineage?.crossCohort === true,
    exactOriginal: identity === COHORT_IDENTITY.EXACT_ORIGINAL,
    descendant: identity === COHORT_IDENTITY.DESCENDANT,
  };
}

/** Count descendant convergence: distinct final genomes vs. occupied slots. */
export function convergenceStats(rows = []) {
  const list = Array.isArray(rows) ? rows : [];
  const counts = new Map();
  for (const row of list) {
    const digest = row?.digest ?? null;
    if (typeof digest !== "string") continue;
    counts.set(digest, (counts.get(digest) ?? 0) + 1);
  }
  let convergedSlots = 0;
  const repeated = [];
  for (const [digest, count] of counts) {
    if (count > 1) {
      convergedSlots += count - 1;
      repeated.push({ digest, copies: count });
    }
  }
  repeated.sort((a, b) => (a.digest < b.digest ? -1 : a.digest > b.digest ? 1 : 0));
  return {
    occupiedSlots: list.length,
    uniqueFinalGenomes: counts.size,
    convergenceCount: convergedSlots,
    repeatedDigests: repeated,
    uniqueRatio: list.length > 0 ? counts.size / list.length : 0,
  };
}

function clamp01(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return AB_DEFAULTS.researchShare;
  return Math.min(1, Math.max(0, number));
}

/**
 * Build the matched A/B seed cohorts.
 *
 * Sizing rule (the heart of "do not run 42 vs 158 and call it fair"):
 *
 *   requestedPerCohort = min(requested, share-derived split)   (symmetric)
 *   matchedPerCohort   = min(requestedPerCohort,
 *                            uniqueResearchSeeds,
 *                            uniqueConventionalSeeds,
 *                            maxPerCohort)
 *
 * Both cohorts get `matchedPerCohort` slots. A shortage is REPORTED, never
 * padded by cloning. If expansion is enabled the cohorts are evolved up to
 * `requestedPerCohort` later under identical rules (descendants, not clones).
 *
 * @param {{
 *   requestedPopulation: number,
 *   researchShare?: number,
 *   researchSeeds?: object[],
 *   conventionalSeeds?: object[],
 *   expandDescendants?: boolean,
 *   maxPerCohort?: number|null,
 * }} options
 */
export function buildMatchedAbCohort({
  requestedPopulation = 200,
  researchShare = AB_DEFAULTS.researchShare,
  researchSeeds = [],
  conventionalSeeds = [],
  expandDescendants = AB_DEFAULTS.expandDescendants,
  maxPerCohort = null,
} = {}) {
  const total = Math.max(0, Math.round(Number(requestedPopulation) || 0));
  const share = clamp01(researchShare);
  const researchRequested = Math.round(total * share);
  const conventionalRequested = total - researchRequested;
  // A/B is symmetric by construction: the per-cohort target is the smaller of
  // the two requested arms, so neither side is ever larger than the other.
  const requestedPerCohort = Math.max(0, Math.min(researchRequested, conventionalRequested));

  const researchUnique = dedupeSeedEntrants(researchSeeds);
  const conventionalUnique = dedupeSeedEntrants(conventionalSeeds);

  const cap =
    Number.isFinite(Number(maxPerCohort)) && Number(maxPerCohort) > 0
      ? Math.floor(Number(maxPerCohort))
      : Number.POSITIVE_INFINITY;

  const matchedPerCohort = Math.max(
    0,
    Math.min(requestedPerCohort, researchUnique.unique.length, conventionalUnique.unique.length, cap),
  );

  const researchShortage = Math.max(0, requestedPerCohort - researchUnique.unique.length);
  const conventionalShortage = Math.max(0, requestedPerCohort - conventionalUnique.unique.length);
  const reasons = [];
  if (researchShortage > 0) {
    reasons.push(
      `only ${researchUnique.unique.length} unique research seed genome(s) available for a requested ${requestedPerCohort} (${researchUnique.duplicates.length} duplicate seed digest(s) rejected)`,
    );
  }
  if (conventionalShortage > 0) {
    reasons.push(
      `only ${conventionalUnique.unique.length} unique conventional seed genome(s) available for a requested ${requestedPerCohort} (${conventionalUnique.duplicates.length} duplicate seed digest(s) rejected)`,
    );
  }
  if (Number.isFinite(cap) && cap < requestedPerCohort && reasons.length === 0) {
    reasons.push(`per-cohort cap of ${cap} is below the requested ${requestedPerCohort}`);
  }

  const ok = matchedPerCohort > 0;
  const targetPerCohort = expandDescendants && ok ? Math.max(matchedPerCohort, requestedPerCohort) : matchedPerCohort;

  const research = researchUnique.unique
    .slice(0, matchedPerCohort)
    .map((entry) => tagSeedLineage(entry, { cohort: AB_COHORT.RESEARCH }));
  const conventional = conventionalUnique.unique
    .slice(0, matchedPerCohort)
    .map((entry) => tagSeedLineage(entry, { cohort: AB_COHORT.CONVENTIONAL }));

  const matchedDowngrade = requestedPerCohort - matchedPerCohort;
  const accounting = {
    mode: "ab",
    requestedPopulation: total,
    requestedResearchShare: share,
    requestedPerCohort,
    // Actual starting slot counts — identical for both cohorts by construction.
    startingResearchSeeds: research.length,
    startingConventionalSeeds: conventional.length,
    matchedPerCohort,
    // Opt-in descendant expansion target (only reachable through ordinary,
    // identical evolution — never by duplicating a seed).
    targetPerCohort,
    expandDescendants: Boolean(expandDescendants),
    uniqueResearchSeeds: researchUnique.unique.length,
    uniqueConventionalSeeds: conventionalUnique.unique.length,
    seedDuplicatesRejected: {
      research: researchUnique.duplicates.length,
      conventional: conventionalUnique.duplicates.length,
    },
    seedShortage: {
      research: researchShortage,
      conventional: conventionalShortage,
    },
    matchedDowngrade,
    downgraded: matchedDowngrade > 0,
    shortageReason: reasons.length > 0 ? reasons.join("; ") : null,
    cloningToFillQuota: 0,
    crossCohortCrossover: false,
    symmetricStartingSlots: research.length === conventional.length,
    ok,
  };

  return {
    ok,
    research,
    conventional,
    accounting,
    error: ok ? null : "no matched cohort could be built (zero unique seeds on at least one side)",
  };
}

/* -------------------------------------------------------------------------- */
/* Phase 5A.3.1: STRICT species matching                                      */
/* -------------------------------------------------------------------------- */

/**
 * The species of an entrant / artifact row. Missing species is reported as
 * `null` (never invented) so a cohort that cannot be species-matched fails
 * loudly instead of matching against a fabricated species.
 */
export function speciesOf(entry) {
  if (typeof entry?.species === "string" && entry.species.length > 0) return entry.species;
  const researchSpecies = entry?.research?.species;
  if (typeof researchSpecies === "string" && researchSpecies.length > 0) return researchSpecies;
  return null;
}

/** Deterministic species counts for entrants / artifact rows. */
export function speciesCountsOf(entries = []) {
  const out = {};
  for (const entry of Array.isArray(entries) ? entries : []) {
    const species = speciesOf(entry);
    if (!species) continue;
    out[species] = (out[species] ?? 0) + 1;
  }
  return out;
}

/** Exact equality of two species distributions (absent species count as zero). */
export function speciesCountsEqual(a = {}, b = {}) {
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  for (const key of keys) {
    if ((a?.[key] ?? 0) !== (b?.[key] ?? 0)) return false;
  }
  return true;
}

/**
 * Compare two species distributions. `matched` is true only when EVERY species
 * count is identical on both sides.
 */
export function speciesMatchVerdict(researchCounts = {}, conventionalCounts = {}) {
  const species = [
    ...new Set([...Object.keys(researchCounts ?? {}), ...Object.keys(conventionalCounts ?? {})]),
  ].sort();
  const deltas = {};
  let matched = true;
  for (const key of species) {
    const delta = (researchCounts?.[key] ?? 0) - (conventionalCounts?.[key] ?? 0);
    deltas[key] = delta;
    if (delta !== 0) matched = false;
  }
  return { matched, deltas, species };
}

/**
 * Is the strict species-matched control requested? Only the exact value `1`
 * enables it, matching every other EVOLVE_ARENA_* boolean in this repository.
 */
export function speciesMatchRequested(env = {}) {
  return String(env?.EVOLVE_ARENA_AB_SPECIES_MATCHED ?? "") === "1";
}

/**
 * Scale a species distribution to a new total with largest-remainder
 * allocation. Deterministic and symmetric: the same input counts always
 * produce the same quotas, so both A/B arms receive identical per-species
 * resources.
 */
export function scaleSpeciesCounts(counts = {}, total = 0) {
  const target = Math.max(0, Math.round(Number(total) || 0));
  const entries = Object.entries(counts ?? {})
    .filter(([, count]) => Number.isFinite(Number(count)) && Number(count) > 0)
    .map(([species, count]) => [species, Number(count)]);
  const sum = entries.reduce((acc, [, count]) => acc + count, 0);
  if (target === 0 || sum === 0) return {};
  const order = entries.map(([species]) => species).sort();
  const exact = new Map(order.map((species) => [species, (Number(counts[species]) / sum) * target]));
  const out = {};
  let allocated = 0;
  for (const species of order) {
    const floor = Math.floor(exact.get(species));
    out[species] = floor;
    allocated += floor;
  }
  const remainders = order
    .map((species) => ({ species, remainder: exact.get(species) - out[species] }))
    .sort((a, b) => b.remainder - a.remainder || (a.species < b.species ? -1 : 1));
  let remaining = target - allocated;
  for (const { species } of remainders) {
    if (remaining <= 0) break;
    out[species] += 1;
    remaining -= 1;
  }
  let guard = 0;
  while (remaining > 0 && order.length > 0 && guard < order.length) {
    out[order[0]] += 1;
    remaining -= 1;
    guard += 1;
  }
  return out;
}

/**
 * Generate species-exact conventional controls: for every requested species,
 * that many FRESH, standard species-initialized genomes.
 *
 * Hard rules (all enforced here, not by convention):
 *   - a generated digest is never reused (`avoidDigests` plus the digests of
 *     this batch), so no genome occupies a second slot and no control can be a
 *     copy of a Research genome;
 *   - a species is NEVER substituted for another — an unattainable quota is
 *     reported as a shortfall instead;
 *   - generation is deterministic for a given seed.
 *
 * @param {{
 *   counts?: Record<string, number>,
 *   seed?: string,
 *   avoidDigests?: string[],
 *   maxAttemptsPerGenome?: number,
 * }} options
 */
export function speciesMatchControlSeeds({
  counts = {},
  seed = "ab-species-match",
  avoidDigests = [],
  maxAttemptsPerGenome = 64,
} = {}) {
  const avoid = new Set((Array.isArray(avoidDigests) ? avoidDigests : []).filter(Boolean));
  const attemptsPerGenome = Math.max(1, Math.round(Number(maxAttemptsPerGenome) || 1));
  const random = createSeededRandom(`ab-species-match:${seed}`);
  const seeds = [];
  const achievedCounts = {};
  const shortfall = {};
  // Deterministic species order: the requested species (sorted) first. Species
  // with a zero count consume no slot.
  const order = [...new Set([...Object.keys(counts ?? {}).sort(), ...SPECIES])];
  for (const species of order) {
    const count = Math.max(0, Math.round(Number(counts?.[species] ?? 0) || 0));
    if (count === 0) continue;
    let made = 0;
    const budget = count * attemptsPerGenome;
    for (let attempt = 0; attempt < budget && made < count; attempt += 1) {
      const genome = randomGenome(species, random);
      const digest = digestOf(genome);
      if (avoid.has(digest)) continue;
      avoid.add(digest);
      seeds.push({ genome, species, origin: "immigrant", digest });
      made += 1;
    }
    achievedCounts[species] = made;
    if (made < count) shortfall[species] = count - made;
  }
  return {
    seeds,
    achievedCounts,
    shortfall,
    requestedCounts: { ...counts },
    ok: Object.keys(shortfall).length === 0,
  };
}

/**
 * Keep, per species, only the first `counts[species]` entries — in the cohort's
 * own natural order. Used for a symmetric per-species shrink; it never selects
 * by performance and never changes a retained genome.
 */
export function trimSpeciesCounts(entries = [], counts = {}) {
  const seen = {};
  const out = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const species = speciesOf(entry);
    if (!species) continue;
    const limit = Number(counts?.[species] ?? 0);
    if (!Number.isFinite(limit) || limit <= 0) continue;
    const used = seen[species] ?? 0;
    if (used >= limit) continue;
    seen[species] = used + 1;
    out.push(entry);
  }
  return out;
}

/**
 * Build the complete strict species-matched plan for one A/B run.
 *
 * The REFERENCE distribution is the Research cohort exactly as the research
 * pipeline produced it (never reshaped, never re-sorted by performance). The
 * conventional controls are generated to those exact species counts, and a
 * quota that cannot be filled as UNIQUE controls shrinks BOTH cohorts
 * symmetrically — with no cloning and no species substitution anywhere.
 *
 * @param {{
 *   researchSeeds?: object[],
 *   requestedPerCohort?: number,
 *   seed?: string,
 *   maxAttemptsPerGenome?: number,
 *   extraAvoidDigests?: string[],
 * }} options
 */
export function planSpeciesMatchedCohort({
  researchSeeds = [],
  requestedPerCohort = 0,
  seed = "ab-species-match",
  maxAttemptsPerGenome = 64,
  extraAvoidDigests = [],
} = {}) {
  const researchUnique = dedupeSeedEntrants(researchSeeds).unique;
  const request = Math.max(0, Math.round(Number(requestedPerCohort) || 0));
  const perCohort = Math.min(request, researchUnique.length);
  const referenceSeeds = researchUnique.slice(0, perCohort);
  const requestedCounts = speciesCountsOf(referenceSeeds);
  const identified = Object.values(requestedCounts).reduce((acc, count) => acc + count, 0);
  const base = {
    requestedMatchMode: "species-matched",
    requestedPerCohort: request,
    perCohort,
    uniqueResearchSeeds: researchUnique.length,
    requestedCounts,
    cloningToFillQuota: 0,
    substitutedSpecies: 0,
  };

  if (perCohort === 0) {
    return {
      ...base,
      ok: false,
      counts: {},
      matchedPerCohort: 0,
      research: [],
      conventional: [],
      shortfall: {},
      symmetricShrink: false,
      noCloning: true,
      error: "no unique research seed genome is available to species-match against",
    };
  }
  if (identified !== referenceSeeds.length) {
    return {
      ...base,
      ok: false,
      counts: {},
      matchedPerCohort: 0,
      research: [],
      conventional: [],
      shortfall: {},
      symmetricShrink: false,
      noCloning: true,
      error: `${referenceSeeds.length - identified} research seed genome(s) carry no species identity, so an exact species match cannot be guaranteed`,
    };
  }

  const controls = speciesMatchControlSeeds({
    counts: requestedCounts,
    seed,
    avoidDigests: [
      ...referenceSeeds.map((entry) => genomeDigestOf(entry)).filter(Boolean),
      ...(Array.isArray(extraAvoidDigests) ? extraAvoidDigests.filter(Boolean) : []),
    ],
    maxAttemptsPerGenome,
  });
  const counts = { ...controls.achievedCounts };
  const research = trimSpeciesCounts(referenceSeeds, counts);
  const conventional = trimSpeciesCounts(controls.seeds, counts);
  const matchedPerCohort = Object.values(counts).reduce((acc, count) => acc + count, 0);
  if (matchedPerCohort === 0) {
    return {
      ...base,
      ok: false,
      counts,
      matchedPerCohort,
      research,
      conventional,
      shortfall: controls.shortfall,
      symmetricShrink: true,
      noCloning: true,
      error: `no unique species-matched control genome could be produced for ${JSON.stringify(requestedCounts)} (shortfall ${JSON.stringify(controls.shortfall)}); species are never substituted and genomes are never cloned`,
    };
  }

  return {
    ...base,
    ok: true,
    counts,
    matchedPerCohort,
    research,
    conventional,
    shortfall: controls.shortfall,
    symmetricShrink: !controls.ok,
    noCloning: true,
    error: null,
  };
}

/**
 * The strict species-matching INVARIANT, checked at the formal evaluation
 * freeze: speciesCounts(research) === speciesCounts(conventional) exactly —
 * plus no cloned/duplicated genome digest inside a cohort and no digest shared
 * across cohorts. Returns an explicit verdict; a caller must never continue on
 * `ok: false`.
 */
export function enforceSpeciesMatchInvariant({
  research = [],
  conventional = [],
  expectedCounts = null,
  requested = true,
} = {}) {
  const researchList = Array.isArray(research) ? research : [];
  const conventionalList = Array.isArray(conventional) ? conventional : [];
  const researchCounts = speciesCountsOf(researchList);
  const conventionalCounts = speciesCountsOf(conventionalList);
  const verdict = speciesMatchVerdict(researchCounts, conventionalCounts);

  const digestsIn = (rows) => {
    const seen = new Set();
    const duplicates = [];
    for (const row of rows) {
      const digest = genomeDigestOf(row);
      if (!digest) continue;
      if (seen.has(digest)) duplicates.push(digest);
      else seen.add(digest);
    }
    return { digests: seen, duplicates };
  };
  const researchDigests = digestsIn(researchList);
  const conventionalDigests = digestsIn(conventionalList);
  const sharedDigests = [...conventionalDigests.digests]
    .filter((digest) => researchDigests.digests.has(digest))
    .sort();

  const expected = expectedCounts == null ? null : { ...expectedCounts };
  const expectedSatisfied =
    expected == null
      ? true
      : speciesCountsEqual(researchCounts, expected) && speciesCountsEqual(conventionalCounts, expected);

  const reasons = [];
  if (!verdict.matched) {
    reasons.push(
      `species counts differ (research ${JSON.stringify(researchCounts)} vs conventional ${JSON.stringify(conventionalCounts)})`,
    );
  }
  if (researchDigests.duplicates.length > 0 || conventionalDigests.duplicates.length > 0) {
    reasons.push(
      `no-cloning violated: duplicate genome digest inside a cohort (research ${researchDigests.duplicates.length}, conventional ${conventionalDigests.duplicates.length})`,
    );
  }
  if (sharedDigests.length > 0) {
    reasons.push(`no-cloning violated: ${sharedDigests.length} genome digest(s) appear in BOTH cohorts`);
  }
  if (!expectedSatisfied) {
    reasons.push(`frozen species counts deviate from the agreed quotas ${JSON.stringify(expected)}`);
  }
  const ok = reasons.length === 0;
  return {
    ok,
    requested: requested === true,
    matched: verdict.matched,
    researchCounts,
    conventionalCounts,
    deltas: verdict.deltas,
    expectedCounts: expected,
    expectedSatisfied,
    sharedDigests,
    duplicateDigests: {
      research: researchDigests.duplicates,
      conventional: conventionalDigests.duplicates,
    },
    researchCohortSize: researchList.length,
    conventionalCohortSize: conventionalList.length,
    reason: ok ? null : reasons.join("; "),
  };
}

/** One-line species distribution, e.g. `Reversal 12, Wallet Flow 1`. */
export function describeSpeciesCounts(counts = {}) {
  const entries = Object.entries(counts ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (entries.length === 0) return "(none)";
  return entries.map(([species, count]) => `${species} ${count}`).join(", ");
}

/**
 * Species-matched conventional controls over a Research seed list (Phase 5A.3
 * entry point, kept for compatibility). Species-exact, deterministic, and
 * digest-unique: the same seed list always yields the same controls.
 *
 * @param {{ researchSeeds?: object[], population?: number, seed?: string }} options
 */
export function speciesMatchedConventionalSeeds({ researchSeeds = [], population = 0, seed = "ab-species-match" } = {}) {
  const seeds = Array.isArray(researchSeeds) ? researchSeeds : [];
  const target = Math.max(0, Math.min(Math.round(Number(population) || 0), seeds.length));
  const reference = seeds.slice(0, target);
  const counts = speciesCountsOf(reference);
  const { seeds: controls } = speciesMatchControlSeeds({
    counts,
    seed,
    avoidDigests: reference.map((entry) => genomeDigestOf(entry)).filter(Boolean),
  });
  return controls;
}

/** Compact one-line startup summary, e.g. `research=84 conventional=84 total=168`. */
export function describeAbCohorts(accounting) {
  const research = accounting?.startingResearchSeeds ?? 0;
  const conventional = accounting?.startingConventionalSeeds ?? 0;
  return `research=${research} conventional=${conventional} total=${research + conventional}`;
}
