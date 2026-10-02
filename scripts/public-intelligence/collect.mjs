#!/usr/bin/env node
// Phase 5K.3 - EXPLICIT COLLECTION CLI. Never invoked by any validator.
//
//   node scripts/public-intelligence/collect.mjs collect --instance mastodon.social --hashtag solana \
//        [--provider mastodon] [--max-pages 1] [--max-records 10] [--timeout-ms 10000] \
//        [--max-response-bytes 524288] [--max-lookback-ms 86400000] \
//        [--output <runtime-root>] [--dry-run [--fetch]]
//   node scripts/public-intelligence/collect.mjs verify --run <run-directory>
//
// collect              LIVE bounded run; persists a run directory under the runtime root.
// collect --dry-run    validates the plan and prints its fingerprint; NO provider contact.
// collect --dry-run --fetch   performs the bounded request(s) in memory; PERSISTS NOTHING.
// verify               offline replay + manifest verification of a stored run; no network.
//
// This is the wall-clock boundary: the clock is injected into the orchestrator
// from here and nowhere else. No daemon, no scheduler, no loop.
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { buildCollectionPlan, collectionPlanFingerprint } from './collection-plan.mjs';
import { executeCollectionRun } from './collection-run.mjs';
import { replayRun } from './replay.mjs';
import { PUBLIC_INTELLIGENCE_5K3_DEFAULT_RUNTIME_ROOT, assertSafeRuntimeRoot } from './run-store.mjs';

export const COLLECT_DEFAULT_BOUNDS = Object.freeze({
  maxPages: 1, maxRecords: 10, timeoutMs: 10_000, maxResponseBytes: 512 * 1024, maxLookbackMs: 24 * 60 * 60 * 1000,
});
const FLAGS = Object.freeze({
  '--provider': 'provider', '--instance': 'instance', '--hashtag': 'hashtag', '--max-pages': 'maxPages',
  '--max-records': 'maxRecords', '--timeout-ms': 'timeoutMs', '--max-response-bytes': 'maxResponseBytes',
  '--max-lookback-ms': 'maxLookbackMs', '--output': 'output', '--run': 'run',
});
const SWITCHES = Object.freeze({ '--dry-run': 'dryRun', '--fetch': 'liveDryRun' });
const NUMERIC = new Set(['maxPages', 'maxRecords', 'timeoutMs', 'maxResponseBytes', 'maxLookbackMs']);

/** Strict argv parser: unknown flags and malformed numbers are refused, never ignored. */
export function parseCollectArgs(argv) {
  const [command, ...rest] = argv;
  if (!['collect', 'verify'].includes(command)) throw new Error('CLI_COMMAND_INVALID');
  const parsed = { command, dryRun: false, liveDryRun: false, bounds: { ...COLLECT_DEFAULT_BOUNDS } };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (Object.hasOwn(SWITCHES, arg)) { parsed[SWITCHES[arg]] = true; continue; }
    if (!Object.hasOwn(FLAGS, arg)) throw new Error(`CLI_FLAG_UNKNOWN:${arg.slice(0, 40)}`);
    const value = rest[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`CLI_FLAG_VALUE_MISSING:${arg}`);
    i += 1;
    const key = FLAGS[arg];
    if (NUMERIC.has(key)) {
      if (!/^[0-9]{1,12}$/.test(value)) throw new Error(`CLI_NUMBER_INVALID:${arg}`);
      parsed.bounds[key] = Number(value);
    } else parsed[key] = value;
  }
  if (parsed.liveDryRun && !parsed.dryRun) throw new Error('CLI_FETCH_ONLY_WITH_DRY_RUN');
  return parsed;
}

const aggregate = result => ({
  status: result.status, runId: result.runId, dryRun: result.dryRun,
  verification: result.verification?.ok ?? null,
  directory: result.directory ? path.relative(process.cwd(), result.directory) || '.' : null,
  ...(result.manifest ? {
    requestCount: result.manifest.requestCount, pageCount: result.manifest.pageCount,
    providerRecordsSeen: result.manifest.providerRecordsSeen, recordsMapped: result.manifest.recordsMapped,
    recordsIngested: result.manifest.recordsIngested, duplicates: result.manifest.duplicates,
    conflicts: result.manifest.conflicts, refused: result.manifest.refused,
    rawEvidenceRecordsWritten: result.manifest.rawEvidenceRecordsWritten,
    normalizedRecordsWritten: result.manifest.normalizedRecordsWritten,
    failureCounts: result.manifest.failureCounts, refusedReasons: result.manifest.refusedReasons,
    stopReason: result.manifest.providerCursorSummary.stopReason,
    manifestFingerprint: result.manifest.manifestFingerprint,
  } : { reason: result.reason ?? null }),
});

async function main(argv) {
  const args = parseCollectArgs(argv);
  if (args.command === 'verify') {
    if (!args.run) throw new Error('CLI_RUN_REQUIRED');
    const result = replayRun(path.resolve(args.run));
    console.log(JSON.stringify({ verify: result.ok ? 'PASS' : 'FAIL', failures: result.failures }, null, 2));
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if ((args.provider ?? 'mastodon') !== 'mastodon') throw new Error('CLI_PROVIDER_UNSUPPORTED');
  const plan = buildCollectionPlan({
    instance: (args.instance ?? '').toLowerCase(), hashtag: args.hashtag, bounds: args.bounds,
    collectionMode: 'LIVE_PUBLIC_PROVIDER', createdAt: Date.now(),
  });
  if (args.dryRun && !args.liveDryRun) {
    console.log(JSON.stringify({ dryRun: true, contact: 'none', planFingerprint: collectionPlanFingerprint(plan), bounds: plan.bounds }, null, 2));
    return;
  }
  const outputRoot = args.dryRun ? null : assertSafeRuntimeRoot(path.resolve(args.output ?? PUBLIC_INTELLIGENCE_5K3_DEFAULT_RUNTIME_ROOT));
  const result = await executeCollectionRun(plan, { clock: Date.now, outputRoot, dryRun: args.dryRun });
  console.log(JSON.stringify(aggregate(result), null, 2));
  if (result.status !== 'COMPLETED' || result.verification?.ok === false) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(error => {
    console.error(JSON.stringify({ error: String(error?.message ?? error).split('\n')[0].slice(0, 160) }));
    process.exitCode = 2;
  });
}
