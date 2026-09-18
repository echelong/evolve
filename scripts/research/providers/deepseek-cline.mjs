/**
 * DeepSeek V4.1 Flash research provider, through the locally installed Cline CLI
 * (Phase 5B). OPTIONAL: `mock` remains the default provider.
 *
 * Contract with the rest of EVOLVE — identical to the mock provider:
 *
 *   input:  a bounded, TRAIN-only evidence packet + a role + a bounded call budget
 *   output: raw proposal-shaped objects, which the strict schema then validates
 *           and the deterministic compiler then turns into genomes (or rejects)
 *
 * What this provider is NOT allowed to do, by construction:
 *   - it never trades, never places orders, never touches a wallet or key, never
 *     signs, never builds a transaction, never calls an RPC
 *   - it never changes Arena gates, scores, promotion rules, or its own outcome
 *   - it never sees validation/test/out-of-sample/deployment evidence
 *   - it never executes anything the model says: output is parsed as JSON, and
 *     only the deterministic schema decides what survives
 *
 * Every call is bounded (wall-clock timeout, attempt count, call budget), and
 * every failure becomes an explicit status. There is NO fallback to the mock
 * provider: a failed external call is reported as a failure, never disguised as
 * research.
 *
 * PAPER ONLY research machinery.
 */

import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";

import { digestOf } from "../../lib/hash.mjs";
import { PROVIDER_STATUS, resolveProviderConfig } from "../provider-config.mjs";
import { RESEARCH_PROMPT_VERSION, buildResearchPrompt, proposingRoles } from "../prompt.mjs";
import { EVIDENCE_PACKET_VERSION, buildResearchEvidencePacket, evidenceDigestOf } from "../evidence-packet.mjs";
import { PROPOSAL_SCHEMA_VERSION, validateProposal } from "../proposal-schema.mjs";
import {
  buildClineArgs,
  createProviderRunRecord,
  ensureProviderWorkdir,
  extractAssistantText,
  extractJsonObject,
  providerCacheKey,
  proposalRequestIdFor,
  readProviderCache,
  readProviderOutput,
  resolveClineCommand,
  runClineProcess,
  safeDiagnostic,
  writeProviderCache,
  writeProviderOutput,
  writeProviderRun,
} from "../provider-runtime.mjs";

export const DEEPSEEK_CLINE_PROVIDER = "deepseek-cline";

/** Statuses that justify a retry (transport/format problems, never verdicts). */
const RETRYABLE_STATUSES = new Set([
  PROVIDER_STATUS.TIMEOUT,
  PROVIDER_STATUS.PROCESS_ERROR,
  PROVIDER_STATUS.UNAVAILABLE,
]);

/** A provider run id: deterministic per call site, safe as a file name. */
export function providerRunIdFor({ experimentId = null, role, cycle = 1, slot = 1, attempt = 1, salt = "" }) {
  const digest = digestOf({ experimentId, role, cycle, slot, attempt, salt }).slice(0, 10);
  return `R-${digest}`;
}

function nowIso(now) {
  return new Date(now()).toISOString();
}

/* ============================================================================
 * One bounded provider call
 * ==========================================================================*/

/**
 * Make one research call and reduce it to either a schema-valid proposal or an
 * explicit failure status.
 *
 * @returns {{ run: object, proposal: object|null }}
 */
