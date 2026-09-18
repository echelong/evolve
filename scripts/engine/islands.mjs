/**
 * Strategy islands (Phase 5A / Phase 5A.1).
 *
 * An "island" is a semi-isolated sub-population that breeds primarily from its
 * own members. Phase 5A uses the existing EVOLVE species as islands directly
 * (Genesis Hunter, Momentum, Reversal, Wallet Flow, Liquidity, Experimental) —
 * an island is not a new taxonomy, it is the species label used as a breeding
 * boundary instead of just a dashboard grouping.
 *
 * Phase 5A hard-coded each island to an equal 1/N quota: births were allocated
 * against a fixed even target every generation, so every island snapped back to
 * exactly populationSize/N no matter how different the evidence was. Phase 5A.1
 * replaces that with **soft diversity-protected islands**:
 *
 *   evidence-adjusted reproductive weight (per island)
 *     -> desired share
 *     -> bounded per-generation movement (`maxShareDelta`, so no single lucky
 *        generation can hand one island the population)
 *     -> soft target clamped into [diversity floor, monoculture cap]
 *     -> birth allocation that fills the floor first, then moves every island
 *        toward its soft target, then fills any residue by weight
 *
 * The one hard invariant is global: `sum(island populations) == populationSize`.
 * Individual islands may grow and shrink substantially, a weak island can be
 * driven down to the floor, and only a config with `minShare = 0` lets an
 * island actually reach zero (after which the existing revival rule applies).
 *
 * Everything here is pure and deterministic: same inputs -> same outputs, no
 * randomness, no I/O. `simulation.mjs` owns the one place random() is called
 * (parent selection, mutation) so a run stays reproducible for a given seed.
 *
 * PAPER ONLY research machinery.
 */

/**
 * Defaults for the soft diversity policy. `minShare`/`maxShare` are fractions
 * of the whole population; `maxShareDelta` bounds how far one island's share
 * may move in a single generation; `advantageStrength` scales how much an
 * evidence-backed fitness advantage can shift an island's reproductive weight.
 */
export const ISLAND_DIVERSITY_DEFAULTS = Object.freeze({
  minShare: 0.08,
  maxShare: 0.3,
  maxShareDelta: 0.06,
  advantageStrength: 0.75,
  fitnessScale: 8,
  minWeight: 0.05,
  baseWeight: 1,
});

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function finiteOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Split `populationSize` across `islandNames` as evenly as possible, honoring
 * any explicit per-island targets first (clamped so they never individually
 * exceed the total, and never let the total run over/under `populationSize`).
 *
 * Phase 5A.1: this is the **initialization / base** split. It is what
 * `seedPopulation` starts from and what `EVOLVE_ISLAND_TARGETS` expresses a
 * preference through; it is no longer a hard per-generation quota — see
 * `islandSoftTargets` / `allocateIslandBirths` below.
 * The largest-remainder method keeps the split exact: the returned counts
 * always sum to exactly `populationSize`, for any population size and any
 * number of islands (including population sizes smaller than the island
 * count, where some islands legitimately get 0).
 *
 * @param {number} populationSize
 * @param {string[]} islandNames
 * @param {Record<string, number>} [explicitTargets]
 * @returns {Record<string, number>}
 */
export function islandTargetCounts(populationSize, islandNames, explicitTargets = {}) {
  const total = Math.max(0, Math.round(Number(populationSize) || 0));
  const names = Array.isArray(islandNames) && islandNames.length > 0 ? [...islandNames] : ["default"];

  if (total === 0) return Object.fromEntries(names.map((name) => [name, 0]));

  // Explicit targets are a *weight*, not a literal reservation: an unset
  // island gets the same weight an island would get under a plain even split
  // ("no targets given" is the total/names.length baseline), so an operator
  // who only pins one or two islands still gets a sane, proportional split
  // for the rest — and the final counts always sum to exactly `total` no
  // matter what the explicit weights add up to.
  const evenShare = total / names.length;
  const weights = {};
  for (const name of names) {
    const explicit = explicitTargets?.[name];
    weights[name] = Number.isFinite(explicit) && explicit > 0 ? explicit : evenShare;
  }

  return largestRemainderAllocation(weights, total);
}

