# Phase 5K.6 — Bluesky / AT Protocol Public Provider

**Roadmap label:** PHASE_5K_6 — SECOND LIVE PUBLIC PROVIDER.

**Status:** research / observer only. This phase adds an *observation* surface and
nothing else.

## Purpose

Phase 5K.6 adds Bluesky / AT Protocol as the **second** live public provider, on
top of the governance (5K.0), evidence and provenance boundary (5K.1), the first
provider adapter (5K.2), bounded collection runs (5K.3), the cross-run corpus
(5K.4) and temporal/revision semantics (5K.5).

It adds **no** sentiment, no score, no ranking, no prediction, no market linkage,
no price correlation, no trading signal, no profitability inference, and it has
**no** engine authority and **no** Arena authority. A Bluesky observation is
evidence that a public post existed and was acquired. Nothing more.

## Official endpoint

A single credentialless public endpoint:

    GET https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts

* host: `public.api.bsky.app` (the documented public AppView) — fixed, not
  operator-selectable
* method: `app.bsky.feed.searchPosts` — the only governed XRPC method
* parameters used: `q`, `limit`, `cursor` — nothing else
* transport: HTTPS only, `redirect: 'error'`, `credentials: 'omit'`,
  no `Authorization`, no `Cookie`, no OAuth, no app password, no session, no
  scraping of `bsky.app`

If the endpoint ever requires authentication, the adapter **fails closed** with
`BLUESKY_AUTH_REQUIRED` and the run stops. It never adapts by adding a
credential.

## Provider identity

    provider = bluesky:public-appview

Deliberately host-free and handle-free: upstream identity must stay stable when
an account changes its handle or when the provider moves infrastructure. The
namespace carries no DID, no handle and no host.

## AT URI

    providerObservationId = at://did:plc:.../app.bsky.feed.post/<rkey>

AT Protocol repository paths are `<collection>/<record-key>`, and a path is stable
for the life of a record while everything about its content may change. The AT URI
is therefore the correct identity. It is **not** derived from a handle, a display
name, post text, a timestamp, a web URL or a CID alone.

## DID

`providerAuthorId` is the author's **DID** (e.g. `did:plc:...`), and the mapper
refuses any record whose `author.did` does not match the AT URI authority. The
source permalink is built from the DID, never from a mutable handle.

## CID semantics

`cid` is the provider's own content address for the record at that AT URI.

* A CID is **provider-native content-addressed evidence**.
* A CID is **never** an EVOLVE fingerprint. It never replaces or influences
  `rawObservationFingerprint`, `contentFingerprint` or
  `observationStateFingerprint`, which remain authoritative for EVOLVE evidence.
* The CID is carried in an **authenticated sidecar** bound to the exact
  `rawObservationFingerprint` of the observation it describes, so the frozen 5K.1
  raw schema does not have to learn about CIDs.

## Revision semantics

Per the AT Protocol repository spec, updating a record changes its CID while the
path — and therefore the AT URI — stays the same.

    same AT URI + same CID       => one content version
    same AT URI + different CID  => provider-declared content revision
    no CID available             => no proof

A CID difference is **only** ever claimed when the provider itself returned a
different CID for the same AT URI. It is never inferred from a text change and
never inferred from a counter change.

Requirements honoured:

* revision evidence is bound to the exact `rawObservationFingerprint`
* every historical version is preserved
* there is no latest-wins overwrite
* same URI + same CID is the same provider content version
* frozen 5K.1 raw evidence is never rewritten

Mastodon's revision semantics (a provider `edited_at` timestamp) are **not
modified** by this phase; Bluesky uses its own content-address sidecar.

## Transport

`providers/bluesky-transport.mjs` is the only Bluesky module that opens a
network connection.

* HTTPS, fixed public host, no redirects, no credentials
* bounded pages, bounded records, bounded response bytes, bounded timeout
* at most one retry, and only for a transient 5xx or network error
* a 429 is never retried and is never slept on; the module contains no sleep
* arbitrary hosts, arbitrary XRPC methods and arbitrary URLs are impossible
* request records are structural only (status, counts, bytes, timing)

## Mapper

