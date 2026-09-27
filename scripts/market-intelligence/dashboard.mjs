import { readdirSync, readFileSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { EVIDENCE, digest } from './definition.mjs';

// Public output is constructed from numeric counts and finite enums only; no raw
// payload, key, endpoint, participant address or provider error message is exposed.
export function loadMarketIntelligenceDashboard(root = '.evolve/market-intelligence') {
  const empty = { ...EVIDENCE, state: 'NO_FINALIZED_SESSION', captureStatus: null, providers: [], mintsJoined: 0, freshJoined: 0, launchEvents: 0, providerErrors: 0, maxPriceRangeBps: null, endedAt: null };
  const numeric = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  const states = new Set(['HEALTHY', 'DEGRADED', 'READY', 'DISABLED', 'DISABLED_NO_KEY', 'DISABLED_UNVERIFIED_TRANSPORT', 'EXTERNAL_RECORD_COPY']);
  try {
    const sessions = path.join(root, 'sessions');
    const dirs = readdirSync(/* turbopackIgnore: true */ sessions, { withFileTypes: true }).filter(d => d.isDirectory() && /^[a-zA-Z0-9_-]{1,100}$/.test(d.name)).map(d => d.name).sort().reverse().slice(0, 20);
    for (const id of dirs) {
      const file = path.join(sessions, id, 'summary.json');
      try {
        const stat = lstatSync(/* turbopackIgnore: true */ file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192) continue;
        const body = readFileSync(/* turbopackIgnore: true */ file, 'utf8');
        const summary = JSON.parse(body);
        if (summary.schemaVersion !== 1 || !Object.entries(EVIDENCE).every(([k, v]) => summary[k] === v)) continue;
        const manifestFile = path.join(sessions, id, 'manifest.json'), manifestStat = lstatSync(/* turbopackIgnore: true */ manifestFile);
        if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > 8192) continue;
        const manifest = JSON.parse(readFileSync(/* turbopackIgnore: true */ manifestFile, 'utf8'));
        if (manifest.files?.['summary.json'] !== createHash('sha256').update(body).digest('hex') || manifest.fingerprint !== digest(manifest.files)) continue;
        const providers = ['jupiter', 'gmgn', 'dexscreener', 'launch'].map(provider => {
          const h = summary.health?.[provider] ?? {};
          const state = provider === 'jupiter' ? h.state === 'EXTERNAL_RECORD_COPY' ? 'EXTERNAL_RECORD_COPY' : h.healthy === true && h.effectiveMode === 'live' ? 'HEALTHY' : 'DEGRADED' : states.has(h.state) ? h.state : 'UNAVAILABLE';
          return { provider, state, observations: numeric(summary.providerCounts?.[provider === 'launch' ? 'launch-observer' : provider]) ?? 0, errors: numeric(h.recordedErrors ?? h.errors ?? h.errorCount) ?? 0 };
        });
        return { ...empty, state: 'FINALIZED_SESSION', captureStatus: summary.status === 'complete' ? 'complete' : 'incomplete', providers, endedAt: numeric(summary.endedAt),
          mintsJoined: numeric(summary.metrics?.mintsJoined) ?? 0, freshJoined: numeric(summary.metrics?.freshJoined) ?? 0,
          launchEvents: numeric(summary.metrics?.launchEvents) ?? 0, providerErrors: numeric(summary.metrics?.providerErrors) ?? 0,
          maxPriceRangeBps: numeric(summary.metrics?.priceRangeBps?.max) };
      } catch { /* In-progress, invalid and unavailable summaries are independent of the engine. */ }
    }
  } catch { /* No capture is a normal disabled dashboard state. */ }
  return empty;
}
