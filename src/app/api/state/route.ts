import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  try {
    const statePath = path.join(process.cwd(), ".evolve", "state.json");
    const raw = await readFile(statePath, "utf8");

    return new NextResponse(raw, {
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store, max-age=0",
      },
    });
  } catch {
    return NextResponse.json(
      {
        error: "Engine state is not available yet.",
        hint: "Run npm run dev:all so the dashboard and evolutionary engine start together.",
      },
      { status: 503 },
    );
  }
}
