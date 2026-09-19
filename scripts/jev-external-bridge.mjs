/**
 * Phase 5F.0 — EXTERNAL INTELLIGENCE → JEV SHADOW EXPERIMENT BRIDGE.
 *
 * This is experimentation, NOT operational routing:
 *
 *   frozen capture
 *     → offline replay
 *     → audited external-intelligence-packet-v1
 *     → bounded Jev external-intelligence projection (a SECOND whitelist)
 *     → fixed question set `jev-external-intelligence-v1`
 *     → explicit Jev shadow call
 *     → immutable Jev experiment record
 *     → STOP
 *
 * What this module deliberately does NOT do:
 *
 *   * it never sets `JEV_ROUTING_ACTIVE` / `DEEPSEEK_ROUTING_ACTIVE`
 *   * it never makes the intelligence subsystem invoke Jev automatically
 *   * it never spawns Agent-Reach, never takes a capture, never calls DeepSeek
 *     and never runs the Arena
 *   * it never feeds a decision into the candidate/Arena calibration path
 *
 * The external packet is NEVER handed to Jev as-is. A dedicated builder projects
 * only bounded, outcome-independent fields into a `packetKind` of its own —
 * `JEV_EXTERNAL_INTELLIGENCE_DECISION_PACKET` — so the existing candidate and
 * market packet versions are neither overloaded nor bumped.
 *
 * The deterministic `evidenceQuality` label the external packet already carries
 * is WITHHELD from Jev (Jev is asked to judge evidence quality independently);
 * it is recorded afterwards as a deterministic comparator instead.
 *
 * PAPER ONLY, SHADOW ONLY, READ-ONLY.
 */

import { choice, noul, score } from "@typesafe-ai/sdk";

import { digestOf } from "./lib/hash.mjs";
import {
  EXTERNAL_INTELLIGENCE_DISPOSITIONS,
  EXTERNAL_INTELLIGENCE_PACKET_KIND,
  EXTERNAL_INTELLIGENCE_PACKET_VERSION,
  PacketAuditError,
  assertPacketAllowed,
} from "./intelligence/packet.mjs";
import { JEV_STATUS } from "./jev/config.mjs";
import { auditJevDecisionPacket } from "./jev/decision-packet.mjs";
import { jevDecide } from "./jev/decide.mjs";
import {
  buildJevDecisionRecord,
  createJevExperiment,
  jevDecisionIdFor,
  jevExperimentIdFor,
  jevExperimentRootFor,
  readJevExperiment,
  writeJevDecision,
  writeJevExperiment,
} from "./jev/experiment.mjs";

/* ============================================================================
 * Explicit packet kind and version
 * ==========================================================================*/

/**
 * A SEPARATE packet-version constant for the third packet kind. The existing
 * candidate/market `JEV_DECISION_PACKET_VERSION` is NOT redefined or bumped
 * merely because a third kind exists.
 */
export const JEV_EXTERNAL_INTELLIGENCE_PACKET_VERSION = 1;

export const JEV_EXTERNAL_INTELLIGENCE_PACKET_KIND = "JEV_EXTERNAL_INTELLIGENCE_DECISION_PACKET";

/* ============================================================================
 * Dedicated fixed question set
 * ==========================================================================*/

export const JEV_EXTERNAL_INTELLIGENCE_QUESTION_SET_ID = "jev-external-intelligence-v1";
export const JEV_EXTERNAL_INTELLIGENCE_QUESTION_SET_VERSION = 1;

/** Bounded vocabulary for `primaryConcern`. Never extended dynamically. */
export const PRIMARY_CONCERN_VOCAB = Object.freeze([
  "insufficient_sample",
  "source_concentration",
  "low_field_coverage",
  "coordination_pattern",
  "fetch_instability",
  "no_obvious_concern",
]);

/**
 * Bounded vocabulary for `researchDisposition`. This is EXACTLY the existing
 * future external-intelligence vocabulary (`ignore` / `observe` /
 * `escalate_to_deep_research`) — never a new label. It is asserted below so a
 * future divergence is a hard error at module load.
 */
export const RESEARCH_DISPOSITION_VOCAB = Object.freeze([...EXTERNAL_INTELLIGENCE_DISPOSITIONS]);

