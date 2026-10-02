// Phase 5K.2 - MASTODON MAPPER: provider-native status -> 5K.1 raw observation.
//
// PURE AND OFFLINE BY CONSTRUCTION. This module performs no network call, reads
// no environment variable, reads no clock, writes no file and holds no
// credential. Everything it needs (host, fetchedAt, run id) is passed in as
// evidence by the caller.
//
// It emits the EXISTING closed 5K.1 raw observation schema and nothing else. It
// computes no sentiment, score, ranking, recommendation or signal.
//
// EXACT-MINT RULE: claimedMint is set only when exactly one exact, valid base58
// Solana mint string is explicitly present in the post text. Symbols, cashtags,
// hashtags, names, usernames and URL slugs never become identity.
import { canonicalMintAddress, PUBLIC_INTELLIGENCE_CLASSIFICATION, PUBLIC_INTELLIGENCE_SCHEMA_VERSION,
  PUBLIC_INTELLIGENCE_RECORD_TYPES } from '../definition.mjs';
import {
  canonicalizeRawObservation, PUBLIC_INTELLIGENCE_5K1_COLLECTOR_MODES,
  PUBLIC_INTELLIGENCE_5K2_LIVE_COLLECTOR_MODES,
} from '../observation.mjs';
import {
  PROVIDER_ERROR_CODES, providerFail, parseProviderTimestamp, assertNoCredentialOrPrivateLeak,
} from './common.mjs';

export const MASTODON_ADAPTER_NAME = 'mastodon_public_timeline';
export const MASTODON_ADAPTER_VERSION = '5k2.0.0';
export const MASTODON_PROVIDER_PREFIX = 'mastodon:';

/** Provider-native record types that are never public posts. */
const PRIVATE_RECORD_TYPES = Object.freeze([
  'direct', 'private', 'dm', 'conversation', 'mention', 'follow_request', 'notification',
]);

/**
 * The ONLY provider-native fields the mapper reads. Everything else in a status
 * (account profile, avatar, display name, media, card, poll, application, ...)
 * is discarded by construction and cannot reach the raw schema.
 */
export const MASTODON_CONSUMED_FIELDS = Object.freeze([
  'id', 'visibility', 'type', 'reblog', 'in_reply_to_id', 'created_at', 'url', 'uri',
  'content', 'language', 'tags', 'account.id',
  'favourites_count', 'replies_count', 'reblogs_count',
]);

const MINT_CANDIDATE = /(?<![1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{32,44}(?![1-9A-HJ-NP-Za-km-z])/g;
const CASHTAG = /(?<![A-Za-z0-9_$])\$[A-Za-z][A-Za-z0-9]{1,14}\b/g;
const NAMED_ENTITIES = Object.freeze({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' });

/** Single-pass entity decode, so `&amp;lt;` becomes `&lt;` and not `<`. */
function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]{2,6});/g, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
        ? String.fromCodePoint(code) : whole;
    }
    return Object.hasOwn(NAMED_ENTITIES, body) ? NAMED_ENTITIES[body] : whole;
  });
}

/**
 * Deterministic HTML -> text. <br> is a newline, paragraph boundaries are a
 * blank line, every other tag is dropped, entities are decoded once. The
 * provider's visible text is otherwise preserved character-for-character.
 */
export function mastodonHtmlToText(html) {
  if (typeof html !== 'string') providerFail(PROVIDER_ERROR_CODES.RECORD_REFUSED, { reason: 'CONTENT_NOT_A_STRING' });
  const withBreaks = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p[^>]*>/gi, '\n\n');
  return decodeEntities(withBreaks.replace(/<[^>]*>/g, ''));
}

/** Exact Solana mints explicitly present in text, de-duplicated, in order of appearance. */
export function extractExactMints(text) {
  const found = [];
  for (const match of text.matchAll(MINT_CANDIDATE)) {
    const candidate = canonicalMintAddress(match[0]);
    if (candidate !== null && !found.includes(candidate)) found.push(candidate);
  }
  return found;
}

