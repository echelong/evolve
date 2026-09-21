#!/usr/bin/env node
/**
 * EVOLVE Phase 5I-PS.1 — JEV PAPER SHADOW POST-HOC FORENSIC ANALYZER (entry).
 *
 *   npm run jev:paper:analyze -- --session jpaper-<UTC timestamp>-<digest>
 *
 * FULLY OFFLINE: no network call, no Jev call, no Jupiter call, no live market
 * call, no provider construction, no API key, no Jev configuration, and no
 * wallet / signing / swap / order / RPC-write / execution capability.
 *
 * The analyzer READS one captured paper-shadow session and writes a forensic
 * artifact set into the separate `.evolve/jev-paper-forensics/<analysis-id>/`
 * tree. It never modifies, scores, tunes, influences, or contaminates Phase
 * 5I.0b, the Phase 5I.1 canonical replication, the Phase 5I.1a temporal
 * replication, tomorrow's temporal session, the Arena, the Shadow League, the
 * deployment gates, evolution, or the research swarm.
 *
 * PAPER ONLY / DEVELOPMENT ONLY / POST-HOC ONLY.
 */

import { runPaperForensicsCli } from "./jev/paper-forensics/cli.mjs";

const exitCode = await runPaperForensicsCli(process.argv.slice(2));
process.exitCode = exitCode;
