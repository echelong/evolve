/**
 * Deterministic proposal compiler (Phase 5A / Phase 5A.2).
 *
 * Converts *validated* research proposals into candidate genome families. The
 * compiler — never the LLM, never the proposal — controls:
 *
 *   - which fields exist at all (only whitelisted genome keys survive; the
 *     schema already rejects everything else, and this layer re-checks)
 *   - gene ranges (proposals may only narrow inside GENE_BOUNDS/species boxes)
 *   - species bounds (clamped through the same clampToBounds as every genome)
 *   - maximum risk fraction, stop-loss / take-profit floors, pool-age caps
 *   - feature availability (a family can only blend presets that exist)
 *   - UNIQUENESS: `digestOf(genome)` is the canonical identity. A proposal
 *     whose compiled genome is already in this cohort never silently consumes
 *     a second slot — it is either deterministically diversified *inside the
 *     region the proposal itself declared*, or rejected as DUPLICATE_GENOME.
 *
 * Compilation is a pure function: same proposals + same cohort -> byte-identical
 * genomes. There is no eval, no dynamic import, no shell, and no I/O.
 *
 * Diversification is NOT random noise. A proposal that declares a parameter
 * *range* `[min, max]` has (by construction) declared every point in that range
 * acceptable; the first compile uses the midpoint, and a duplicate re-draws a
 * different point from that same declared range using a seed derived from the
 * proposal id and the colliding digest. A proposal with no non-degenerate range
 * has no faithful room to move and is rejected as a duplicate instead of being
 * perturbed arbitrarily.
 *
 * PAPER ONLY research machinery.
 */

import { digestOf } from "../lib/hash.mjs";
import { createSeededRandom } from "../lib/random.mjs";
import { GENOME_KEYS, GENE_BOUNDS, SPECIES, clampToBounds } from "../engine/genome.mjs";
import { resolveFamily, genomeFromFamily } from "../engine/families.mjs";

export const PROPOSAL_COMPILER_VERSION = 2;

/** Reason code recorded when a compiled genome collides with the cohort. */
export const DUPLICATE_GENOME = "DUPLICATE_GENOME";

/** How many faithful in-range re-draws are attempted before giving up. */
export const MAX_DIVERSIFICATION_ATTEMPTS = 8;

/**
 * Compiler-side hard limits, deliberately tighter than the raw gene bounds.
 * The compiler owns these numbers; proposals can narrow inside them, never
 * widen past them. Documented in the README.
 */
export const COMPILER_LIMITS = Object.freeze({
  // Position sizing: research families never exceed a quarter of the bankroll.
  maxRiskFraction: 0.25,
  // A stop tighter than 2% of equity is churn bait; the floor stays above it.
  minStopLoss: 0.02,
  // Take-profit must be reachable in a realistic hold window.
  minTakeProfit: 0.04,
  // No compiled family may hold positions effectively forever.
  maxPoolAgeHours: 24 * 730,
  maxMinPoolAgeHours: 24 * 90,
});

/**
 * Apply compiler limits on top of the gene-bound clamped genome. Deterministic,
 * no-op when the value is already inside limits.
 */
function applyCompilerLimits(genome) {
  const g = { ...genome };
  if (g.riskFraction > COMPILER_LIMITS.maxRiskFraction) g.riskFraction = COMPILER_LIMITS.maxRiskFraction;
  if (g.stopLoss < COMPILER_LIMITS.minStopLoss) g.stopLoss = COMPILER_LIMITS.minStopLoss;
  if (g.takeProfit < COMPILER_LIMITS.minTakeProfit) g.takeProfit = COMPILER_LIMITS.minTakeProfit;
  if (g.minPoolAgeHours > COMPILER_LIMITS.maxMinPoolAgeHours) g.minPoolAgeHours = COMPILER_LIMITS.maxMinPoolAgeHours;
  if (g.maxPoolAgeHours > COMPILER_LIMITS.maxPoolAgeHours) g.maxPoolAgeHours = COMPILER_LIMITS.maxPoolAgeHours;
  if (g.minPoolAgeHours > g.maxPoolAgeHours) {
    const swap = g.minPoolAgeHours;
    g.minPoolAgeHours = Math.min(swap, g.maxPoolAgeHours);
    g.maxPoolAgeHours = Math.max(swap, g.maxPoolAgeHours);
  }
  g.maxHold = Math.round(g.maxHold);
  return g;
}

