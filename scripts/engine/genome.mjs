/**
 * Agent genomes and species.
 *
 * A genome is a flat bag of numbers: hard gate thresholds (which tokens an
 * agent is even allowed to consider) plus soft signal weights (how much it
 * likes each feature), plus risk/exit behaviour. Keeping it numeric-only means
 * mutation and crossover stay trivial and every gene is comparable.
 *
 * Species are *presets*, not hard classes: a child inherits a parent's species
 * label but its genome can drift across the whole gene space. Species exist to
 * keep the population behaviourally diverse instead of converging on one
 * strategy.
 *
 * These signals are evolutionary features only. Nothing here claims to predict
 * profit, and every trade that results is simulated paper accounting.
 */

export const SPECIES = [
  "Genesis Hunter",
  "Momentum",
  "Reversal",
  "Wallet Flow",
  "Liquidity",
  "Experimental",
];

/** Human-readable specialization notes, shown on the dashboard. */
export const SPECIES_ROLES = Object.freeze({
  "Genesis Hunter": "young pools · organic score · rising buyer count",
  Momentum: "5m momentum · volume expansion · buy pressure",
  Reversal: "negative momentum · surviving liquidity · improving flow",
  "Wallet Flow": "traders · organic buyers · net buyer imbalance",
  Liquidity: "deep liquidity · safe authorities · low concentration",
  Experimental: "broad mutable combinations · exploration",
});

export const MAX_POOL_AGE_UNBOUNDED = 1_000_000;

const WEIGHT_KEYS = [
  "momentumWeight",
  "flowWeight",
  "traderWeight",
  "liquidityWeight",
  "organicWeight",
  "safetyWeight",
  "ageWeight",
  "holderWeight",
  "volumeWeight",
  "trendWeight",
];

const GATE_KEYS = [
  "momentumGateEnabled",
  "momentumThreshold",
  "buyPressureThreshold",
  "entryScoreThreshold",
  "minLiquidityQuality",
  "minOrganicScore",
  "maxTopHolderPct",
  "requireConcentrationKnown",
  "minPoolAgeHours",
  "maxPoolAgeHours",
  "requireAuthoritySafe",
  "requireVerified",
];

const RISK_KEYS = ["stopLoss", "takeProfit", "maxHold", "riskFraction"];

export const GENOME_KEYS = [...WEIGHT_KEYS, ...GATE_KEYS, ...RISK_KEYS, "contrarian"];

/** Hard bounds for every gene. Mutation can never leave this box. */
export const GENE_BOUNDS = Object.freeze({
  momentumWeight: [0, 1],
  flowWeight: [0, 1],
  traderWeight: [0, 1],
  liquidityWeight: [0, 1],
  organicWeight: [0, 1],
  safetyWeight: [0, 1],
  ageWeight: [0, 1],
  holderWeight: [0, 1],
  volumeWeight: [0, 1],
  trendWeight: [0, 1],
  momentumGateEnabled: [0, 1],
  momentumThreshold: [-1, 1],
  buyPressureThreshold: [0.2, 0.95],
  entryScoreThreshold: [0.05, 0.85],
  minLiquidityQuality: [0, 0.95],
  minOrganicScore: [0, 0.95],
  maxTopHolderPct: [1, 100],
  requireConcentrationKnown: [0, 1],
  minPoolAgeHours: [0, 720],
  // Global fallback ceiling for genomes with no species-specific override
  // (see SPECIES_AGE_BOUNDS below) — generous, but finite: no genome should
  // ever be able to reach anything like MAX_POOL_AGE_UNBOUNDED's ~114 years.
  maxPoolAgeHours: [0.05, 24 * 730],
  requireAuthoritySafe: [0, 1],
  requireVerified: [0, 1],
  stopLoss: [0.01, 0.3],
  takeProfit: [0.02, 1],
  maxHold: [3, 180],
  riskFraction: [0.02, 0.5],
  contrarian: [0, 1],
});

const BINARY_GENES = new Set([
  "momentumGateEnabled",
  "requireConcentrationKnown",
  "requireAuthoritySafe",
  "requireVerified",
  "contrarian",
]);

