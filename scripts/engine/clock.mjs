/**
 * Simulation clock.
 *
 * Everything evolutionary must be a function of *simulation* time, never of the
 * machine clock. Live trading uses wall-clock time; historical replay uses the
 * timestamps carried by the dataset. Both are handed to the engine as a plain
 * `now()` function so no other module needs to know which mode is active.
 *
 * This is what makes accelerated replay safe: pressing the speed up changes only
 * how long the process waits between snapshots, never a single decision.
 */

export const CLOCK_MODE = Object.freeze({
  WALL: "wall",
  DATASET: "dataset",
  MANUAL: "manual",
});

/** Real time. Used by live/auto/synthetic modes. */
export function createWallClock(now = () => Date.now()) {
  return {
    mode: CLOCK_MODE.WALL,
    now: () => now(),
    advancedBy: "wall-clock",
  };
}

/** Dataset time. Used by replay mode: reads the replay provider's cursor. */
export function createDatasetClock(replayFeed) {
  if (!replayFeed || typeof replayFeed.currentTimestamp !== "function") {
    throw new Error("createDatasetClock requires a replay provider with currentTimestamp()");
  }
  return {
    mode: CLOCK_MODE.DATASET,
    now: () => {
      const timestamp = replayFeed.currentTimestamp();
      return Number.isFinite(timestamp) ? timestamp : 0;
    },
    advancedBy: "dataset-snapshot",
  };
}

/**
 * Manually advanced clock. Used by fixtures, validation, and any test that needs
 * to drive time explicitly instead of waiting for it.
 */
export function createManualClock(start = 1_760_000_000_000) {
  let current = start;
  return {
    mode: CLOCK_MODE.MANUAL,
    now: () => current,
    advance: (ms) => {
      const step = Number(ms);
      current += Number.isFinite(step) ? step : 0;
      return current;
    },
    set: (value) => {
      const next = Number(value);
      if (Number.isFinite(next)) current = next;
      return current;
    },
    value: () => current,
    advancedBy: "manual",
  };
}
