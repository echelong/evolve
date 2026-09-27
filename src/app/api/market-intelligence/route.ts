import path from "node:path";
import { NextResponse } from "next/server";
import { loadMarketIntelligenceDashboard } from "../../../../scripts/market-intelligence/dashboard.mjs";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  return NextResponse.json(loadMarketIntelligenceDashboard(path.join(process.cwd(), ".evolve", "market-intelligence")));
}
