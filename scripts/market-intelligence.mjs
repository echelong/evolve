#!/usr/bin/env node
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createIntelligenceConfig, createIntelligenceRecorder, createGmgnProvider, createDexProvider, createLaunchObserver, readSummary, normalizeDex, SESSION_FINALIZATION_RESERVE_BYTES } from './market-intelligence/index.mjs';
import { createMarketConfig, createMarketFeed } from './market/index.mjs';
import { createRevisitQueue } from './market-intelligence/revisits.mjs';
import { planDexRevisits, dexRevisitSafetyMs } from './market-intelligence/revisit-scheduler.mjs';
import { snapshotMissingReason } from './market-outcomes/index.mjs';

const COMMANDS = new Set(['doctor', 'probe', 'capture', 'summary']);
// Only these fixed bounded codes reach the terminal. Exception text may carry
// URLs, provider payload fragments or secrets and is never printed.
export const SAFE_FAILURE_CODES = Object.freeze(['SESSION_STORAGE_BOUND', 'RAW_STORAGE_BOUND', 'FINALIZATION_STORAGE_BOUND',
  'SESSION_STORAGE_IDENTITY_BOUND', 'SESSION_STORAGE_RECEIPT_BOUND', 'NO_LOOKAHEAD_TIMESTAMP',
  'REVISIT_COVERAGE_FAILED', 'REVISIT_QUEUE_BOUND', 'REVISIT_CYCLE_BOUND', 'REVISIT_TIMESTAMP_BOUND']);
export const safeFailureCode = error => typeof error?.message === 'string' && SAFE_FAILURE_CODES.includes(error.message) ? error.message : 'OBSERVATION_FAILED';
export const failureLine = (command, error) => `[EVOLVE 5J] ${COMMANDS.has(command) ? command : 'command'} failed: ${safeFailureCode(error)}`;
export const revisitExitFailure = queue => queue && (queue.status().pending || queue.status().failed) ? new Error('REVISIT_COVERAGE_FAILED') : null;

// Storage bounds are shown before a long capture starts; no path or secret is included.
export function doctorReport({ config, gmgn, dex, launch }) {
  return { evidence: 'DEVELOPMENT / OBSERVER ONLY / PAPER ONLY', gmgn: gmgn.health(), dexscreener: dex.health(), launch: launch.health(), jupiter: 'existing feed.markets() adapter; live only',
    storage: { maxSessionMiB: config.maxSessionMiB, maxSessionBytes: config.maxSessionBytes, finalizationReserveBytes: SESSION_FINALIZATION_RESERVE_BYTES } };
}