async function callProviderOnce({
  route,
  role,
  evidence,
  experimentId,
  cycle,
  slot,
  seed,
  promptVersion,
  evidencePacketVersion,
  evidenceDigest,
  identity,
  cacheEnabled,
  workdir,
  secrets = [],
}) {
  const { config, root, now, spawnImpl } = route;
  const promptDigest = digestOf({ role, promptVersion, evidenceDigest, experimentId, cycle, slot });
  const runId = providerRunIdFor({ experimentId, role, cycle, slot, attempt: 1 });
  // The identity of THIS logical proposal slot — deterministic, not wall-clock
  // based. This is what the cache key is scoped to: it is what stops cycle 2's
  // `regime-researcher` slot from silently reusing cycle 1's cached answer for
  // a brand-new cohort (Phase 5B.2 bugfix).
  const proposalRequestId = proposalRequestIdFor({ experimentId, cycle, slot, role, seed });

  const base = {
    providerRunId: runId,
    experimentId,
    provider: DEEPSEEK_CLINE_PROVIDER,
    model: config.model,
    reasoning: config.reasoning,
    authorRole: role,
    promptVersion,
    evidencePacketVersion,
    evidenceDigest,
    promptDigest,
    contextTruncated: evidence?.truncation?.occurred === true,
  };

  const cacheKey = providerCacheKey({
    provider: DEEPSEEK_CLINE_PROVIDER,
    model: config.model,
    reasoning: config.reasoning,
    role,
    promptVersion,
    evidencePacketVersion,
    evidenceDigest,
    schemaVersion: PROPOSAL_SCHEMA_VERSION,
    proposalRequestId,
  });

  // ---- cache ---------------------------------------------------------------
  if (cacheEnabled && root) {
    const cached = await readProviderCache(root, cacheKey);
    if (cached?.proposal) {
      const revalidated = validateProposal(cached.proposal);
      if (revalidated.ok) {
        route.stats.cacheHits += 1;
        const run = createProviderRunRecord({
          ...base,
          status: PROVIDER_STATUS.OK,
          // Never claim a cache hit was a fresh model call: the reason names
          // the exact logical slot being replayed from memoized state.
          reason: `cache hit: reused a persisted proposal for the same logical proposal slot (${proposalRequestId})`,
          cacheHit: true,
          requestStartedAt: nowIso(now),
          requestCompletedAt: nowIso(now),
          latencyMs: 0,
          schemaValid: true,
          proposalId: revalidated.proposal.proposalId,
        });
        run.cacheKey = cacheKey;
        run.proposalRequestId = proposalRequestId;
        run.cycle = cycle;
        run.slot = slot;
        // Provenance of the ORIGINAL provider run this cache entry came from,
        // distinct from the current request slot recorded above. For a real
        // cache hit the two always describe the same logical slot (the cache
        // key is scoped to it) — this field just makes that traceable rather
        // than implicit.
        run.originalProviderRunId = cached.providerRunId ?? null;
        return { run, proposal: revalidated.proposal };
      }
      // A cached payload that no longer validates is not repaired and not used.
      route.stats.lastError = "cached provider output failed re-validation";
    }
  }

  // ---- live call -----------------------------------------------------------
  const prompt = buildResearchPrompt({ role, evidence, identity, experimentId, cycle, slot, seed });
  const { command, baseArgs } = resolveClineCommand({
    executable: config.executable,
    executableIsScript: config.executableIsScript,
  });
  const timeoutSeconds = Math.max(30, Math.floor(config.timeoutMs / 1000) - 10);
  const args = buildClineArgs({
    profile: config.profile,
    model: config.model,
    reasoning: config.reasoning,
    prompt,
    timeoutSeconds,
    cwd: workdir,
    json: true,
  });
let attempt = 0;
  let last = null;
  for (attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
    const result = await runClineProcess({
      command,
      args: [...baseArgs, ...args],
      timeoutMs: config.timeoutMs,
      cwd: workdir,
      env: route.env ?? process.env,
      maxOutputChars: config.maxStreamChars ?? config.maxResponseChars,
      spawnImpl,
      now,
    });

    if (result.status === PROVIDER_STATUS.OK) {
      const assistant = extractAssistantText(result.stdout);
      const text = assistant.text ?? "";
      if (text.trim().length === 0) {
        last = { ...result, status: PROVIDER_STATUS.INVALID_OUTPUT, failureDetail: "provider returned empty output" };
      } else if (text.length > config.maxResponseChars) {
        last = {
          ...result,
          status: PROVIDER_STATUS.INVALID_OUTPUT,
          failureDetail: `provider answer exceeded ${config.maxResponseChars} characters`,
          oversized: true,
          rawOutputDigest: digestOf(text),
        };
      } else {
        const extraction = extractJsonObject(text);
        if (!extraction.ok) {
          last = {
            ...result,
            status: PROVIDER_STATUS.INVALID_OUTPUT,
            failureDetail: extraction.reason,
            rawOutputDigest: digestOf(text),
            usage: assistant.usage ?? null,
          };
        } else {
          const validated = validateProposal(extraction.value);
          last = {
            ...result,
            rawOutputDigest: digestOf(text),
            extractionMethod: extraction.method,
            validated,
            usage: assistant.usage ?? null,
          };
          if (!validated.ok) {
            last.status = PROVIDER_STATUS.SCHEMA_REJECTED;
            last.failureDetail = `schema rejected provider output: ${validated.errors.join("; ")}`;
          }
        }
      }
    } else {
      last = result;
    }

    if (last.status === PROVIDER_STATUS.OK) break;
    if (!RETRYABLE_STATUSES.has(last.status)) break;
  }

  const status = last?.status ?? PROVIDER_STATUS.UNAVAILABLE;
  const proposal = status === PROVIDER_STATUS.OK ? last.validated.proposal : null;
  route.stats.calls += 1;
  if (status !== PROVIDER_STATUS.OK) {
    route.stats.failures += 1;
    if (status === PROVIDER_STATUS.SCHEMA_REJECTED) route.stats.schemaRejects += 1;
    route.stats.lastError = last?.failureDetail ?? status;
  }

  const run = createProviderRunRecord({
    ...base,
    status,
    reason: last?.failureDetail ?? null,
    attempts: Math.max(1, Math.min(attempt, config.maxAttempts)),
    requestStartedAt: last?.startedAt ?? nowIso(now),
    requestCompletedAt: last?.completedAt ?? nowIso(now),
    latencyMs: Number.isFinite(last?.latencyMs) ? last.latencyMs : null,
    rawOutputDigest: last?.rawOutputDigest ?? null,
    schemaValid: status === PROVIDER_STATUS.OK ? true : status === PROVIDER_STATUS.SCHEMA_REJECTED ? false : null,
    proposalId: proposal?.proposalId ?? null,
    usage: { ...(last?.usage ?? {}), durationMs: last?.usage?.durationMs ?? last?.latencyMs ?? null },
    executableMissing: last?.executableMissing === true,
    oversized: last?.oversized === true,
  });
  run.cacheKey = cacheKey;
  run.proposalRequestId = proposalRequestId;
  run.cycle = cycle;
  run.slot = slot;
  run.extractionMethod = last?.extractionMethod ?? null;
  if (last?.failureDetail) run.diagnostic = safeDiagnostic(last.failureDetail, secrets);

  if (root) {
    await writeProviderRun(root, run);
    if (proposal) {
      await writeProviderOutput(root, {
        runId,
        proposal,
        role,
        experimentId,
        meta: { evidenceDigest, proposalRequestId, cycle, slot },
      });
      if (cacheEnabled) {
        await writeProviderCache(root, cacheKey, {
          schemaVersion: 1,
          cacheKey,
          proposalRequestId,
          cycle,
          slot,
          provider: DEEPSEEK_CLINE_PROVIDER,
          model: config.model,
          reasoning: config.reasoning,
          authorRole: role,
          promptVersion,
          evidencePacketVersion,
          evidenceDigest,
          providerRunId: runId,
          proposal,
        });
      }
    }
  }

  return { run, proposal };
}
/* ============================================================================
 * Provider factory
 * ==========================================================================*/

