/**
 * Phase 5E — `external-intelligence-packet-v1` (PAPER ONLY, INTERFACE ONLY).
 *
 * A bounded, WHITELIST-ONLY packet describing one frozen capture. It exists so a
 * future phase can hand external intelligence to Phase 5D Jev (and, on Jev's
 * decision only, to a deep-research escalation). NOTHING is routed today:
 *
 *   JEV_ROUTING_ACTIVE = false
 *   DEEPSEEK_ROUTING_ACTIVE = false
 *
 * The packet carries identity, counts, health and the bounded feature vector —
 * never raw social text, never a cookie, never a token, never a URL list, never
 * a strategy, and never anything that could be executed.
 *
 * PAPER ONLY. No wallet, no signing, no write RPC, no posting.
 */

import { canonicalJson, digestOf } from "../lib/hash.mjs";
import { featuresDigestSubject } from "./features.mjs";

export const EXTERNAL_INTELLIGENCE_PACKET_VERSION = "external-intelligence-packet-v1";
export const EXTERNAL_INTELLIGENCE_PACKET_KIND = "external-intelligence-packet";
export const JEV_ROUTING_ACTIVE = false;
export const DEEPSEEK_ROUTING_ACTIVE = false;

/** Dispositions a FUTURE Jev decision could return (no routing is active). */
export const EXTERNAL_INTELLIGENCE_DISPOSITIONS = Object.freeze([
  "ignore",
  "observe",
  "escalate_to_deep_research",
]);

/** The exact keys a packet may contain. Anything else is a hard error. */
export const ALLOWED_PACKET_KEYS = Object.freeze([
  "packetVersion",
  "kind",
  "phase",
  "paperOnly",
  "readOnly",
  "shadowOnly",
  "captureId",
  "captureManifestDigest",
  "provider",
  "syntheticIntelligence",
  "capturedAt",
  "channels",
  "querySetId",
  "counts",
  "health",
  "features",
  "featureVersion",
  "evidenceQuality",
  "routing",
  "packetDigest",
  "note",
]);

/**
 * Keys that must NEVER appear in a packet: raw content, credentials, execution
 * material, or anything the evaluator could act on.
 */
export const FORBIDDEN_PACKET_KEYS = Object.freeze([
  "records",
  "raw",
  "rawRecords",
  "text",
  "textExcerpt",
  "canonicalUrl",
  "url",
  "urls",
  "cookie",
  "cookies",
  "token",
  "tokens",
  "apiKey",
  "authorization",
  "wallet",
  // Both spellings: the sanitizer already treats `private_key` as sensitive too.
  "private_key",
  "privateKey",
  "signer",
  "transaction",
  "strategies",
  "orders",
  "positions",
  "rpc",
]);

export class PacketAuditError extends Error {
  constructor(message) {
    super(message);
    this.name = "PacketAuditError";
  }
}

/**
 * Evidence-quality labels: a bounded, honest statement about how much the
 * snapshot can support. Never a score, never a threshold, never a gate.
 */
export const EVIDENCE_QUALITY = Object.freeze({
  NONE: "NONE",
  WEAK: "WEAK",
  LIMITED: "LIMITED",
  USABLE_CONTEXT: "USABLE_CONTEXT",
});

/** Determine an evidence-quality label deterministically. */
export function evidenceQualityOf({ recordCount = 0, channelCount = 0, failureCount = 0 } = {}) {
  if (recordCount === 0) return EVIDENCE_QUALITY.NONE;
  if (recordCount < 5 || channelCount < 1 || failureCount > 0) return EVIDENCE_QUALITY.WEAK;
  if (recordCount < 20) return EVIDENCE_QUALITY.LIMITED;
  return EVIDENCE_QUALITY.USABLE_CONTEXT;
}

/**
 * Build the packet from a replay result. Pure: it takes the replayed evidence,
 * returns a bounded packet, and routes nothing.
 *
 * @param {{ replay: object, now?: number }} options
 */
