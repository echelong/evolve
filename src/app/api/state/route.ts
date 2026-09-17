import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";

import { sanitizeForPublic } from "../../../../scripts/lib/sanitize.mjs";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Public dashboard state.
 *
 * The engine already writes a sanitized, secret-free snapshot, and the API key
 * is stored as a non-enumerable config property that never reaches state. This
 * route re-runs the same sanitizer on the way out as a second guard, so a
 * hand-edited or older state file still cannot leak a credential, a non-finite
 * number, or an unserializable value to the browser.
 *
 * EVOLVE is paper trading only. Nothing served here can place a trade.
 */

const sanitize = sanitizeForPublic as (
  value: unknown,
  options?: { secrets?: string[] },
) => unknown;

export async function GET() {
  const secrets = [process.env.JUPITER_API_KEY, process.env.HELIUS_API_KEY].filter(
    (value): value is string => typeof value === "string" && value.trim().length >= 4,
  );

  try {
    const statePath = path.join(process.cwd(), ".evolve", "state.json");
    const raw = await readFile(statePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const payload = sanitize(parsed, { secrets });

    return NextResponse.json(payload, {
      headers: {
        "cache-control": "no-store, max-age=0",
        "x-evolve-mode": "paper-only",
      },
    });
  } catch {
    return NextResponse.json(
      {
        error: "Engine state is not available yet.",
        hint: "Run npm run dev:all so the dashboard and evolutionary engine start together.",
        paperOnly: true,
      },
      { status: 503 },
    );
  }
}