if (
  RESEARCH_DISPOSITION_VOCAB.length !== 3 ||
  RESEARCH_DISPOSITION_VOCAB[0] !== "ignore" ||
  RESEARCH_DISPOSITION_VOCAB[1] !== "observe" ||
  RESEARCH_DISPOSITION_VOCAB[2] !== "escalate_to_deep_research"
) {
  throw new Error(
    "Jev external-intelligence researchDisposition vocabulary must be exactly ignore / observe / escalate_to_deep_research",
  );
}

/** Ordered 0..4 rubric for `evidenceQuality` (Jev judges it blind). */
export const EXTERNAL_EVIDENCE_QUALITY_LEVELS = Object.freeze([
  "very weak: effectively insufficient external evidence",
  "weak: sparse or concentrated evidence; conclusions would be fragile",
  "limited: some useful observations but insufficient corroboration",
  "good: reasonably broad and internally consistent external evidence",
  "strong: broad, well-covered, independently corroborated external evidence",
]);

/** Every question name in the external-intelligence set, for validators/normalization. */
export const EXTERNAL_INTELLIGENCE_QUESTION_NAMES = Object.freeze([
  "evidenceSufficiency",
  "primaryConcern",
  "evidenceQuality",
  "corroborationConfidence",
  "researchDisposition",
]);

/**
 * Question A — evidenceSufficiency (noul).
 * A research-conclusion judgment, NEVER a profitability probability.
 */
function evidenceSufficiencyQuestion() {
  return noul(
    "Based ONLY on this frozen bounded external-intelligence evidence, is there enough breadth, field coverage and " +
      "independent support to justify drawing any research conclusion beyond continued observation? This is about the " +
      "strength of the evidence, never a profitability probability.",
    {
      true: "The evidence is sufficiently broad/corroborated to support a research conclusion.",
      false: "The evidence is too sparse, concentrated, incomplete or weak for a conclusion beyond observation.",
    },
  );
}

/** Question B — primaryConcern (choice, bounded vocabulary, explicit descriptions). */
function primaryConcernQuestion() {
  return choice("If this frozen external evidence has one dominant concern, which is it?", {
    insufficient_sample: "The frozen capture has too few records to support any conclusion beyond observation.",
    source_concentration: "The evidence is dominated by a small number of sources or accounts.",
    low_field_coverage:
      "Too few records carry the fields needed (authors, text, links, timestamps, engagement) to judge breadth.",
    coordination_pattern:
      "Deterministic coordination indicators fired over the frozen bytes (e.g. repeated text, few authors, one link domain, burst rate).",
    fetch_instability: "The capture recorded failures or timeouts, so its coverage is unstable.",
    no_obvious_concern: "No single dominant concern is visible in the supplied bounded external evidence.",
  });
}

/**
 * Question C — evidenceQuality (score, fixed 5-level rubric).
 * The source packet's deterministic `evidenceQuality` label is deliberately
 * WITHHELD from Jev so it judges independently.
 */
function externalEvidenceQualityQuestion() {
  return score(
    "Rate the overall quality/strength of this frozen bounded external-intelligence evidence.",
    [...EXTERNAL_EVIDENCE_QUALITY_LEVELS],
  );
}

/** Question D — corroborationConfidence (noul). Never a probability of truth/legitimacy. */
function corroborationConfidenceQuestion() {
  return noul(
    "Does the frozen evidence demonstrate meaningful corroboration across independent observations/sources rather than " +
      "merely repeating one narrow source? Never interpret this as a probability of truth, profitability or legitimacy.",
    {
      true: "Meaningful corroboration exists across independent observations/sources.",
      false: "Corroboration is absent or not demonstrated.",
    },
  );
}

/**
 * Question E — researchDisposition (choice). SHADOW ONLY.
 * Even `escalate_to_deep_research` is a RECORDED HYPOTHETICAL: it never invokes
 * DeepSeek and never changes any research lifecycle.
 */
function externalResearchDispositionQuestion() {
  return choice(
    "SHADOW ONLY — this answer does not route anything and does not start any research. Given only this frozen bounded " +
      "external-intelligence evidence, what would be the appropriate next research step?",
    {
      ignore: "Evidence contains no useful research signal worth pursuing now.",
      observe: "Keep collecting external evidence; the current packet does not justify deep research.",
      escalate_to_deep_research:
        "The packet contains enough bounded evidence that deeper research would be worth investigating.",
    },
  );
}