export async function main(args = process.argv.slice(2)) {
  const config = createIntelligenceConfig();
  const command = args[0] ?? 'doctor';
  if (command === 'summary') { console.log(JSON.stringify(readSummary(config.root), null, 2)); return; }
  const gmgn = createGmgnProvider({ config: config.gmgn }), dex = createDexProvider({ config: config.dex }), launch = createLaunchObserver({ config: config.launch });
  if (command === 'doctor') {
    console.log(JSON.stringify(doctorReport({ config, gmgn, dex, launch }), null, 2)); return;
  }
  if (command === 'probe') {
    const mint = 'So11111111111111111111111111111111111111112';
    const result = await dex.observe(mint);
    console.log('DexScreener', result.unavailable ?? `pairs ${result.payload.length}, normalized ${normalizeDex(result).length}`);
    const g = await gmgn.observe('info', mint);
    console.log('GMGN', g.unavailable === 'DISABLED_NO_KEY' ? 'PROVIDER IMPLEMENTED; LIVE PROBE SKIPPED — API KEY NOT CONFIGURED' : g.unavailable ?? 'read-only token info received');
    console.log('Launch observer', launch.health().state); return;
  }
  if (command !== 'capture') throw new Error('Use probe, capture, summary or doctor');
  const targetedMode = args.includes('--r4-revisits');
  const index = args.indexOf('--minutes');
  const minutes = index < 0 ? 30 : Number(args[index + 1]);
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 1440) throw new Error('Minutes must be >0 and <=1440');
  // Always live: synthetic fallback is explicitly excluded from intelligence evidence.
  const feed = createMarketFeed({ config: createMarketConfig({ ...process.env, EVOLVE_MARKET_MODE: 'live', EVOLVE_ALLOW_SYNTHETIC_FALLBACK: 'false' }, { loadEnv: false }) });
  const recorder = createIntelligenceRecorder({ config, feed, gmgn, dex, launch });
  const revisits = targetedMode ? createRevisitQueue({ onEvent: event => recorder.writeRevisitEvent(event) }) : null;
  let stop = false, reason = 'duration reached';
  const signal = () => { stop = true; reason = 'signal'; };
  process.on('SIGINT', signal); process.on('SIGTERM', signal);
  const started = Date.now(), referenceCutoffAt = started + minutes * 60000; let failed = null, nextOrdinaryAt = started;
  const safetyMs = dexRevisitSafetyMs(config.dex);
  try {
    while (!stop && (Date.now() < referenceCutoffAt || revisits?.status().pending)) {
      const cycleAt = Date.now();
      try { await feed.advance(); } catch { /* Provider failure is reflected by existing feed health. */ }
      revisits?.expire(Date.now(), safetyMs);
      const markets = feed.markets(Date.now()).map(m => targetedMode && m.synthetic === false && m.source === 'Jupiter Tokens V2'
        ? { ...m, lastFetchedAt: feed.universe.get(m.mint)?.lastSeenAt ?? m.lastObservedAt } : m);
      const ready = revisits?.due(Date.now()).filter(mint => {
        const targets = revisits.targets(mint, Date.now());
        const observation = markets.find(m => m.mint === mint && m.synthetic === false && m.source === 'Jupiter Tokens V2');
        return targets.length && observation && observation.lastFetchedAt >= Math.min(...targets.map(t => t.targetAt)) && Date.now() - observation.lastFetchedAt <= config.alignmentMs;
      }) ?? [];
      const ordinaryDue = cycleAt >= nextOrdinaryAt;
      const schedulingAt = Date.now();
      const plan = revisits ? planDexRevisits({ queue: revisits, at: schedulingAt, budget: dex.budget(schedulingAt), readyMints: ready,
        ordinaryDue, safetyMs }) : null;
      const targetedMints = plan?.targetedMints ?? [];
      const passiveDexLimit = targetedMode ? plan.passiveDexLimit : config.dex.maxRequests;
      if ((!ordinaryDue && !targetedMints.length) || targetedMode && !targetedMints.length && !passiveDexLimit) {
        await sleep(250);
        continue;
      }
      const targetedLatestStart = Object.fromEntries(targetedMints.map(mint => [mint, Math.min(...revisits.targets(mint, schedulingAt).map(entry => entry.deadlineAt - safetyMs))]));
      const stats = await recorder.capture({ markets, targetedMints, targetedLatestStart, passiveDexLimit, skipGmgn: targetedMints.length > 0 });
      if (ordinaryDue && (!targetedMode || passiveDexLimit > 0 || !targetedMints.length)) nextOrdinaryAt = Date.now() + Math.max(config.gmgn.pollMs, config.dex.pollMs);
      for (const mint of targetedMints) {
        const snapshot = stats.snapshots.find(s => s.mint === mint);
        const attempt = stats.revisitResults[mint];
        if (attempt?.unavailable === 'DEADLINE_UNSAFE') { revisits.expire(Date.now(), safetyMs); continue; }
        if (attempt?.requestAttempted !== true && ['CYCLE_BUDGET', 'BACKOFF', 'BUSY'].includes(attempt?.unavailable)) {
          continue;
        }
        const closedAt = snapshot?.observedAt ?? Date.now();
        revisits.complete(mint, closedAt, entry => attempt?.requestAttempted === true && attempt.unavailable === null && snapshotMissingReason(snapshot) === null && snapshot.disagreement.metrics.contributors.price.every(p => p.providerObservedAt >= entry.targetAt),
          { requestStartedAt: attempt?.requestStartedAt ?? null, requestReceivedAt: attempt?.receivedAt ?? null, snapshotAt: snapshot?.observedAt ?? null,
            coalescedEntryCount: revisits.targets(mint, attempt?.requestStartedAt ?? closedAt).filter(entry => entry.targetAt <= (markets.find(m => m.mint === mint)?.lastFetchedAt ?? -Infinity)).length,
            eligibleUntilAt: markets.find(m => m.mint === mint)?.lastFetchedAt ?? null, providerUnavailable: attempt?.unavailable ?? null });
      }
      for (const snapshot of stats.snapshots) if (snapshot.observedAt < referenceCutoffAt) revisits?.add(snapshot);
      const elapsed = Math.floor((Date.now() - started) / 1000);
      process.stdout.write(`\r[EVOLVE 5J] elapsed ${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')} mints ${stats.mints} Jupiter ${stats.providers.jupiter} GMGN ${stats.providers.gmgn} DexScreener ${stats.providers.dexscreener} launch events ${stats.launchEvents} fresh joined ${stats.freshJoined} errors ${stats.errors}    `);
      const deadline = Math.min(Date.now() < referenceCutoffAt ? referenceCutoffAt : Infinity, nextOrdinaryAt, revisits?.status().nextAt ?? Infinity, plan?.nextAt ?? Infinity);
      while (!stop && Date.now() < deadline) await sleep(Math.min(250, deadline - Date.now()));
    }
    if (revisits) {
      revisits.expire(Date.now() + 1);
      const status = revisits.status();
      console.log(`\n[EVOLVE 5J] R4 revisit coverage: scheduled ${status.scheduled}, completed ${status.completed}, pending ${status.pending}, failures ${status.failed}, by code ${JSON.stringify(status.failuresByCode)}`);
      const coverageFailure = revisitExitFailure(revisits);
      if (coverageFailure) throw coverageFailure;
    }
  } catch (e) { failed = e; reason = 'capture failed'; }
  finally {
    if (!failed && revisitExitFailure(revisits)) { failed = revisitExitFailure(revisits); reason = 'capture failed'; }
    feed.stop(); process.off('SIGINT', signal); process.off('SIGTERM', signal);
    const manifest = recorder.finalize(reason, { revisitCoverage: revisits ? { scheduled: revisits.status().scheduled, completed: revisits.status().completed, failed: revisits.status().failed, pending: revisits.status().pending, failuresByCode: revisits.status().failuresByCode } : null });
    console.log(`\n${recorder.dir}\nfingerprint ${manifest.fingerprint}`);
  }
  if (failed) throw failed;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(e => {
  console.error(failureLine(process.argv[2] ?? 'doctor', e)); console.error('Market intelligence command failed; no engine state changed.'); process.exitCode = 1;
});
