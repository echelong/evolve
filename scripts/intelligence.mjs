#!/usr/bin/env node
/**
 * Phase 5E — external-intelligence CLI (PAPER ONLY, READ-ONLY, SHADOW ONLY).
 *
 *   npm run intelligence            -- --provider mock --fixture synthetic
 *   npm run intelligence:capture    -- --query-set reach-query-set-v1 --candidates candidates.json
 *   npm run intelligence:capture    -- --provider agent-reach --query-set reach-query-set-v1 --candidates candidates.json
 *   npm run intelligence:replay     -- --capture capture-20260919T120000Z
 *   npm run intelligence:stats      -- --capture capture-20260919T120000Z
 *   npm run intelligence:doctor     [-- --probe] [-- --save]
 *   npm run probe:reach
 *
 * ACTIONS (exactly one; `capture` is the default for `npm run intelligence`):
 *
 *   capture   run ONE bounded, read-only capture and freeze it. Refuses when the
 *             provider is `disabled` (the default) and never overwrites an
 *             existing capture.
 *   replay    replay a FROZEN capture offline (zero network) and print the
 *             bounded evidence/features. Fail-closed on integrity mismatch.
 *   stats     read-only capture inventory (no records printed).
 *   doctor    configuration/health report. No live probe unless `--probe`, and
 *             nothing is persisted unless `--save`.
 *   version   print the pinned Agent-Reach identity and the allowlists.
 *
 * PAPER ONLY. No wallet, no signer, no write RPC, no posting, no GitHub writes.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { access } from "node:fs/promises";
import path from "node:path";

import { parseArgs } from "./lib/args.mjs";
import {
  AGENT_REACH_PIN,
  DEFAULT_INTELLIGENCE_PROVIDER,
  DISABLED_INTELLIGENCE_CHANNELS,
  ENABLED_INTELLIGENCE_CHANNELS,
  INTELLIGENCE_DIR,
  READ_ONLY_ACTIONS,
  REGISTERED_INTELLIGENCE_PROVIDERS,
  WRITE_ACTIONS,
  resolveIntelligenceConfig,
} from "./intelligence/config.mjs";
import { listCaptureSummaries } from "./intelligence/dashboard.mjs";
import { CAPTURE_SCHEMA_VERSION, listCaptures, runCapture, verifyCapture } from "./intelligence/capture.mjs";
import { DEFAULT_FEATURE_VERSION, REGISTERED_FEATURE_VERSIONS } from "./intelligence/features.mjs";
import { captureStats, replayCapture, verifyReplayDeterminism } from "./intelligence/replay.mjs";
import { buildExternalIntelligencePacket, auditExternalIntelligencePacket } from "./intelligence/packet.mjs";
import {
  REACH_ACTIVE_CAPABILITY_MAP_VERSION,
  REACH_CAPABILITY_MAP_VERSION,
  inspectReachCapabilities,
  probeReachHealth,
  resolveReachBinary,
} from "./intelligence/agent-reach.mjs";
import { REACH_QUERY_SET_ID } from "./intelligence/query-sets.mjs";

const BOOLEAN_FLAGS = ["json", "probe", "save", "help", "verify"];
const VALUE_FLAGS = [
  "action",
  "provider",
  "query",
  "mode",
  "query-set",
  "candidates",
  "fixture",
  "capture",
  "out",
  "max-calls",
  "max-results",
  "timeout-ms",
  "max-bytes",
  "channels",
];

const ACTION = Object.freeze({ CAPTURE: "capture", REPLAY: "replay", STATS: "stats", DOCTOR: "doctor", VERSION: "version" });

/** The synthetic candidate used by `--fixture synthetic` (never Wave 2 data). */
export const SYNTHETIC_FIXTURE_CANDIDATE = Object.freeze({
  symbol: "FIXTURE",
  name: "Fixture Token",
  mint: "FixtureMint1111111111111111111111111111111",
  domain: "fixture.example",
  handle: "@fixture",
});

