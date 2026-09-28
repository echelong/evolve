# R4 future-observation capture engineering

This is pre-preregistration capture engineering. The P3-C reuse policy and all
frozen R4 outcome rules remain unchanged. No outcome or return is computed by
the revisit scheduler or its offline capacity simulation.

## Existing path and root cause

The live-only CLI calls `feed.advance()`, then copies `feed.markets()` into the
intelligence recorder, then sleeps for the larger of the GMGN and Dex polling
intervals (30 seconds by default). The measured request and processing time
made the shakedown cycle about 39 seconds. The Jupiter client rotates one of
three ranked Tokens V2 list endpoints per permitted request. It has a 3-second
keyed or 3.5-second keyless minimum poll interval and request spacing of 0.8
or 2 seconds, respectively. The feed merges returned mints into a bounded
150-mint universe and retains older observations until eviction/expiry. A
feed entry is not a new provider observation merely because it is copied again.

The recorder sorts the current Jupiter mints, selects six Dex mint requests per
capture from a rotating cursor, and sends them serially through a transport
with one in-flight request and 1.2-second spacing. Dex allows six requests per
30-second provider cycle, has a 30-second cache, bounded backoff and HTTP 429
backoff. Each Dex request is for one mint and can return multiple pairs, but
those pairs count as one provider. GMGN has its own cursor and route rotation;
it was disabled without a key in the shakedown. Normalized provider records
are retained by provider, mint, endpoint and pair; aggregation groups by mint
and writes one snapshot per group per capture. Price comparability requires
fresh records aligned within 15 seconds. Jupiter and Dex must be the two price
contributors for R4. The outcome foundation later validates each source record
and derives eligible references from valid existing snapshots; maturation
sessions add candidates and never add references. No prior future-revisit
scheduler existed.

With about 150 ambient mints and six Dex requests per 39-second capture,
same-mint Dex round robin takes about 25 captures or 975 seconds, close to the
observed 933-second median. That leaves almost no same-mint Dex observations
near a five-minute target. The primary S2 shakedown had 196 eligible references
from 106 mints and zero otherwise-valid future candidates, even with the P3-C
reuse comparison removed. The failure precedes the P3-C policy question.

## Frozen timing math

For reference timestamp `t`, both future contributors must be observed at or
after `t+300000`; the snapshot must occur in the inclusive interval
`[t+300000,t+360000]`. A contributor may be at most 60 seconds old at that
snapshot, and the two provider observations must be within 15 seconds of each
other. A targeted pair can therefore start at `t+300000` and has at most 60
seconds total for scheduling delay, provider work, and snapshot creation. The
inter-provider gap has its own 15-second limit. Request latency and capture
work consume these budgets; the scheduler does not reinterpret them.

For a mint-independent round robin to guarantee one Dex observation in every
60-second future window, its same-mint revisit gap must be at most 60 seconds
(less in practice for latency). For independently phased Jupiter and Dex
polling, Jupiter same-mint gaps of at most 15 seconds are needed to guarantee
alignment to a Dex request. At 150 mints, Dex would require at least 150
requests/minute, or 75 per 30 seconds, while the configured cap is six per
30 seconds. Polling both providers independently to a 15-second per-mint
cadence would require 600 mint observations/minute each. Faster global round
robin is therefore infeasible under the existing Dex cap.

## Selected scheduler

`capture --r4-revisits` opt-in uses the existing live feed and recorder. Each
valid two-source snapshot before the requested reference cutoff schedules a
Dex revisit at exactly its snapshot time plus 300 seconds. The queue contains
only mint and time. It sorts by target time then mint, deduplicates identical
mint/time entries, has a 10,000-entry hard cap, and coalesces simultaneous due
work for one mint into one request. Targeted Dex work precedes passive work,
and bypasses the transport cache to make a real request. Up to two passive Dex
slots are used on each ordinary capture; due-only captures use no passive Dex
slots. Existing capture without the flag retains its original behavior.