function refuse(reason, extra = {}) {
  return providerFail(PROVIDER_ERROR_CODES.RECORD_REFUSED, { reason, ...extra });
}

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function countOrOmit(value) {
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

function safeHttpsUrl(value) {
  if (typeof value !== 'string' || !value) return null;
  let parsed;
  try { parsed = new URL(value); } catch { return null; }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
  return value;
}

/**
 * Maps ONE Mastodon status to ONE 5K.1 raw observation.
 *
 * context (all required, none defaulted):
 *   host           - the instance host the status was read from (namespaces ids)
 *   fetchedAt      - integer epoch ms established by the transport
 *   collectionRunId- stable id for this collection run
 *   collectorMode  - 'OFFLINE_FIXTURE' (fixtures) or 'LIVE_PUBLIC_PROVIDER' (transport)
 *
 * Throws ProviderAdapterError (RECORD_REFUSED / PROVIDER_TIMESTAMP_MALFORMED).
 */
export function mapStatusToRawObservation(status, context) {
  if (!isPlainObject(context)) refuse('CONTEXT_INVALID');
  const { host, fetchedAt, collectionRunId, collectorMode } = context;
  if (typeof host !== 'string' || !host) refuse('CONTEXT_HOST_REQUIRED');
  if (!Number.isInteger(fetchedAt)) refuse('CONTEXT_FETCHED_AT_REQUIRED');
  if (typeof collectionRunId !== 'string' || !collectionRunId.trim()) refuse('CONTEXT_RUN_ID_REQUIRED');
  if (![...PUBLIC_INTELLIGENCE_5K1_COLLECTOR_MODES, ...PUBLIC_INTELLIGENCE_5K2_LIVE_COLLECTOR_MODES]
    .includes(collectorMode)) refuse('CONTEXT_COLLECTOR_MODE_INVALID');

  if (!isPlainObject(status)) providerFail(PROVIDER_ERROR_CODES.MALFORMED_RESPONSE, { reason: 'STATUS_NOT_AN_OBJECT' });

  // A stable provider-native id is mandatory. Text is never an identity.
  if (typeof status.id !== 'string' || !/^[0-9]{1,32}$/.test(status.id)) refuse('PROVIDER_ID_MISSING_OR_INVALID');

  // PUBLIC ONLY. `unlisted` is public-by-link but is not a public timeline
  // post; 5K.2 refuses it rather than guess the author's intent.
  if (status.visibility !== 'public') refuse('NON_PUBLIC_VISIBILITY', { visibility: String(status.visibility) });
  if (typeof status.type === 'string' && PRIVATE_RECORD_TYPES.includes(status.type.toLowerCase())) {
    refuse('PRIVATE_RECORD_TYPE', { type: status.type });
  }
  // A boost wrapper is not an original observation; the original has its own id.
  if (status.reblog !== null && status.reblog !== undefined) refuse('REBLOG_WRAPPER');

  const rawText = mastodonHtmlToText(status.content);
  const sourceUrl = safeHttpsUrl(status.url) ?? safeHttpsUrl(status.uri);

  // Credential/privacy guard over the WHOLE native record (keys) and every
  // string the mapper consumes. Reports the class of problem, not the value.
  assertNoCredentialOrPrivateLeak(status, [rawText, sourceUrl ?? '']);

  const publishedAt = status.created_at === undefined || status.created_at === null
    ? null
    : parseProviderTimestamp(status.created_at);

  const accountId = isPlainObject(status.account) && typeof status.account.id === 'string'
    && /^[0-9]{1,32}$/.test(status.account.id) ? status.account.id : null;

  const mints = extractExactMints(rawText);
  const cashtags = [...new Set(rawText.match(CASHTAG) ?? [])];
  const hashtags = Array.isArray(status.tags)
    ? [...new Set(status.tags
      .map(tag => (isPlainObject(tag) && typeof tag.name === 'string' && /^[\p{L}\p{N}_]{1,100}$/u.test(tag.name)
        ? `#${tag.name}` : null))
      .filter(Boolean))]
    : [];

  const engagement = {};
  for (const [target, source] of [['likes', 'favourites_count'], ['replies', 'replies_count'], ['reposts', 'reblogs_count']]) {
    const value = countOrOmit(status[source]);
    if (value !== undefined) engagement[target] = value;
  }

  const raw = {
    schemaVersion: PUBLIC_INTELLIGENCE_SCHEMA_VERSION,
    recordType: PUBLIC_INTELLIGENCE_RECORD_TYPES.RAW_SOCIAL_OBSERVATION,
    provider: `${MASTODON_PROVIDER_PREFIX}${host}`,
    providerObservationId: status.id,
    providerAuthorId: accountId === null ? null : `${host}:${accountId}`,
    sourceType: status.in_reply_to_id === null || status.in_reply_to_id === undefined ? 'POST' : 'REPLY',
    sourceUrl,
    publishedAt,
    // The provider does not tell us when EVOLVE observed it; the adapter does
    // not invent one. fetchedAt carries the acquisition instant separately.
    observedAt: null,
    fetchedAt,
    rawText,
    rawMetadata: {
      language: typeof status.language === 'string' ? status.language : null,
      engagement: Object.keys(engagement).length ? engagement : null,
      cashtags,
      hashtags,
      mentionedHandles: [],
      claimedSymbol: null,
      claimedTokenName: null,
      candidateMintAddresses: mints,
      similaritySignals: [],
      fixtureNote: null,
    },
    // Exactly one explicit exact mint -> claimed. Zero or several -> null and
    // 5K.1 decides UNASSOCIATED / AMBIGUOUS. Never inferred from anything else.
    claimedMint: mints.length === 1 ? mints[0] : null,
    collectionContext: {
      collectionRunId,
      adapterName: MASTODON_ADAPTER_NAME,
      adapterVersion: MASTODON_ADAPTER_VERSION,
      collectorMode,
    },
    classification: PUBLIC_INTELLIGENCE_CLASSIFICATION,
  };

  // The closed 5K.1 schema is the final gate: nothing unknown can pass it.
  return canonicalizeRawObservation(raw);
}
