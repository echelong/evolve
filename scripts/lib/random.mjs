/**
 * Deterministic pseudo-random generator.
 *
 * Validation and smoke runs need reproducible populations: a failing
 * generation should be replayable. Production runs still use Math.random.
 */

/** mulberry32 — small, fast, good enough for simulation seeding. */
export function mulberry32(seed = 0x9e3779b9) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Accepts a number, a numeric string, or a text seed. */
export function createSeededRandom(seed = 1) {
  const numeric =
    typeof seed === "number" && Number.isFinite(seed)
      ? Math.floor(seed)
      : hashString(String(seed));
  return mulberry32(numeric);
}

function hashString(text) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