/** The fixed external-intelligence question set. Never dynamic. */
export function buildExternalIntelligenceQuestions() {
  return {
    evidenceSufficiency: evidenceSufficiencyQuestion(),
    primaryConcern: primaryConcernQuestion(),
    evidenceQuality: externalEvidenceQualityQuestion(),
    corroborationConfidence: corroborationConfidenceQuestion(),
    researchDisposition: externalResearchDispositionQuestion(),
  };
}

/* ============================================================================
 * Projection: external-intelligence-packet-v1 → bounded Jev packet
 * ==========================================================================*/

/** The exact top-level keys a Jev external-intelligence packet may contain. */
export const ALLOWED_JEV_EXTERNAL_KEYS = Object.freeze([
  "packetVersion",
  "packetKind",
  "sourceCapture",
  "counts",
  "features",
  "limitations",
  "createdAt",
  "generatedBy",
]);

/** Keys that may NEVER appear anywhere inside a Jev external-intelligence packet. */
export const FORBIDDEN_JEV_EXTERNAL_KEYS = Object.freeze([
  // raw intelligence content
  "records",
  "raw",
  "rawrecords",
  "rawrecord",
  "text",
  "textexcerpt",
  "excerpt",
  "excerpts",
  "canonicalurl",
  "url",
  "urls",
  "link",
  "links",
  "author",
  "authorid",
  "authorids",
  "authors",
  "repository",
  "repositoryname",
  "reponame",
  "description",
  "descriptions",
  "searchresult",
  "searchresults",
  // credentials / execution material
  "cookie",
  "cookies",
  "token",
  "tokens",
  "apikey",
  "authorization",
  "bearer",
  "credential",
  "credentials",
  "env",
  "environment",
  "rule",
  "rules",
  "command",
  "commands",
  "commandpreview",
  "script",
  "shell",
  "executable",
  // clock / deterministic labels withheld from Jev
  "captureagems",
  "evidencequality",
  "deterministicevidencequality",
  // outcomes Jev must never see
  "arenaresults",
  "arenarank",
  "arenascore",
  "arenaid",
  "candidateoutcome",
  "candidateoutcomes",
  "validationoutcome",
  "validationresult",
  "validationresults",
  "testoutcome",
  "testresult",
  "testresults",
  "oosresult",
  "oosresults",
  "futureobservation",
  "futureobservations",
  "gateresult",
  "deploymenteligible",
  "deploymentstatus",
  "replicationresult",
]);

const FORBIDDEN_JEV_EXTERNAL_KEY_SET = new Set(FORBIDDEN_JEV_EXTERNAL_KEYS);

/** Credential-shaped key name PATTERNS (patterns, not literal words). */
const FORBIDDEN_KEY_PATTERNS = Object.freeze([
  { label: "credential-key-name", re: /^(private|secret)[_-]?key$/ },
  { label: "credential-word-name", re: /^seed[_-]?phr/ },
  { label: "credential-word-name", re: /^mnem/ },
  { label: "credential-word-name", re: /^(passphrase|wallet[_-]?secret)$/ },
]);

