/**
 * Strategy islands (Phase 5A).
 *
 * An "island" is a semi-isolated sub-population that breeds primarily from its
 * own members. Phase 5A uses the existing EVOLVE species as islands directly
 * (Genesis Hunter, Momentum, Reversal, Wallet Flow, Liquidity, Experimental) —
 * an island is not a new taxonomy, it is the species label used as a breeding
 * boundary instead of just a dashboard grouping.
 *
 * Everything here is pure and deterministic: same inputs -> same outputs, no
 * randomness, no I/O. `simulation.mjs` owns the one place random() is called
 * (parent selection, mutation) so a run stays reproducible for a given seed.
 *
 * PAPER ONLY research machinery.
 */

/**
 * Split `populationSize` across `islandNames` as evenly as possible, honoring
 * any explicit per-island targets first (clamped so they never individually
 * exceed the total, and never let the total run over/under `populationSize`).
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
 * Deficit-proportional birth allocation. Islands above their target
 * contribute nothing (their deficit floors at 0); islands below target split
 * `birthsNeeded` proportional to how far under target they are, exact sum via
 * largest remainder. Deliberately soft: an island far under target does not
 * necessarily get its *entire* deficit filled in one generation if total
 * demand exceeds supply — this damps one-generation whiplash while still
 * moving toward the target every generation.
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
 * Pick a different island than `exclude` from `islandNames`, using `random()`
 * for the choice. Deterministic given a deterministic `random`. Returns null
 * only when no other island exists.
 */
export function pickOtherIsland(islandNames, exclude, random = Math.random) {
  const candidates = islandNames.filter((name) => name !== exclude);
  if (candidates.length === 0) return null;
  return candidates[Math.floor(random() * candidates.length)];
}
