/**
 * Arena-gated research promotion (Phase 5A).
 *
 * The ONLY place a research memory record may reach PROMISING, ARENA_SURVIVOR,
 * or SHADOW_ELIGIBLE. A research cycle (research/cycle.mjs) can only ever
 * leave a proposal at PROPOSED, TESTING, or REJECTED — promotion requires an
 * actual `npm run arena` result naming this exact compiled genome. There is
 * no path from "researcher says it's good" to a promoted status; the researcher
 * cannot self-promote its own output, quarantine cannot be talked away, and
 * this function never touches Arena gates, scores, or deployment logic — it
 * only reads an already-finished Arena result and relabels research memory.
 *
 * Matching is by genome digest (`digestOf`, the same function the Arena uses
 * for its own leaderboard `digest` field) — the one thing that is identical
 * whether a genome came from research compilation or anywhere else, so no
 * special-case wiring is needed inside the Arena to carry a research id
 * through the whole tournament.
 *
 * PAPER ONLY research machinery.
 */

import { digestOf } from "../lib/hash.mjs";
import {
  MEMORY_STATUS,
  appendConclusion,
  appendMemoryRecord,
  createMemoryRecord,
  listCompiledCandidates,
} from "./memory.mjs";

export const PROMOTE_VERSION = 1;

const ARENA_TO_MEMORY_STATUS = Object.freeze({
  "DEPLOYMENT CANDIDATE": MEMORY_STATUS.SHADOW_ELIGIBLE,
  "ARENA SURVIVOR": MEMORY_STATUS.ARENA_SURVIVOR,
});

/**
 * A quarantined candidate can never be promoted here, full stop — even if it
 * somehow also appears on an Arena leaderboard (e.g. a stale/duplicate
 * genome), a quarantine flag on its OWN family id blocks promotion.
 */
export function isQuarantined(memoryRecords, familyId) {
  return (memoryRecords ?? []).some(
    (record) => record.candidateFamily === familyId && record.watchdogVerdict === "QUARANTINED",
  );
}

/**
 * @param {{
 *   root: string,
 *   leaderboardRows: Array<{ digest: string, status: string|null }>,
 *   memoryRecords: object[],  // from readMemoryIndex(root) — passed in so the
 *                              // quarantine check uses the same evidence the
 *                              // caller already loaded, not a fresh read.
 *   now?: () => number,
 * }} options
 * @returns {Promise<{ promoted: Array<{familyId: string, from: string|null, to: string}>, skipped: Array<{familyId: string, reason: string}> }>}
 */
export async function promoteFromArenaLeaderboard({ root, leaderboardRows = [], memoryRecords = [], now = () => Date.now() }) {
  const compiled = await listCompiledCandidates(root);
  const byDigest = new Map();
  for (const row of leaderboardRows ?? []) {
    if (typeof row?.digest === "string") byDigest.set(row.digest, row);
  }

  const promoted = [];
  const skipped = [];

  for (const candidate of compiled) {
    const digest = digestOf(candidate.genome);
    const row = byDigest.get(digest);
    if (!row) {
      skipped.push({ familyId: candidate.familyId, reason: "not present in this Arena leaderboard" });
      continue;
    }
    if (isQuarantined(memoryRecords, candidate.familyId)) {
      skipped.push({ familyId: candidate.familyId, reason: "QUARANTINED — cannot self-clear or be promoted" });
      continue;
    }

    const target = ARENA_TO_MEMORY_STATUS[row.status] ?? MEMORY_STATUS.PROMISING;
    const conclusion = `Arena result '${row.status ?? "scored"}' (digest ${digest.slice(0, 12)}) -> ${target}`;

    const record = createMemoryRecord({
      proposalId: candidate.proposalId,
      authorRole: candidate.authorRole,
      hypothesis: "",
      candidateFamily: candidate.familyId,
      status: target,
      conclusion,
    });
    await appendMemoryRecord(root, record);
    await appendConclusion(root, {
      proposalId: candidate.proposalId,
      authorRole: candidate.authorRole,
      status: target,
      conclusion,
      at: new Date(now()).toISOString(),
    });

    promoted.push({ familyId: candidate.familyId, from: MEMORY_STATUS.TESTING, to: target });
  }

  return { promoted, skipped };
}
