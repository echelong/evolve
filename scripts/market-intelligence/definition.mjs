import { createHash } from 'node:crypto';

export const SCHEMA_VERSION = 1;
export const EVIDENCE = Object.freeze({
  evidenceClassification: 'DEVELOPMENT_MULTI_SOURCE_MARKET_INTELLIGENCE',
  developmentOnly: true, observerOnly: true, paperOnly: true,
  tradingAuthority: false, futureOutcomeIncluded: false,
});
export function canonical(value) {
  if (value === null || typeof value !== 'object') {
    if (value === undefined || (typeof value === 'number' && !Number.isFinite(value))) throw new Error('Noncanonical value');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}
export const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
export const mintIdentity = value => typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value) ? value : null;
export const number = value => (typeof value === 'number' || (typeof value === 'string' && value.trim())) && Number.isFinite(Number(value)) ? Number(value) : null;
export const text = value => typeof value === 'string' && value.trim() ? value.slice(0, 2048) : null;
export function epoch(value) {
  if (value === null || value === undefined) return null;
  const n = number(value);
  if (n !== null) return n < 1e12 ? n * 1000 : n;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
const SENSITIVE_KEY = /api.?key|authorization|password|private.?key|secret.?key|mnemonic|seed.?phrase|credential/i;

// Credential-shaped fields are removed at every persistence boundary, including raw responses.
export function redact(value, secrets = []) {
  if (typeof value === 'string') {
    let result = value;
    for (const secret of secrets.filter(Boolean)) result = result.split(secret).join('[REDACTED]');
    return result;
  }
  if (Array.isArray(value)) return value.map(v => redact(v, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([k]) => !SENSITIVE_KEY.test(k))
    .map(([k, v]) => [redact(k, secrets), redact(v, secrets)]));
  return value;
}