/**
 * Per-species overrides for the pool-age genes.
 *
 * Before this fix, every species mutated min/maxPoolAgeHours against the
 * single global GENE_BOUNDS span (then [0.05, 1_000_000], ~114 years — wide
 * enough that MAX_POOL_AGE_UNBOUNDED could serve as a "no age gate" sentinel
 * value some presets set outright). Mutation jitter is proportional to that
 * span, so a Genesis Hunter genome — whose preset starts at a sane 48h —
 * could drift to something like 844,533h within a handful of generations:
 * the step size was scaled for a different species' range entirely.
 *
 * Each species now gets its own finite, niche-appropriate [min, max] box for
 * these two genes (no preset uses the unbounded sentinel as a value anymore).
 * `boundsFor` uses this box in place of GENE_BOUNDS whenever a species is
 * known, so both the mutation step size and the clamp stay inside a
 * meaningful range for that species — mutation can wander within the niche,
 * never out of it. One consequence: every species is now genuinely
 * age-aware (see the `ageAware` check in engine/simulation.mjs), since none
 * of them carries an unbounded/"don't care" age gene anymore.
 */
export const SPECIES_AGE_BOUNDS = Object.freeze({
  // Young launches only: hours to a few days old.
  "Genesis Hunter": { minPoolAgeHours: [0, 24], maxPoolAgeHours: [0.5, 96] },
  // Momentum can ride broader ages than a launch-hunter, but still finite.
  Momentum: { minPoolAgeHours: [0, 96], maxPoolAgeHours: [1, 24 * 45] },
  // Reversal looks for surviving liquidity after a move — broader still.
  Reversal: { minPoolAgeHours: [0, 168], maxPoolAgeHours: [1, 24 * 90] },
  "Wallet Flow": { minPoolAgeHours: [0, 96], maxPoolAgeHours: [1, 24 * 60] },
  // Liquidity/survivor species are explicitly fine with older, seasoned pools.
  Liquidity: { minPoolAgeHours: [0, 720], maxPoolAgeHours: [24, 24 * 270] },
  // Broad exploration, but finite and meaningful — not "effectively forever".
  Experimental: { minPoolAgeHours: [0, 336], maxPoolAgeHours: [1, 24 * 200] },
});

/** Bounds for one gene, narrowed to a species' niche when one applies. */
function boundsFor(key, species) {
  if (species && (key === "minPoolAgeHours" || key === "maxPoolAgeHours")) {
    const speciesBounds = SPECIES_AGE_BOUNDS[species];
    if (speciesBounds?.[key]) return speciesBounds[key];
  }
  return GENE_BOUNDS[key];
}

export const SPECIES_PRESETS = Object.freeze({
  "Genesis Hunter": {
    weights: { momentum: 0.1, flow: 0.16, trader: 0.16, liquidity: 0.1, organic: 0.18, safety: 0.05, age: 0.3, holder: 0, volume: 0.1, trend: 0.05 },
    gates: { momentumGateEnabled: 0, momentumThreshold: -0.1, buyPressureThreshold: 0.52, entryScoreThreshold: 0.42, minLiquidityQuality: 0.12, minOrganicScore: 0.05, maxTopHolderPct: 92, requireConcentrationKnown: 0, minPoolAgeHours: 0, maxPoolAgeHours: 48, requireAuthoritySafe: 0, requireVerified: 0 },
    risk: { stopLoss: 0.1, takeProfit: 0.3, maxHold: 26, riskFraction: 0.12 },
    contrarian: 0,
  },
  Momentum: {
    weights: { momentum: 0.34, flow: 0.18, trader: 0.1, liquidity: 0.14, organic: 0.08, safety: 0.03, age: 0.04, holder: 0.01, volume: 0.16, trend: 0.1 },
    gates: { momentumGateEnabled: 1, momentumThreshold: 0.22, buyPressureThreshold: 0.55, entryScoreThreshold: 0.46, minLiquidityQuality: 0.2, minOrganicScore: 0.08, maxTopHolderPct: 95, requireConcentrationKnown: 0, minPoolAgeHours: 0, maxPoolAgeHours: 24 * 30, requireAuthoritySafe: 0, requireVerified: 0 },
    risk: { stopLoss: 0.08, takeProfit: 0.3, maxHold: 30, riskFraction: 0.14 },
    contrarian: 0,
  },
  Reversal: {
    weights: { momentum: 0.26, flow: 0.2, trader: 0.14, liquidity: 0.12, organic: 0.1, safety: 0.05, age: 0.03, holder: 0.02, volume: 0.03, trend: 0.26 },
    gates: { momentumGateEnabled: 1, momentumThreshold: -0.18, buyPressureThreshold: 0.44, entryScoreThreshold: 0.42, minLiquidityQuality: 0.28, minOrganicScore: 0.08, maxTopHolderPct: 92, requireConcentrationKnown: 0, minPoolAgeHours: 1, maxPoolAgeHours: 24 * 45, requireAuthoritySafe: 0, requireVerified: 0 },
    risk: { stopLoss: 0.06, takeProfit: 0.22, maxHold: 24, riskFraction: 0.11 },
    contrarian: 1,
  },
  "Wallet Flow": {
    weights: { momentum: 0.06, flow: 0.34, trader: 0.34, liquidity: 0.1, organic: 0.1, safety: 0.03, age: 0.02, holder: 0.04, volume: 0.08, trend: 0.06 },
    gates: { momentumGateEnabled: 0, momentumThreshold: 0, buyPressureThreshold: 0.5, entryScoreThreshold: 0.44, minLiquidityQuality: 0.18, minOrganicScore: 0.05, maxTopHolderPct: 96, requireConcentrationKnown: 0, minPoolAgeHours: 0, maxPoolAgeHours: 24 * 30, requireAuthoritySafe: 0, requireVerified: 0 },
    risk: { stopLoss: 0.09, takeProfit: 0.26, maxHold: 28, riskFraction: 0.12 },
    contrarian: 0,
  },
  Liquidity: {
    weights: { momentum: 0.04, flow: 0.02, trader: 0.02, liquidity: 0.3, organic: 0.12, safety: 0.22, age: 0.01, holder: 0.22, volume: 0.01, trend: 0.08 },
    gates: { momentumGateEnabled: 0, momentumThreshold: -1, buyPressureThreshold: 0.4, entryScoreThreshold: 0.5, minLiquidityQuality: 0.78, minOrganicScore: 0.2, maxTopHolderPct: 45, requireConcentrationKnown: 1, minPoolAgeHours: 24, maxPoolAgeHours: 24 * 180, requireAuthoritySafe: 1, requireVerified: 0 },
    risk: { stopLoss: 0.05, takeProfit: 0.18, maxHold: 42, riskFraction: 0.08 },
    contrarian: 0,
  },
  Experimental: null,
});