export function buildExternalIntelligencePacket({ replay } = {}) {
  if (!replay?.captureId) throw new PacketAuditError("buildExternalIntelligencePacket requires a replay result");
  const recordCount = replay.recordCount ?? 0;
  const channelCount = (replay.channels ?? []).length;
  const failureCount = replay.counts?.failures ?? 0;
  const packet = {
    packetVersion: EXTERNAL_INTELLIGENCE_PACKET_VERSION,
    kind: EXTERNAL_INTELLIGENCE_PACKET_KIND,
    phase: "5E",
    paperOnly: true,
    readOnly: true,
    shadowOnly: true,
    captureId: replay.captureId,
    captureManifestDigest: replay.captureManifestDigest ?? null,
    provider: replay.provider ?? null,
    syntheticIntelligence: replay.syntheticIntelligence === true,
    capturedAt: replay.capturedAt ?? null,
    channels: [...(replay.channels ?? [])],
    querySetId: replay.querySetId ?? null,
    counts: {
      records: recordCount,
      channels: channelCount,
      failures: failureCount,
      timeouts: replay.counts?.timeouts ?? 0,
      calls: replay.counts?.calls ?? 0,
    },
    health: replay.health ?? {},
    // Clock-derived feature fields are dropped so the packet (and its digest) is
    // deterministic for one frozen capture regardless of when it is built.
    features: featuresDigestSubject(replay.features ?? null),
    featureVersion: replay.features?.featureVersion ?? null,
    evidenceQuality: evidenceQualityOf({ recordCount, channelCount, failureCount }),
    routing: {
      // Interface only. Nothing is routed in Phase 5E.
      jevRoutingActive: JEV_ROUTING_ACTIVE,
      deepseekRoutingActive: DEEPSEEK_ROUTING_ACTIVE,
      allowedFutureDispositions: [...EXTERNAL_INTELLIGENCE_DISPOSITIONS],
      disposition: null,
      decidedBy: null,
      note: "No routing is active in Phase 5E: this packet is stored/described only and can never influence EVOLVE.",
    },
    note:
      "Bounded external-intelligence packet. It contains NO raw text, NO URLs, NO credentials and NO execution material. " +
      "Social observations may be noisy or manipulated; external intelligence must prove value experimentally before any future use.",
  };
  packet.packetDigest = packetDigest(packet);
  return packet;
}

/** Digest of the packet's own content (excluding the digest field). */
export function packetDigest(packet) {
  const subject = { ...(packet ?? {}) };
  delete subject.packetDigest;
  return digestOf(subject);
}

/**
 * Audit a packet against the whitelist: unknown keys and forbidden keys are hard
 * errors. This is the guard that keeps a future handoff honest.
 */
export function auditExternalIntelligencePacket(packet) {
  const keys = Object.keys(packet ?? {});
  const unknown = keys.filter((key) => !ALLOWED_PACKET_KEYS.includes(key));
  const forbidden = keys.filter((key) => FORBIDDEN_PACKET_KEYS.includes(key));
  const nestedForbidden = [];
  const walk = (value, trail) => {
    if (value === null || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      // A forbidden NAME holding a compile-time scalar (a count, a status, a
      // boolean) cannot carry content: `counts.records` is a number and
      // `health.x.records` is a number. Arrays/objects under such a name are
      // still rejected, because those could carry raw records or URLs.
      const scalar = child === null || ["number", "boolean"].includes(typeof child);
      if (FORBIDDEN_PACKET_KEYS.includes(key) && !scalar) nestedForbidden.push(`${trail}${key}`);
      walk(child, `${trail}${key}.`);
    }
  };
  walk(packet, "");
  const digestOk = packet?.packetDigest === packetDigest(packet);
  return {
    ok: unknown.length === 0 && forbidden.length === 0 && nestedForbidden.length === 0 && digestOk,
    version: packet?.packetVersion ?? null,
    unknownKeys: unknown,
    forbiddenKeys: forbidden,
    nestedForbiddenKeys: nestedForbidden,
    digestOk,
    serializedBytes: Buffer.byteLength(canonicalJson(packet ?? {}), "utf8"),
    routingActive: packet?.routing?.jevRoutingActive === true || packet?.routing?.deepseekRoutingActive === true,
  };
}

/** Throwing form of the audit (used at every boundary). */
export function assertPacketAllowed(packet) {
  const audit = auditExternalIntelligencePacket(packet);
  if (!audit.ok) {
    throw new PacketAuditError(
      `external-intelligence packet rejected: unknown=${JSON.stringify(audit.unknownKeys)} forbidden=${JSON.stringify([
        ...audit.forbiddenKeys,
        ...audit.nestedForbiddenKeys,
      ])} digestOk=${audit.digestOk}`,
    );
  }
  if (audit.routingActive) {
    throw new PacketAuditError("external-intelligence routing must remain INACTIVE in Phase 5E");
  }
  return packet;
}
