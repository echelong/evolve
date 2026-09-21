/**
 * EVOLVE Phase 5I-PS.1 — captured paper-shadow SOURCE loading + integrity.
 *
 * The analyzer reads exactly three files of ONE explicitly named session:
 *
 *   .evolve/jev-paper-shadow/<session-id>/session.json
 *   .evolve/jev-paper-shadow/<session-id>/summary.json
 *   .evolve/jev-paper-shadow/<session-id>/events.ndjson
 *
 * It is STRICT where the live runner is tolerant: a malformed NDJSON line is a
 * hard integrity failure here (never silently skipped), because a forensic
 * instrument may not analyze a source it cannot fully parse.
 *
 * Nothing is ever rewritten, repaired, normalized, or "fixed". Source digests
 * are computed from the exact bytes and persisted in the forensic manifest.
 *
 * PAPER ONLY / READ-ONLY.
 */

import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { digestOf, sha256Hex } from "../../lib/hash.mjs";
import { isSensitiveKey, sanitizeForPublic } from "../../lib/sanitize.mjs";
import {
  PAPER_SHADOW_EVENTS_FILE,
  PAPER_SHADOW_PURPOSE,
  PAPER_SHADOW_SESSION_FILE,
  PAPER_SHADOW_SUMMARY_FILE,
  isPathWithin,
} from "../paper-shadow/definition.mjs";
import {
  PAPER_FORENSICS_EXPECTED_UPSTREAM,
  PAPER_FORENSICS_SOURCE_FILES,
  PAPER_FORENSICS_SOURCE_ROOT_DIR,
  PAPER_FORENSICS_TOLERANCE,
  isValidPaperShadowSourceSessionId,
  roundTo,
} from "./definition.mjs";

export const PAPER_FORENSICS_SOURCE_VERSION = 1;

