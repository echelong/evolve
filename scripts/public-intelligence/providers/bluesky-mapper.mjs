// Phase 5K.6 - BLUESKY MAPPER: provider-native postView -> 5K.1 raw observation.
//
// PURE AND OFFLINE BY CONSTRUCTION. No network call, no environment read, no
// clock, no credential, no file write. Everything it needs (fetchedAt, run id)
// is passed in as evidence by the caller.
//
// It emits the EXISTING closed 5K.1 raw observation schema and nothing else.
// No parallel schema is invented.
//
// PROVIDER IDENTITY
//
//   providerObservationId = the record's AT URI, e.g.
//       at://did:plc:.../app.bsky.feed.post/<rkey>
//
// The AT URI is the correct identifier because AT Protocol repository paths are
// `<collection>/<record-key>` and a path is stable for the life of the record
// while everything about its content may change. A DISPLAY HANDLE is never used:
// handles are mutable and resolvable, so an identity built from one would
// change when a user renames themselves. The DID is inside the AT URI, so
// upstream identity already carries the stable author reference.
//
// CID AND REVISION SEMANTICS
//
// `cid` is the provider's own content address for the record at that path. Per
// the AT Protocol repository spec, updating a record CHANGES ITS CID while the
// path - and therefore the AT URI - stays the same. That makes a CID change
// under an unchanged AT URI genuine PROVIDER-DECLARED evidence that the record
// was updated, which is stronger than Mastodon's `edited_at`.
//
// The CID is therefore retained as provider-native content evidence inside
// `rawMetadata.cid`, and 5K.5 consumes it through its additive, fingerprint-bound
// revision-evidence sidecar. The CID is NEVER treated as an EVOLVE raw
// fingerprint and never replaces `rawObservationFingerprint`, which remains 5K.1's
// authoritative statement of what was received.
//
// PRIVACY
//
// The AppView returns a large author profile. Only `author.did` is ever read.
// Display name, handle, avatar, banner, bio, follower/following counts, lists
// and labels are discarded by construction and cannot reach the raw schema.
import {
  canonicalMintAddress, PUBLIC_INTELLIGENCE_CLASSIFICATION, PUBLIC_INTELLIGENCE_SCHEMA_VERSION,
  PUBLIC_INTELLIGENCE_RECORD_TYPES,
} from '../definition.mjs';
import { canonicalizeRawObservation } from '../observation.mjs';
import { assertNoCredentialOrPrivateLeak } from './common.mjs';
import {
  BLUESKY_PROVIDER_NAMESPACE, BLUESKY_SUPPORTED_RECORD_TYPES, BLUESKY_ENGAGEMENT_COUNTERS,
  BLUESKY_ENGAGEMENT_MAPPING, BLUESKY_PROVIDER_ERROR_CODES, BlueskyAdapterError,
  blueskyFail, assertProviderCid, parseAtUri, parseBlueskyTimestamp,
} from './bluesky-common.mjs';

export const BLUESKY_ADAPTER_NAME = 'bluesky_public_appview';
export const BLUESKY_ADAPTER_VERSION = '5k6.0.0';

/**
 * The ONLY provider-native fields this mapper reads. Everything else in a
 * postView is discarded by construction.
 *
 * `bookmarkCount`, `viewer`, `labels`, `embeds`, `threadgate`, `via` and the
 * entire author profile beyond `did` are intentionally NOT consumed.
 */
export const BLUESKY_CONSUMED_FIELDS = Object.freeze([
  'uri', 'cid', 'author.did', 'record.$type', 'record.text', 'record.createdAt', 'record.langs',
  'record.reply.parent.uri', 'embed', 'embeds', ...BLUESKY_ENGAGEMENT_COUNTERS,
]);

/** Embed forms that are NOT posts and can never contribute post text. */
const NON_POST_EMBED = Object.freeze([
  'app.bsky.embed.images', 'app.bsky.embed.video', 'app.bsky.embed.audio',
  'app.bsky.embed.external', 'app.bsky.embed.record', 'app.bsky.embed.recordWithMedia',
]);

