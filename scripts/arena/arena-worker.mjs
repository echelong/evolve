/**
 * Arena worker thread.
 *
 * One unit of work = one candidate genome evaluated across the datasets,
 * seeds, and stress profiles given in the task. Results are deterministic per
 * task (independent seeded replay stages), so worker count cannot change the
 * outcome — this is asserted by the Phase 4 validation suite.
 *
 * PAPER ONLY: uses the same replay feed and simulated fill engine as the
 * inline evaluator. No network access happens in a worker.
 */

import { parentPort } from "node:worker_threads";

import { evaluateCandidateOnDataset } from "./evaluator.mjs";

parentPort?.on("message", async (message) => {
  if (message?.type !== "start" || !message.task) return;
  const { task, index } = message;

  try {
    const oosRuns = [];
    const stressRuns = [];

    for (const dataset of task.datasets) {
      const evaluation = await evaluateCandidateOnDataset({
        candidate: task.candidate,
        datasetDir: dataset.dir,
        config: task.config,
        seeds: task.seeds,
        stressProfiles: task.stressProfiles,
        maxWindows: dataset.maxWindows ?? null,
        cacheDir: task.cacheDir ?? null,
        useCache: task.useCache !== false,
      });
      oosRuns.push(...evaluation.oosRuns);
      stressRuns.push(...evaluation.stressRuns);
    }

    parentPort.postMessage({ type: "result", index, value: { oosRuns, stressRuns } });
  } catch (error) {
    parentPort.postMessage({
      type: "error",
      index,
      error: error?.message ?? String(error),
    });
  }
});
