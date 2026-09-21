/**
 * EVOLVE Phase 5I-PS.1 — `stateDigest` / `packetDigest` AUDIT (§16).
 *
 * Run #1 recorded identical `stateDigest` and `packetDigest` on every decision.
 * This module answers, from the CODE PATH rather than from a guess, whether that
 * is:
 *
 *   1. intentional — both fields currently digest the exact same canonical
 *      object; or
 *   2. an instrumentation defect — the two fields are meant to represent
 *      different objects.
 *
 * CONCLUSION (documented, verified at runtime by this module): option 1.
 *
 *   - `packetDigestOf(packet)`      = `digestOf(stableProjection(packet))`
 *   - `packetStateDigestOf(packet)` = `jevStateDigestOf(packet)`
 *                                   = `digestOf(stableProjection(packet))`
 *
 * `stableProjection` is the same key-sorted projection (dropping the two
 * volatile fields `createdAt` / `generatedBy`) in both paths, so for any packet
 * the two digests are equal BY CONSTRUCTION. Phase 5I's canonical runner asserts
 * exactly that and refuses to freeze a packet when they disagree.
 *
 * Therefore: no instrumentation fix is required, no field is renamed, and NO
 * Phase 5I canonical digest semantic is touched. The audit is recorded in the
 * forensic artifacts so the observation is never re-litigated from memory.
 *
 * READ-ONLY / OFFLINE.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

export const PAPER_FORENSICS_DIGEST_AUDIT_VERSION = 1;

/** The three source files the audit reads (paths only; nothing is executed). */
export const DIRECTION_PACKET_SOURCE_FILE = path.join("scripts", "jev", "direction", "packet.mjs");
export const DIRECTION_DECISION_PACKET_SOURCE_FILE = path.join("scripts", "jev", "decision-packet.mjs");
export const DIRECTION_RUNNER_SOURCE_FILE = path.join("scripts", "jev", "direction", "runner.mjs");

/** The two admissible conclusions, named so the artifact can never be vague. */
export const PAPER_FORENSICS_DIGEST_AUDIT_CONCLUSIONS = Object.freeze({
  INTENTIONAL_SHARED_OBJECT: "INTENTIONAL_SHARED_CANONICAL_OBJECT",
  INSTRUMENTATION_DEFECT: "INSTRUMENTATION_DEFECT",
});

const SHARED_CONCLUSION = PAPER_FORENSICS_DIGEST_AUDIT_CONCLUSIONS.INTENTIONAL_SHARED_OBJECT;

/**
 * Static code-path audit: find the two digest functions and the canonical
 * runner's equality assertion, with line numbers, so the conclusion is
 * traceable to source.
 */
export function auditDigestCodePaths({ packetSource, decisionPacketSource, runnerSource }) {
  const findings = [];
  const lines = (text) => String(text ?? "").split("\n");
  const findLine = (text, needle) => {
    const index = lines(text).findIndex((line) => line.includes(needle));
    return index === -1 ? null : index + 1;
  };

  const packetDigestLine = findLine(packetSource, "export function packetDigestOf");
  const stateDigestLine = findLine(packetSource, "export function packetStateDigestOf");
  const stableProjectionLine = findLine(packetSource, "function stableProjection");
  const volatileFieldsLine = findLine(packetSource, "DIRECTION_VOLATILE_PACKET_FIELDS =");
  const runtimeDigestLine = findLine(decisionPacketSource, "export function jevStateDigestOf");
  const runnerStateLine = findLine(runnerSource, "packetStateDigestOf(packet)");
  const runnerPacketLine = findLine(runnerSource, "packetDigestOf(packet)");
  const runnerGuardLine = findLine(runnerSource, "packet digest and state digest disagree");

  for (const [id, present, line] of [
    ["packetDigestOf", packetSource.includes("export function packetDigestOf"), packetDigestLine],
    ["packetStateDigestOf", packetSource.includes("export function packetStateDigestOf"), stateDigestLine],
    ["stableProjection", packetSource.includes("function stableProjection"), stableProjectionLine],
    ["volatileFields", packetSource.includes("DIRECTION_VOLATILE_PACKET_FIELDS"), volatileFieldsLine],
    ["jevStateDigestOf", decisionPacketSource.includes("export function jevStateDigestOf"), runtimeDigestLine],
    ["runnerComputesStateDigest", runnerSource.includes("packetStateDigestOf(packet)"), runnerStateLine],
    ["runnerComputesPacketDigest", runnerSource.includes("packetDigestOf(packet)"), runnerPacketLine],
    ["runnerAssertion", runnerSource.includes("packet digest and state digest disagree"), runnerGuardLine],
  ]) {
    findings.push({ id, present: present === true, line, file: null });
  }

  // Both digest paths must go through the SAME projection and the SAME digest.
  const sharedProjection =
    packetSource.includes("return digestOf(stableProjection(packet ?? {}));") &&
    decisionPacketSource.includes("return digestOf(stableProjection(packet ?? {}));");
  const runnerAssertsEquality =
    runnerSource.includes("const stateDigest = packetStateDigestOf(packet);") &&
    runnerSource.includes("const packetDigest = packetDigestOf(packet);") &&
    runnerSource.includes("if (stateDigest !== packetDigest) {");

  return {
    version: PAPER_FORENSICS_DIGEST_AUDIT_VERSION,
    files: {
      packet: DIRECTION_PACKET_SOURCE_FILE,
      decisionPacket: DIRECTION_DECISION_PACKET_SOURCE_FILE,
      runner: DIRECTION_RUNNER_SOURCE_FILE,
    },
    codePaths: {
      packetDigest: {
        file: DIRECTION_PACKET_SOURCE_FILE,
        line: packetDigestLine,
        expression: "digestOf(stableProjection(packet ?? {}))",
      },
      stateDigest: {
        file: DIRECTION_PACKET_SOURCE_FILE,
        line: stateDigestLine,
        delegatesTo: "jevStateDigestOf(packet)",
        implementation: {
          file: DIRECTION_DECISION_PACKET_SOURCE_FILE,
          line: runtimeDigestLine,
          expression: "digestOf(stableProjection(packet ?? {}))",
        },
      },
      sharedProjection: {
        file: DIRECTION_PACKET_SOURCE_FILE,
        line: stableProjectionLine,
        dropsFields: "DIRECTION_VOLATILE_PACKET_FIELDS = [createdAt, generatedBy]",
        droppedFieldsLine: volatileFieldsLine,
        keySorted: true,
      },
      canonicalRunner: {
        file: DIRECTION_RUNNER_SOURCE_FILE,
        stateDigestLine: runnerStateLine,
        packetDigestLine: runnerPacketLine,
        assertionLine: runnerGuardLine,
        assertion: "throws when stateDigest !== packetDigest, so the two are equal by construction and enforced",
      },
      paperShadowRunner: {
        file: "scripts/jev/paper-shadow/runner.mjs",
        behavior:
          "computes packetStateDigestOf(packet) and packetDigestOf(packet) independently from the SAME frozen packet and persists both",
      },
    },
    findings,
    sharedProjection,
    runnerAssertsEquality,
  };
}