function usage() {
  return [
    "EVOLVE Phase 5E external intelligence (PAPER ONLY, READ-ONLY, SHADOW ONLY)",
    "",
    "Actions — mutually exclusive, `capture` is the default:",
    "  capture   run ONE bounded read-only capture and freeze it (never overwrites)",
    "  replay    replay a frozen capture offline (zero network, byte-equivalent)",
    "  stats     read-only capture inventory",
    "  doctor    configuration/health report (no live probe unless --probe)",
    "  version   print the pinned Agent-Reach identity and the allowlists",
    "",
    "Options:",
    `  --provider <${REGISTERED_INTELLIGENCE_PROVIDERS.join("|")}>  default ${DEFAULT_INTELLIGENCE_PROVIDER} (disabled)`,
    "  --mode shadow                       the ONLY mode Phase 5E allows",
    `  --query-set <id>                    default ${REACH_QUERY_SET_ID}`,
    "  --candidates <file>                 JSON array of whitelisted token metadata",
    "  --query <text>                      REFUSED in canonical mode (free-form queries are rejected)",
    "  --fixture synthetic                 use the built-in synthetic candidate (offline tests)",
    "  --capture <id>                      capture to replay / inspect",
    "  --out <dir>                         capture root (default .evolve/intelligence)",
    "  --max-calls <n> --max-results <n> --timeout-ms <n> --max-bytes <n>",
    "  --json                              machine-readable output",
    "  --probe                             doctor only: run the read-only Agent-Reach probe",
    "  --save                              doctor only: persist the health report",
    "  --help",
    "",
    "Live internet is NEVER read inside the Arena: observations are captured, frozen, fingerprinted and replayed.",
    "Write-capable actions are rejected before any call; the disabled provider is the default and never has a fallback.",
  ].join("\n");
}

function fail(message) {
  console.error(`[intelligence] ${message}`);
  process.exitCode = 1;
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

/**
 * Render operation-aware capability readiness for the doctor.
 *
 * Channel health is NEVER collapsed into a single status: `web` search (mcporter)
 * and `web` read (curl) are genuinely different capabilities, and the upstream
 * Agent-Reach doctor (which only knows a channel is reachable) is reported
 * SEPARATELY from EVOLVE's frozen local executable readiness.
 */
function formatCapabilityReadiness(readiness, upstreamDoctor) {
  const lines = [];
  for (const channel of readiness.channels) {
    lines.push(`${channel}:`);
    lines.push(`  upstream doctor: ${upstreamDoctor}`);
    for (const operation of Object.keys(readiness.byChannel[channel]).sort()) {
      const row = readiness.byChannel[channel][operation];
      lines.push(
        row.available
          ? `  ${operation}: ready (${row.binary})`
          : `  ${operation}: unavailable (${row.binary} missing)`,
      );
    }
  }
  return lines;
}

/**
 * Resolve the action from `--action <name>` or the leading positional
 * (`npm run intelligence:capture` → `node scripts/intelligence.mjs capture`).
 * A stray positional that is not a known action is an error rather than a
 * silent fall-through to `capture`.
 */
function resolveAction(args) {
  const explicit = typeof args.action === "string" ? args.action.trim().toLowerCase() : null;
  const positional = Array.isArray(args._) && typeof args._[0] === "string" ? args._[0].trim().toLowerCase() : null;
  if (explicit && positional && positional !== explicit) {
    return { ok: false, action: null, error: `conflicting actions: positional '${positional}' vs --action '${explicit}'` };
  }
  if (positional && !Object.values(ACTION).includes(positional)) {
    return { ok: false, action: null, error: `unknown action '${positional}' (expected ${Object.values(ACTION).join(", ")})` };
  }
  const requested = explicit ?? positional ?? (args.capture !== undefined ? ACTION.REPLAY : ACTION.CAPTURE);
  if (!Object.values(ACTION).includes(requested)) {
    return { ok: false, action: null, error: `unknown action '${requested}' (expected ${Object.values(ACTION).join(", ")})` };
  }
  return { ok: true, action: requested, error: null };
}

async function readCandidates(args) {
  if (typeof args.candidates === "string" && args.candidates.trim().length > 0) {
    const text = await readFile(path.resolve(args.candidates), "utf8");
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) throw new Error("--candidates must be a JSON array of token metadata");
    return { candidates: parsed, source: path.resolve(args.candidates) };
  }
  if (args.fixture === "synthetic") {
    return { candidates: [{ ...SYNTHETIC_FIXTURE_CANDIDATE }], source: "synthetic-fixture" };
  }
  if (args.fixture !== undefined) {
    throw new Error(`unknown fixture '${args.fixture}' (only 'synthetic' exists)`);
  }
  return { candidates: [], source: null };
}

/* ============================================================================
 * Actions
 * ==========================================================================*/