const MINT_CANDIDATE = /(?<![1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{32,44}(?![1-9A-HJ-NP-Za-km-z])/g;
const CASHTAG = /(?<![A-Za-z0-9_$])\$[A-Za-z][A-Za-z0-9]{1,14}\b/g;
const HASHTAG = /(?<![A-Za-z0-9_&])#([\p{L}\p{N}_]{1,100})/gu;

const NAMED_ENTITIES = Object.freeze({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' });

/**
 * Bluesky record text is plain UTF-8, not HTML, so there is no tag-stripping
 * step. Named HTML entities are still decoded once, because a post may contain
 * a literal `&amp;` and leaving it would misrepresent the text. The characters
 * are otherwise preserved character-for-character.
 */
export function decodeBlueskyEntities(text) {
  if (typeof text !== 'string') blueskyFail(BLUESKY_PROVIDER_ERROR_CODES.RECORD_REFUSED, { reason: 'TEXT_NOT_A_STRING' });
  return text.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]{2,6});/g, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (Number.isInteger(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)) {
        return String.fromCodePoint(code);
      }
      return whole;
    }
    return Object.hasOwn(NAMED_ENTITIES, body) ? NAMED_ENTITIES[body] : whole;
  });
}

/** Exact Solana mints explicitly present in text, de-duplicated, in order. */
export function extractExactMints(text) {
  const found = text.match(MINT_CANDIDATE) ?? [];
  const seen = new Set();
  const out = [];
  for (const candidate of found) {
    const canonicalForm = canonicalMintAddress(candidate);
    if (canonicalForm !== null && !seen.has(canonicalForm)) { seen.add(canonicalForm); out.push(canonicalForm); }
  }
  return out;
}

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const countOrOmit = value => (typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined);
const refuse = (reason, details = {}) => blueskyFail(BLUESKY_PROVIDER_ERROR_CODES.RECORD_REFUSED, { reason, ...details });

/**
 * Classifies the provider-native post into an explicit source type.
 *
 * AT Protocol record types are separate COLLECTIONS, and this adapter supports
 * exactly one of them. A repost/feed wrapper is NOT a post: it arrives as a
 * `feedViewPost` whose `reason.$type` is `app.bsky.feed.defs#reasonRepost`, and
 * such a wrapper is refused rather than being mistaken for the original post it
 * points at.
 *
 * Reply vs original is decided by the record's own `reply` ref, which is part of
 * the signed record content.
 */
export function classifyBlueskySourceType(view) {
  if (!isPlainObject(view)) refuse('POSTVIEW_NOT_AN_OBJECT');
  if (view.$type === 'app.bsky.feed.defs#feedViewPost' || view.$type === 'app.bsky.feed.defs#skeletonFeedPost') {
    refuse('FEED_WRAPPER_NOT_A_POST', { wrapper: String(view.$type).slice(0, 48) });
  }
  // A repost reason attached to a feed item must never masquerade as a new post.
  if (view.reason !== undefined && view.reason !== null) {
    refuse('FEED_WRAPPER_REPOST_REASON', { reasonType: String(view.reason?.$type ?? '').slice(0, 48) });
  }
  if (view.post !== undefined && view.post !== null) refuse('NESTED_POST_WRAPPER');
  const recordType = view.record?.$type;
  if (recordType !== undefined && !BLUESKY_SUPPORTED_RECORD_TYPES.includes(recordType)) {
    refuse('RECORD_TYPE_UNSUPPORTED', { recordType: String(recordType).slice(0, 48) });
  }
  const parsed = parseAtUri(view.uri);
  if (parsed === null) refuse('AT_URI_INVALID');
  if (view.cid === undefined || view.cid === null) refuse('CID_MISSING');
  // Rejects an embed that points at a record in an unsupported collection.
  const embedTypes = [
    ...(isPlainObject(view.embed) && typeof view.embed.$type === 'string' ? [view.embed.$type] : []),
    ...(Array.isArray(view.embeds) ? view.embeds.map(entry => entry?.$type).filter(type => typeof type === 'string') : []),
  ];
  for (const type of embedTypes) {
    if (NON_POST_EMBED.includes(type)) continue;
    refuse('EMBED_TYPE_UNSUPPORTED', { embedType: type.slice(0, 48) });
  }
  if (!isPlainObject(view.record)) refuse('RECORD_NOT_AN_OBJECT');
  if (typeof view.record.text !== 'string') refuse('RECORD_TEXT_NOT_A_STRING');
  if (typeof view.author?.did !== 'string' || !view.author.did.trim()) refuse('AUTHOR_DID_MISSING');

  return isPlainObject(view.record.reply) && typeof view.record.reply.parent?.uri === 'string' ? 'REPLY' : 'POST';
}

