// Phase 5K.2 - PROVIDER-COMMON helpers: pure, offline, provider-neutral.
//
// This module opens no socket, reads no environment variable, reads no clock and
// writes no file. It holds the explicit acquisition bounds, the closed adapter
// error vocabulary, strict timestamp parsing and the credential/privacy leak
// guard that every provider mapper shares.
//
// RESEARCH/OBSERVER-ONLY BY CONSTRUCTION, exactly as frozen by Phase 5K.0.

/** Closed vocabulary of adapter failures. Every refusal is a code, never a default. */
export const PROVIDER_ERROR_CODES = Object.freeze({
  BOUNDS_INVALID: 'PROVIDER_BOUNDS_INVALID',
  HOST_INVALID: 'PROVIDER_HOST_INVALID',
  QUERY_INVALID: 'PROVIDER_QUERY_INVALID',
  TIMEOUT: 'PROVIDER_TIMEOUT',
  NETWORK_ERROR: 'PROVIDER_NETWORK_ERROR',
  RATE_LIMITED: 'PROVIDER_RATE_LIMITED',
  SERVER_ERROR_5XX: 'PROVIDER_SERVER_ERROR_5XX',
  AUTH_REQUIRED: 'PROVIDER_AUTH_REQUIRED',
  CLIENT_ERROR_4XX: 'PROVIDER_CLIENT_ERROR_4XX',
  UNEXPECTED_CONTENT_TYPE: 'PROVIDER_UNEXPECTED_CONTENT_TYPE',
  RESPONSE_TOO_LARGE: 'PROVIDER_RESPONSE_TOO_LARGE',
  MALFORMED_RESPONSE: 'PROVIDER_MALFORMED_RESPONSE',
  RECORD_REFUSED: 'PROVIDER_RECORD_REFUSED',
});

/** A typed adapter failure carrying a stable code and non-sensitive details. */
export class ProviderAdapterError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = 'ProviderAdapterError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

export const providerFail = (code, details) => { throw new ProviderAdapterError(code, details); };

/**
 * Hard ceilings. A caller may ask for LESS than these; it can never ask for
 * more. There is no "unlimited" value and no way to disable a bound.
 */
export const PROVIDER_HARD_CEILINGS = Object.freeze({
  maxPages: 5,
  maxRecords: 200,
  maxResponseBytes: 2 * 1024 * 1024,
  timeoutMs: 20_000,
  lookbackMs: 7 * 24 * 60 * 60 * 1000,
  maxRetries: 0,
});

/** Conservative defaults used when a caller passes a partial bounds object. */
export const PROVIDER_DEFAULT_BOUNDS = Object.freeze({
  maxPages: 2,
  maxRecords: 40,
  maxResponseBytes: 512 * 1024,
  timeoutMs: 10_000,
  lookbackMs: 24 * 60 * 60 * 1000,
  maxRetries: 0,
});

const BOUND_KEYS = Object.freeze(Object.keys(PROVIDER_HARD_CEILINGS));

/**
 * Validates explicit bounds. Unknown keys, non-integers, zero/negative values
 * and values above the hard ceiling are all refused. Nothing is clamped.
 */
export function resolveBounds(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    providerFail(PROVIDER_ERROR_CODES.BOUNDS_INVALID, { reason: 'not-an-object' });
  }
  for (const key of Object.keys(input)) {
    if (!BOUND_KEYS.includes(key)) providerFail(PROVIDER_ERROR_CODES.BOUNDS_INVALID, { reason: 'unknown-key', key });
  }
  const bounds = {};
  for (const key of BOUND_KEYS) {
    const value = input[key] ?? PROVIDER_DEFAULT_BOUNDS[key];
    const min = key === 'maxRetries' ? 0 : 1;
    if (!Number.isInteger(value) || value < min || value > PROVIDER_HARD_CEILINGS[key]) {
      providerFail(PROVIDER_ERROR_CODES.BOUNDS_INVALID, { reason: 'out-of-range', key });
    }
    bounds[key] = value;
  }
  return Object.freeze(bounds);
}

// ---------------------------------------------------------------------------
// STRICT TIMESTAMPS
// ---------------------------------------------------------------------------

const ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Parses a provider ISO-8601 timestamp into integer epoch milliseconds.
 * Calendar overflow (Feb 31), missing zone, and free-form dates are refused.
 * Never reads a clock; never substitutes a value.
 */
export function parseProviderTimestamp(value, code = 'PROVIDER_TIMESTAMP_MALFORMED') {
  if (typeof value !== 'string') providerFail(code, { reason: 'not-a-string' });
  const match = ISO_TIMESTAMP.exec(value);
  if (!match) providerFail(code, { reason: 'format' });
  const [, y, mo, d, h, mi, s] = match.map((part, index) => (index >= 1 && index <= 6 ? Number(part) : part));
  if (mo < 1 || mo > 12 || h > 23 || mi > 59 || s > 59) providerFail(code, { reason: 'range' });
  const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  if (d < 1 || d > daysInMonth) providerFail(code, { reason: 'calendar' });
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) providerFail(code, { reason: 'unparseable' });
  return parsed;
}

