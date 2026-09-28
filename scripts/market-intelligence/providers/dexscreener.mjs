import { mintIdentity } from '../definition.mjs';
import { createObservationTransport } from './http.mjs';

export const DEX_ROUTES = Object.freeze({ pairs: Object.freeze({ method: 'GET', path: mint => `/token-pairs/v1/solana/${mint}` }) });
export function createDexProvider({ config, ...options }) {
  const transport = createObservationTransport({ config, origin: 'https://api.dexscreener.com', routes: DEX_ROUTES, ...options });
  let cycleAt = null, cycleRequests = 0, malformed = 0, lastMalformed = false;
  const now = options.now || Date.now;
  return Object.freeze({
    async observe(mint, { fresh = false } = {}) {
      if (!mintIdentity(mint)) throw new Error('Invalid Solana mint');
      if (!config.enabled) return { unavailable: 'DISABLED' };
      if (cycleAt === null || now() - cycleAt >= config.pollMs) { cycleAt = now(); cycleRequests = 0; }
      if (cycleRequests >= config.maxRequests) return { unavailable: 'CYCLE_BUDGET' };
      cycleRequests++;
      const result = await transport.read('pairs', mint, { fresh });
      if (result.payload !== undefined && (!Array.isArray(result.payload) || result.payload.some(p => !p || typeof p !== 'object' || typeof p.chainId !== 'string' || typeof p.pairAddress !== 'string' || !mintIdentity(p.baseToken?.address)))) { malformed++; lastMalformed = true; return { unavailable: 'MALFORMED_PAYLOAD' }; }
      if (result.payload !== undefined) lastMalformed = false;
      return result;
    },
    health: () => config.enabled ? { ...transport.health(), errors: transport.health().errors + malformed, malformed, state: lastMalformed && transport.health().state === 'HEALTHY' ? 'DEGRADED' : transport.health().state } : { state: 'DISABLED', requests: 0, errors: 0 },
  });
}