`providers/bluesky-mapper.mjs` is **pure and offline** — no socket, no clock, no
environment, no filesystem. It maps a provider `postView` into the **existing
closed 5K.1 raw schema** and invents no parallel schema. Only minimized evidence
is retained: identity, timestamps, text, governed raw metadata, exact-mint
association, collection context and classification.

## Privacy

Refused or dropped by construction: display name, avatar, banner, profile
description/bio, follower counts, following counts, post counts, labels, lists,
contact graphs, viewer state, private data, e-mail, geo, address, cookies,
credentials and tokens. Only `author.did` is ever read from the author profile.
Identity uses the DID / AT URI rather than a mutable human-readable handle.

## Reply

A record whose own `record.reply.parent.uri` is present maps deterministically to
source type `REPLY`. The reply reference is part of the signed record content, so
reply-ness is provider-declared rather than inferred.

## Quote

A quote is a post that embeds another record (`app.bsky.embed.record` or
`app.bsky.embed.recordWithMedia`). The quoted record is treated as a non-post
embed for text purposes, so the quoting post maps as its own observation and the
quoted text never contributes to its text.

## Repost

A repost / feed wrapper (`app.bsky.feed.defs#feedViewPost`,
`#skeletonFeedPost`, or any view carrying a `reason` such as `#reasonRepost`) is
**refused** rather than mistaken for the original post it points at. A wrapper
must never masquerade as a new original post, and identities are never flattened
accidentally. Unsupported forms fail closed.

## Engagement

`likeCount`, `replyCount`, `repostCount` and `quoteCount` are retained as
**observation-state** semantics and mapped onto the frozen 5K.1 counter
vocabulary. Changing counters are *same content, updated state* — never a content
conflict. Counter regression is allowed. Missing stays missing; a provider zero
stays an observed zero; there is no interpolation and no zero-filling.

## Exact mint

Only an explicit exact Solana mint address present in public post evidence may
become `claimedMint`. A mint is never inferred from a ticker, symbol, cashtag,
hashtag, display handle, project name, domain, URL slug, profile or link preview.
Exactly one distinct exact candidate becomes `claimedMint`; zero or several
leaves it `null` and 5K.1 decides `UNASSOCIATED` / `AMBIGUOUS`. Never guessed.

## Collection plan integration

5K.3 is extended **additively** for provider-neutral support:

* the governed provider registry gains `bluesky`
* the governed query-type registry gains `TEXT_SEARCH`
* `TEXT_SEARCH` accepts a bounded plain keyword only — letters and digits — so it
  can carry no URL, path, XRPC parameter or query syntax
* Mastodon keeps `HASHTAG`, and Mastodon plans stay byte-identical
* the run engine takes an **injected** adapter, so 5K.3's single-transport
  isolation guarantee is preserved
* the raw-observation provider namespace comes from the governed registry, so a
  plan can never influence its own namespace

## Run

Bluesky runs use the existing bounded-run machinery: plan, run identity,
manifest, bounded requests, accounting invariants, storage layout and terminal
status. Bluesky runs finalize, verify, replay offline and tamper-detect.
Request records remain structural only — no body dumps, no full response headers,
no cookies, no authorization and no credentials.

## Replay

Replay performs **zero** network calls: it re-reads stored artifacts and
re-derives every fingerprint. The validator proves this with a fetch tripwire.

## Cross-provider corpus

5K.4 supports both providers. Provider-scoped identity stays authoritative:
Mastodon and Bluesky evidence is **never** deduplicated across provider
namespaces merely because text, mint, URL or timestamp matches.

## Temporal integration

5K.5 supports Bluesky observation state and revision semantics through the
provider-specific sidecar. Field classification remains exhaustive, and the
temporal layer refuses any field it has not classified.

## Non-goals

No sentiment. No score. No ranking. No prediction. No market linkage. No price
correlation. No trading signal. No profitability inference. No engine authority.
No Arena authority. No promotion. No execution. No credentials. No scraping.

Stated as explicit refusals: this phase grants **no trading authority**, **no
engine authority**, **no arena eligibility**, **no market linkage**, **no price
correlation** and **no profitability inference**. A Bluesky observation is **not
a trading signal** and is **not a trading signal** under any interpretation.

## Roadmap label

`PHASE_5K_6` — second live public provider (Bluesky / AT Protocol). Later phases
are not implemented here and nothing in this document claims them.