/**
 * Largest-remainder apportionment: distribute `total` whole units across
 * `weights` (a map of name -> non-negative weight) proportionally, with the
 * exact sum guaranteed to equal `total`. A name with weight 0 can still
 * receive 0 or (if remainder order demands it) end up with a unit if every
 * other name is already exactly satisfied — never negative, always integer.
 */
export function largestRemainderAllocation(weights, total) {
  const names = Object.keys(weights);
  const clamped = names.map((name) => Math.max(0, Number(weights[name]) || 0));
  const weightSum = clamped.reduce((a, b) => a + b, 0);
  const targetTotal = Math.max(0, Math.round(Number(total) || 0));

  const out = {};
  if (names.length === 0) return out;
  if (weightSum <= 0 || targetTotal === 0) {
    for (const name of names) out[name] = 0;
    return out;
  }

  const raw = names.map((name, i) => (clamped[i] / weightSum) * targetTotal);
  const floors = raw.map((v) => Math.floor(v));
  let assigned = floors.reduce((a, b) => a + b, 0);
  const remainders = names
    .map((name, i) => ({ name, remainder: raw[i] - floors[i], index: i }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);

  const result = names.map((name, i) => floors[i]);
  let cursor = 0;
  while (assigned < targetTotal && remainders.length > 0) {
    const pick = remainders[cursor % remainders.length];
    result[pick.index] += 1;
    assigned += 1;
    cursor += 1;
  }

  names.forEach((name, i) => {
    out[name] = result[i];
  });
  return out;
}

/**
 * Deficit-proportional birth allocation against a *fixed* target. Phase 5A.1
 * no longer uses this in the live loop — that fixed-target behaviour is exactly
 * the hard-equal-quota model that kept every island pinned at populationSize/N.
 * It is retained, and still exported, as the plain building block the tests and
 * the initialization path exercise.
 *
 * @param {Record<string, number>} deficits island -> (target - currentCount), may be negative
 * @param {number} birthsNeeded
 * @returns {Record<string, number>}
 */
export function allocateBirths(deficits, birthsNeeded) {
  const positive = {};
  for (const [name, value] of Object.entries(deficits ?? {})) {
    positive[name] = Math.max(0, Number(value) || 0);
  }
  const positiveSum = Object.values(positive).reduce((a, b) => a + b, 0);
  const need = Math.max(0, Math.round(Number(birthsNeeded) || 0));

  if (positiveSum <= 0) {
    // No island is under target (can happen right after a rebalance): fall
    // back to an even split so births still land somewhere deterministic.
    const names = Object.keys(deficits ?? {});
    const evenWeights = Object.fromEntries(names.map((name) => [name, 1]));
    return largestRemainderAllocation(evenWeights, need);
  }

  return largestRemainderAllocation(positive, need);
}

/**
 * Resolve the soft diversity policy (floor + cap + per-generation movement)
 * for a population size and island list.
 *
 * The floor is clamped to `floor(populationSize / islandCount)` so the floors
 * can never demand more agents than the population holds, and the cap is
 * clamped up to `ceil(populationSize / islandCount)` so the caps can always
 * hold the whole population (otherwise the exact-total invariant would be
 * unsatisfiable). A `minShare` of 0 disables the floor entirely, which is how
 * an operator opts back into the pre-5A.1 "an island may go extinct" path.
 *
 * @param {number} populationSize
 * @param {string[]} islandNames
 * @param {{ minShare?: number, maxShare?: number, maxShareDelta?: number }} [options]
 * @returns {{ populationSize: number, islands: number, minShare: number, maxShare: number, maxShareDelta: number, floor: number, cap: number }}
 */
export function islandDiversityPolicy(populationSize, islandNames, options = {}) {
  const total = Math.max(0, Math.round(finiteOr(populationSize, 0)));
  const names = Array.isArray(islandNames) && islandNames.length > 0 ? [...islandNames] : ["default"];
  const count = names.length;

  const minShare = clamp01(finiteOr(options.minShare, ISLAND_DIVERSITY_DEFAULTS.minShare));
  const maxShare = Math.max(
    minShare,
    clamp01(finiteOr(options.maxShare, ISLAND_DIVERSITY_DEFAULTS.maxShare)),
  );
  const maxShareDelta = Math.max(
    0,
    Math.min(1, finiteOr(options.maxShareDelta, ISLAND_DIVERSITY_DEFAULTS.maxShareDelta)),
  );

  if (total === 0) {
    return { populationSize: 0, islands: count, minShare, maxShare, maxShareDelta, floor: 0, cap: 0 };
  }

  const fairShare = total / count;
  const cap = Math.max(Math.ceil(fairShare), Math.round(total * maxShare));
  const floor = Math.min(Math.floor(fairShare), Math.round(total * minShare));

  return { populationSize: total, islands: count, minShare, maxShare, maxShareDelta, floor: Math.max(0, floor), cap };
}

/**
 * Evidence-adjusted reproductive weight for one island.
 *
 * The fitness term is damped by how much of the island's surviving population
 * actually has sufficient evidence this generation (`evidenceSufficientCount /
 * population`). An island whose advantage rests on one lucky, barely-evidenced
 * agent therefore gets almost no extra reproductive weight: it cannot buy a
 * larger share of the next generation with a single fluke. A failing but
 * well-evidenced island still shrinks — the floor is the only thing protecting
 * it, not the weight.
 *
 * @param {{ population?: number, trades?: number, meanFitness?: number, medianFitness?: number, evidenceSufficientCount?: number }} stats
 * @param {{ baseWeight?: number, advantageStrength?: number, fitnessScale?: number, minWeight?: number }} [options]
 * @returns {number}
 */
export function islandEvidenceWeight(stats = {}, options = {}) {
  const base = Math.max(
    0,
    finiteOr(options.baseWeight, ISLAND_DIVERSITY_DEFAULTS.baseWeight),
  );
  const advantageStrength = Math.max(
    0,
    finiteOr(options.advantageStrength, ISLAND_DIVERSITY_DEFAULTS.advantageStrength),
  );
  const fitnessScale = Math.max(
    1e-6,
    Math.abs(finiteOr(options.fitnessScale, ISLAND_DIVERSITY_DEFAULTS.fitnessScale)),
  );
  const minWeight = Math.max(0, finiteOr(options.minWeight, ISLAND_DIVERSITY_DEFAULTS.minWeight));

  const population = Math.max(0, finiteOr(stats.population, 0));
  if (population <= 0) return Math.max(base, minWeight);

  const evidenceRatio = clamp01(finiteOr(stats.evidenceSufficientCount, 0) / population);
  const fitness = finiteOr(stats.medianFitness, finiteOr(stats.meanFitness, 0));
  const normalized = Math.tanh(fitness / fitnessScale);
  const adjusted = base * (1 + advantageStrength * normalized * evidenceRatio);

  return Math.max(minWeight, finiteOr(adjusted, base));
}

/**
 * Compute every island's evidence-adjusted reproductive weight. `baseWeights`
 * lets an explicit `EVOLVE_ISLAND_TARGETS` preference act as the pre-evidence
 * baseline instead of a uniform one.
 *
 * @param {Record<string, object>} islandStats island name -> stats
 * @param {{ baseWeights?: Record<string, number>, advantageStrength?: number, fitnessScale?: number, minWeight?: number, baseWeight?: number }} [options]
 * @returns {Record<string, number>}
 */
export function islandReproductiveWeights(islandStats = {}, options = {}) {
  const baseWeights = options.baseWeights ?? {};
  const weights = {};
  for (const [name, stats] of Object.entries(islandStats ?? {})) {
    const baseWeight = finiteOr(baseWeights[name], ISLAND_DIVERSITY_DEFAULTS.baseWeight);
    weights[name] = islandEvidenceWeight(stats, { ...options, baseWeight });
  }
  return weights;
}

/**
 * Soft (evidence-adjusted, inertia-bounded) targets: where each island should
 * sit *at the end of* this generation, given where it started and how well it
 * performed.
 *
 * `desired_i` is the island's evidence-adjusted share of the whole population.
 * The target is `start_i` moved toward `desired_i` by at most
 * `maxShareDelta * total` — the anti-takeover bound — then clamped into
 * [floor, cap]. That combination is what lets an island gain or lose real share
 * over a few generations while making it impossible for one lucky generation to
 * hand the population to a single island.
 *
 * `startCounts` is the island population *at the start of the generation (before
 * culling)*, and `total` is the population those shares are measured against
 * (the configured population size) — not the much smaller interim survivor
 * count, which would wash the evidence signal out.
 *
 * Targets are advisory: `allocateIslandBirths` always returns births summing
 * exactly to the requested budget.
 *
 * @param {{ startCounts: Record<string, number>, weights: Record<string, number>, total?: number, floor?: number, cap?: number, maxShareDelta?: number }} options
 * @returns {Record<string, number>}
 */
export function islandSoftTargets({
  startCounts = {},
  weights = {},
  total = null,
  floor = 0,
  cap = Infinity,
  maxShareDelta = ISLAND_DIVERSITY_DEFAULTS.maxShareDelta,
} = {}) {
  const names = Object.keys(startCounts ?? {});
  const startSum = names.reduce((sum, name) => sum + Math.max(0, Math.round(finiteOr(startCounts[name], 0))), 0);
  const basis = Math.max(1, Math.max(startSum, Math.round(finiteOr(total, 0))));
  const weightSum = names.reduce((sum, name) => sum + Math.max(0, finiteOr(weights[name], 0)), 0);
  const step = Math.max(0, Math.round(basis * clamp01(finiteOr(maxShareDelta, 0))));
  const lowBound = Math.max(0, finiteOr(floor, 0));
  const highBound = Math.max(lowBound, finiteOr(cap, basis));

  const targets = {};
  for (const name of names) {
    const start = Math.max(0, Math.round(finiteOr(startCounts[name], 0)));
    const weight = Math.max(0, finiteOr(weights[name], 0));
    const desired = weightSum > 0 ? (weight / weightSum) * basis : basis / Math.max(1, names.length);
    const moved = Math.min(step, Math.max(-step, Math.round(desired) - start));
    targets[name] = Math.min(highBound, Math.max(lowBound, start + moved));
  }
  return targets;
}

/**
 * Soft-diversity birth allocation. Returns whole births per island summing
 * exactly to `birthsNeeded` (given enough cap headroom — and `cap` is always
 * large enough to hold the whole population), in three passes:
 *
 *   1. diversity floor  — islands below `floor` are filled first, so no island
 *      is starved out of existence while births are available;
 *   2. soft targets     — remaining births move each island toward its
 *      evidence-adjusted target, never past its cap;
 *   3. weighted residue — anything still unallocated follows the reproductive
 *      weight, and a final deterministic pass guarantees the exact total even
 *      in a pathological "every island already over cap" configuration.
 *
 * @param {{ counts?: Record<string, number>, targets?: Record<string, number>, weights?: Record<string, number>, birthsNeeded?: number, floor?: number, cap?: number }} options
 * @returns {Record<string, number>}
 */
export function allocateIslandBirths({
  counts = {},
  targets = {},
  weights = {},
  birthsNeeded = 0,
  floor = 0,
  cap = Infinity,
} = {}) {
  const names = Object.keys(counts ?? {});
  const out = Object.fromEntries(names.map((name) => [name, 0]));
  const need = Math.max(0, Math.round(finiteOr(birthsNeeded, 0)));
  if (names.length === 0 || need === 0) return out;

  const ceiling = Math.max(0, finiteOr(cap, 0));
  const currentCount = (name) => Math.max(0, Math.round(finiteOr(counts[name], 0)));
  const remainingCapacity = (name) => Math.max(0, Math.floor(ceiling - currentCount(name) - out[name]));

  let remaining = need;

  // 1. Diversity floor.
  const floorDemand = {};
  let floorSum = 0;
  for (const name of names) {
    const bounded = Math.min(
      Math.max(0, Math.round(finiteOr(floor, 0)) - currentCount(name)),
      remainingCapacity(name),
    );
    floorDemand[name] = bounded;
    floorSum += bounded;
  }
  if (floorSum > 0) {
    const granted = floorSum <= remaining ? floorDemand : largestRemainderAllocation(floorDemand, remaining);
    for (const name of names) {
      const add = Math.min(granted[name] ?? 0, remainingCapacity(name));
      out[name] += add;
      remaining -= add;
    }
  }

  // 2. Move toward each island's evidence-adjusted soft target.
  if (remaining > 0) {
    const softDemand = {};
    let softSum = 0;
    for (const name of names) {
      const target = Math.min(
        ceiling,
        Math.max(Math.max(0, finiteOr(floor, 0)), Math.round(finiteOr(targets[name], currentCount(name)))),
      );
      const bounded = Math.min(Math.max(0, target - currentCount(name) - out[name]), remainingCapacity(name));
      softDemand[name] = bounded;
      softSum += bounded;
    }
    if (softSum > 0) {
      const granted = softSum <= remaining ? softDemand : largestRemainderAllocation(softDemand, remaining);
      for (const name of names) {
        const add = Math.min(granted[name] ?? 0, remainingCapacity(name));
        out[name] += add;
        remaining -= add;
      }
    }
  }

  // 3. Weighted residue, respecting remaining cap headroom. A cap can only be
  // exceeded here if a previous generation left every island with no headroom,
  // which is guarded by the exact-total pass below.
  let guard = 0;
  while (remaining > 0 && guard < 64) {
    guard += 1;
    const headroom = names.filter((name) => remainingCapacity(name) > 0);
    if (headroom.length === 0) break;
    const proposed = largestRemainderAllocation(
      Object.fromEntries(headroom.map((name) => [name, Math.max(1e-6, finiteOr(weights[name], 0))])),
      remaining,
    );
    let moved = 0;
    for (const name of headroom) {
      const add = Math.min(proposed[name] ?? 0, remainingCapacity(name));
      out[name] += add;
      moved += add;
    }
    if (moved === 0) {
      const pick = headroom.sort(
        (a, b) => finiteOr(weights[b], 0) - finiteOr(weights[a], 0) || a.localeCompare(b),
      )[0];
      out[pick] += 1;
      moved = 1;
    }
    remaining -= moved;
  }

  // Exact-total guarantee: the population invariant outranks the cap.
  if (remaining > 0) {
    const fill = largestRemainderAllocation(
      Object.fromEntries(names.map((name) => [name, Math.max(1e-6, finiteOr(weights[name], 0))])),
      remaining,
    );
    for (const name of names) out[name] += fill[name] ?? 0;
  }

  return out;
}

/**
 * Pick a different island than `exclude` from `islandNames`, using `random()`
 * for the choice. Deterministic given a deterministic `random`. Returns null
 * only when no other island exists.
 */
export function pickOtherIsland(islandNames, exclude, random = Math.random) {
  const candidates = islandNames.filter((name) => name !== exclude);
  if (candidates.length === 0) return null;
  return candidates[Math.floor(random() * candidates.length)];
}