The due loop continues the existing Jupiter endpoint rotation and waits until
the mint has a Jupiter list inclusion at or after the target and no more than
15 seconds old before issuing Dex. It does not issue a Dex request merely
because an old Jupiter value remains in the universe. R4 capture copies the
feed universe's already tracked per-mint `lastSeenAt` as `lastFetchedAt` and
uses it as the local Jupiter request-start timestamp. This can advance on a
real unchanged-value response while the engine's changed-value `observedAt`
remains untouched. The copied payload explicitly labels this timestamp as
local fetch provenance, not a provider price update. The returned snapshot must pass
the existing two-source validator and both contributor timestamps must be at
or after the target. A failed attempt or missed inclusive deadline is an
explicit coverage failure. Cycle-budget/backoff deferrals remain pending and
are retried within the window. Capture drains pending work after the reference
cutoff; any coverage failure makes the session incomplete. A signal with
pending work also makes the session incomplete. An abrupt process death leaves
an unfinalized session, which the source reader rejects; the queue is never
silently reconstructed from an old finalized session. A new session starts a
new queue. The existing session cannot be resumed or overwritten. The summary
records scheduled/completed/failed/pending counts and failure codes; the queue
keeps at most 32 example failures in memory.

Scheduling uses source validity, mint and reference time only. It does not
read model scores, price direction, subsequent movement, or outcome values.
The later R4 resolver and `REUSED_REFERENCE_PRICE_EVIDENCE` test are unchanged.
The scheduler can create an observation opportunity; it cannot force a ranked
Jupiter endpoint to return a specific mint or force prices to change.

## Offline capacity and limits

The offline simulation reads the verified S2 session and its 196 structurally
valid reference times without resolving outcomes. It models the actual local
six-request Dex provider cycle, two passive request attempts on each ordinary
39-second capture, and 1.2-second serialized requests. All 196 have a service
opportunity within `[t+300s,t+360s]`; the maximum simulated targeted load is
six in a provider cycle.
Thus 196/196 have a Dex freshness opportunity. Under the explicit assumption
that a Jupiter ranked-list poll returns each due mint near service time,
196/196 also have Jupiter freshness and 15-second alignment opportunities,
and 196/196 are theoretically capable of a valid two-source candidate. These
are structural opportunities, not observed provider responses or a forecast
of actual valid prices. The simulator reports misses in overload cases.

196 targets in 30 minutes average 6.53 targeted requests/minute. Two passive
requests per 30 seconds add at most four/minute, totaling 10.53/minute against
the configured 12/minute Dex ceiling: about 1.47 requests/minute (12.2%)
average headroom. A bucket containing four targets and two passive requests
has zero instantaneous headroom. Bursts, HTTP 429/backoff, slow responses,
Jupiter mint absence and session storage limits can still cause explicit
coverage failure. The rate cap is local; no claim is made about an external
provider's future quota.

## Provenance audit

Provider-authenticated: Dex pair address and payload contents; Jupiter Tokens
V2 token fields; GMGN envelope and data fields. The current adapter has no
verified upstream observation ID or per-mint update timestamp for Dex/GMGN.
Jupiter `lastObservedAt` is a local feed request-start timestamp, not a
provider-authenticated price update time. There is no provider-authenticated
distinct-response identifier in the persisted price evidence.

Transport-level: the HTTP layer has access to response headers and status.
It currently reads `Retry-After` and `x-ratelimit-reset` on failures, but
does not persist `Date`, `Age`, `ETag`, `Last-Modified`, cache headers, request
IDs or response IDs; their presence in real provider responses is unknown.
Jupiter's client also sees the response object but does not persist headers.

Locally generated: the Dex/GMGN transport has request attempt state, receipt
time, serial request count, cache state and one-in-flight state. GMGN adds a
random client ID to authenticated request URLs but does not persist it. The
Jupiter feed tracks request start and response latency. R4 capture now records
`lastFetchedAt` from the existing per-mint `lastSeenAt` field, with a
`feed_last_seen_request_start_and_local_copy` basis. This improves local
attempt-time distinguishability but does not authenticate an upstream update,
and the normalized price digest can still match the reference. A later, separately
tested backward-compatible enhancement could persist a local request UUID,
start/end/receipt times, and an allowlisted set of actually returned response
headers, explicitly labeled by provenance tier. This would distinguish local
fetch attempts but would not authenticate a provider-side price update or
change the frozen P3-C reuse comparison. No request UUID or HTTP header is added here.
