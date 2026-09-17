#!/usr/bin/env node
/**
 * Champions CLI.
 *
 *   npm run champions
 *
 * Prints the champion archive and the Hall of Fame. Neither implies deployment
 * eligibility, profitability, or safety — paper research records only.
 */

import path from "node:path";
import { readFile } from "node:fs/promises";

import { createMarketConfig } from "./market/config.mjs";

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function main() {
  const config = createMarketConfig(process.env, { loadEnv: true });
  const championsDir = config.championsDir ?? ".evolve/champions";
  const hofFile = path.join(config.hallOfFameDir ?? ".evolve/hall-of-fame", "index.json");

  const index = await readJson(path.join(championsDir, "index.json"));
  const hof = await readJson(hofFile);

  console.log("=".repeat(72));
  console.log("CHAMPION ARCHIVE  •  PAPER RESEARCH RECORDS");
  console.log("=".repeat(72));

  const champions = index?.champions ?? [];
  if (champions.length === 0) {
    console.log("No champions archived yet. Run:  npm run experiment -- <dataset>");
  } else {
    for (const champ of champions.slice(0, 24)) {
      console.log(
        `  ${String(champ.species ?? "?").padEnd(16)} ${String(champ.genomeDigest ?? "?").slice(0, 12)}  robustness ${String(champ.robustness ?? "n/a").padStart(8)}  ${champ.classification ?? ""}`,
      );
    }
  }

  console.log("");
  console.log("=".repeat(72));
  console.log("HALL OF FAME  •  HISTORICAL INTEREST ONLY — NOT DEPLOYMENT ELIGIBILITY");
  console.log("=".repeat(72));

  const members = hof?.members ?? [];
  if (members.length === 0) {
    console.log("No Hall of Fame members yet. Run:  npm run arena");
  } else {
    console.log("  digest         species           appear  defend  elim  best   latest  status");
    for (const member of members.slice(0, 24)) {
      console.log(
        `  ${String(member.digest ?? "?").slice(0, 12)}  ${String(member.species ?? "?").padEnd(16)}  ${String(member.arenaAppearances ?? 0).padStart(6)}  ${String(member.titleDefenses ?? 0).padStart(6)}  ${String(member.eliminations ?? 0).padStart(4)}  ${String(member.bestArenaScore ?? "n/a").padStart(5)}  ${String(member.latestArenaScore ?? "n/a").padStart(6)}  ${member.bestStatus ?? "-"}`,
      );
    }
    console.log("");
    console.log(`  ${members.length} member(s) · updated ${hof?.updated ?? "unknown"}`);
    console.log("  Hall of Fame does NOT imply deployment eligibility or profitability.");
  }
}

main().catch((error) => {
  console.error("[champions] failed:", error?.message ?? error);
  process.exitCode = 1;
});