/** Credential-shaped content patterns. Bounded, structural, never a secret value. */
const SECRET_PATTERNS = Object.freeze([
  { label: "api-key", re: /\b(sk|pk)-[A-Za-z0-9]{16,}/ },
  { label: "bearer-token", re: /bearer\s+[A-Za-z0-9._-]{16,}/i },
  { label: "env-assignment", re: /\b[A-Z0-9_]{3,}_(KEY|TOKEN|SECRET)\s*=/ },
  { label: "solana-secret-key-array", re: /\[\s*\d{1,3}(\s*,\s*\d{1,3}){31,}\s*\]/ },
  { label: "private-key-block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
]);

/** Resolve the source session root. Refuses anything that escapes the source tree. */
export function resolveSourceSessionRoot({ sessionId, sourceRoot = null } = {}) {
  const base = path.resolve(sourceRoot ?? PAPER_FORENSICS_SOURCE_ROOT_DIR);
  if (!isValidPaperShadowSourceSessionId(sessionId)) {
    throw new Error(
      `invalid paper-shadow session id '${sessionId}'; session ids look like 'jpaper-<UTC timestamp>-<digest>'`,
    );
  }
  const root = path.join(base, sessionId);
  if (!isPathWithin(root, base)) {
    throw new Error(`refusing a source session root outside the paper-shadow tree: ${root}`);
  }
  return root;
}

/**
 * Read one captured session STRICTLY.
 *
 * @returns {Promise<{
 *   ok: boolean, sessionId: string, root: string,
 *   session: object|null, summary: object|null, events: object[],
 *   digests: { session: string|null, summary: string|null, events: string|null, source: string|null },
 *   bytes: { session: number, summary: number, events: number },
 *   parseProblems: Array<{ check: string, detail: string }>, problems: string[],
 * }>}
 */
export async function loadSourceSession({ sessionId, sourceRoot = null } = {}) {
  const root = resolveSourceSessionRoot({ sessionId, sourceRoot });
  const problems = [];
  const parseProblems = [];

  const readTarget = async (filename) => {
    const target = path.join(root, filename);
    try {
      const raw = await readFile(target);
      const content = new TextDecoder("utf-8", { fatal: true }).decode(raw);
      return { ok: true, content, raw, bytes: raw.length, target };
    } catch (error) {
      problems.push(`source artifact ${filename} could not be read: ${error?.code ?? error?.message ?? error}`);
      return { ok: false, content: null, bytes: 0, target };
    }
  };

  const sessionFile = await readTarget(PAPER_SHADOW_SESSION_FILE);
  const summaryFile = await readTarget(PAPER_SHADOW_SUMMARY_FILE);
  const eventsFile = await readTarget(PAPER_SHADOW_EVENTS_FILE);

  if (!sessionFile.ok || !summaryFile.ok || !eventsFile.ok) {
    return {
      ok: false,
      sessionId,
      root,
      session: null,
      summary: null,
      events: [],
      digests: { session: null, summary: null, events: null, source: null },
      bytes: { session: sessionFile.bytes, summary: summaryFile.bytes, events: eventsFile.bytes },
      parseProblems,
      problems,
    };
  }

  let session = null;
  let summary = null;
  try {
    session = JSON.parse(sessionFile.content);
  } catch {
    problems.push("session.json is not valid JSON");
  }
  try {
    summary = JSON.parse(summaryFile.content);
  } catch {
    problems.push("summary.json is not valid JSON");
  }

  // STRICT NDJSON: every non-empty line must parse. No tolerance, no repair.
  const events = [];
  const lines = eventsFile.content.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        parseProblems.push({ check: "events_valid_json", detail: `line ${index + 1} is not a JSON object` });
        continue;
      }
      events.push(parsed);
    } catch {
      parseProblems.push({
        check: "events_valid_json",
        detail: `line ${index + 1} is not valid JSON`,
      });
    }
  }

  const digests = {
    session: sha256Hex(sessionFile.raw),
    summary: sha256Hex(summaryFile.raw),
    events: sha256Hex(eventsFile.raw),
    source: null,
  };
  digests.source = digestOf({
    sessionId,
    files: PAPER_FORENSICS_SOURCE_FILES.map((file) => ({
      file,
      digest:
        file === PAPER_SHADOW_SESSION_FILE
          ? digests.session
          : file === PAPER_SHADOW_SUMMARY_FILE
            ? digests.summary
            : digests.events,
    })),
  });

  return {
    ok: problems.length === 0,
    sessionId,
    root,
    session,
    summary,
    events,
    digests,
    bytes: { session: sessionFile.bytes, summary: summaryFile.bytes, events: eventsFile.bytes },
    parseProblems,
    problems,
  };
}

/** Every leaf of a JSON value as `path -> value` (bounded depth), for scans. */
function walkLeaves(value, visit, trail = "$", depth = 0) {
  if (depth > 100) throw new Error("source nesting exceeds integrity limit");
  visit(trail, value);
  if (value === null || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => walkLeaves(entry, visit, `${trail}[${index}]`, depth + 1));
    return;
  }
  for (const [key, entry] of Object.entries(value)) walkLeaves(entry, visit, `${trail}.${key}`, depth + 1);
}

/** Scan arbitrary parsed JSON for credential-shaped keys or values. */
export function scanForSecrets(payload) {
  const findings = [];
  walkLeaves(payload, (trail, value) => {
    const lastKey = String(trail).split(".").pop() ?? "";
    const normalizedKey = lastKey.replace(/\[\d+\]$/, "").toLowerCase();
    if (isSensitiveKey(normalizedKey) || ["password", "signingkey"].includes(normalizedKey)) {
      findings.push({ path: trail, kind: "credential-key-name", detail: normalizedKey });
    }
    if (typeof value === "string") {
      for (const pattern of SECRET_PATTERNS) {
        if (pattern.re.test(value)) {
          findings.push({ path: trail, kind: pattern.label, detail: "credential-shaped value" });
        }
      }
    }
  });
  return findings;
}


