#!/usr/bin/env node
// Phase 5K.5 - EXPLICIT LIVE TEMPORAL SMOKE (the ONLY 5K.5 code path that opens
// a socket, and it is never reached by the offline validator).
//
//   node scripts/public-intelligence/temporal-smoke.mjs
//     [--host mastodon.social] [--hashtag solana] [--pages 1] [--records 5]
//     [--gapMs 5000] [--root <absolute dir>]
//
// Performs TWO tiny Mastodon collection runs several seconds apart against the
// same instance and hashtag, builds the temporal corpus over both, and reports
// AGGREGATE STRUCTURAL COUNTS ONLY.
//
// IT NEVER PRINTS POST TEXT, and it never manufactures evidence to force a
// particular classification: if no counter moved between the two acquisitions,
// the report simply says so. Fixtures cover the update-state case regardless.
//
// No credential is read or sent. No `.evolve` write. No trading or engine path.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildCollectionPlan, executeCollectionRun } from './research-surface.mjs';
import { assertSafeRuntimeRoot } from './run-store.mjs';
import { buildAndStoreTemporalSnapshot } from './temporal-snapshot.mjs';
import { verifyTemporalSnapshot } from './temporal-verify.mjs';
import { PUBLIC_INTELLIGENCE_5K5_CORPUS_SEMANTICS } from './temporal-corpus.mjs';

const argValue = (args, name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function smoke(args) {
  const host = argValue(args, '--host', 'mastodon.social');
  const hashtag = argValue(args, '--hashtag', 'solana');
  const maxRecords = Number(argValue(args, '--records', '5'));
  const maxPages = Number(argValue(args, '--pages', '1'));
  const gapMs = Number(argValue(args, '--gapMs', '5000'));
  const rootInput = argValue(args, '--root', null);
  const root = rootInput ? assertSafeRuntimeRoot(rootInput) : mkdtempSync(path.join(tmpdir(), 'evolve-5k5-smoke-'));

  const bounds = Object.freeze({
    maxPages, maxRecords, maxResponseBytes: 512 * 1024, timeoutMs: 15_000, maxLookbackMs: 24 * 60 * 60 * 1000,
  });
  const runOnce = startedAt => executeCollectionRun(
    buildCollectionPlan({ instance: host, hashtag, bounds, collectionMode: 'LIVE_PUBLIC_PROVIDER', createdAt: startedAt }),
    { clock: () => Date.now(), outputRoot: root },
  );

  try {
    const first = await runOnce(Date.now());
    await wait(gapMs);
    const second = await runOnce(Date.now());

    const runIds = [first, second].map(run => run.runId).filter(Boolean);
    if (runIds.length === 0) throw new Error('NO_RUN_COMPLETED');
    const built = buildAndStoreTemporalSnapshot({ root, runIds, createdAt: Date.now() });
    const verification = verifyTemporalSnapshot(root, built.temporalSnapshotId);
    const A = built.manifest.accounting;

    // Structural counts only. No text, no ids, no authors, no URLs.
    console.log(JSON.stringify({
      smoke: 'PASS',
      host,
      hashtag,
      runs: runIds.length,
      runStatuses: [first.status, second.status],
      gapMs,
      snapshotVerified: verification.ok,
      temporalSnapshotId: built.temporalSnapshotId,
      counts: {
        upstreamIdentities: A.upstreamIdentityCount,
        contentVersions: A.contentVersionCount,
        observationRecords: A.observationRecordCount,
        observationStateSnapshots: A.observationStateSnapshotCount,
        sameContentSameState: A.sameContentSameStateCount,
        sameContentUpdatedState: A.sameContentUpdatedStateCount,
        providerDeclaredRevisions: A.providerDeclaredRevisionCount,
        unverifiedContentDivergences: A.unverifiedDivergenceCount,
        duplicateAppearances: A.duplicateAppearanceCount,
        conflictedIdentities: A.conflictedUpstreamIdentityCount,
      },
      notes: [
        'Structural counts only: no post text, ids, authors or URLs are reported.',
        'No live evidence is manufactured to force any particular classification.',
        'A counter regression would be reported as sameContentUpdatedState, not a conflict.',
        'Engagement is research evidence only: not sentiment, importance, momentum or a signal.',
      ],
      scoringApplied: PUBLIC_INTELLIGENCE_5K5_CORPUS_SEMANTICS.scoringApplied,
      tradingInferenceMade: PUBLIC_INTELLIGENCE_5K5_CORPUS_SEMANTICS.tradingInferenceMade,
      persisted: rootInput ? 'explicit-runtime-root' : 'temporary',
    }, null, 2));
  } finally {
    if (!rootInput) rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await smoke(process.argv.slice(2)).catch(error => {
    console.error(JSON.stringify({ smoke: 'FAIL', message: String(error?.message ?? error).slice(0, 300) }));
    process.exitCode = 1;
  });
}
