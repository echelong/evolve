import { mintIdentity } from '../definition.mjs';
import { createObservationTransport } from './http.mjs';

export const GMGN_ROUTES = Object.freeze(Object.fromEntries([
  ['info', '/v1/token/info'], ['security', '/v1/token/security'], ['pool', '/v1/token/pool_info'],
  ['holders', '/v1/market/token_top_holders'], ['traders', '/v1/market/token_top_traders'],
].map(([kind, path]) => [kind, Object.freeze({ method: 'GET', path })]).concat([
  ['trenches', Object.freeze({ method: 'POST', path: '/v1/trenches' })],
])));
export function createGmgnProvider({ config, ...options }) {
  const disabled = !config.apiKey ? 'DISABLED_NO_KEY' : !config.enabled ? 'DISABLED' : null;
  const transport = disabled ? null : createObservationTransport({ config, origin: 'https://openapi.gmgn.ai', routes: GMGN_ROUTES, secrets: [config.apiKey], ...options });
  let cycleAt = null, cycleRequests = 0;
  const now = options.now || Date.now;
  return Object.freeze({
    async observe(kind, mint = null) {
      if (!Object.hasOwn(GMGN_ROUTES, kind)) throw new Error('Observation route not allowed');
      if (kind !== 'trenches' && !mintIdentity(mint)) throw new Error('Invalid Solana mint');
      if (disabled) return { unavailable: disabled };
      if (cycleAt === null || now() - cycleAt >= config.pollMs) { cycleAt = now(); cycleRequests = 0; }
      if (cycleRequests >= config.maxRequests) return { unavailable: 'CYCLE_BUDGET' };
      cycleRequests++;
      const query = kind === 'trenches' ? { chain: 'sol' } : { chain: 'sol', address: mint };
      if (kind === 'holders' || kind === 'traders') query.limit = 20;
      const body = kind === 'trenches' ? { version: 'v2', new_creation: { filters: ['offchain', 'onchain'], launchpad_platform_v2: true, limit: 20 } } : null;
      return transport.read(kind, mint, { query, body });
    },
    health: () => disabled ? { state: disabled, requests: 0, errors: 0 } : transport.health(),
  });
}
