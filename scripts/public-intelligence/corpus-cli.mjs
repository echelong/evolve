#!/usr/bin/env node
// Phase 5K.4 - EXPLICIT CORPUS CLI. Never invoked by any validator. Offline.
//
//   corpus-cli.mjs discover --root <runtime-root> [--include-partial]
//   corpus-cli.mjs build    --root <runtime-root> --runs <runId,runId,...> [--include-partial]
//   corpus-cli.mjs verify   --root <runtime-root> --snapshot <snapshot-id>
//   corpus-cli.mjs inspect  --root <runtime-root> --snapshot <snapshot-id>
//
// discover and inspect are read-only. build requires EXPLICIT run ids (there is no
// "all runs" mode). Output is aggregate/structural only: never post bodies.
// This is the wall-clock boundary: `createdAt` is taken here and injected.
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { assertSafeRuntimeRoot, PUBLIC_INTELLIGENCE_5K3_DEFAULT_RUNTIME_ROOT } from './run-store.mjs';
import { buildCorpusPolicy, discoverRuns } from './corpus-membership.mjs';
import { buildAndStoreSnapshot, corporaDirectoryOf, loadSnapshotArtifacts } from './corpus-snapshot.mjs';
import { verifySnapshot } from './corpus-verify.mjs';

const FLAGS = Object.freeze({ '--root': 'root', '--runs': 'runs', '--snapshot': 'snapshot' });
const SWITCHES = Object.freeze({ '--include-partial': 'includePartial' });

/** Strict argv parser: unknown flags are refused, never ignored. */
export function parseCorpusArgs(argv) {
  const [command, ...rest] = argv;
  if (!['discover', 'build', 'verify', 'inspect'].includes(command)) throw new Error('CLI_COMMAND_INVALID');
  const parsed = { command, includePartial: false, root: null, runs: null, snapshot: null };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (Object.hasOwn(SWITCHES, arg)) { parsed[SWITCHES[arg]] = true; continue; }
    if (!Object.hasOwn(FLAGS, arg)) throw new Error(`CLI_FLAG_UNKNOWN:${arg.slice(0, 40)}`);
    const value = rest[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`CLI_FLAG_VALUE_MISSING:${arg}`);
    i += 1;
    parsed[FLAGS[arg]] = value;
  }
  if (parsed.command === 'build') {
    if (!parsed.runs) throw new Error('CLI_BUILD_REQUIRES_EXPLICIT_RUNS');
    parsed.runIds = parsed.runs.split(',');
    if (parsed.runIds.some(id => !/^run-[0-9a-f]{32}$/.test(id))) throw new Error('CLI_RUN_ID_INVALID');
  }
  if (['verify', 'inspect'].includes(parsed.command) && !parsed.snapshot) throw new Error('CLI_SNAPSHOT_REQUIRED');
  return parsed;
}

async function main(argv) {
  const args = parseCorpusArgs(argv);
  const root = assertSafeRuntimeRoot(path.resolve(args.root ?? PUBLIC_INTELLIGENCE_5K3_DEFAULT_RUNTIME_ROOT));
  const policy = buildCorpusPolicy({ includePartial: args.includePartial });
  if (args.command === 'discover') {
    const found = discoverRuns(root, policy);
    const tally = {};
    for (const entry of found) tally[entry.classification] = (tally[entry.classification] ?? 0) + 1;
    console.log(JSON.stringify({ policy, tally, runs: found.map(entry => ({ name: entry.name, classification: entry.classification, status: entry.status ?? null, reasons: entry.reasons.slice(0, 3) })) }, null, 2));
    return;
  }
  if (args.command === 'build') {
    const result = buildAndStoreSnapshot({ root, runIds: args.runIds, policy, createdAt: Date.now() });
    const m = result.manifest;
    console.log(JSON.stringify({ outcome: result.outcome, snapshotId: result.snapshotId, membershipCount: m.membershipCount,
      canonicalObservationCount: m.canonicalObservationCount, duplicateAppearancesAcrossRuns: m.duplicateAppearancesAcrossRuns,
      conflictedUpstreamIdentities: m.conflictedUpstreamIdentities, snapshotFingerprint: m.snapshotFingerprint }, null, 2));
    return;
  }
  if (args.command === 'verify') {
    const result = verifySnapshot(root, args.snapshot);
    console.log(JSON.stringify({ verify: result.ok ? 'PASS' : 'FAIL', failures: result.failures }, null, 2));
    if (!result.ok) process.exitCode = 1;
    return;
  }
  const stored = loadSnapshotArtifacts(corporaDirectoryOf(root, args.snapshot));
  if (!stored.manifest) throw new Error('CLI_SNAPSHOT_NOT_FOUND');
  const { coverage, ...summary } = stored.manifest;
  console.log(JSON.stringify({ ...summary, coverage }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(error => {
    console.error(JSON.stringify({ error: String(error?.message ?? error).split('\n')[0].slice(0, 200) }));
    process.exitCode = 2;
  });
}