async function captureAction({ args, config, root }) {
  // Fail closed on the disabled provider BEFORE anything else is read.
  if (!config.enabled) {
    fail(
      `capture refused: the intelligence provider is DISABLED (the default). Pass \`--provider mock\` (offline fixture) or \`--provider agent-reach\` (read-only adapter).`,
    );
    return;
  }
  const { candidates, source } = await readCandidates(args);
  if (candidates.length === 0) {
    fail(
      "capture refused: no token metadata was supplied. Pass `--candidates <file>` (whitelisted metadata) or `--fixture synthetic`. " +
        "Free-form queries are never accepted in canonical Phase 5E.",
    );
    return;
  }
  const result = await runCapture({
    root,
    config,
    candidates,
    querySetId: String(args["query-set"] ?? REACH_QUERY_SET_ID),
    // Free-form queries are refused in canonical Phase 5E: only rendered
    // queries from the versioned query set may ever reach a provider.
    requestedQuery: typeof args.query === "string" ? args.query : null,
    provider: config.provider,
    env: process.env,
  });
  const packet = buildExternalIntelligencePacket({
    replay: {
      captureId: result.captureId,
      captureManifestDigest: result.manifest.manifestDigest,
      provider: result.provider,
      syntheticIntelligence: result.manifest.syntheticIntelligence,
      capturedAt: result.manifest.startedAt,
      channels: result.manifest.queries.channels,
      querySetId: result.manifest.queries.querySetId,
      counts: result.manifest.counts,
      health: result.manifest.health,
      features: null,
    } ,
  });
  if (args.json === true) {
    printJson({
      action: ACTION.CAPTURE,
      captureId: result.captureId,
      dir: result.dir,
      provider: result.provider,
      contentSource: source,
      counts: result.manifest.counts,
      manifestDigest: result.manifest.manifestDigest,
      captureSchemaVersion: result.manifest.captureSchemaVersion,
      featureVersion: result.manifest.featureVersion,
      capabilityMapVersion: result.manifest.capabilityMapVersion ?? null,
      recordsDigest: result.manifest.digests.recordsDigest,
      channels: result.manifest.queries.channels,
      health: result.manifest.health,
      packetAudit: auditExternalIntelligencePacket(packet),
      networkCalls: config.provider === "agent-reach" ? result.calls : 0,
      note: "Frozen capture. Replay reads these bytes; the live internet is never read by the evaluator.",
    });
    return;
  }
  console.log(`[intelligence] capture ${result.captureId}`);
  console.log(`[intelligence]   dir:        ${result.dir}`);
  console.log(`[intelligence]   provider:   ${result.provider}`);
  console.log(`[intelligence]   records:    ${result.manifest.counts.records}`);
  console.log(`[intelligence]   channels:   ${(result.manifest.queries.channels ?? []).join(", ") || "none"}`);
  console.log(`[intelligence]   failures:   ${result.manifest.counts.failures} · timeouts: ${result.manifest.counts.timeouts}`);
  console.log(`[intelligence]   pinned:     capture schema ${result.manifest.captureSchemaVersion} · feature ${result.manifest.featureVersion}`);
  if (result.manifest.capabilityMapVersion) {
    console.log(`[intelligence]   capability: ${result.manifest.capabilityMapVersion}`);
  }
  console.log(`[intelligence]   digest:     ${result.manifest.manifestDigest}`);
  console.log("[intelligence] captured, frozen and fingerprinted. Nothing was routed to Jev, DeepSeek or the Arena.");
}

async function replayAction({ args, root }) {
  const captureId = String(args.capture ?? "");
  if (!captureId) {
    fail("replay requires --capture <id> (see `npm run intelligence:stats`)");
    return;
  }
  const replay = await replayCapture({ root, captureId, asOf: Date.now() });
  const determinism = await verifyReplayDeterminism({ root, captureId });
  const packet = buildExternalIntelligencePacket({ replay });
  if (args.json === true) {
    printJson({
      action: ACTION.REPLAY,
      ...captureStats(replay),
      features: replay.features,
      replayDigest: replay.replayDigest,
      determinism,
      packet,
      packetAudit: auditExternalIntelligencePacket(packet),
      networkCalls: 0,
    });
    return;
  }
  console.log(`[intelligence] replay ${captureId}`);
  console.log(`[intelligence]   records:   ${replay.recordCount}`);
  console.log(`[intelligence]   provider:  ${replay.provider}${replay.syntheticIntelligence ? " (SYNTHETIC)" : ""}`);
  if (replay.provenance?.legacyProvenanceMismatch) {
    // Distinguish immutable stored provenance from current corrected behavior:
    // the historical artifact bytes are never rewritten.
    console.log(
      `[intelligence]   provenance: stored manifest says ${replay.provenance.storedSyntheticIntelligence ? "SYNTHETIC" : "real"} ` +
        `(legacy empty-capture rule) — corrected provider provenance is ${replay.provenance.correctedSyntheticIntelligence ? "SYNTHETIC" : "real"} ` +
        "(the frozen artifact is unchanged)",
    );
  }
  console.log(
    `[intelligence]   versions:  capture schema ${replay.captureSchemaVersion ?? "unknown"} · feature ${replay.featureVersion} · replay ${replay.replayVersion}`,
  );
  console.log(`[intelligence]   features:  mentions ${replay.features.mentionCount} · authors ${replay.features.uniqueAuthors} · dupText ${replay.features.duplicateTextRatio} · coordination ${replay.features.coordinationIndicators.count}`);
  console.log(`[intelligence]   replayDigest: ${replay.replayDigest} (deterministic: ${determinism.ok})`);
  console.log("[intelligence] replayed offline: zero network calls, zero provider calls, zero routing.");
}

