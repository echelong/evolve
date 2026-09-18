#!/usr/bin/env node
/**
 * EVOLVE research-provider probe (Phase 5B).
 *
 *   npm run probe:research-provider
 *   npm run probe:research-provider -- --provider mock
 *   npm run probe:research-provider -- --timeout-ms 60000 --json
 *
 * Verifies, cheaply and explicitly:
 *   - the Cline executable exists and can be spawned
 *   - the selected profile / model / reasoning level are accepted
 *   - a structured response can be obtained
 *   - the JSON extractor and the proposal schema both work on it
 *
 * It performs NO Arena work, touches no champion, changes no research memory, and
 * prints no secrets. Its only optional artifact is a dedicated probe record under
 * `.evolve/research/providers/probes/`.
 *
 * PAPER ONLY.
 */

import path from "node:path";

import { parseArgs } from "./lib/args.mjs";
import {
  REGISTERED_PROVIDERS,
  UnknownResearchProviderError,
  requireProviderName,
  resolveProviderConfig,
} from "./research/provider-config.mjs";
import { formatProbeReport, probeDeepSeekClineProvider } from "./research/providers/deepseek-cline.mjs";
import { mockProviderPropose } from "./research/provider.mjs";
import { validateProposal } from "./research/proposal-schema.mjs";

const BOOLEAN_FLAGS = ["json", "help", "save"];
const VALUE_FLAGS = ["provider", "timeout-ms", "role", "experiment"];

function usage() {
  return [
    "EVOLVE research provider probe (PAPER ONLY)",
    "",
    "  npm run probe:research-provider -- [options]",
    "",
    "Options:",
    `  --provider <name>   ${REGISTERED_PROVIDERS.join(" | ")} (default: env, else mock)`,
    "  --timeout-ms <n>    wall-clock bound for the probe call",
    "  --role <role>       researcher role to probe with (default signal-researcher)",
    "  --experiment <id>   experiment id recorded in the probe provenance",
    "  --save              write the probe artifact under the research root (no memory is mutated)",
    "  --json              print the machine-readable probe result",
    "",
    "The probe verifies the executable, profile, model, reasoning level, JSON",
    "extraction, and proposal schema. It never mutates the Arena or champions.",
    "",
    "Provider selection is FAIL-CLOSED: an explicit unregistered provider name is",
    "a configuration error (exit code 2) and nothing is probed.",
  ].join("\n");
}

function probeMock({ experimentId = null }) {
  const packet = buildResearchEvidencePacket({ experimentId, limits: { maxContextChars: 2_000 } });
  const started = Date.now();
  const proposals = mockProviderPropose({ evidence: packet, count: 1, seed: "probe", cycle: 0 });
  const validated = validateProposal(proposals[0] ?? null);
  return {
    schemaVersion: 1,
    probe: "research-provider",
    provider: "mock",
    model: null,
    reasoning: null,
    profile: null,
    executable: null,
    authorRole: proposals[0]?.authorRole ?? null,
    promptVersion: RESEARCH_PROMPT_VERSION,
    status: validated.ok ? "PROVIDER_OK" : "PROVIDER_SCHEMA_REJECTED",
    reason: validated.ok ? null : validated.errors.join("; "),
    latencyMs: Date.now() - started,
    validJson: true,
    schemaValid: validated.ok,
    proposalId: validated.ok ? validated.proposal.proposalId : null,
    rawOutputDigest: null,
    extractionMethod: "deterministic",
    executableMissing: false,
    oversized: false,
    usage: null,
    checkedAt: new Date().toISOString(),
    paperOnly: true,
    note: "The mock provider is deterministic and offline: no subprocess, no network, no key.",
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2), { booleanFlags: BOOLEAN_FLAGS, valueFlags: VALUE_FLAGS });
  if (args.help === true) {
    console.log(usage());
    return;
  }

  const envConfig = resolveProviderConfig();
  // FAIL-CLOSED: resolve the REQUESTED name (flag first, then the environment).
  // An explicit unregistered name throws — the mock provider is never probed in
  // its place, and no probe artifact is written.
  const requestedName = args.provider !== undefined ? String(args.provider) : envConfig.requestedProvider;
  let resolution;
  try {
    resolution = requireProviderName(requestedName);
  } catch (error) {
    console.error(`[probe] ${error.message}`);
    console.error(`[probe] registered providers: ${REGISTERED_PROVIDERS.join(", ")}`);
    console.error(
      "[probe] there is no provider fallback: fix the name, or leave EVOLVE_RESEARCH_PROVIDER unset to use the deterministic mock default.",
    );
    console.error("[probe] no provider was called and no probe artifact was written.");
    process.exitCode = 2;
    return;
  }
  const resolvedProvider = resolution.provider;

  const experimentId = args.experiment ? String(args.experiment) : null;
  const timeoutMs = args["timeout-ms"]
    ? Math.max(1_000, Number.parseInt(String(args["timeout-ms"]), 10) || envConfig.timeoutMs)
    : envConfig.timeoutMs;

  let result;
  if (resolvedProvider === "mock") {
    result = probeMock({ experimentId });
  } else {
    result = await probeDeepSeekClineProvider({
      provider: { config: { ...envConfig, timeoutMs }, root: null, now: () => Date.now(), spawnImpl: null, stats: null },
      role: args.role ? String(args.role) : "signal-researcher",
      experimentId,
    });
  }

  if (args.json === true) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatProbeReport(result));
  }

  if (args.save === true) {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const dir = path.join(".evolve", "research", "providers", "probes");
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `${result.provider}-${Date.now()}.json`);
    await writeFile(file, JSON.stringify(result, null, 2), "utf8");
    console.log(`  artifact        ${file}`);
  }

  process.exitCode = result.status === "PROVIDER_OK" ? 0 : 3;
}

main().catch((error) => {
  if (error instanceof UnknownResearchProviderError) {
    console.error(`[probe] ${error.message}`);
    process.exitCode = 2;
    return;
  }
  console.error("[probe] research provider probe failed:", error?.message ?? error);
  process.exitCode = 1;
});

import { buildResearchEvidencePacket } from "./research/evidence-packet.mjs";
import { RESEARCH_PROMPT_VERSION } from "./research/prompt.mjs";