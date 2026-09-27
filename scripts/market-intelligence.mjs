#!/usr/bin/env node
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createIntelligenceConfig, createIntelligenceRecorder, createGmgnProvider, createDexProvider, createLaunchObserver, readSummary, normalizeDex } from './market-intelligence/index.mjs';
import { createMarketConfig, createMarketFeed } from './market/index.mjs';

export async function main(args = process.argv.slice(2)) {
  const config = createIntelligenceConfig();
  const command = args[0] ?? 'doctor';
  if (command === 'summary') { console.log(JSON.stringify(readSummary(config.root), null, 2)); return; }
  const gmgn = createGmgnProvider({ config: config.gmgn }), dex = createDexProvider({ config: config.dex }), launch = createLaunchObserver({ config: config.launch });
  if (command === 'doctor') {
    console.log(JSON.stringify({ evidence: 'DEVELOPMENT / OBSERVER ONLY / PAPER ONLY', gmgn: gmgn.health(), dexscreener: dex.health(), launch: launch.health(), jupiter: 'existing feed.markets() adapter; live only' }, null, 2)); return;
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
  const index = args.indexOf('--minutes');
  const minutes = index < 0 ? 30 : Number(args[index + 1]);
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 1440) throw new Error('Minutes must be >0 and <=1440');
  // Always live: synthetic fallback is explicitly excluded from intelligence evidence.
  const feed = createMarketFeed({ config: createMarketConfig({ ...process.env, EVOLVE_MARKET_MODE: 'live', EVOLVE_ALLOW_SYNTHETIC_FALLBACK: 'false' }, { loadEnv: false }) });
  const recorder = createIntelligenceRecorder({ config, feed, gmgn, dex, launch });
  let stop = false, reason = 'duration reached';
  const signal = () => { stop = true; reason = 'signal'; };
  process.on('SIGINT', signal); process.on('SIGTERM', signal);
  const started = Date.now(); let failed = null;
  try {
    while (!stop && Date.now() - started < minutes * 60000) {
      try { await feed.advance(); } catch { /* Provider failure is reflected by existing feed health. */ }
      const stats = await recorder.capture();
      const elapsed = Math.floor((Date.now() - started) / 1000);
      process.stdout.write(`\r[EVOLVE 5J] elapsed ${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')} mints ${stats.mints} Jupiter ${stats.providers.jupiter} GMGN ${stats.providers.gmgn} DexScreener ${stats.providers.dexscreener} launch events ${stats.launchEvents} fresh joined ${stats.freshJoined} errors ${stats.errors}    `);
      const deadline = Math.min(started + minutes * 60000, Date.now() + Math.max(config.gmgn.pollMs, config.dex.pollMs));
      while (!stop && Date.now() < deadline) await sleep(Math.min(250, deadline - Date.now()));
    }
  } catch (e) { failed = e; reason = 'capture failed'; }
  finally {
    feed.stop(); process.off('SIGINT', signal); process.off('SIGTERM', signal);
    const manifest = recorder.finalize(reason);
    console.log(`\n${recorder.dir}\nfingerprint ${manifest.fingerprint}`);
  }
  if (failed) throw failed;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => { console.error('Market intelligence command failed; no engine state changed.'); process.exitCode = 1; });
