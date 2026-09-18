/**
 * Arena-gated research promotion (Phase 5A / 5A.2).
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
 * Matching is by genome digest (`digestOf`, the same value the Arena uses for
 * its own leaderboard `digest` field).
 *
 * Phase 5A.2: promotion reads the Arena's EXPLICIT stage/gate information
 * (`gateStatus`, `deploymentGateStatus`, `deploymentEligible`, `highestStage`,
 * `finalRank`) instead of pattern-matching a human-readable status sentence.
 * The legacy `status` string is still honoured as a fallback so an older
 * leaderboard (or a hand-written test row) keeps working.
 *
 * PAPER ONLY research machinery.
 */

import { digestOf } from "../lib/hash.mjs";
import { GATE_STATUS } from "../arena/orchestrator.mjs";
import {
  MEMORY_OUTCOME,
  MEMORY_STATUS,
  appendConclusion,
  appendMemoryRecord,
  createMemoryRecord,
  listCompiledCandidates,
} from "./memory.mjs";

export const PROMOTE_VERSION = 2;

/** Legacy mapping, used only when a leaderboard row carries no explicit gate info. */
const ARENA_TO_MEMORY_STATUS = Object.freeze({
  "DEPLOYMENT CANDIDATE": MEMORY_STATUS.SHADOW_ELIGIBLE,
  "ARENA SURVIVOR": MEMORY_STATUS.ARENA_SURVIVOR,
});

/**
 * Decide the memory status a leaderboard row justifies, from explicit gate
 * information first and the legacy status string only as a fallback.
 */
export function memoryStatusForArenaRow(row) {
  const gateStatus = row?.deploymentGateStatus ?? row?.gateStatus ?? null;

  if (gateStatus === GATE_STATUS.GATES_PASSED) {
    return {
      status: row?.deploymentEligible === true ? MEMORY_STATUS.SHADOW_ELIGIBLE : MEMORY_STATUS.ARENA_SURVIVOR,
      basis: "explicit gate status",
    };
  }
  if (gateStatus === GATE_STATUS.GATES_FAILED || gateStatus === GATE_STATUS.INSUFFICIENT_EVIDENCE) {
    // Arena-evaluated, but not gate-qualified: PROMISING at most, and never a
    // deployment/shadow status.
    return { status: MEMORY_STATUS.PROMISING, basis: "explicit gate status" };
  }
  if (typeof row?.status === "string" && ARENA_TO_MEMORY_STATUS[row.status]) {
    return { status: ARENA_TO_MEMORY_STATUS[row.status], basis: "legacy status string fallback" };
  }
  return { status: MEMORY_STATUS.PROMISING, basis: "Arena-evaluated, no gate information" };
}

/** Lifecycle outcome recorded alongside the coarse memory status. */
function outcomeForStatus(status) {
  if (status === MEMORY_STATUS.SHADOW_ELIGIBLE) return MEMORY_OUTCOME.SHADOW_ELIGIBLE;
  if (status === MEMORY_STATUS.ARENA_SURVIVOR) return MEMORY_OUTCOME.ARENA_SURVIVOR;
  return MEMORY_OUTCOME.ARENA_EVALUATED;
}

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
 *   leaderboardRows: Array<object>,
 *   memoryRecords: object[],  // from readMemoryIndex(root) — passed in so the
 *                              // quarantine check uses the same evidence the
 *                              // caller already loaded, not a fresh read.
 *   now?: () => number,
 * }} options
 * @returns {Promise<{ promoted: Array<{familyId: string, from: string|null, to: string, basis: string}>, skipped: Array<{familyId: string, reason: string}> }>}
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

    const { status: target, basis } = memoryStatusForArenaRow(row);
    // Never let a quarantine-adjacent status slip through the explicit path.
    if (isQuarantined(memoryRecords, candidate.familyId) && target !== MEMORY_STATUS.PROMISING) {
      skipped.push({ familyId: candidate.familyId, reason: "QUARANTINED — deployment/shadow status refused" });
      continue;
    }
    const stageText = Number.isFinite(row.finalRank)
      ? `rank ${row.finalRank}${row.highestStage ? `, reached ${row.highestStage}` : ""}`
      : "unranked";
    const conclusion = `Arena result ${row.gateStatus ?? row.status ?? "(unknown)"} (${stageText}, digest ${digest.slice(0, 12)}) -> ${target} [${basis}]`;

    const record = createMemoryRecord({
      proposalId: candidate.proposalId,
      authorRole: candidate.authorRole,
      hypothesis: "",
      candidateFamily: candidate.familyId,
      status: target,
      outcome: outcomeForStatus(target),
      conclusion,
    });
    await appendMemoryRecord(root, record);
    await appendConclusion(root, {
      proposalId: candidate.proposalId,
      authorRole: candidate.authorRole,
      status: target,
      outcome: outcomeForStatus(target),
      conclusion,
      at: new Date(now()).toISOString(),
    });

    promoted.push({ familyId: candidate.familyId, from: MEMORY_STATUS.TESTING, to: target, basis });
  }

  return { promoted, skipped };
}