// ---------------------------------------------------------------------------
// CREDENTIAL / PRIVACY LEAK GUARD
// ---------------------------------------------------------------------------

/**
 * Key names that must never appear anywhere in a provider-native record.
 * Compared after lowercasing and removing every non-alphanumeric character, so
 * `access_token`, `accessToken` and `Access-Token` are the same refusal.
 */
export const PROVIDER_REFUSED_KEYS = Object.freeze([
  'email', 'emailaddress', 'phone', 'phonenumber', 'mobilenumber',
  'privatemessage', 'directmessage', 'groupmessage', 'dmcontent',
  'sessioncookie', 'cookie', 'cookies', 'setcookie', 'accesstoken', 'refreshtoken',
  'bearertoken', 'apikey', 'apisecret', 'clientsecret', 'password', 'passwd',
  'privatekey', 'secretkey', 'mnemonic', 'seedphrase', 'credential', 'credentials',
  'authorization', 'authheader', 'browsersession', 'devicefingerprint',
  'ipaddress', 'realname', 'legalname', 'homeaddress', 'geolocation',
  'birthdate', 'deviceid', 'followerlist', 'followinglist', 'contactlist',
  'contactdiscovery', 'locationhistory', 'iphistory', 'mutualconnections',
]);
const REFUSED_KEY_SET = new Set(PROVIDER_REFUSED_KEYS);
const normalizeKey = key => key.toLowerCase().replace(/[^a-z0-9]/g, '');

const BASE58 = '1-9A-HJ-NP-Za-km-z';
const CREDENTIAL_TEXT_PATTERNS = Object.freeze([
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i,
  /\bAuthorization\s*:\s*\S{8,}/i,
  /\bSet-Cookie\s*:/i,
  /\b(?:sk|pk|rk)[-_](?:live|test|proj)?[-_]?[A-Za-z0-9]{20,}/,
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret)\s*[:=]\s*\S{8,}/i,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, // JWT
  // A base58 run far longer than a 32-44 char mint is shaped like a Solana
  // secret key or signature, never like a public mint.
  new RegExp(`(?<![${BASE58}])[${BASE58}]{64,}(?![${BASE58}])`),
]);

/** Returns the refusing key name found anywhere in `value`, or null. */
export function findRefusedKey(value, depth = 0) {
  if (depth > 12 || value === null || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const hit = findRefusedKey(entry, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  for (const key of Object.keys(value)) {
    if (REFUSED_KEY_SET.has(normalizeKey(key))) return key;
    const hit = findRefusedKey(value[key], depth + 1);
    if (hit) return hit;
  }
  return null;
}

/** True when a string looks like it carries a credential or secret key. */
export function looksLikeCredential(text) {
  return typeof text === 'string' && CREDENTIAL_TEXT_PATTERNS.some(pattern => pattern.test(text));
}

/**
 * Refuses a provider record that names a private/credential key anywhere, or
 * whose consumed text fields look like a credential. Reports the CLASS of the
 * problem, never the offending value.
 */
export function assertNoCredentialOrPrivateLeak(record, consumedStrings = []) {
  const key = findRefusedKey(record);
  if (key) providerFail(PROVIDER_ERROR_CODES.RECORD_REFUSED, { reason: 'REFUSED_KEY_PRESENT', key });
  for (const text of consumedStrings) {
    if (looksLikeCredential(text)) providerFail(PROVIDER_ERROR_CODES.RECORD_REFUSED, { reason: 'CREDENTIAL_LIKE_TEXT' });
  }
  return true;
}

// ---------------------------------------------------------------------------
// QUERY / HOST CONTRACT (shared by transport and 5K.3 collection plans)
// ---------------------------------------------------------------------------

const HOST_PATTERN = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/;
const REFUSED_HOST_SUFFIXES = Object.freeze(['.local', '.localhost', '.internal', '.lan', '.home', '.corp', '.onion']);
const HASHTAG_PATTERN = /^[A-Za-z0-9_]{1,64}$/;

/** Public DNS hostnames only: no IP literal, port, userinfo, or private suffix. */
export function assertPublicHost(host) {
  if (typeof host !== 'string') providerFail(PROVIDER_ERROR_CODES.HOST_INVALID);
  const lowered = host.toLowerCase();
  if (!HOST_PATTERN.test(lowered) || REFUSED_HOST_SUFFIXES.some(suffix => lowered.endsWith(suffix))) {
    providerFail(PROVIDER_ERROR_CODES.HOST_INVALID);
  }
  return lowered;
}

export function assertHashtag(hashtag) {
  if (typeof hashtag !== 'string' || !HASHTAG_PATTERN.test(hashtag)) providerFail(PROVIDER_ERROR_CODES.QUERY_INVALID);
  return hashtag;
}