/**
 * Create a DeepSeek-through-Cline research provider.
 *
 * The returned object satisfies the same conceptual contract as the mock:
 * `propose({ evidence, count, seed, cycle, roles })` returns raw proposals and
 * records provenance. Its `runs` array exposes the per-call records for the
 * experiment artifact, dashboard, and tests.
 */
export function createDeepSeekClineProvider(options = {}) {
  const config = { ...resolveProviderConfig(options.env ?? process.env), ...(options.config ?? {}) };
  const root = options.root ?? null;
  const now = options.now ?? (() => Date.now());
  const spawnImpl = options.spawnImpl ?? null;
  // The environment the subprocess inherits. Production uses the process
  // environment; tests inject a controlled bag so the offline stub can select a
  // behaviour without ever touching the real CLI's configuration.
  const subprocessEnv = options.env ?? process.env;
  const defaultRoles = options.roles ? [...options.roles] : null;
  const replayRunIds = [...(options.replayRunIds ?? [])];

  const stats = {
    calls: 0,
    failures: 0,
    cacheHits: 0,
    schemaRejects: 0,
    budgetExceeded: 0,
    replays: 0,
    proposalsAccepted: 0,
    lastError: null,
  };
  const runs = [];

  const identity = {
    provider: DEEPSEEK_CLINE_PROVIDER,
    model: config.model,
    reasoning: config.reasoning,
    external: true,
  };

  /** Replay a saved provider output without ever invoking the CLI. */
  async function replayOne({ runId, role, experimentId, evidenceDigest, effectiveRoot }) {
    stats.replays += 1;
    const saved = await readProviderOutput(effectiveRoot, runId);
    const run = createProviderRunRecord({
      providerRunId: runId,
      experimentId,
      provider: DEEPSEEK_CLINE_PROVIDER,
      model: config.model,
      reasoning: config.reasoning,
      authorRole: role ?? saved?.authorRole ?? null,
      promptVersion: RESEARCH_PROMPT_VERSION,
      evidencePacketVersion: EVIDENCE_PACKET_VERSION,
      evidenceDigest,
      promptDigest: null,
      rawOutputDigest: saved?.proposalDigest ?? null,
      status: PROVIDER_STATUS.OK,
      reason: "replayed persisted provider output (no provider call was made)",
      replay: true,
      requestStartedAt: nowIso(now),
      requestCompletedAt: nowIso(now),
      latencyMs: 0,
      schemaValid: true,
      proposalId: saved?.proposal?.proposalId ?? null,
    });
    if (!saved?.proposal) {
      run.status = PROVIDER_STATUS.INVALID_OUTPUT;
      run.reason = `no saved provider output for run ${runId}`;
      run.schemaValid = null;
      return { run, proposal: null };
    }
    const validated = validateProposal(saved.proposal);
    if (!validated.ok) {
      run.status = PROVIDER_STATUS.SCHEMA_REJECTED;
      run.reason = `replayed output failed validation: ${validated.errors.join("; ")}`;
      run.schemaValid = false;
      return { run, proposal: null };
    }
    return { run, proposal: validated.proposal };
  }

  /**
   * Ask the provider for up to `count` proposals, one bounded call per slot.
   * Async: the caller awaits it. A synchronous provider (the mock) simply
   * returns an array, which `await` accepts unchanged.
   */
  async function propose({
    evidence = {},
    count = 1,
    seed = null,
    cycle = 1,
    roles = null,
    root: rootOverride = null,
    experimentId = null,
    cacheEnabled = null,
    maxCallsPerRun = null,
    config: configOverride = null,
  } = {}) {
    const effectiveConfig = configOverride ? { ...config, ...configOverride } : config;
    const effectiveRoot = rootOverride ?? root ?? path.join(".evolve", "research", "provider");
    const route = { config: effectiveConfig, root: effectiveRoot, now, spawnImpl, stats, env: subprocessEnv };
    const budget = Number.isFinite(maxCallsPerRun) ? maxCallsPerRun : effectiveConfig.maxCallsPerRun;
    const useCache = cacheEnabled === null ? effectiveConfig.cacheEnabled === true : cacheEnabled === true;
    const roleList = (roles ?? defaultRoles ?? proposingRoles()).filter((role) => typeof role === "string");
    const workdir = await ensureProviderWorkdir(effectiveRoot);
    const evidenceDigest = evidenceDigestOf(evidence);

    const proposals = [];
    const limit = Math.max(1, Math.round(Number(count) || 1));

    // ---- replay path: deterministic, zero provider calls -------------------
    if (replayRunIds.length > 0) {
      for (let index = 0; index < Math.min(limit, replayRunIds.length); index += 1) {
        const { run, proposal } = await replayOne({
          runId: replayRunIds[index],
          role: roleList[index % Math.max(1, roleList.length)] ?? null,
          experimentId,
          evidenceDigest,
          effectiveRoot,
        });
        runs.push(run);
        if (proposal) proposals.push(proposal);
      }
      stats.proposalsAccepted += proposals.length;
      return proposals;
    }

    // ---- live path: one bounded call per slot ------------------------------
    for (let index = 0; index < limit; index += 1) {
      const role = roleList[index % Math.max(1, roleList.length)] ?? "signal-researcher";
      const slot = index + 1;

      if (stats.calls >= budget) {
        stats.budgetExceeded += 1;
        const run = createProviderRunRecord({
          providerRunId: providerRunIdFor({ experimentId, role, cycle, slot, attempt: 1, salt: "budget" }),
          experimentId,
          provider: DEEPSEEK_CLINE_PROVIDER,
          model: effectiveConfig.model,
          reasoning: effectiveConfig.reasoning,
          authorRole: role,
          promptVersion: RESEARCH_PROMPT_VERSION,
          evidencePacketVersion: EVIDENCE_PACKET_VERSION,
          evidenceDigest,
          promptDigest: null,
          status: PROVIDER_STATUS.BUDGET_EXCEEDED,
          reason: `provider call budget of ${budget} reached; no further calls were made`,
          requestStartedAt: nowIso(now),
          requestCompletedAt: nowIso(now),
          latencyMs: 0,
        });
        run.proposalRequestId = proposalRequestIdFor({ experimentId, cycle, slot, role, seed });
        run.cycle = cycle;
        run.slot = slot;
        runs.push(run);
        if (effectiveRoot) await writeProviderRun(effectiveRoot, run);
        break;
      }

      const { run, proposal } = await callProviderOnce({
        route,
        role,
        evidence,
        experimentId,
        cycle,
        slot,
        seed,
        promptVersion: RESEARCH_PROMPT_VERSION,
        evidencePacketVersion: EVIDENCE_PACKET_VERSION,
        evidenceDigest,
        identity,
        cacheEnabled: useCache,
        workdir,
      });
      runs.push(run);
      if (proposal) proposals.push(proposal);
    }

    stats.proposalsAccepted += proposals.length;
    return proposals;
  }

  return {
    name: DEEPSEEK_CLINE_PROVIDER,
    model: config.model,
    reasoning: config.reasoning,
    offline: false,
    external: true,
    requiresExecutable: true,
    isAsync: true,
    stats,
    runs,
    describe() {
      return {
        provider: DEEPSEEK_CLINE_PROVIDER,
        model: config.model,
        reasoning: config.reasoning,
        profile: config.profile,
        executable: config.executable,
        offline: false,
        cacheEnabled: config.cacheEnabled === true,
        timeoutMs: config.timeoutMs,
        maxAttempts: config.maxAttempts,
        maxCallsPerRun: config.maxCallsPerRun,
        replay: replayRunIds.length > 0,
      };
    },
    propose,
    /** Cheap structured health probe: one real call, no Arena/champion mutation. */
    async probe({ timeoutMs = config.timeoutMs, role = "signal-researcher", experimentId = null, evidence = {} } = {}) {
      return probeDeepSeekClineProvider({
        provider: { config: { ...config, timeoutMs }, root, now, spawnImpl, stats: { ...stats } },
        role,
        experimentId,
        evidence,
      });
    },
  };
}

