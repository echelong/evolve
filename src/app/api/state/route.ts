import path from "node:path";
import { NextResponse } from "next/server";

import { readDashboardState } from "../../../../scripts/lib/dashboard-state.mjs";
import { loadJevPaperShadowState } from "../../../../scripts/jev/paper-shadow/dashboard.mjs";
import { sanitizeForPublic } from "../../../../scripts/lib/sanitize.mjs";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Public dashboard state.
 *
 * State isolation:
 *   live / synthetic engine -> .evolve/state.json
 *   historical replay       -> .evolve/replay-state.json
 *   experiment reports      -> .evolve/experiments/<id>/ (read-only, summarized)
 *   champion archive        -> .evolve/champions/index.json (read-only, summarized)
 *   champion arena          -> .evolve/arenas/<id>/summary.json (read-only, summarized)
 *   hall of fame            -> .evolve/hall-of-fame/index.json (read-only, summarized)
 *   live shadow league      -> .evolve/shadow/*.json (read-only, summarized, PAPER ONLY)
 *   research swarm memory   -> .evolve/research/ (read-only via the live state summary)
 *   Jev shadow supervisor   -> .evolve/jev/ (read-only, summarized, SHADOW ONLY, Phase 5D)
 *   Jev paper shadow (5I-PS)-> .evolve/jev-paper-shadow/ (read-only, summarized,
 *                              PAPER ONLY DEVELOPMENT demo; never canonical/
 *                              replication/Arena/deployment evidence)
 *   Agent-Reach observations -> .evolve/intelligence/ (read-only, summarized,
 *                              SHADOW ONLY, Phase 5E — identity/health/counts
 *                              only; never raw social text, URLs or cookies)
 *
 * Two research concepts are exposed as two distinct fields and are never
 * merged (Phase 5A.1):
 *
 *   researchSwarm      the CURRENT Phase 5A controlled research swarm summary
 *                      (cycle, provider, proposals, compiled families, injected
 *                      candidates, memory records, researcher roles, watchdog
 *                      NORMAL/WATCH/QUARANTINED counts, current research regime)
 *   historicalResearch Phase 3/4 replay + experiment + arena + champion + shadow
 *                      reference data, explicitly labelled historical
 *
 * The dashboard asks for a source (`?source=live|replay|auto`). A replay run can
 * never overwrite what the live dashboard shows: `auto` serves the live document
 * whenever it exists (a stale live snapshot is still the current live run) and
 * only falls back to a replay when there is no live state at all. The swarm
 * summary additionally falls back to the live document, so browsing a historical
 * replay never blanks the swarm panel.
 *
 * The selection + assembly logic lives in `scripts/lib/dashboard-state.mjs` so
 * the offline validation suite can exercise the exact same contract the browser
 * consumes (see validate-phase5a cases 64+).
 *
 * Security: the engine already writes a sanitized, secret-free snapshot, the API
 * key is a non-enumerable config property that never reaches state, and this
 * route re-runs the same sanitizer on the way out with the environment secrets
 * passed explicitly, so a hand-edited or older file still cannot leak a
 * credential, a non-finite number, or an unserializable value to the browser.
 *
 * Historical replay is raw observations replayed through the paper engine; it is
 * never presented as a prediction or as real profit.
 */

const sanitize = sanitizeForPublic as (
  value: unknown,
  options?: { secrets?: string[] },
) => unknown;

const readState = readDashboardState as (options: {
  root: string;
  requested: string;
}) => Promise<{ status: number; body: unknown }>;

const readJevPaperShadow = loadJevPaperShadowState as (root: string) => Promise<unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function GET(request: Request) {
  const secrets = [process.env.JUPITER_API_KEY, process.env.HELIUS_API_KEY].filter(
    (value): value is string => typeof value === "string" && value.trim().length >= 4,
  );

  const requestedParam = new URL(request.url).searchParams.get("source");
  const configured = process.env.EVOLVE_DASHBOARD_SOURCE ?? "auto";
  const requested = (requestedParam ?? configured).toLowerCase();

  const evolveRoot = path.join(process.cwd(), ".evolve");
  const { status, body } = await readState({
    root: evolveRoot,
    requested,
  });

  // Phase 5I-PS: attach the isolated Jev PAPER SHADOW block as its OWN field,
  // never merged into `jevShadow` (Phase 5D supervisor health). This is a
  // DEVELOPMENT dashboard demo — read-only, compact, paper only, and never
  // canonical/replication/Arena/deployment evidence. It is attached here rather
  // than inside `readDashboardState` because that module is a byte-frozen Phase
  // 5H.0 sealed source.
  const jevPaperShadow = await readJevPaperShadow(evolveRoot);
  const composed = isRecord(body) ? { ...body, jevPaperShadow } : body;

  const payload = sanitize(composed, { secrets });
  const stateSource =
    typeof (payload as { stateSource?: unknown })?.stateSource === "string"
      ? ((payload as { stateSource: string }).stateSource as string)
      : "none";

  return NextResponse.json(payload, {
    status,
    headers: {
      "cache-control": "no-store, max-age=0",
      "x-evolve-mode": "paper-only",
      "x-evolve-state-source": stateSource,
    },
  });
}