/** Every gene present, finite, and inside GENE_BOUNDS — or this is a bug. */
function assertCompiledGenome(genome) {
  for (const key of Object.keys(genome)) {
    if (!GENOME_KEYS.includes(key)) throw new Error(`compiler produced unknown gene ${key}`);
    const value = genome[key];
    if (!Number.isFinite(value)) throw new Error(`compiler produced non-finite gene ${key}`);
    const [lo, hi] = GENE_BOUNDS[key];
    if (value < lo || value > hi) throw new Error(`compiler produced out-of-bounds gene ${key}`);
  }
}

/**
 * A deterministic point inside `[lo, hi]`, derived purely from `salt`. Used
 * only for faithful diversification inside a range the proposal declared.
 */
export function deterministicInRange(lo, hi, salt) {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return lo;
  if (hi <= lo) return lo;
  const draw = createSeededRandom(salt)();
  return lo + (hi - lo) * draw;
}

/**
 * True when a proposal declares at least one non-degenerate numeric range — the
 * only regions we may move inside without inventing an unfaithful hypothesis.
 */
export function hasDiversifiableRange(changes = {}) {
  return Object.values(changes ?? {}).some(
    (value) => Array.isArray(value) && value.length === 2 && Number(value[0]) < Number(value[1]),
  );
}

/** Overrides for one compile attempt (attempt 0 = the declared midpoint). */
function buildOverrides(changes, { attempt = 0, salt = "" } = {}) {
  const overrides = {};
  for (const [key, value] of Object.entries(changes ?? {})) {
    if (Array.isArray(value)) {
      const [lo, hi] = value.map(Number);
      overrides[key] = attempt === 0 ? (lo + hi) / 2 : deterministicInRange(lo, hi, `${salt}:${key}:${attempt}`);
    } else {
      overrides[key] = value;
    }
  }
  return overrides;
}

/**
 * Order valid compile jobs so a small `maxCompilations` does not simply take
 * the first N proposals (which is how every compiled candidate used to end up
 * in the same one or two families). Jobs are bucketed by target family and
 * picked round-robin, preserving first-appearance order — deterministic, and
 * biased toward breadth without imposing any quota.
 */
function orderJobsForBreadth(jobs) {
  const buckets = new Map();
  for (const job of jobs) {
    const key = job.family?.name ?? "unknown";
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(job);
  }
  const lists = [...buckets.values()];
  const ordered = [];
  let round = 0;
  let added = true;
  while (added) {
    added = false;
    for (const list of lists) {
      if (round < list.length) {
        ordered.push(list[round]);
        added = true;
      }
    }
    round += 1;
  }
  return ordered;
}

/**
 * Compile validated proposals into candidate genome families.
 *
 * @param {{
 *   proposals: object[],
 *   maxCompilations?: number,
 *   now?: (() => number) | null,
 *   diversify?: boolean,
 *   maxDiversificationAttempts?: number,
 *   maxSpeciesShare?: number,   // optional anti-collapse guard (1 = off)
 *   existingDigests?: Iterable<string>,  // genomes already in the cohort
 * }} options
 * @returns {{
 *   compiled: Array<object>,
 *   rejected: Array<{ proposalId: string, reasons: string[], code: string }>,
 *   stats: object,
 * }}
 */