/** Structural leak patterns inside string values (URLs, keys, bearer tokens). */
const FORBIDDEN_VALUE_PATTERNS = Object.freeze([
  { label: "url", re: /\b(https?|ftp):\/\//i },
  { label: "api-key", re: /\b(sk|pk)-[A-Za-z0-9]{16,}/ },
  { label: "bearer-token", re: /bearer\s+[A-Za-z0-9._-]{16,}/i },
  { label: "env-assignment", re: /\b[A-Z0-9_]{3,}_(KEY|TOKEN|SECRET)\s*=/ },
]);

/** The bounded feature fields the Jev projection may carry. Nothing else. */
export const JEV_EXTERNAL_FEATURE_KEYS = Object.freeze([
  "mentionCount",
  "uniqueAuthors",
  "uniqueTexts",
  "uniqueLinkDomains",
  "authorObservedCount",
  "textObservedCount",
  "linkObservedCount",
  "publishedAtObservedCount",
  "engagementObservedCount",
  "authorCoverage",
  "textCoverage",
  "linkCoverage",
  "publishedAtCoverage",
  "engagementCoverage",
  "postsPerMinute",
  "engagementTotal",
  "engagementMedian",
  "duplicateTextRatio",
  "repeatedAuthorRatio",
  "linkDomainConcentration",
  "accountConcentration",
  "sourceCount",
  "backendCount",
  "sourceDiversity",
  "queryCoverage",
  "fetchFailureRate",
  "coordinationIndicatorCount",
  "coordinationIndicatorIds",
]);

/**
 * Walk a Jev external-intelligence packet and report every forbidden key and
 * every forbidden string value, at any depth.
 *
 * @returns {{ ok: boolean, unknownKeys: string[], forbiddenKeys: string[], forbiddenValues: Array<{path:string,detail:string}> }}
 */
export function auditExternalIntelligenceJevPacket(packet) {
  const unknownKeys = Object.keys(packet ?? {}).filter((key) => !ALLOWED_JEV_EXTERNAL_KEYS.includes(key));
  const forbiddenKeys = [];
  const forbiddenValues = [];
  const seen = new WeakSet();

  const walk = (value, path, isTopLevelCall = false) => {
    void isTopLevelCall;
    if (value === null || value === undefined) return;
    const kind = typeof value;
    if (kind === "string") {
      for (const { label, re } of FORBIDDEN_VALUE_PATTERNS) {
        if (re.test(value)) forbiddenValues.push({ path, detail: label });
      }
      return;
    }
    if (kind !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach((entry, index) => walk(entry, `${path}[${index}]`));
      return;
    }
    for (const [key, entry] of Object.entries(value)) {
      const normalized = String(key).toLowerCase();
      const matchesPattern = FORBIDDEN_KEY_PATTERNS.find((entryPattern) => entryPattern.re.test(normalized));
      // A forbidden NAME holding a compile-time scalar (a count, a status, a
      // boolean) cannot carry content: `counts.records` is a number, and
      // `packetVersion` is a string. Arrays/objects under such a name are still
      // rejected, because those could carry raw records, URLs or text.
      const scalar = entry === null || ["number", "boolean"].includes(typeof entry);
      if (matchesPattern || (FORBIDDEN_JEV_EXTERNAL_KEY_SET.has(normalized) && !scalar)) {
        forbiddenKeys.push(`${path}.${key}`);
      }
      walk(entry, `${path}.${key}`);
    }
  };

  walk(packet, "packet");
  return {
    ok: unknownKeys.length === 0 && forbiddenKeys.length === 0 && forbiddenValues.length === 0,
    unknownKeys,
    forbiddenKeys,
    forbiddenValues,
  };
}

function projectFeatures(features) {
  const out = {};
  const indicators = features?.coordinationIndicators?.indicators;
  for (const key of JEV_EXTERNAL_FEATURE_KEYS) {
    if (key === "coordinationIndicatorIds") {
      out[key] = Array.isArray(indicators)
        ? indicators
            .map((indicator) => (typeof indicator?.id === "string" ? indicator.id.slice(0, 64) : null))
            .filter((id) => id !== null)
        : [];
      continue;
    }
    if (key === "coordinationIndicatorCount") {
      out[key] = Number.isFinite(features?.coordinationIndicators?.count)
        ? features.coordinationIndicators.count
        : 0;
      continue;
    }
    const value = features?.[key];
    out[key] = Number.isFinite(value) ? value : null;
  }
  return out;
}

/**
 * Verify that an external-intelligence packet may be projected at all.
 *
 * Order matters: the packet is first passed through `assertPacketAllowed` (the
 * external audit) and only then are the routing/`shadowOnly`/`paperOnly`/
 * `readOnly` invariants re-checked. A routing-active, non-shadow, non-paper or
 * write-capable packet is refused.
 *
 * @throws {PacketAuditError}
 */
export function assertExternalPacketProjectable(externalPacket) {
  if (!externalPacket || typeof externalPacket !== "object") {
    throw new PacketAuditError("buildExternalIntelligenceJevPacket requires a built external-intelligence packet");
  }
  // 1. The external audit is mandatory BEFORE any projection.
  assertPacketAllowed(externalPacket);
  if (externalPacket.packetVersion !== EXTERNAL_INTELLIGENCE_PACKET_VERSION) {
    throw new PacketAuditError(
      `refusing to project an unrecognized external packet version ${JSON.stringify(externalPacket.packetVersion)}`,
    );
  }
  if (externalPacket.kind !== EXTERNAL_INTELLIGENCE_PACKET_KIND) {
    throw new PacketAuditError(
      `refusing to project external packet kind ${JSON.stringify(externalPacket.kind)}`,
    );
  }
  // 2. Routing must be inactive, and the packet must be shadow/paper/read-only.
  if (externalPacket.routing?.jevRoutingActive !== false) {
    throw new PacketAuditError("refusing to project an external packet whose jevRoutingActive is not false");
  }
  if (externalPacket.routing?.deepseekRoutingActive !== false) {
    throw new PacketAuditError("refusing to project an external packet whose deepseekRoutingActive is not false");
  }
  if (externalPacket.shadowOnly !== true) {
    throw new PacketAuditError("refusing to project an external packet that is not shadowOnly");
  }
  if (externalPacket.paperOnly !== true) {
    throw new PacketAuditError("refusing to project an external packet that is not paperOnly");
  }
  if (externalPacket.readOnly !== true) {
    throw new PacketAuditError("refusing to project an external packet that is not readOnly");
  }
  return externalPacket;
}

/**
 * Build the bounded, outcome-independent Jev projection of an already-built
 * `external-intelligence-packet-v1`.
 *
 * WHITELIST ONLY: raw records, raw text, excerpts, URLs, author ids, repository
 * names, search-result descriptions, credentials, executable material, command
 * previews, `captureAgeMs`, Arena results, candidate outcomes, validation/test/
 * OOS outcomes, future observations, the deterministic `evidenceQuality` label
 * and the coordination-indicator prose `rule` strings are all excluded by
 * construction.
 *
 * @param {{ externalPacket: object, createdAt?: string|null, generatedBy?: object|null }} options
 */
export function buildExternalIntelligenceJevPacket({ externalPacket, createdAt = null, generatedBy = null } = {}) {
  assertExternalPacketProjectable(externalPacket);

  const counts = externalPacket.counts ?? {};
  const channels = Array.isArray(externalPacket.channels) ? [...externalPacket.channels] : [];

  const packet = {
    packetVersion: JEV_EXTERNAL_INTELLIGENCE_PACKET_VERSION,
    packetKind: JEV_EXTERNAL_INTELLIGENCE_PACKET_KIND,
    sourceCapture: {
      captureId: typeof externalPacket.captureId === "string" ? externalPacket.captureId.slice(0, 128) : null,
      captureManifestDigest:
        typeof externalPacket.captureManifestDigest === "string"
          ? externalPacket.captureManifestDigest.slice(0, 128)
          : null,
      packetDigest: typeof externalPacket.packetDigest === "string" ? externalPacket.packetDigest.slice(0, 128) : null,
      provider: typeof externalPacket.provider === "string" ? externalPacket.provider.slice(0, 64) : null,
      querySetId: typeof externalPacket.querySetId === "string" ? externalPacket.querySetId.slice(0, 128) : null,
      featureVersion: typeof externalPacket.featureVersion === "string" ? externalPacket.featureVersion.slice(0, 64) : null,
      channels: channels.filter((channel) => typeof channel === "string").map((channel) => channel.slice(0, 64)),
    },
    counts: {
      records: Number.isFinite(counts.records) ? counts.records : 0,
      channels: Number.isFinite(counts.channels) ? counts.channels : channels.length,
      failures: Number.isFinite(counts.failures) ? counts.failures : 0,
      timeouts: Number.isFinite(counts.timeouts) ? counts.timeouts : 0,
      calls: Number.isFinite(counts.calls) ? counts.calls : 0,
    },
    features: projectFeatures(externalPacket.features ?? {}),
    limitations: [
      "Frozen, bounded external-intelligence evidence only: no raw records, raw text, excerpts, URLs, author identities, " +
        "repository names, search-result descriptions, credentials, or executable material are present.",
      "SHADOW ONLY: these answers cannot route a candidate, trigger DeepSeek, trigger an Agent-Reach capture, alter research " +
        "lifecycle, modify Arena/gates/scoring/cohorts/replication/trading, or change deployment eligibility.",
    ],
    createdAt: createdAt ?? null,
    generatedBy: generatedBy ?? null,
  };

  const audit = auditExternalIntelligenceJevPacket(packet);
  if (!audit.ok) {
    throw new PacketAuditError(
      `external-intelligence Jev projection failed its own audit: unknown=${JSON.stringify(audit.unknownKeys)} ` +
        `forbidden=${JSON.stringify(audit.forbiddenKeys)} values=${JSON.stringify(audit.forbiddenValues)}`,
    );
  }
  // The generic Jev packet audit must also pass, so `jevDecide` accepts it.
  const generic = auditJevDecisionPacket(packet);
  if (!generic.ok) {
    throw new PacketAuditError(
      `external-intelligence Jev projection failed the generic Jev audit: ${JSON.stringify(generic.violations)}`,
    );
  }
  return packet;
}

/**
 * Deterministic comparators recorded at prediction time ALONGSIDE the shadow
 * answer. These are things EVOLVE already knows from the frozen capture — they
 * are never future outcomes, and they are never shown to Jev.
 */
export function externalIntelligenceComparators(externalPacket) {
  const features = externalPacket?.features ?? {};
  const counts = externalPacket?.counts ?? {};
  return {
    externalEvidenceQuality: typeof externalPacket?.evidenceQuality === "string" ? externalPacket.evidenceQuality : null,
    coordinationIndicatorCount: Number.isFinite(features?.coordinationIndicators?.count)
      ? features.coordinationIndicators.count
      : 0,
    recordCount: Number.isFinite(counts.records) ? counts.records : 0,
    sourceCount: Number.isFinite(features?.sourceCount) ? features.sourceCount : null,
    queryCoverage: Number.isFinite(features?.queryCoverage) ? features.queryCoverage : null,
    fetchFailureRate: Number.isFinite(features?.fetchFailureRate) ? features.fetchFailureRate : null,
  };
}

/* ============================================================================
 * Orchestration — one explicit SHADOW experiment
 * ==========================================================================*/

export const JEV_EXTERNAL_DECIDE_VERSION = 1;

/**
 * Run exactly one external-intelligence shadow decision.
 *
 * The packet is projected and audited, the fixed question set is built, the
 * selected provider is asked ONCE (budget-checked by `jevDecide`), and — only
 * when `persist` is true — an ordinary Jev experiment, provider run, cache
 * entry and immutable decision record are written under the EXISTING
 * `.evolve/jev/experiments/<id>/` storage. Nothing else is written, and nothing
 * outside that root is touched.
 *
 * @returns {Promise<{
 *   externalPacket: object,
 *   jevPacket: object,
 *   questions: object,
 *   comparators: object,
 *   run: object,
 *   decision: object|string,
 *   decisionRecord: object|null,
 *   experimentId: string|null,
 *   root: string|null,
 *   stateDigest: string,
 * }>}
 */
export async function runExternalIntelligenceShadowDecision({
  externalPacket,
  provider,
  root = null,
  experimentRootBase = undefined,
  cacheEnabled = false,
  budget = null,
  experimentId = null,
  persist = false,
  now = () => Date.now(),
  salt = "",
} = {}) {
  assertExternalPacketProjectable(externalPacket);

  const jevPacket = buildExternalIntelligenceJevPacket({
    externalPacket,
    createdAt: externalPacket.capturedAt ?? null,
    generatedBy: { bridge: "external-intelligence", formatVersion: JEV_EXTERNAL_DECIDE_VERSION },
  });
  const questions = buildExternalIntelligenceQuestions();
  const comparators = externalIntelligenceComparators(externalPacket);

  let resolvedRoot = root;
  let resolvedExperimentId = experimentId;
  if (persist) {
    if (!resolvedExperimentId) {
      resolvedExperimentId = jevExperimentIdFor({
        provider: provider?.name ?? "disabled",
        startedAt: now(),
        salt: `${externalPacket.captureId ?? ""}:external-intelligence`,
      });
    }
    resolvedRoot = jevExperimentRootFor(experimentRootBase, resolvedExperimentId);
    const existing = await readJevExperiment(resolvedRoot);
    if (!existing) {
      await writeJevExperiment(
        resolvedRoot,
        createJevExperiment({
          experimentId: resolvedExperimentId,
          provider: provider?.name ?? null,
          model: provider?.model ?? null,
          decisionPacketVersion: JEV_EXTERNAL_INTELLIGENCE_PACKET_VERSION,
          questionSetId: JEV_EXTERNAL_INTELLIGENCE_QUESTION_SET_ID,
          questionSetVersion: JEV_EXTERNAL_INTELLIGENCE_QUESTION_SET_VERSION,
          cacheEnabled: cacheEnabled === true,
          maxCallsPerRun: budget?.max ?? null,
          startedAt: now(),
        }),
      );
    }
  } else {
    resolvedRoot = null;
  }

  const { run, decision } = await jevDecide({
    provider,
    packet: jevPacket,
    questions,
    questionSetId: JEV_EXTERNAL_INTELLIGENCE_QUESTION_SET_ID,
    questionSetVersion: JEV_EXTERNAL_INTELLIGENCE_QUESTION_SET_VERSION,
    decisionPacketVersion: JEV_EXTERNAL_INTELLIGENCE_PACKET_VERSION,
    experimentId: resolvedExperimentId,
    root: resolvedRoot,
    cacheEnabled: cacheEnabled === true,
    budget,
    now,
    salt,
  });

  let decisionRecord = null;
  if (persist && resolvedRoot) {
    const decisionId = jevDecisionIdFor({
      experimentId: resolvedExperimentId,
      packetKind: JEV_EXTERNAL_INTELLIGENCE_PACKET_KIND,
      subjectDigest: externalPacket.packetDigest,
      questionSetId: JEV_EXTERNAL_INTELLIGENCE_QUESTION_SET_ID,
    });
    decisionRecord = buildJevDecisionRecord({
      decisionId,
      experimentId: resolvedExperimentId,
      packetKind: JEV_EXTERNAL_INTELLIGENCE_PACKET_KIND,
      // The source external packet's immutable digest is the decision's subject.
      subjectDigest: externalPacket.packetDigest,
      questionSetId: JEV_EXTERNAL_INTELLIGENCE_QUESTION_SET_ID,
      questionSetVersion: JEV_EXTERNAL_INTELLIGENCE_QUESTION_SET_VERSION,
      decisionPacketVersion: JEV_EXTERNAL_INTELLIGENCE_PACKET_VERSION,
      stateDigest: run.stateDigest,
      jevRunId: run.jevRunId,
      provider: run.provider,
      model: run.model,
      status: run.status,
      answers: decision === "NO_JEV_DECISION" ? null : decision,
      syntheticDecision: run.syntheticDecision === true,
      deterministicComparators: comparators,
      predictedAt: run.completedAt,
      // Transport provenance: one logical decision may have taken several
      // physical attempts, and the historical record must show all of them.
      providerAttempts: run.providerAttempts ?? null,
      providerAttemptCount: run.providerAttemptCount ?? null,
    });
    await writeJevDecision(resolvedRoot, decisionRecord);
  }

  return {
    externalPacket,
    jevPacket,
    questions,
    comparators,
    run,
    decision,
    decisionRecord,
    experimentId: resolvedExperimentId,
    root: resolvedRoot,
    stateDigest: run.stateDigest,
  };
}

/** Digest of the whole bridge configuration, for provenance in reports. */
export function externalIntelligenceBridgeIdentity() {
  return {
    packetVersion: JEV_EXTERNAL_INTELLIGENCE_PACKET_VERSION,
    packetKind: JEV_EXTERNAL_INTELLIGENCE_PACKET_KIND,
    questionSetId: JEV_EXTERNAL_INTELLIGENCE_QUESTION_SET_ID,
    questionSetVersion: JEV_EXTERNAL_INTELLIGENCE_QUESTION_SET_VERSION,
    questionNames: [...EXTERNAL_INTELLIGENCE_QUESTION_NAMES],
    primaryConcernVocab: [...PRIMARY_CONCERN_VOCAB],
    researchDispositionVocab: [...RESEARCH_DISPOSITION_VOCAB],
    externalPacketVersion: EXTERNAL_INTELLIGENCE_PACKET_VERSION,
    digest: digestOf({
      packetVersion: JEV_EXTERNAL_INTELLIGENCE_PACKET_VERSION,
      packetKind: JEV_EXTERNAL_INTELLIGENCE_PACKET_KIND,
      questionSetId: JEV_EXTERNAL_INTELLIGENCE_QUESTION_SET_ID,
      questionSetVersion: JEV_EXTERNAL_INTELLIGENCE_QUESTION_SET_VERSION,
    }),
  };
}

/** `NO_JEV_DECISION`-shaped statuses never carry a disposition. */
export function isExternalShadowFailure(status) {
  return !status || status !== JEV_STATUS.OK;
}