/**
 * The provider's own content address for the record at this AT URI.
 *
 * Returned separately rather than stored inside the frozen 5K.1 raw metadata
 * schema: adding a field there would change Mastodon's raw evidence bytes and
 * force an edit to the 5K.2 mapper. The CID is instead carried by the additive,
 * fingerprint-bound revision-evidence sidecar, which never alters a 5K.1 record.
 */
export function providerContentCidOf(view) {
  return assertProviderCid(view?.cid);
}

/**
 * Maps one provider-native postView into the EXISTING 5K.1 raw observation.
 *
 * options: { fetchedAt, collectionRunId, collectorMode }
 */
export function mapPostViewToRawObservation(view, { fetchedAt, collectionRunId, collectorMode }) {
  const sourceType = classifyBlueskySourceType(view);

  const parsedUri = parseAtUri(view.uri);
  const did = view.author.did;

  // The credential/privacy guard runs over the WHOLE native record (keys) and
  // every string the mapper consumes. It reports the CLASS of the problem, never
  // the offending value.
  const rawText = decodeBlueskyEntities(view.record.text);
  assertNoCredentialOrPrivateLeak(view, [rawText, view.uri]);

  const cid = assertProviderCid(view.cid);
  const authorDidMatchesUri = parsedUri.authority === did;
  if (!authorDidMatchesUri) refuse('AUTHOR_DID_NE_AT_URI_AUTHORITY');

  const publishedAt = parseBlueskyTimestamp(view.record.createdAt);

  const mints = extractExactMints(rawText);
  const cashtags = [...new Set(rawText.match(CASHTAG) ?? [])];
  const hashtags = [...new Set([...(rawText.match(HASHTAG) ?? []).map(tag => `#${tag.slice(1)}`)])];

  // Engagement maps onto the FROZEN 5K.1 counter vocabulary. A counter the
  // provider did not supply stays absent; it is never defaulted to zero.
  const engagement = {};
  for (const [providerField, target] of Object.entries(BLUESKY_ENGAGEMENT_MAPPING)) {
    const value = countOrOmit(view[providerField]);
    if (value !== undefined) engagement[target] = value;
  }

  const raw = {
    schemaVersion: PUBLIC_INTELLIGENCE_SCHEMA_VERSION,
    recordType: PUBLIC_INTELLIGENCE_RECORD_TYPES.RAW_SOCIAL_OBSERVATION,
    // Stable namespace. No DID, no handle, no host.
    provider: BLUESKY_PROVIDER_NAMESPACE,
    // The AT URI: the record's stable path identity, DID-based, handle-free.
    providerObservationId: view.uri,
    // The DID only. No handle, no display name, no profile.
    providerAuthorId: did,
    sourceType,
    // The canonical public web permalink. Constructed from the AT URI, never
    // from a mutable handle, and never used as identity.
    sourceUrl: `https://bsky.app/profile/${encodeURIComponent(did)}/post/${encodeURIComponent(parsedUri.rkey)}`,
    publishedAt,
    // The AppView does not tell us when EVOLVE observed it. The adapter does
    // not invent one; fetchedAt carries the acquisition instant separately.
    observedAt: null,
    fetchedAt,
    rawText,
    rawMetadata: {
      language: Array.isArray(view.record.langs) && typeof view.record.langs[0] === 'string' ? view.record.langs[0] : null,
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
      adapterName: BLUESKY_ADAPTER_NAME,
      adapterVersion: BLUESKY_ADAPTER_VERSION,
      collectorMode,
    },
    classification: PUBLIC_INTELLIGENCE_CLASSIFICATION,
  };

  // The provider CID travels as derived, non-frozen metadata alongside the
  // record. It is bound to the record by `rawObservationFingerprint` and is
  // NEVER used as an EVOLVE fingerprint.
  return Object.freeze({ raw: canonicalizeRawObservation(raw), providerContentCid: cid });
}

export { BlueskyAdapterError, BLUESKY_PROVIDER_NAMESPACE };