export function compileProposals({
  proposals,
  maxCompilations = 3,
  now = null,
  diversify = true,
  maxDiversificationAttempts = MAX_DIVERSIFICATION_ATTEMPTS,
  maxSpeciesShare = 1,
  existingDigests = [],
} = {}) {
  const list = Array.isArray(proposals) ? proposals : [];
  const capacity = Math.max(0, Math.round(maxCompilations));
  const compiled = [];
  const rejected = [];
  const seenDigests = new Map(); // genomeDigest -> familyId
  const seenFamilyIds = new Set();
  for (const digest of existingDigests ?? []) {
    if (typeof digest === "string") seenDigests.set(digest, "cohort");
  }

  const jobs = [];

  // ---- 1) Structural validation + family resolution (no capacity limit yet).
  for (const proposal of list) {
    const proposalId = typeof proposal?.proposalId === "string" ? proposal.proposalId : "unknown";
    const reasons = [];

    const changes = proposal?.changes ?? {};
    for (const [key, value] of Object.entries(changes)) {
      if (!GENOME_KEYS.includes(key)) reasons.push(`unsupported parameter: ${key}`);
      else if (Array.isArray(value)) {
        if (value.length !== 2 || value.some((v) => typeof v !== "number" || !Number.isFinite(v))) {
          reasons.push(`invalid range for ${key}`);
        }
      } else if (typeof value !== "number" || !Number.isFinite(value)) {
        reasons.push(`invalid value for ${key}`);
      }
    }

    const familyName = Array.isArray(proposal?.parentFamilies) ? proposal.parentFamilies[0] : null;
    const family = resolveFamily(familyName);
    if (!family) reasons.push(`no resolvable parent family: ${String(familyName ?? "(none)").slice(0, 40)}`);

    if (Array.isArray(proposal?.abstainRegimes) && proposal.abstainRegimes.some((r) => typeof r !== "string")) {
      reasons.push("abstainRegimes must be strings");
    }

    // Species assignment: an explicit, schema-validated targetSpecies wins (all
    // six species are reachable this way, including Experimental); otherwise
    // the family's lead parent decides, exactly as before.
    const requested = proposal?.targetSpecies ?? null;
    const species = SPECIES.includes(requested) ? requested : family?.parents?.[0] ?? null;
    if (requested && !SPECIES.includes(requested)) reasons.push(`unsupported targetSpecies: ${String(requested).slice(0, 40)}`);

    if (reasons.length > 0) {
      rejected.push({ proposalId, reasons, code: "COMPILER_REJECTED" });
      continue;
    }

    jobs.push({
      proposalId,
      family,
      species,
      authorRole: proposal.authorRole ?? null,
      targetRegimes: [...(proposal.targetRegimes ?? [])],
      abstainRegimes: [...(proposal.abstainRegimes ?? [])],
      changes,
      targetSpecies: species,
    });
  }

  // ---- 2) Compile with breadth-first ordering + uniqueness enforcement.
  const ordered = orderJobsForBreadth(jobs);
  const speciesCap = maxSpeciesShare >= 1 ? Infinity : Math.max(1, Math.ceil(capacity * Math.max(0, maxSpeciesShare)));
  const speciesCounts = new Map();
  const deferred = [];
  let duplicatesDetected = 0;
  let duplicatesRejected = 0;
  let diversified = 0;
  let concentrationWarning = false;

  const attemptJob = (job) => {
    let usedAttempt = 0;
    let entry = null;

    for (let attempt = 0; attempt <= (diversify ? maxDiversificationAttempts : 0); attempt += 1) {
      if (attempt > 0 && !hasDiversifiableRange(job.changes)) break;
      const overrides = buildOverrides(job.changes, {
        attempt,
        salt: `${job.proposalId}:${job.family.name}:${job.species ?? ""}`,
      });
      const genome = applyCompilerLimits(genomeFromFamily(job.family, Math.random, overrides, job.species));
      assertCompiledGenome(genome);

      const genomeDigest = digestOf(genome);
      if (seenDigests.has(genomeDigest)) {
        if (attempt === 0) duplicatesDetected += 1;
        continue;
      }

      const familyId = `F-${digestOf({ p: job.proposalId, f: job.family.name, g: genome }).slice(0, 10)}`;
      if (seenFamilyIds.has(familyId)) continue;
      seenFamilyIds.add(familyId);

      usedAttempt = attempt;
      entry = {
        familyId,
        proposalId: job.proposalId,
        family: job.family.name,
        species: job.species,
        targetSpecies: job.targetSpecies,
        genome,
        genomeDigest,
        authorRole: job.authorRole,
        targetRegimes: [...job.targetRegimes],
        abstainRegimes: [...job.abstainRegimes],
        compilerVersion: PROPOSAL_COMPILER_VERSION,
        compiledAt: now ? new Date(now()).toISOString() : null,
        diversified: attempt > 0,
        diversificationAttempt: attempt,
        limits: { ...COMPILER_LIMITS },
      };
      seenDigests.set(genomeDigest, familyId);
      break;
    }

    return { entry, usedAttempt };
  };

  // Pass 1: honour the optional species-share guard.
  for (const job of ordered) {
    if (compiled.length >= capacity) break;
    const count = speciesCounts.get(job.species) ?? 0;
    if (count >= speciesCap) {
      deferred.push(job);
      continue;
    }
    const { entry, usedAttempt } = attemptJob(job);
    if (!entry) {
      if (hasDiversifiableRange(job.changes)) {
        duplicatesRejected += 1;
        rejected.push({
          proposalId: job.proposalId,
          reasons: [`${DUPLICATE_GENOME}: compiled genome already present in this research cohort`],
          code: DUPLICATE_GENOME,
        });
      } else {
        duplicatesRejected += 1;
        rejected.push({
          proposalId: job.proposalId,
          reasons: [`${DUPLICATE_GENOME}: no declared parameter range to diversify faithfully inside`],
          code: DUPLICATE_GENOME,
        });
      }
      continue;
    }
    if (usedAttempt > 0) diversified += 1;
    speciesCounts.set(job.species, count + 1);
    compiled.push(entry);
  }

  // Pass 2: if the guard left unused capacity, fill it with the deferred jobs
  // rather than under-filling the cycle — but record the concentration
  // explicitly instead of pretending the cohort was diverse.
  for (const job of deferred) {
    if (compiled.length >= capacity) break;
    const { entry, usedAttempt } = attemptJob(job);
    if (!entry) {
      duplicatesRejected += 1;
      rejected.push({
        proposalId: job.proposalId,
        reasons: [`${DUPLICATE_GENOME}: compiled genome already present in this research cohort`],
        code: DUPLICATE_GENOME,
      });
      continue;
    }
    concentrationWarning = true;
    if (usedAttempt > 0) diversified += 1;
    speciesCounts.set(job.species, (speciesCounts.get(job.species) ?? 0) + 1);
    compiled.push(entry);
  }

  const speciesDistribution = {};
  for (const [species, count] of speciesCounts.entries()) speciesDistribution[species] = count;

  return {
    compiled,
    rejected,
    stats: {
      requested: list.length,
      structurallyAccepted: jobs.length,
      compiled: compiled.length,
      uniqueGenomes: compiled.length,
      duplicatesDetected,
      duplicatesRejected,
      diversified,
      speciesDistribution,
      concentrationWarning,
      maxSpeciesShare,
      maxCompilations: capacity,
      diversificationAttempts: maxDiversificationAttempts,
    },
  };
}

/** Which proposals could not compile and why (for research memory + dashboard). */
export function compilationReport({ compiled, rejected, stats = null }) {
  return {
    compilerVersion: PROPOSAL_COMPILER_VERSION,
    compiled: compiled.length,
    rejected: rejected.length,
    duplicateRejections: (rejected ?? []).filter((row) => row.code === DUPLICATE_GENOME).length,
    rejectedReasons: rejected.flatMap((row) => row.reasons.map((reason) => ({ proposalId: row.proposalId, reason }))),
    stats: stats ?? null,
    limits: { ...COMPILER_LIMITS },
  };
}

/** Re-export for tests: a compiled genome must survive the same clamp. */
export { clampToBounds };