async function statsAction({ args, root }) {
  const captureId = typeof args.capture === "string" ? args.capture : null;
  if (captureId) {
    const replay = await replayCapture({ root, captureId, asOf: Date.now() });
    const integrity = await verifyCapture(root, captureId);
    if (args.json === true) printJson({ action: ACTION.STATS, ...captureStats(replay), integrity, networkCalls: 0 });
    else {
      console.log(`[intelligence] stats ${captureId}`);
      console.log(`[intelligence]   integrity: ${integrity.ok} · records ${replay.recordCount} · calls ${replay.counts.calls ?? 0}`);
      console.log(`[intelligence]   manifest:  ${replay.captureManifestDigest}`);
    }
    return;
  }
  const rows = await listCaptureSummaries(root);
  const captures = await listCaptures(root);
  if (args.json === true) printJson({ action: ACTION.STATS, captures: captures.length, rows, networkCalls: 0 });
  else {
    console.log(`[intelligence] capture inventory (${captures.length} capture(s))`);
    for (const row of rows) {
      console.log(
        `[intelligence]   ${row.captureId}  provider=${row.provider}  records=${row.records}  failures=${row.failures}${row.syntheticIntelligence ? "  SYNTHETIC" : ""}`,
      );
    }
    if (rows.length === 0) console.log("[intelligence]   (none yet — no capture has been taken in this workspace)");
  }
}