/**
 * Dynamic proof on a REPRESENTATIVE object: the two digest functions are equal
 * for the same input, are stable across volatile-field changes, and DO change
 * when a content field changes. Nothing here touches canonical evidence.
 */
export function auditDigestEquality({ packetDigestOf, packetStateDigestOf, sample }) {
  const content = {
    schemaVersion: 1,
    packetVersion: 1,
    packetKind: "JEV_DIRECTION_DECISION_PACKET",
    observationId: "audit-sample-1",
    features: { priceReturn1m: 0.001, liquidityUsd: 1234.5 },
    createdAt: "2026-09-20T00:00:00.000Z",
    generatedBy: { phase: "5I", runner: 1 },
    ...(sample ?? {}),
  };
  const packetDigest = packetDigestOf(content);
  const stateDigest = packetStateDigestOf(content);
  const volatileChanged = { ...content, createdAt: "2030-01-01T00:00:00.000Z", generatedBy: { phase: "x" } };
  const contentChanged = { ...content, observationId: "audit-sample-2" };
  return {
    equalForSameObject: packetDigest === stateDigest,
    packetDigest,
    stateDigest,
    stableAcrossVolatileFields:
      packetDigestOf(volatileChanged) === packetDigest && packetStateDigestOf(volatileChanged) === stateDigest,
    sensitiveToContent:
      packetDigestOf(contentChanged) !== packetDigest && packetStateDigestOf(contentChanged) !== stateDigest,
  };
}

/**
 * The complete audit record persisted in `integrity.json`. It always states the
 * conclusion explicitly, plus whether any fix was applied.
 */
export async function auditDigestIdentity({ root = ".", packetDigestOf, packetStateDigestOf } = {}) {
  const readOrEmpty = async (relative) => {
    try {
      return await readFile(path.join(root, relative), "utf8");
    } catch {
      return "";
    }
  };
  const [packetSource, decisionPacketSource, runnerSource] = await Promise.all([
    readOrEmpty(DIRECTION_PACKET_SOURCE_FILE),
    readOrEmpty(DIRECTION_DECISION_PACKET_SOURCE_FILE),
    readOrEmpty(DIRECTION_RUNNER_SOURCE_FILE),
  ]);

  const codePaths = auditDigestCodePaths({ packetSource, decisionPacketSource, runnerSource });
  const equality =
    typeof packetDigestOf === "function" && typeof packetStateDigestOf === "function"
      ? auditDigestEquality({ packetDigestOf, packetStateDigestOf })
      : null;
  const sourceReadable =
    packetSource.length > 0 && decisionPacketSource.length > 0 && runnerSource.length > 0;

  const intentional =
    sourceReadable &&
    codePaths.sharedProjection &&
    codePaths.runnerAssertsEquality &&
    (equality === null || (equality.equalForSameObject && equality.stableAcrossVolatileFields));

  return {
    version: PAPER_FORENSICS_DIGEST_AUDIT_VERSION,
    question:
      "Why did run #1 record identical stateDigest and packetDigest — intentional shared object, or instrumentation defect?",
    conclusion: intentional ? SHARED_CONCLUSION : "UNVERIFIED_REQUIRES_CODE_REVIEW",
    conclusionMeaning: intentional ?
      "Both fields digest the exact same canonical object through the same key-sorted projection; the equality is by construction and is asserted by the Phase 5I canonical runner. This is NOT an instrumentation defect." : "The code-path audit could not confirm the shared projection; manual code review is required.",
    sourceReadable,
    codePaths,
    dynamicEquality: equality,
    defectFound: intentional ? false : null,
    fixApplied: false,
    fixRequired: intentional ? false : null,
    sealedContractsTouched: false,
    canonicalDigestSemanticsUnchanged: true,
    priorArtifactsMutated: false,
    notes: intentional ? [
      "Option 1 confirmed: both fields currently digest the exact same canonical object.",
      "No field is renamed and no note is added to the sealed 5I contract, because that would change a frozen contract for no gain.",
      "The equality is reported in this forensic artifact (and by the CLI) instead of being inferred from memory.",
    ] : ["No defect conclusion can be drawn from an unverified code path."],
  };
}