/** Clamp one gene into its (species-aware) bounds. Exported for the Phase 5A
 * proposal compiler so family genomes pass through the identical clamp every
 * other genome uses. */
export function clampToBounds(key, value, species = null) {
  const [min, max] = boundsFor(key, species);
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function gaussian(random = Math.random) {
  let u = 0;
  let v = 0;
  while (!u) u = random();
  while (!v) v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Additive jitter that stays inside the gene's bounds. Jitter magnitude is
 * proportional to the *span of those bounds* — pass `species` for genes with
 * a species-specific box (see SPECIES_AGE_BOUNDS) so the step size matches
 * that species' niche instead of the (much wider) global range.
 */
export function mutateValue(key, value, scale, random = Math.random, species = null) {
  const [min, max] = boundsFor(key, species);
  const span = max - min;
  const next = clampToBounds(key, value + gaussian(random) * scale * span, species);
  return next;
}

function presetGenome(species, random) {
  const preset = SPECIES_PRESETS[species];

  if (!preset) {
    // Experimental: a broad random draw across the whole gene space, but the
    // age gene still draws from Experimental's own finite bounds rather than
    // the sentinel "unbounded" value.
    const ageBounds = SPECIES_AGE_BOUNDS.Experimental;
    const genome = {};
    for (const key of WEIGHT_KEYS) genome[key] = clampToBounds(key, 0.05 + random() * 0.5);
    genome.momentumGateEnabled = random() < 0.5 ? 1 : 0;
    genome.momentumThreshold = (random() * 2 - 1) * 0.4;
    genome.buyPressureThreshold = 0.35 + random() * 0.45;
    genome.entryScoreThreshold = 0.3 + random() * 0.35;
    genome.minLiquidityQuality = random() * 0.6;
    genome.minOrganicScore = random() * 0.5;
    genome.maxTopHolderPct = 40 + random() * 55;
    genome.requireConcentrationKnown = random() < 0.3 ? 1 : 0;
    genome.minPoolAgeHours = ageBounds.minPoolAgeHours[0] + random() * (ageBounds.minPoolAgeHours[1] - ageBounds.minPoolAgeHours[0]);
    genome.maxPoolAgeHours = ageBounds.maxPoolAgeHours[0] + random() * (ageBounds.maxPoolAgeHours[1] - ageBounds.maxPoolAgeHours[0]);
    genome.requireAuthoritySafe = random() < 0.3 ? 1 : 0;
    genome.requireVerified = random() < 0.2 ? 1 : 0;
    genome.stopLoss = 0.04 + random() * 0.14;
    genome.takeProfit = 0.08 + random() * 0.4;
    genome.maxHold = Math.round(6 + random() * 54);
    genome.riskFraction = 0.04 + random() * 0.18;
    genome.contrarian = random() < 0.35 ? 1 : 0;
    return genome;
  }

  const genome = {};
  for (const key of WEIGHT_KEYS) {
    const base = preset.weights[key.replace("Weight", "")] ?? 0.05;
    genome[key] = clampToBounds(key, Math.max(0.01, base + gaussian(random) * 0.04));
  }
  for (const key of GATE_KEYS) {
    const base = preset.gates[key];
    if (BINARY_GENES.has(key)) {
      genome[key] = random() < 0.12 ? 1 - base : base;
    } else if (key === "momentumThreshold") {
      genome[key] = clampToBounds(key, base + gaussian(random) * 0.08);
    } else {
      genome[key] = mutateValue(key, base, 0.08, random, species);
    }
  }
  for (const key of RISK_KEYS) {
    genome[key] = mutateValue(key, preset.risk[key], 0.12, random, species);
  }
  genome.maxHold = Math.round(genome.maxHold);
  genome.contrarian = random() < 0.05 ? 1 - preset.contrarian : preset.contrarian;
  return genome;
}

/** A fresh genome for a species, jittered around the species preset. */
export function randomGenome(species = SPECIES[0], random = Math.random) {
  return presetGenome(species, random);
}

/** Mutate a genome in place-free fashion. `scale` is the fraction of gene span. */
export function mutateGenome(parent, { scale = 0.06, random = Math.random, species = null } = {}) {
  const genome = { ...parent };

  for (const key of WEIGHT_KEYS) {
    genome[key] = mutateValue(key, parent[key], scale * 1.4, random, species);
  }

  for (const key of GATE_KEYS) {
    if (BINARY_GENES.has(key)) {
      genome[key] = random() < scale * 0.6 ? 1 - parent[key] : parent[key];
    } else {
      // Species-aware: min/maxPoolAgeHours mutate against that species' own
      // finite age box (SPECIES_AGE_BOUNDS), not the global ~114-year span,
      // so a Genesis Hunter genome cannot drift into a Liquidity-sized range.
      genome[key] = mutateValue(key, parent[key], scale, random, species);
    }
  }

  for (const key of RISK_KEYS) {
    genome[key] = mutateValue(key, parent[key], scale * 1.6, random, species);
  }

  // Keep the age band coherent: min must stay below max.
  if (genome.minPoolAgeHours > genome.maxPoolAgeHours) {
    const swap = genome.minPoolAgeHours;
    genome.minPoolAgeHours = Math.min(swap, genome.maxPoolAgeHours);
    genome.maxPoolAgeHours = Math.max(swap, genome.maxPoolAgeHours);
  }

  genome.maxHold = Math.round(genome.maxHold);

  if (species && SPECIES_PRESETS[species]) {
    // Light pull toward the species preset keeps species meaningfully distinct.
    const preset = SPECIES_PRESETS[species];
    for (const key of WEIGHT_KEYS) {
      const base = preset.weights[key.replace("Weight", "")];
      if (base === undefined) continue;
      genome[key] = clampToBounds(key, genome[key] * 0.9 + base * 0.1);
    }
  }

  return genome;
}

/** Uniform crossover, then a small mutation so children are never clones. */
export function crossoverGenomes(a, b, { random = Math.random, species = null } = {}) {
  const genome = {};
  const keys = new Set([...GENOME_KEYS, ...Object.keys(a), ...Object.keys(b)]);

  for (const key of keys) {
    if (!(key in GENE_BOUNDS)) {
      genome[key] = random() < 0.5 ? a[key] : b[key];
      continue;
    }
    const pick = random() < 0.5 ? a[key] : b[key];
    genome[key] = BINARY_GENES.has(key) ? (pick === 1 ? 1 : 0) : pick;
  }

  return mutateGenome(genome, { scale: 0.05, random, species });
}

/** Serialize a genome for the dashboard without leaking anything internal. */
export function genomeSummary(genome) {
  const out = {};
  for (const key of GENOME_KEYS) {
    const value = genome?.[key];
    out[key] = Number.isFinite(value) ? Number(value.toFixed(3)) : 0;
  }
  return out;
}