/* ============================================================================
 * Health probe
 * ==========================================================================*/

/**
 * Run ONE cheap structured call to verify the provider path end to end:
 * executable present → profile/model/reasoning accepted → response obtained →
 * JSON extracted → proposal schema validated.
 *
 * The probe performs no Arena work, touches no champion, and writes nothing
 * except (optionally, by the caller) its own probe artifact. It never throws:
 * an unavailable provider is a probe RESULT, not a crash.
 *
 * @param {{
 *   provider: object,           // { config, root, now, spawnImpl, stats }
 *   role?: string,
 *   experimentId?: string|null,
 *   evidence?: object|null,
 * }} options
 */
export async function probeDeepSeekClineProvider({ provider, role = "signal-researcher", experimentId = null, evidence = null }) {
  const config = provider?.config ?? resolveProviderConfig();
  const now = provider?.now ?? (() => Date.now());
  const stats = provider?.stats ?? { calls: 0, failures: 0, cacheHits: 0, schemaRejects: 0, lastError: null };
  const allowedRoles = proposingRoles();
  const probeRole = allowedRoles.includes(role) ? role : allowedRoles[0];

  const packet =
    evidence ??
    buildResearchEvidencePacket({
      experimentId,
      researchCycle: 0,
      createdAt: new Date(now()).toISOString(),
      limits: { maxContextChars: 2_000, maxMemoryRecords: 0, maxPriorConclusions: 0, maxRegimeSummaries: 2 },
      generatedBy: { probe: true },
    });

  // A probe must leave NO trace in the repository. The subprocess work directory
  // is a throwaway temp directory (removed below), and `route.root` is null so
  // no run record, saved output, cache entry, or research-memory write happens.
  const workdir = await mkdtemp(path.join(tmpdir(), "evolve-probe-"));
  try {
    const { run } = await callProviderOnce({
      route: {
        config,
        root: null,
        now,
        spawnImpl: provider?.spawnImpl ?? null,
        stats,
        env: provider?.env ?? process.env,
      },
      role: probeRole,
      evidence: packet,
      experimentId,
      cycle: 0,
      slot: 1,
      seed: "probe",
      promptVersion: RESEARCH_PROMPT_VERSION,
      evidencePacketVersion: EVIDENCE_PACKET_VERSION,
      evidenceDigest: evidenceDigestOf(packet),
      identity: {
        provider: DEEPSEEK_CLINE_PROVIDER,
        model: config.model,
        reasoning: config.reasoning,
        external: true,
      },
      cacheEnabled: false,
      workdir,
    });

    return {
      schemaVersion: 1,
      probe: "research-provider",
      provider: DEEPSEEK_CLINE_PROVIDER,
      model: config.model,
      reasoning: config.reasoning,
      profile: config.profile,
      executable: config.executable,
      authorRole: probeRole,
      promptVersion: RESEARCH_PROMPT_VERSION,
      evidencePacketVersion: EVIDENCE_PACKET_VERSION,
      evidenceDigest: run.evidenceDigest,
      status: run.status,
      reason: run.reason,
      latencyMs: run.latencyMs,
      validJson: run.status === PROVIDER_STATUS.OK || run.status === PROVIDER_STATUS.SCHEMA_REJECTED,
      schemaValid: run.status === PROVIDER_STATUS.OK,
      proposalId: run.proposalId,
      rawOutputDigest: run.rawOutputDigest,
      extractionMethod: run.extractionMethod,
      executableMissing: run.executableMissing === true,
      oversized: run.oversized === true,
      usage: run.usage,
      checkedAt: new Date(now()).toISOString(),
      paperOnly: true,
      note: "Probe only. It never mutates the Arena, champions, or research memory.",
    };
  } finally {
    await rm(workdir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Structured, secret-free probe report for the CLI. */
export function formatProbeReport(result) {
  const lines = [
    "EVOLVE research provider probe (PAPER ONLY)",
    `  provider        ${result.provider}`,
    `  model           ${result.model}`,
    `  reasoning       ${result.reasoning}`,
    `  executable      ${result.executable}`,
    `  role            ${result.authorRole}`,
    `  status          ${result.status}`,
    `  latency         ${Number.isFinite(result.latencyMs) ? `${result.latencyMs}ms` : "n/a"}`,
    `  valid JSON      ${result.validJson ? "yes" : "no"}`,
    `  schema valid    ${result.schemaValid ? "yes" : "no"}`,
    `  prompt version  ${result.promptVersion}`,
    `  evidence digest ${result.evidenceDigest ? result.evidenceDigest.slice(0, 12) : "n/a"}`,
  ];
  if (result.reason) lines.push(`  reason          ${result.reason}`);
  if (result.usage) lines.push(`  latency(report) ${result.usage.durationMs ?? "n/a"}ms`);
  lines.push("  note            no secrets are printed; no Arena or champion state was touched");
  return lines.join("\n");
}