function check(id, ok, detail, { blocking = true } = {}) {
  return { id, ok: ok === true, blocking: blocking !== false, detail: detail ?? null };
}

/** Count events matching a predicate. */
function countWhere(events, predicate) {
  return events.reduce((total, event) => total + (predicate(event) ? 1 : 0), 0);
}

/**
 * The source integrity contract (§3). Every check is reproducible from the
 * source bytes alone; nothing is repaired and nothing is inferred.
 */
export function verifySourceIntegrity({
  sessionId,
  root = null,
  session,
  summary,
  events = [],
  digests = null,
  bytes = null,
  parseProblems = [],
  loadProblems = [],
} = {}) {
  const checks = [];
  const problems = [];

  // ---- presence -----------------------------------------------------------
  const present = Boolean(session) && Boolean(summary) && Array.isArray(events);
  checks.push(
    check(
      "source_files_present",
      present && loadProblems.length === 0,
      loadProblems.length > 0 ? loadProblems.join("; ") : "session.json, summary.json and events.ndjson were read",
    ),
  );

  // ---- identity -----------------------------------------------------------
  const sessionIdMatchesDirectory = session?.sessionId === sessionId;
  checks.push(
    check(
      "session_id_matches_directory",
      sessionIdMatchesDirectory,
      sessionIdMatchesDirectory ? null : `session.json declares '${session?.sessionId ?? "null"}'`,
    ),
  );

  // ---- status -------------------------------------------------------------
  const statusComplete = session?.status === "COMPLETE";
  checks.push(
    check("session_status_complete", statusComplete, statusComplete ? null : `status is '${session?.status ?? "null"}'`),
  );

  // ---- NDJSON -------------------------------------------------------------
  checks.push(
    check(
      "events_valid_json",
      parseProblems.length === 0,
      parseProblems.length === 0 ? null : parseProblems.map((problem) => problem.detail).join("; "),
    ),
  );

  // ---- sequences ----------------------------------------------------------
  const sequences = events.map((event) => event?.sequence);
  const uniqueSequences = new Set(sequences);
  const contiguous =
    sequences.length > 0 &&
    uniqueSequences.size === sequences.length &&
    sequences.every((value, index) => value === index + 1);
  checks.push(
    check(
      "sequences_contiguous_unique",
      contiguous,
      contiguous
        ? null
        : `expected 1..${sequences.length}; saw ${sequences.length} events and ${uniqueSequences.size} distinct sequences`,
    ),
  );

  // ---- timestamps ---------------------------------------------------------
  const observedTimes = events.map((event) => Date.parse(String(event?.observedAt ?? "")));
  let monotonic = observedTimes.length > 0 && observedTimes.every((value) => Number.isFinite(value));
  for (let index = 1; index < observedTimes.length && monotonic; index += 1) {
    if (observedTimes[index] < observedTimes[index - 1]) monotonic = false;
  }
  checks.push(
    check(
      "timestamps_monotonic",
      monotonic,
      monotonic ? null : "observedAt is missing, unparsable, or decreases between events",
    ),
  );

  // ---- finite values ------------------------------------------------------
  const nonFinite = [];
  walkLeaves(events, (trail, value) => {
    if (typeof value === "number" && !Number.isFinite(value)) nonFinite.push(trail);
  });
  walkLeaves(summary ?? {}, (trail, value) => {
    if (typeof value === "number" && !Number.isFinite(value)) nonFinite.push(`summary${trail}`);
  });
  walkLeaves(session ?? {}, (trail, value) => {
    if (typeof value === "number" && !Number.isFinite(value)) nonFinite.push(`session${trail}`);
  });
  checks.push(
    check(
      "finite_values_only",
      nonFinite.length === 0,
      nonFinite.length === 0 ? null : `non-finite numbers at ${nonFinite.slice(0, 5).join(", ")}`,
    ),
  );

  // ---- prose (no credentials) --------------------------------------------
  const secrets = [...scanForSecrets(events), ...scanForSecrets(session ?? {}), ...scanForSecrets(summary ?? {})];
  checks.push(
    check(
      "no_credentials_or_secrets",
      secrets.length === 0,
      secrets.length === 0
        ? null
        : `credential-shaped content at ${secrets.slice(0, 5).map((finding) => finding.path).join(", ")}`,
    ),
  );

  // ---- classification -----------------------------------------------------
  const classFlagsAllFalse = [
    "canonicalEvidence",
    "replicationEvidence",
    "temporalReplicationEvidence",
    "arenaEligible",
    "deploymentEligible",
    "profitabilityInferencePermitted",
  ].every((key) => session?.[key] === false);
  const classificationOk =
    session?.purpose === PAPER_SHADOW_PURPOSE &&
    session?.paperOnly === true &&
    session?.shadowOnly === true &&
    summary?.purpose === PAPER_SHADOW_PURPOSE && summary?.paperOnly === true &&
    ["canonicalEvidence", "replicationEvidence", "temporalReplicationEvidence", "arenaEligible", "deploymentEligible"].every(key => summary?.[key] === false) &&
    session?.status === "COMPLETE" &&
    classFlagsAllFalse;
  checks.push(
    check(
      "source_classification_development_only",
      classificationOk,
      classificationOk
        ? null
        : `purpose='${session?.purpose ?? "null"}' paperOnly=${session?.paperOnly ?? "null"} flags=${
            classFlagsAllFalse ? "all-false" : "a flag is not false"
          }`,
    ),
  );

  checks.push(check("probability_and_intent", events.every((event) =>
    event.pHigher === null ? event.modelIntent === null :
      Number.isFinite(event.pHigher) && event.pHigher >= 0 && event.pHigher <= 1 &&
      event.modelIntent === (event.pHigher >= 0.5 ? "HIGHER" : "LOWER")), "probabilities must be null or in [0,1] and match intents"));
  checks.push(check("source_identity_and_settings", summary?.sessionId === sessionId &&
    summary?.status === "COMPLETE" && events.every((event) => event.sessionId === sessionId) &&
    Number.isFinite(session?.startingCash) && session.startingCash > 0 &&
    summary?.startingCash === session.startingCash && Number.isFinite(session?.positionFraction) &&
    session.positionFraction > 0 && session.positionFraction <= 1 && session.intentThreshold === 0.5,
    "summary, event identity and frozen accounting settings"));

  checks.push(check("recorded_fills_well_formed", events.every((event) => {
    const fill = event.paperFill;
    if (!["ENTER", "EXIT"].includes(event.action)) return fill === null;
    return fill && fill.side === (event.action === "ENTER" ? "BUY" : "SELL") &&
      ["qty", "referencePrice", "executedPrice", "notional"].every((key) => Number.isFinite(fill[key]) && fill[key] > 0) &&
      ["feeUsd", "frictionUsd", "slippageBps", "costBps"].every((key) => Number.isFinite(fill[key]) && fill[key] >= 0) &&
      fill.referencePrice === event.referencePrice;
  }), "each executed action requires a finite matching fill"));

  // ---- counts/accounting --------------------------------------------------
  const decidable = events.filter((event) => typeof event?.action === "string");
  const jevOk = countWhere(events, (event) => event?.status === "JEV_OK");
  const jevAttempted = countWhere(events, (event) => event?.jevCallAttempted === true);
  const jevFailures = jevAttempted - jevOk;
  const higherCount = countWhere(events, (event) => event?.modelIntent === "HIGHER");
  const lowerCount = countWhere(events, (event) => event?.modelIntent === "LOWER");
  const reproducedActions = {
    ENTER: countWhere(events, (event) => event?.action === "ENTER"),
    EXIT: countWhere(events, (event) => event?.action === "EXIT"),
    HOLD: countWhere(events, (event) => event?.action === "HOLD"),
    CASH: countWhere(events, (event) => event?.action === "CASH"),
  };

  const decisionCountOk =
    events.length === summary?.decisions && events.length === session?.decisions && decidable.length === events.length;
  checks.push(
    check(
      "decision_count_matches_summary",
      decisionCountOk,
      decisionCountOk
        ? null
        : `events=${events.length} summary.decisions=${summary?.decisions ?? "null"} session.decisions=${
            session?.decisions ?? "null"
          } decidable=${decidable.length}`,
    ),
  );

  const jevCountsOk = jevOk === summary?.jevOk && jevFailures === summary?.jevFailures;
  checks.push(
    check(
      "jev_counts_reproduce",
      jevCountsOk,
      jevCountsOk
        ? null
        : `ok=${jevOk} failures=${jevFailures}; summary ok=${summary?.jevOk} failures=${summary?.jevFailures}`,
    ),
  );

  const intentCountsOk = higherCount === summary?.higherCount && lowerCount === summary?.lowerCount;
  checks.push(
    check(
      "intent_counts_reproduce",
      intentCountsOk,
      intentCountsOk
        ? null
        : `higher=${higherCount} lower=${lowerCount}; summary higher=${summary?.higherCount} lower=${summary?.lowerCount}`,
    ),
  );

  const actionCountsOk =
    reproducedActions.ENTER === summary?.enterCount &&
    reproducedActions.EXIT === summary?.exitCount &&
    reproducedActions.HOLD === summary?.holdCount &&
    reproducedActions.CASH === summary?.cashCount;
  checks.push(
    check(
      "action_counts_reproduce",
      actionCountsOk,
      actionCountsOk
        ? null
        : `events=${JSON.stringify(reproducedActions)}; summary enter=${summary?.enterCount} exit=${
            summary?.exitCount
          } hold=${summary?.holdCount} cash=${summary?.cashCount}`,
    ),
  );

  const lastEvent = events[events.length - 1] ?? null;
  const accountFields = ["cash", "grossPnl", "netPnl", "costs", "equity", "maxDrawdown"];
  const accountDeltas = {};
  let accountOk = lastEvent !== null;
  for (const field of accountFields) {
    const eventValue = Number.isFinite(lastEvent?.[field]) ? lastEvent[field] : null;
    const summaryField = { cash: "endingCash", costs: "totalCosts", equity: "endingEquity" }[field] ?? field;
    const summaryValue = Number.isFinite(summary?.[summaryField]) ? summary[summaryField] : null;
    const delta = eventValue === null || summaryValue === null ? null : Math.abs(eventValue - summaryValue);
    accountDeltas[field] = roundTo(delta, 12);
    if (delta === null || delta > PAPER_FORENSICS_TOLERANCE.accountUsd) accountOk = false;
  }
  const eventPositionValue =
    lastEvent === null || !Number.isFinite(lastEvent.positionQty) || (lastEvent.positionQty > 0 && !Number.isFinite(lastEvent.positionMarkPrice))
      ? null
      : lastEvent.positionQty === 0 ? 0 : lastEvent.positionQty * lastEvent.positionMarkPrice;
  const positionValueDelta =
    eventPositionValue === null || !Number.isFinite(summary?.endingPositionValue)
      ? null
      : Math.abs(summary.endingPositionValue - Number(eventPositionValue.toFixed(10)));
  if (positionValueDelta === null || positionValueDelta > PAPER_FORENSICS_TOLERANCE.accountUsd) accountOk = false;
  checks.push(
    check(
      "final_account_values_reproduce",
      accountOk,
      accountOk
        ? null
        : `deltas ${JSON.stringify(accountDeltas)} positionValueDelta=${positionValueDelta} (tolerance ${
            PAPER_FORENSICS_TOLERANCE.accountUsd
          })`,
    ),
  );

  // ---- digests ------------------------------------------------------------
  const digestsOk =
    typeof digests?.session === "string" &&
    typeof digests?.summary === "string" &&
    typeof digests?.events === "string" &&
    typeof digests?.source === "string";
  checks.push(
    check("source_digests_recorded", digestsOk, digestsOk ? null : "one or more source digests are unavailable"),
  );

  // ---- summary self digest -----------------------------------------------
  const summarySubject = { ...(summary ?? {}) };
  delete summarySubject.summaryDigest;
  // Paper Shadow storage appends updatedAt AFTER the runner computes this digest.
  delete summarySubject.updatedAt;
  const summaryDigestOk = digestOf(summarySubject) === summary?.summaryDigest;
  checks.push(
    check(
      "summary_self_digest_reproduces",
      summaryDigestOk,
      summaryDigestOk ? null : "summaryDigest does not reproduce from the persisted summary body",
      { blocking: true },
    ),
  );

  const blockingFailures = checks.filter((entry) => entry.blocking !== false && entry.ok !== true);
  for (const failure of blockingFailures) problems.push(`${failure.id}: ${failure.detail ?? "failed"}`);

  return sanitizeForPublic({
    status: blockingFailures.length === 0 ? "PASS" : "FAIL",
    sourceRoot: root,
    sessionId,
    checks,
    problems,
    observed: {
      events: events.length,
      jevOk,
      jevAttempted,
      jevFailures,
      higherCount,
      lowerCount,
      actions: reproducedActions,
      accountDeltas,
      endingPositionValueDelta: roundTo(positionValueDelta, 12),
    },
    expected: {
      events: session?.decisions ?? null,
      summaryDecisions: summary?.decisions ?? null,
      jevOk: summary?.jevOk ?? null,
      jevFailures: summary?.jevFailures ?? null,
      higherCount: summary?.higherCount ?? null,
      lowerCount: summary?.lowerCount ?? null,
      actions: {
        ENTER: summary?.enterCount ?? null,
        EXIT: summary?.exitCount ?? null,
        HOLD: summary?.holdCount ?? null,
        CASH: summary?.cashCount ?? null,
      },
    },
    sourceBytes: bytes,
    digests: digests ?? null,
    upstreamMetadata: forensicMetadataDiagnostic(session),
    secretFindings: secrets,
  });
}