async function doctorAction({ args, config, root }) {
  const binary = (() => {
    try {
      return resolveReachBinary({ reachBin: config.reachBin });
    } catch (error) {
      return { error: String(error?.message ?? error) };
    }
  })();
  let binaryExists = false;
  if (typeof binary === "string") {
    binaryExists = await access(binary).then(() => true).catch(() => false);
  }

  // Operation-aware capability readiness. Purely offline: it resolves each frozen
  // (channel, operation) capability against the bounded sanitized-PATH walk and
  // spawns NOTHING. This is the distinction the coarse channel health could not
  // make — e.g. `web` read ready via `curl` while `web` search is unavailable
  // because `mcporter` is missing.
  //
  // The V1 map stays the documented readiness basis: its (operation, channel,
  // executable) triples are IDENTICAL to V2's — Phase 5G.1b changed only the
  // MCPorter search ARGV, never which executable a capability needs — so local
  // readiness is the same for both contracts. The ACTIVE contract is reported
  // alongside (and asserted triple-identical by `validate:phase5g1b`), so this
  // doctor remains a zero-upstream-statement inspection either way.
  const capabilityReadiness = inspectReachCapabilities({
    reachBin: config.reachBin ?? null,
    projectRoot: process.cwd(),
    env: process.env,
  });

  const report = {
    action: ACTION.DOCTOR,
    phase: "5E",
    paperOnly: true,
    readOnly: true,
    shadowOnly: true,
    provider: config.provider,
    providerEnabled: config.enabled,
    mode: config.mode,
    registeredProviders: [...REGISTERED_INTELLIGENCE_PROVIDERS],
    enabledChannels: [...ENABLED_INTELLIGENCE_CHANNELS],
    disabledChannels: [...DISABLED_INTELLIGENCE_CHANNELS],
    requestedChannels: [...config.channels],
    readOnlyActions: [...READ_ONLY_ACTIONS],
    rejectedWriteActions: [...WRITE_ACTIONS],
    agentReach: { ...AGENT_REACH_PIN },
    captureSchemaVersion: CAPTURE_SCHEMA_VERSION,
    featureVersions: [...REGISTERED_FEATURE_VERSIONS],
    defaultFeatureVersion: DEFAULT_FEATURE_VERSION,
    capabilityMaps: {
      active: REACH_ACTIVE_CAPABILITY_MAP_VERSION,
      historical: REACH_CAPABILITY_MAP_VERSION,
    },
    binary: typeof binary === "string" ? binary : null,
    binaryError: typeof binary === "string" ? null : binary.error ?? null,
    binaryExists,
    capabilityReadiness: {
      // Which map the readiness rows below were resolved against, and which map a
      // NEW capture is bounded by. They are triple-identical today.
      capabilityMapVersion: capabilityReadiness.capabilityMapVersion,
      activeCapabilityMapVersion: REACH_ACTIVE_CAPABILITY_MAP_VERSION,
      // The upstream Agent-Reach doctor health is reported separately from the
      // frozen EVOLVE capability readiness; they are never collapsed.
      health: capabilityReadiness.health,
      channels: capabilityReadiness.channels,
      capabilities: capabilityReadiness.capabilities,
      byChannel: capabilityReadiness.byChannel,
      networkCalls: 0,
      subprocessesSpawned: 0,
    },
    limits: { timeoutMs: config.timeoutMs, maxCalls: config.maxCalls, maxResults: config.maxResults, maxBytes: config.maxBytes },
    probe: null,
    saved: null,
    note:
      binaryExists
        ? "Agent-Reach is present in the project-local directory. `--probe` runs only the side-effect-free `version` + `doctor --json` paths."
        : "Agent-Reach is not installed in the project-local directory; nothing was executed. Install it locally (see README) before a live capture.",
  };

  if (args.probe === true && binaryExists) {
    report.probe = probeReachHealth({ config, env: process.env });
    report.probe.callsExecuted = 2;
  } else if (args.probe === true) {
    report.probe = { skipped: true, reason: "the pinned Agent-Reach binary is not installed in the project-local directory" };
  }

  if (args.save === true) {
    const dir = path.join(root, "health");
    await mkdir(dir, { recursive: true });
    const target = path.join(dir, `reach-health-${new Date().toISOString().replace(/[:.]/g, "")}.json`);
    await writeFile(target, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    report.saved = target;
  }

  if (args.json === true) printJson(report);
  else {
    console.log("[intelligence] Phase 5E doctor (READ-ONLY, SHADOW ONLY)");
    console.log(`[intelligence]   provider:        ${config.provider}${config.enabled ? "" : " (disabled — the default)"}`);
    console.log(`[intelligence]   mode:            ${config.mode}`);
    console.log(`[intelligence]   enabled channels:${ENABLED_INTELLIGENCE_CHANNELS.join(", ")}`);
    console.log(`[intelligence]   disabled channels:${DISABLED_INTELLIGENCE_CHANNELS.join(", ")}`);
    console.log(`[intelligence]   read-only actions:${READ_ONLY_ACTIONS.join(", ")}`);
    console.log(`[intelligence]   pinned Agent-Reach: ${AGENT_REACH_PIN.release} (${AGENT_REACH_PIN.license}, ${AGENT_REACH_PIN.python})`);
    console.log(`[intelligence]   local binary:    ${report.binary ?? report.binaryError} (exists: ${binaryExists})`);
    console.log(`[intelligence]   limits:          timeout ${config.timeoutMs}ms · max calls ${config.maxCalls} · max results ${config.maxResults} · max bytes ${config.maxBytes}`);
    console.log(`[intelligence]   capture schema:  ${CAPTURE_SCHEMA_VERSION} · new captures pin ${DEFAULT_FEATURE_VERSION}`);
    console.log(`[intelligence]   feature versions:${REGISTERED_FEATURE_VERSIONS.join(", ")}`);
    console.log(
      `[intelligence]   capability map:  ${REACH_ACTIVE_CAPABILITY_MAP_VERSION} (active for new captures; ` +
        `${REACH_CAPABILITY_MAP_VERSION} stays frozen for historical captures)`,
    );
    const upstreamDoctor = report.probe
      ? report.probe.skipped
        ? `not run (${report.probe.reason})`
        : `ok=${report.probe.doctor.ok}`
      : "not run (pass --probe)";
    console.log("[intelligence] EVOLVE frozen capability readiness (local executable only; not a claim the source is healthy):");
    for (const line of formatCapabilityReadiness(capabilityReadiness, upstreamDoctor)) console.log(`[intelligence]   ${line}`);
    if (report.probe) {
      console.log(`[intelligence]   probe:           ${report.probe.skipped ? `SKIPPED (${report.probe.reason})` : `version=${report.probe.version.stdout || "n/a"} doctorOk=${report.probe.doctor.ok}`}`);
    } else {
      console.log("[intelligence]   probe:           not run (pass --probe)");
    }
    console.log(`[intelligence]   persisted:       ${report.saved ?? "nothing (pass --save to write a health report)"}`);
  }
}

function versionAction({ args, config }) {
  const payload = {
    action: ACTION.VERSION,
    phase: "5E",
    paperOnly: true,
    readOnly: true,
    shadowOnly: true,
    agentReach: { ...AGENT_REACH_PIN },
    captureSchemaVersion: CAPTURE_SCHEMA_VERSION,
    featureVersions: [...REGISTERED_FEATURE_VERSIONS],
    defaultFeatureVersion: DEFAULT_FEATURE_VERSION,
    enabledChannels: [...ENABLED_INTELLIGENCE_CHANNELS],
    disabledChannels: [...DISABLED_INTELLIGENCE_CHANNELS],
    readOnlyActions: [...READ_ONLY_ACTIONS],
    writeActionsRejected: [...WRITE_ACTIONS],
    provider: config.provider,
    mode: config.mode,
  };
  if (args.json === true) printJson(payload);
  else {
    console.log(`[intelligence] pinned Agent-Reach: ${AGENT_REACH_PIN.release} · commit ${AGENT_REACH_PIN.commit}`);
    console.log(`[intelligence] repository: ${AGENT_REACH_PIN.repository} · ${AGENT_REACH_PIN.license} · Python ${AGENT_REACH_PIN.python}`);
    console.log(`[intelligence] channels: ${ENABLED_INTELLIGENCE_CHANNELS.join(", ")}`);
    console.log(`[intelligence] capture schema: ${CAPTURE_SCHEMA_VERSION} · feature transforms: ${REGISTERED_FEATURE_VERSIONS.join(", ")}`);
    console.log(`[intelligence] new captures pin: ${DEFAULT_FEATURE_VERSION} (legacy schema-1 captures stay on V1)`);
  }
}

/* ============================================================================
 * Dispatch
 * ==========================================================================*/

async function main() {
  const args = parseArgs(process.argv.slice(2), { booleanFlags: BOOLEAN_FLAGS, valueFlags: VALUE_FLAGS });
  if (args.help === true) {
    console.log(usage());
    return;
  }

  const resolved = resolveAction(args);
  if (!resolved.ok) {
    fail(resolved.error);
    console.error("");
    console.error(usage());
    return;
  }

  let config;
  try {
    config = resolveIntelligenceConfig({
      ...process.env,
      ...(typeof args.provider === "string" ? { EVOLVE_INTELLIGENCE_PROVIDER: args.provider } : {}),
      ...(typeof args.mode === "string" ? { EVOLVE_INTELLIGENCE_MODE: args.mode } : {}),
      ...(typeof args.channels === "string" ? { EVOLVE_REACH_CHANNELS: args.channels } : {}),
      ...(typeof args["max-calls"] === "string" ? { EVOLVE_REACH_MAX_CALLS: args["max-calls"] } : {}),
      ...(typeof args["max-results"] === "string" ? { EVOLVE_REACH_MAX_RESULTS: args["max-results"] } : {}),
      ...(typeof args["timeout-ms"] === "string" ? { EVOLVE_REACH_TIMEOUT_MS: args["timeout-ms"] } : {}),
      ...(typeof args["max-bytes"] === "string" ? { EVOLVE_REACH_MAX_BYTES: args["max-bytes"] } : {}),
    });
  } catch (error) {
    fail(String(error?.message ?? error));
    return;
  }

  const root = path.resolve(String(args.out ?? process.env.EVOLVE_INTELLIGENCE_DIR ?? INTELLIGENCE_DIR));

  switch (resolved.action) {
    case ACTION.CAPTURE:
      return captureAction({ args, config, root });
    case ACTION.REPLAY:
      return replayAction({ args, root });
    case ACTION.STATS:
      return statsAction({ args, root });
    case ACTION.DOCTOR:
      return doctorAction({ args, config, root });
    case ACTION.VERSION:
      return versionAction({ args, config });
    default:
      fail(`unknown action '${resolved.action}'`);
      return;
  }
}

main().catch((error) => {
  console.error(`[intelligence] failed: ${error?.message ?? error}`);
  process.exitCode = 1;
});