/**
 * Forensic metadata diagnostic (§15). The first captured session persisted
 * `upstream: null` although its direct provider was TypeSafe; this reports the
 * gap without mutating anything.
 */
export function forensicMetadataDiagnostic(session) {
  const upstream =
    typeof session?.upstream === "string" && session.upstream.trim().length > 0 ? session.upstream.trim() : null;
  const provider =
    typeof session?.provider === "string" && session.provider.trim().length > 0 ? session.provider.trim() : null;
  const expectedUpstream = PAPER_FORENSICS_EXPECTED_UPSTREAM;
  const upstreamPresent = upstream !== null;
  let issue = null;
  if (!upstreamPresent) {
    issue =
      provider === "typesafe-jev"
        ? `upstream is null although provider='typesafe-jev'; the captured session predates the Phase 5I-PS.1 upstream-identity fix (expected '${expectedUpstream}')`
        : "upstream is missing from the captured session record";
  } else if (provider === "typesafe-jev" && upstream !== expectedUpstream) {
    issue = `upstream='${upstream}' but the frozen direct TypeSafe route resolves to '${expectedUpstream}'`;
  }
  return {
    upstreamPresent,
    upstream,
    expectedUpstream,
    provider,
    providerMatchesExpected: provider === "typesafe-jev",
    issue,
  };
}

/** True when a path exists and is a file (bounded stat helper). */
export async function fileExists(target) {
  try {
    const info = await stat(target);
    return info.isFile();
  } catch {
    return false;
  }
}

