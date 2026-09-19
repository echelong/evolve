"use client";

import {
  Activity,
  BrainCircuit,
  CircleDollarSign,
  Coins,
  Crosshair,
  Database,
  Dna,
  FlaskConical,
  Gauge,
  Map,
  Microscope,
  Radio,
  RadioTower,
  ScanSearch,
  ShieldCheck,
  ShieldAlert,
  Signal,
  Sparkles,
  TrendingUp,
  Users,
  WalletCards,
} from "lucide-react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useEffect, useMemo, useState } from "react";

type Agent = {
  id: string;
  species: string;
  parents: string[];
  born: number;
  age: number;
  equity: number;
  returnPct: number;
  netPnl: number;
  grossPnl: number;
  costs: number;
  fitness: number;
  trades: number;
  winRate: number;
  maxDrawdown: number;
  status: string;
  lastAction: string;
  position: null | {
    symbol: string;
    mint: string;
    qty: number;
    entryPrice: number;
    markPrice: number;
    heldTicks: number;
  };
  // Phase 5A: present only for research-compiled candidates.
  research?: {
    familyId: string;
    proposalId: string | null;
    authorRole: string | null;
    targetRegimes: string[];
    abstainRegimes: string[];
    posture: string;
  } | null;
};

type MarketFeed = {
  requestedMode: string;
  effectiveMode: string;
  provider: string;
  source: string;
  live: boolean;
  healthy: boolean;
  degraded: boolean;
  stale: boolean;
  entriesPaused: boolean;
  allowNewEntries: boolean;
  banner: string;
  statusLabel: string;
  modeReason: string;
  fallbackReason: string | null;
  fallbackActive: boolean;
  promotedFromFallback: boolean;
  degradedReason: string | null;
  apiKeyConfigured: boolean;
  keyless: boolean;
  lastSuccessAt: number | null;
  lastAttemptAt: number | null;
  lastObservationAt: number | null;
  ageMs: number | null;
  staleMs: number;
  requestCount: number;
  okCount: number;
  errorCount: number;
  rateLimitCount: number;
  authErrorCount: number;
  timeoutCount: number;
  consecutiveFailures: number;
  backoffMs: number;
  nextAttemptInMs: number;
  lastLatencyMs: number | null;
  lastEndpoint: string | null;
  lastErrorKind: string | null;
  lastErrorSafe: string | null;
  tokensTracked: number;
  universe: {
    tracked: number;
    max: number;
    usable: number;
    fresh: number;
    evicted: number;
    mergedObservations: number;
    lastIngestAt: number | null;
  };
  endpoints: string[];
  pollMs: number;
  synthetic: { tokenCount: number; steps: number; regime: string };
  observerOnly: boolean;
  execution: string;
};

type MarketRow = {
  mint: string;
  shortMint: string;
  symbol: string | null;
  name: string | null;
  price: number | null;
  changePct: number | null;
  liquidity: number | null;
  liquidityChange: number | null;
  mcap: number | null;
  volume5m: number | null;
  buySellRatio: number;
  organicBuySellRatio: number;
  organicScore: number | null;
  organicScoreLabel: string | null;
  holderCount: number | null;
  topHoldersPercentage: number | null;
  poolAgeMs: number | null;
  numTraders: number | null;
  numOrganicBuyers: number | null;
  numNetBuyers: number | null;
  verified: boolean;
  mintAuthorityDisabled: boolean;
  freezeAuthorityDisabled: boolean;
  synthetic: boolean;
  fresh: boolean;
  ageMs: number;
  endpoint: string | null;
};

type Position = {
  agentId: string;
  species: string;
  symbol: string;
  shortMint: string;
  qty: number;
  cost: number;
  value: number;
  entryPrice: number | null;
  markPrice: number | null;
  unrealizedPnl: number;
  unrealizedPct: number;
  heldTicks: number;
  openedAt: string;
};

type Trade = {
  id: string;
  at: string;
  agentId: string;
  species: string;
  symbol: string;
  reason: string;
  netPnl: number;
  grossPnl: number;
  costUsd: number;
  heldTicks: number;
};

type EvolveState = {
  updatedAt: string;
  mode: string;
  modeLabel: string;
  paperOnly: boolean;
  guards: {
    paperOnly: boolean;
    realMoney: boolean;
    canSpendRealSol: boolean;
    walletKeysLoaded: boolean;
    walletConnector: boolean;
    signingCapability: string;
    submissionCapability: string;
    onChainExecution: string;
    providerCalls: string;
  };
  marketFeed: MarketFeed;
  paper: {
    startingCash: number;
    baseFeeBps: number;
    minSlippageBps: number;
    adverseBufferBps: number;
    slippageCapBps: number;
    grossPnl: number;
    netPnl: number;
    costs: number;
    costDragBps: number;
    totalEquity: number;
    note: string;
  };
  generation: number;
  tick: number;
  generationTicks: number;
  marketRegime: string;
  marketBreadth: number;
  stats: {
    population: number;
    alive: number;
    holding: number;
    scanning: number;
    paused: number;
    bornTotal: number;
    terminatedTotal: number;
    trades: number;
    totalEquity: number;
    totalCash: number;
    startingCash: number;
    avgReturn: number;
    netPnl: number;
    bestFitness: number;
    bestReturn: number;
    populationTarget?: number;
  };
  topAgents: Agent[];
  positions: Position[];
  species: {
    name: string;
    role: string;
    count: number;
    avgReturn: number;
    medianReturn?: number;
    avgFitness: number;
    trades: number;
    births?: number;
    deaths?: number;
    peakCount?: number;
    extinctionEvents?: number;
    extinct?: boolean;
  }[];
  // --- Phase 5A / 5A.1: strategy islands --------------------------------
  islands?: {
    name: string;
    /** Initialization/base split — a weight, never a hard per-generation quota. */
    target: number;
    /** This generation's evidence-adjusted, inertia-bounded aim in [floor, cap]. */
    softTarget: number;
    reproductiveWeight: number;
    floor: number;
    cap: number;
    population: number;
    share: number;
    births: number;
    deaths: number;
    migrationsIn: number;
    migrationsOut: number;
    revivals: number;
    extinctionEvents: number;
    avgReturn: number;
    paperReturn: number;
    avgFitness: number;
    meanFitness: number;
    medianFitness: number;
    trades: number;
    evidenceSufficientCount: number;
    evidenceShare: number;
    overCap: boolean;
    extinct: boolean;
  }[];
  researchRegime?: string | null;
  markets: MarketRow[];
  marketSummary: { observed: number; tradeable: number; shown: number; source: string };
  history: { t: number; generation: number; tick: number; avgReturn: number }[];
  events: { id: string; at: string; type: string; message: string }[];
  recentTrades: Trade[];
  lastGenerationSummary: null | {
    generation: number;
    bestId: string;
    bestSpecies: string;
    bestReturn: number;
    averageReturn: number;
    bestFitness: number;
    trades: number;
  };
  config?: {
    requestedMode: string;
    provider: string;
    apiKeyConfigured: boolean;
    keylessAllowed: boolean;
    endpoints: string[];
    staleMs: number;
    universeMax: number;
    loadedEnvFiles: string[];
    paper: Record<string, number>;
    execution: string;
  };
  // --- Phase 3: state isolation + historical research -----------------------
  stateSource?: "live" | "replay";
  stateUpdatedAt?: string;
  sources?: {
    requested: string;
    available: string[];
    live: { exists: boolean; updatedAt: string | null };
    replay: { exists: boolean; updatedAt: string | null };
  };
  // Phase 3/4 reference data (replay metadata, experiment, champions, arena,
  // hall of fame, shadow league), explicitly labelled historical. Phase 5A.1
  // split this out of the old ambiguous `research` field so it can never be
  // mistaken for — or overwrite — the current Phase 5A research swarm.
  historicalResearch?: HistoricalResearch | null;
  // Phase 5A: the CURRENT controlled research swarm's cycle summary — the
  // propose -> validate -> compile -> watchdog -> memory loop.
  researchSwarm?: ResearchSwarm | null;
  // Phase 5C: compact, read-only multi-dataset replication status. Counts and
  // a freeze digest only — never the full per-dataset metric tables.
  replication?: ReplicationState | null;
  // Phase 5D: SHADOW ONLY Jev decision-supervisor state. Jev has zero
  // authority over trading, evolution, Arena, gates, or deployment — this
  // panel is counts/identity/health only, never prompts or raw state.
  jevShadow?: JevShadowState | null;
  // Phase 5E: SHADOW ONLY external-intelligence state (Agent-Reach). Read-only
  // observations that are captured, frozen and replayed — never live internet
  // inside the Arena, and zero authority over anything above.
  externalIntelligence?: ExternalIntelligenceState | null;
  stateContractVersion?: number;
  stateStale?: boolean;
  genealogy?: { nodes: number; lineages: number; prunedNodes: number; activeLineages: number; extinctLineages: number; maxGeneration: number };
  evolution?: {
    enabled: boolean;
    frozen: boolean;
    generationTicks: number;
    mutationScale: number;
    crossoverRate: number;
    immigrantRate: number;
    eliteFraction: number;
    breederFraction: number;
    marketScanLimit: number;
    trackTrades: boolean;
  };
  universe?: { tracked: number; max: number; usable: number; fresh: number; evicted: number };
  runtime?: { uptimeMs: number; startedAt: string; paperStartingCash: number; speciesCount: number; totalTrades: number; frozen: boolean };
};

type ReplicationState = {
  available: boolean;
  paperOnly?: boolean;
  freezeVersion?: string | null;
  freezeDigest?: string | null;
  replicationId?: string | null;
  status?: string | null;
  replicationStatus?: string | null;
  realDatasets?: number | null;
  cleanReplicationDatasets?: number | null;
  eligibleReplicationDatasets?: number | null;
  developmentDatasets?: number | null;
  contaminatedDatasets?: number | null;
  unknownLeakageDatasets?: number | null;
  syntheticDatasets?: number | null;
  duplicateFingerprintGroups?: number | null;
  cohorts?: Record<string, { count: number | null; cohortDigest: string | null; provider: string | null }>;
  units?: { total: number; completed: number; pending: number; failed: number; skipped: number } | null;
  significance: null;
  verdict: null;
  note?: string;
};

type JevShadowState = {
  available: boolean;
  provider?: string | null;
  model?: string | null;
  mode?: string;
  health?: string;
  experimentId?: string | null;
  cacheEnabled?: boolean;
  calls?: number;
  failures?: number;
  cacheHits?: number;
  decisionCount?: number;
  meanLatencyMs?: number | null;
  byStatus?: Record<string, number>;
  lastStatus?: string | null;
  lastDecisionAt?: string | null;
  calibrationCount?: number | null;
  brierScore?: number | null;
  questionSetVersion?: number | null;
  decisionPacketVersion?: number | null;
  paperOnly?: boolean;
  note?: string;
};

// Phase 5E: SHADOW ONLY external-intelligence status. Identity, health and
// counts only — no raw social content, no URLs, no credentials.
type ExternalIntelligenceState = {
  available: boolean;
  phase?: string;
  provider?: string | null;
  providerEnabled?: boolean;
  providerRegistered?: boolean;
  providerError?: string | null;
  mode?: string;
  modeIsShadowOnly?: boolean;
  agentReachVersion?: string | null;
  agentReachCommit?: string | null;
  agentReachLicense?: string | null;
  health?: string;
  enabledChannels?: string[];
  disabledChannels?: string[];
  captures?: number;
  records?: number;
  calls?: number;
  failures?: number;
  timeouts?: number;
  lastCaptureAt?: string | null;
  latestCaptureId?: string | null;
  latestCaptureDigest?: string | null;
  latestCaptureSynthetic?: boolean;
  evidenceQuality?: string | null;
  replayMode?: string;
  network?: { liveInternetInsideArena?: boolean; replayIsOffline?: boolean };
  channels?: { channel: string; status: string; records: number; failures: number; timeouts: number }[];
  routing?: { jevRoutingActive?: boolean; deepseekRoutingActive?: boolean };
  paperOnly?: boolean;
  note?: string;
};

type Range = { start: number; end: number };

type DatasetInfo = {
  id: string | null;
  dir: string | null;
  dataClass: string | null;
  containsSynthetic: boolean | null;
  usableForRealMarketReplay: boolean | null;
  snapshotCount: number | null;
  uniqueMints: number | null;
  firstObservedAt: number | null;
  lastObservedAt: number | null;
  durationMinutes: number | null;
  fingerprint: string | null;
  integrityVerified: boolean | null;
};

type WindowPlanDetail = {
  label: string;
  index: number;
  seed?: string;
  train: Range;
  validate: Range;
  test: Range;
};

type EvidenceCheck = { label: string; actual: number; required: number };

type StageMetrics = {
  netReturn: number | null;
  robustness: number | null;
  maxDrawdown: number | null;
  trades: number | null;
  distinctMints: number | null;
  costs: number | null;
  classification: string | null;
  evidence: { sufficient: boolean; label: string | null; missing: EvidenceCheck[] } | null;
} | null;

type WindowCandidate = {
  candidateId: string | null;
  species: string | null;
  lineageId: string | null;
  seeds: (string | number)[];
  classification: string | null;
  reason: string | null;
  overfitWarning: boolean;
  train: { netReturn: number | null; robustness: number | null; trades: number | null } | null;
  validation: StageMetrics;
  test: StageMetrics;
};

type WindowRow = {
  label: string;
  index: number | null;
  note?: string | null;
  window: { train: Range | null; validate: Range | null; test: Range | null } | null;
  trainRuns: {
    seed: string | number;
    ticks: number | null;
    generations: number | null;
    candidates: number | null;
    eligible: number | null;
    considered: number | null;
    excludedForEvidence: number | null;
    freezeAudit: { immutable?: boolean; genomesMutated?: number; frozen?: boolean } | null;
  }[];
  candidates: WindowCandidate[];
  candidateCount: number;
  survivors: unknown[];
  baselines: { id: string; metrics: { netReturn?: number; trades?: number } | null; usesFutureData: boolean }[];
};

type ExperimentReport = {
  id: string;
  dir: string;
  createdAt: string | null;
  endedAt?: string | null;
  durationMs?: number | null;
  dataset: {
    datasetId?: string;
    dataClass?: string | null;
    containsSynthetic?: boolean | null;
    fingerprint?: string | null;
    snapshotCount?: number | null;
    durationMinutes?: number | null;
  } | null;
  seeds: (string | number)[];
  windows: number | null;
  windowsWithCandidates: number | null;
  champions: number | null;
  resultCounts: Record<string, number> | null;
  outOfSample: {
    validationMedianNetReturn?: number | null;
    validationCount?: number | null;
    validationMedianRobustness?: number | null;
    testMedianNetReturn?: number | null;
    testCount?: number | null;
    testWorstNetReturn?: number | null;
    testBestNetReturn?: number | null;
  } | null;
  classifications: Record<string, number> | null;
  species: {
    name: string;
    role?: string;
    births?: number;
    deaths?: number;
    extinctionEvents?: number;
    medianTrainReturn?: number | null;
    medianValidationReturn?: number | null;
    medianTestReturn?: number | null;
    championCount?: number;
  }[];
  baselineRows: { id: string; window: string; netReturn: number | null; robustness: number | null; trades: number | null; maxDrawdown: number | null; classification: string }[];
  baselineMedianNetReturn: number | null;
  windowPlanScaled: boolean;
  windowsRun: number;
  windowRows: WindowRow[];
  championRows: {
    id: string | null;
    species: string | null;
    lineageId: string | null;
    window: string | null;
    seeds: (string | number)[];
    classification: string | null;
    reason: string | null;
    overfitWarning: boolean;
    netReturn: number | null;
    maxDrawdown: number | null;
    tradeCount: number | null;
    distinctMints: number | null;
    costs: number | null;
    robustness: number | null;
    genomeDigest: string | null;
    datasetFingerprint: string | null;
    createdAt: string | null;
    lineageChain: { agentId: string; generation: number | null; species: string | null; origin: string | null; lineageId: string | null }[];
  }[];
};

type ChampionArchive = {
  available: boolean;
  count: number | null;
  updatedAt?: string | null;
  species: { species: string; count: number }[];
  rows: {
    id: string | null;
    species: string | null;
    window: string | null;
    classification: string | null;
    overfitWarning: boolean;
    validationRobustness: number | null;
    testNetReturn: number | null;
    createdAt: string | null;
  }[];
};

type ArenaFunnelRow = { stage: string; entered: number; survivors: number; rule: string | null };

type ArenaLeaderboardRow = {
  digest: string | null;
  species: string | null;
  origin: string | null;
  score: number | null;
  status: string | null;
  failedGates: string[];
};

type ArenaSummary = {
  arenaId: string | null;
  createdAt: string | null;
  durationMs: number | null;
  entrants: number | null;
  datasets: { id: string | null; sourceType: string | null }[];
  seeds: (string | number)[];
  stressProfiles: string[];
  funnel: ArenaFunnelRow[];
  leaderboard: ArenaLeaderboardRow[];
  deploymentCandidates: { digest: string | null; species: string | null; score: number | null }[];
  diversity: {
    populationSize: number | null;
    uniqueGenomes: number | null;
    genomeDiversity: number | null;
    lineageConcentration: number | null;
  } | null;
  diversityVerdict: { healthy: boolean; action: string | null } | null;
  adaptiveMutation: { scale: number | null; previousScale: number | null; reason: string | null } | null;
  note: string | null;
  paperOnly: boolean;
};

type HallOfFame = {
  available: boolean;
  count: number;
  updatedAt?: string | null;
  note?: string | null;
  rows: {
    digest: string | null;
    species: string | null;
    arenaAppearances: number | null;
    titleDefenses: number | null;
    eliminations: number | null;
    bestArenaScore: number | null;
    latestArenaScore: number | null;
    bestStatus: string | null;
  }[];
};

type ShadowCandidate = {
  candidateId: string | null;
  digest: string | null;
  species: string | null;
  status: string | null;
  qualified: boolean;
  startTimestamp: number | null;
  runtimeMs: number | null;
  bankroll: number | null;
  netPnl: number | null;
  drawdown: number | null;
  trades: number | null;
  distinctMints: number | null;
  activePositions: number | null;
  marketSource: string | null;
  durationMilestones: Record<string, boolean> | null;
};

type ShadowLeague = {
  available: boolean;
  count: number;
  rows: ShadowCandidate[];
};

// --- Phase 5A: controlled research swarm ------------------------------------
type ResearchSwarmLogEntry = {
  cycle: number;
  at: string;
  proposed: number;
  accepted?: number;
  compiled: number;
  rejected: number;
  watchdogEvaluated: number;
  watchdogVerdicts?: Record<string, number>;
};

type ResearchSwarm = {
  enabled: boolean;
  provider: string;
  cycle: number;
  regime: string | null;
  proposalsGenerated: number;
  proposalsAccepted: number;
  proposalsRejected: number;
  compiledCandidates: number;
  compiledFamilies: number;
  injectedCandidates: number;
  memoryRecords: number;
  conclusions: number;
  evaluations: number;
  researcherRoles: Record<string, number>;
  watchdog: {
    normal: number;
    watch: number;
    quarantined: number;
    evaluated: number;
    lastEvaluatedAt: string | null;
  };
  lastRunAt: string | null;
  lastError: string | null;
  log: ResearchSwarmLogEntry[];
  // Provenance: which state document this swarm summary came from.
  source?: string | null;
  sourceUpdatedAt?: string | null;
  paperOnly?: boolean;
  disclaimer?: string;
};

type HistoricalResearch = {
  mode?: string;
  banner?: string;
  stage?: string;
  stageForced?: boolean;
  evolutionFrozen?: boolean;
  seed?: string;
  seeds?: (string | number)[];
  dataset?: DatasetInfo;
  windows?: {
    planned: number;
    scaled: boolean;
    note: string | null;
    current: number | null;
    currentLabel: string | null;
    stage: string | null;
    total: number;
    detail: WindowPlanDetail[];
  };
  replay?: {
    timestamp: number | null;
    speed: number | string;
    snapshotsRead: number;
    totalSnapshots: number | null;
    progressPct: number | null;
    firstTimestamp: number | null;
    lastTimestamp: number | null;
    wallPacedMs: number;
    ticks: number;
    finished: boolean;
  };
  experiment?: ExperimentReport | null;
  champions?: ChampionArchive | null;
  arena?: ArenaSummary | null;
  hallOfFame?: HallOfFame | null;
  shadow?: ShadowLeague | null;
  note?: string;
  disclaimer?: string;
  paperOnly?: boolean;
};

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

const money2 = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const compact = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

function pct(value: number, digits = 2) {
  if (!Number.isFinite(value)) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(digits)}%`;
}

function signedMoney(value: number) {
  if (!Number.isFinite(value)) return "—";
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  return `${sign}${money2.format(Math.abs(value))}`;
}

function price(value: number | null) {
  if (value === null || !Number.isFinite(value)) return "—";
  if (value === 0) return "$0";
  if (value >= 1) return `$${value.toFixed(4)}`;
  if (value >= 0.001) return `$${value.toFixed(6)}`;
  return `$${value.toPrecision(4)}`;
}

function count(value: number | null) {
  if (value === null || !Number.isFinite(value)) return "—";
  return compact.format(value);
}

function duration(ms: number | null) {
  if (ms === null || !Number.isFinite(ms)) return "—";
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${minutes.toFixed(1)}m`;
  const hours = minutes / 60;
  if (hours < 48) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

function relativeTime(iso: string, nowMs: number) {
  const ms = nowMs - new Date(iso).getTime();
  return `${duration(ms)} ago`;
}

function bannerTone(feed: MarketFeed, stateSource?: string) {
  if (stateSource === "replay") return "replay";
  if (feed.effectiveMode === "live" && feed.degraded) return "degraded";
  if (feed.effectiveMode === "live") return "live";
  return "synthetic";
}

/** Phase 3 result vocabulary. Positive return alone is never a verdict. */
const CLASSIFICATION_LABEL: Record<string, string> = {
  "insufficient-sample": "INSUFFICIENT SAMPLE",
  "failed-validation": "FAILED VALIDATION",
  "passed-validation": "PASSED VALIDATION",
  "test-completed": "TEST COMPLETED",
};

function classificationLabel(value: string | null | undefined) {
  if (!value) return "—";
  return CLASSIFICATION_LABEL[value] ?? value.toUpperCase();
}

function classificationTone(value: string | null | undefined) {
  if (value === "test-completed") return "good";
  if (value === "passed-validation") return "good";
  if (value === "failed-validation") return "bad";
  return "warn";
}

function stamp(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return new Date(value).toISOString().replace("T", " ").slice(0, 19);
}

function stageLabel(stage: string | null | undefined) {
  if (!stage) return "—";
  return stage.toUpperCase();
}

function StatCard({
  label,
  value,
  detail,
  icon: Icon,
  paper = false,
}: {
  label: string;
  value: string;
  detail: string;
  icon: typeof Activity;
  paper?: boolean;
}) {
  return (
    <div className="panel stat-card">
      <div className="stat-icon">
        <Icon size={18} />
      </div>
      <div>
        <p className="eyebrow">
          {label} {paper ? <span className="paper-tag">PAPER</span> : null}
        </p>
        <div className="stat-value">{value}</div>
        <p className="muted">{detail}</p>
      </div>
    </div>
  );
}

function MarketBanner({
  feed,
  stateSource,
  research,
}: {
  feed: MarketFeed;
  stateSource?: string;
  research?: HistoricalResearch | null;
}) {
  const tone = bannerTone(feed, stateSource);
  const replayDataset = research?.dataset?.id ?? null;

  const detail =
    tone === "replay"
      ? `Recorded dataset ${replayDataset ?? "unknown"} (${research?.dataset?.dataClass ?? "unclassified"}) · replay speed ${research?.replay?.speed ?? "1"} · simulated paper accounting`
      : tone === "degraded"
        ? (feed.degradedReason ?? "live market data is unavailable")
        : tone === "live"
          ? `Jupiter Tokens V2 · last observation ${duration(feed.ageMs)} ago · stale after ${duration(feed.staleMs)}`
          : feed.fallbackActive
            ? `live data unavailable (${feed.fallbackReason ?? "unknown reason"})`
            : "Phase 1 simulator · no live Solana data in use";

  const headline =
    tone === "replay" ? (research?.banner ?? "HISTORICAL REPLAY • PAPER MONEY") : feed.banner;

  return (
    <section className={`market-banner ${tone}`}>
      <div className="market-banner-main">
        <span className="banner-dot" />
        <strong>{headline}</strong>
        <span className="paper-tag solid">PAPER ONLY</span>
      </div>
      <div className="market-banner-sub">
        <span>{detail}</span>
        <span>
          {tone === "replay"
            ? `provider ${feed.provider} · state source ${stateSource ?? "replay"} · request=${feed.requestedMode} · effective=${feed.effectiveMode}`
            : `${feed.provider} · request=${feed.requestedMode} · effective=${feed.effectiveMode}`}
        </span>
      </div>
    </section>
  );
}

/**
 * Research / Replay panel: where in the historical timeline this run is, which
 * walk-forward stage is active, and which dataset bytes produced it.
 */
function ResearchPanel({ research, stateSource }: { research: HistoricalResearch; stateSource?: string }) {
  const dataset = research.dataset;
  const replay = research.replay;
  const windows = research.windows;

  const items: { label: string; value: string; tone?: string }[] = [
    { label: "State source", value: stateSource === "replay" ? "replay (isolated file)" : "live engine" },
    { label: "Dataset ID", value: dataset?.id ?? "—" },
    { label: "Dataset type", value: dataset?.dataClass ?? "—", tone: dataset?.containsSynthetic ? "warn" : "good" },
    {
      label: "Real-market usable",
      value: dataset?.usableForRealMarketReplay === true ? "yes" : "no (synthetic/mixed)",
      tone: dataset?.usableForRealMarketReplay === true ? "good" : "warn",
    },
    { label: "Replay timestamp", value: stamp(replay?.timestamp) },
    {
      label: "Replay progress",
      value:
        replay?.progressPct === null || replay?.progressPct === undefined
          ? "—"
          : `${replay.progressPct.toFixed(1)}% (${replay.snapshotsRead}/${replay.totalSnapshots ?? "?"})`,
    },
    { label: "Replay speed", value: `${replay?.speed ?? 1}×` },
    {
      label: "Current stage",
      value: stageLabel(research.stage),
      tone: research.evolutionFrozen ? "warn" : undefined,
    },
    { label: "Evolution", value: research.evolutionFrozen ? "FROZEN (no breeding)" : "ACTIVE (train)", tone: research.evolutionFrozen ? "warn" : "good" },
    {
      label: "Window",
      value: windows?.current ? `${windows.current} / ${windows.total}` : `— / ${windows?.total ?? 0}`,
    },
    { label: "Seed", value: String(research.seed ?? "—") },
    { label: "Seeds evaluated", value: (research.seeds ?? []).join(", ") || "—" },
    { label: "Dataset span", value: `${(dataset?.durationMinutes ?? 0).toFixed(1)} min · ${count(dataset?.snapshotCount ?? null)} snapshots` },
    { label: "First observation", value: stamp(dataset?.firstObservedAt) },
    { label: "Final observation", value: stamp(dataset?.lastObservedAt) },
    {
      label: "Integrity",
      value:
        dataset?.integrityVerified === true
          ? "verified"
          : dataset?.integrityVerified === false
            ? "MISMATCH"
            : "unknown",
      tone: dataset?.integrityVerified === false ? "bad" : undefined,
    },
    { label: "Fingerprint", value: dataset?.fingerprint ? `${dataset.fingerprint.slice(0, 16)}…` : "—" },
  ];

  const currentWindow = windows?.detail?.find((entry) => entry.label === windows?.currentLabel) ?? null;

  return (
    <div className="panel research-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">
            RESEARCH / REPLAY <span className="paper-tag">PAPER</span>
          </p>
          <h2>Historical capture</h2>
        </div>
        <Database size={20} />
      </div>

      <div className="health-grid">
        {items.map((item) => (
          <div className="health-item" key={item.label}>
            <span>{item.label}</span>
            <strong className={item.tone ? `tone-${item.tone}` : undefined}>{item.value}</strong>
          </div>
        ))}
      </div>

      {windows && windows.detail.length > 0 ? (
        <div className="window-strip">
          <div className="window-strip-head">
            <span>Walk-forward windows planned: {windows.planned}</span>
            {windows.scaled ? <span className="tone-warn">scaled to dataset length</span> : null}
          </div>
          <div className="window-track">
            {windows.detail.map((entry) => (
              <div
                className={`window-block ${entry.label === windows.currentLabel ? "current" : ""}`}
                key={entry.label}
                title={`${entry.label} · train ${stamp(entry.train.start)} → ${stamp(entry.train.end)} · validate → ${stamp(entry.validate.end)} · test → ${stamp(entry.test.end)}`}
              >
                <span className="window-train" />
                <span className="window-validate" />
                <span className="window-test" />
                <small>{entry.label}</small>
              </div>
            ))}
          </div>
          {currentWindow ? (
            <div className="window-periods">
              <div>
                <span className="tone-good">TRAIN</span>
                <small>
                  {stamp(currentWindow.train.start)} → {stamp(currentWindow.train.end)}
                </small>
              </div>
              <div>
                <span className="tone-warn">VALIDATE</span>
                <small>
                  {stamp(currentWindow.validate.start)} → {stamp(currentWindow.validate.end)}
                </small>
              </div>
              <div>
                <span className="tone-bad">TEST</span>
                <small>
                  {stamp(currentWindow.test.start)} → {stamp(currentWindow.test.end)}
                </small>
              </div>
            </div>
          ) : null}
        </div>
      ) : windows && windows.note ? (
        <p className="health-note">Window plan unavailable for this dataset: {windows.note.split("\n")[0]}</p>
      ) : null}

      <p className="health-note">
        {research.note ??
          "Historical replay runs the paper engine over recorded observations. Recorded data is never re-fetched, and replay speed changes only wall-clock pacing — never a decision."}
      </p>
    </div>
  );
}

/** Out-of-sample panel: the honest scoreboard, including the losing outcomes. */
function OutOfSamplePanel({ experiment }: { experiment: ExperimentReport | null }) {
  if (!experiment) {
    return (
      <div className="panel oos-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">OUT OF SAMPLE</p>
            <h2>Walk-forward results</h2>
          </div>
          <FlaskConical size={20} />
        </div>
        <p className="muted">
          No experiment report yet. Run <code>npm run experiment -- &lt;dataset&gt;</code> to train on one period,
          validate on the next, and test on data neither stage influenced.
        </p>
      </div>
    );
  }

  const oos = experiment.outOfSample;
  const counts = experiment.resultCounts ?? {};
  const champions = experiment.championRows ?? [];
  const best = [...champions].sort((a, b) => (b.netReturn ?? -Infinity) - (a.netReturn ?? -Infinity))[0] ?? null;

  const items: { label: string; value: string; tone?: string }[] = [
    { label: "Experiment", value: experiment.id },
    { label: "Dataset class", value: experiment.dataset?.dataClass ?? "—" },
    { label: "Seeds", value: experiment.seeds.join(", ") || "—" },
    { label: "Windows run", value: `${experiment.windowsRun} / ${experiment.windows ?? "?"}` },
    { label: "Validation median", value: pct((oos?.validationMedianNetReturn ?? NaN) * 100), tone: (oos?.validationMedianNetReturn ?? 0) >= 0 ? "good" : "bad" },
    { label: "Test median", value: pct((oos?.testMedianNetReturn ?? NaN) * 100), tone: (oos?.testMedianNetReturn ?? 0) >= 0 ? "good" : "bad" },
    { label: "Test worst seed", value: pct((oos?.testWorstNetReturn ?? NaN) * 100) },
    { label: "Validation n", value: count(oos?.validationCount ?? null) },
    { label: "Test n", value: count(oos?.testCount ?? null) },
    { label: "Validation robustness (median)", value: oos?.validationMedianRobustness === null || oos?.validationMedianRobustness === undefined ? "—" : oos.validationMedianRobustness.toFixed(2) },
    { label: "Insufficient sample", value: String(counts.insufficientSample ?? 0), tone: (counts.insufficientSample ?? 0) > 0 ? "warn" : undefined },
    { label: "Failed validation", value: String(counts.failedValidation ?? 0), tone: (counts.failedValidation ?? 0) > 0 ? "bad" : undefined },
    { label: "Passed validation", value: String(counts.passedValidation ?? 0) },
    { label: "Test completed", value: String(counts.testCompleted ?? 0) },
    { label: "Overfit warnings", value: String(counts.overfitWarnings ?? 0), tone: (counts.overfitWarnings ?? 0) > 0 ? "bad" : undefined },
    { label: "Champions archived", value: String(experiment.champions ?? 0) },
    { label: "Baseline median", value: pct((experiment.baselineMedianNetReturn ?? NaN) * 100) },
  ];

  return (
    <div className="panel oos-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">
            OUT OF SAMPLE <span className="paper-tag">PAPER</span>
          </p>
          <h2>Walk-forward scoreboard</h2>
        </div>
        <FlaskConical size={20} />
      </div>

      <div className="health-grid">
        {items.map((item) => (
          <div className="health-item" key={item.label}>
            <span>{item.label}</span>
            <strong className={item.tone ? `tone-${item.tone}` : undefined}>{item.value}</strong>
          </div>
        ))}
      </div>

      <div className="table-scroll oos-table-wrap">
        <table className="oos-table">
          <thead>
            <tr>
              <th>Window</th>
              <th>Candidate</th>
              <th>Species</th>
              <th>Train</th>
              <th>Validation</th>
              <th>Test</th>
              <th>Test DD</th>
              <th>Trades</th>
              <th>Tokens</th>
              <th>Costs</th>
              <th>Robustness</th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody>
            {experiment.windowRows.flatMap((row, rowIndex) =>
              row.candidates.map((candidate, candidateIndex) => (
                <tr key={`${row.label}-${rowIndex}-${candidateIndex}`}>
                  <td>{row.label}</td>
                  <td>
                    <strong>{candidate.candidateId ?? candidate.species ?? "—"}</strong>
                    <small>
                      {candidate.lineageId ?? "no lineage"} · seeds {(candidate.seeds ?? []).join(", ")}
                    </small>
                  </td>
                  <td>{candidate.species ?? "—"}</td>
                  <td>{pct((candidate.train?.netReturn ?? NaN) * 100)}</td>
                  <td>{pct((candidate.validation?.netReturn ?? NaN) * 100)}</td>
                  <td className={(candidate.test?.netReturn ?? 0) >= 0 ? "positive" : "negative"}>
                    {candidate.test ? pct((candidate.test.netReturn ?? NaN) * 100) : "not run"}
                  </td>
                  <td>{candidate.test?.maxDrawdown === null || candidate.test?.maxDrawdown === undefined ? "—" : `-${(candidate.test.maxDrawdown * 100).toFixed(1)}%`}</td>
                  <td>{candidate.test?.trades ?? candidate.validation?.trades ?? "—"}</td>
                  <td>{candidate.test?.distinctMints ?? candidate.validation?.distinctMints ?? "—"}</td>
                  <td>{candidate.test?.costs === null || candidate.test?.costs === undefined ? "—" : money2.format(candidate.test.costs)}</td>
                  <td>{candidate.validation?.robustness === null || candidate.validation?.robustness === undefined ? "—" : candidate.validation.robustness.toFixed(1)}</td>
                  <td>
                    <span className={`result-chip ${classificationTone(candidate.classification)}`}>
                      {classificationLabel(candidate.classification)}
                    </span>
                    {candidate.overfitWarning ? <small className="tone-bad"> overfit warning</small> : null}
                  </td>
                </tr>
              )),
            )}
          </tbody>
        </table>
      </div>

      {best ? (
        <p className="health-note">
          Best archived test result: {best.id} ({best.species}) at {pct((best.netReturn ?? NaN) * 100)} paper return over {
            best.tradeCount ?? "?"
          }{" "}
          trades across {best.distinctMints ?? "?"} token(s) · {classificationLabel(best.classification)}. A positive number is
          not a promise: it is one simulated paper window on one dataset.
        </p>
      ) : (
        <p className="health-note">
          No genome cleared the minimum evidence gates yet, so there is nothing to report as validated. That is a valid
          result: two lucky paper trades is not evidence.
        </p>
      )}
    </div>
  );
}

/** Evolution research: lineage health, survival by species, and cheap genealogy SVG. */
function EvolutionResearchPanel({ state, research }: { state: EvolveState; research?: HistoricalResearch | null }) {
  const experiment = research?.experiment ?? null;
  const champions = research?.champions ?? null;
  const archiveCount = champions?.count ?? experiment?.champions ?? 0;
  const best = state.topAgents[0] ?? null;

  const speciesSurvival = useMemo(() => {
    if (experiment && experiment.species.length > 0) return experiment.species;
    return state.species.map((entry) => ({
      name: entry.name,
      role: entry.role,
      births: entry.births ?? 0,
      deaths: entry.deaths ?? 0,
      extinctionEvents: entry.extinctionEvents ?? 0,
      medianValidationReturn: null,
      medianTestReturn: null,
      championCount: 0,
    }));
  }, [experiment, state.species]);

  const maxBirths = Math.max(...speciesSurvival.map((entry) => entry.births ?? 0), 1);

  const evolution = state.evolution as
    | { enabled?: boolean; frozen?: boolean; mutationScale?: number; crossoverRate?: number; immigrantRate?: number; eliteFraction?: number; breederFraction?: number; generationTicks?: number }
    | undefined;

  const lineageChain = experiment?.championRows?.find((row) => row.lineageChain.length > 0)?.lineageChain ?? [];

  const extinctLineages = championLineages(experiment);

  return (
    <div className="panel evolution-research-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">EVOLUTION RESEARCH</p>
          <h2>Lineages and survival</h2>
        </div>
        <BrainCircuit size={20} />
      </div>

      <div className="health-grid">
        <div className="health-item">
          <span>Best current lineage</span>
          <strong>
            {lineageChain[0]?.lineageId ?? best?.id ?? "—"}
            {lineageChain.length > 0 ? ` (${lineageChain.length} steps)` : ""}
          </strong>
        </div>
        <div className="health-item">
          <span>Champion archive</span>
          <strong>{archiveCount}</strong>
        </div>
        <div className="health-item">
          <span>Lineages lost (est.)</span>
          <strong className={extinctLineages > 0 ? "tone-warn" : undefined}>{extinctLineages}</strong>
        </div>
        <div className="health-item">
          <span>Generation</span>
          <strong>{state.generation}</strong>
        </div>
        <div className="health-item">
          <span>Mutation scale</span>
          <strong>{evolution?.mutationScale ?? "—"}</strong>
        </div>
        <div className="health-item">
          <span>Crossover rate</span>
          <strong>{evolution?.crossoverRate ?? "—"}</strong>
        </div>
        <div className="health-item">
          <span>Immigrant rate</span>
          <strong>{evolution?.immigrantRate ?? "—"}</strong>
        </div>
        <div className="health-item">
          <span>Genealogy nodes</span>
          <strong>{state.genealogy?.nodes ?? "—"}</strong>
        </div>
      </div>

      <div className="survival-list">
        {speciesSurvival.map((entry) => (
          <div className="survival-row" key={entry.name}>
            <div className="survival-meta">
              <strong>{entry.name}</strong>
              <span>
                births {entry.births ?? 0} · deaths {entry.deaths ?? 0} · extinct events {entry.extinctionEvents ?? 0} · champions{" "}
                {entry.championCount ?? 0}
              </span>
            </div>
            <div className="survival-track">
              <div className="survival-alive" style={{ width: `${((entry.births ?? 0) / maxBirths) * 100}%` }} />
            </div>
            <small className="species-role">
              {entry.role ?? ""}
              {entry.medianValidationReturn !== null && entry.medianValidationReturn !== undefined
                ? ` · val ${pct(entry.medianValidationReturn * 100)}`
                : ""}
              {entry.medianTestReturn !== null && entry.medianTestReturn !== undefined
                ? ` · test ${pct(entry.medianTestReturn * 100)}`
                : ""}
            </small>
          </div>
        ))}
      </div>

      {lineageChain.length > 0 ? (
        <div className="lineage-block">
          <p className="eyebrow">CHAMPION LINEAGE</p>
          <svg viewBox={`0 0 420 ${lineageChain.length * 34 + 10}`} className="lineage-svg" role="img" aria-label="Champion lineage chain">
            {lineageChain.map((step, index) => (
              <g key={step.agentId} transform={`translate(0 ${index * 34 + 6})`}>
                <circle cx={14} cy={12} r={7} className={`lineage-node ${index === 0 ? "origin" : ""}`} />
                {index < lineageChain.length - 1 ? <line x1={14} y1={19} x2={14} y2={34} className="lineage-edge" /> : null}
                <text x={30} y={10} className="lineage-text">
                  {step.agentId} · gen {step.generation ?? "?"} · {step.species ?? "unknown"}
                </text>
                <text x={30} y={24} className="lineage-sub">
                  {step.origin ?? "unknown origin"} · lineage {step.lineageId ?? "—"}
                </text>
              </g>
            ))}
          </svg>
        </div>
      ) : null}

      <p className="health-note">
        Evolution is selection between paper portfolios, not a profit model. Species survival and lineage depth are
        research statistics; they do not imply any edge in live markets.
      </p>
    </div>
  );
}

/**
 * Strategy Islands panel (Phase 5A). An island is a species label used as a
 * breeding boundary — this shows whether island targets are actually being
 * held, not just a re-labelled species breakdown.
 */
/**
 * Phase 5C replication panel. Descriptive only: it shows how many independent
 * real datasets exist and the frozen cohort digests — never a winner, and never
 * a profitability claim. Absent entirely when no replication run was prepared.
 */
function ReplicationPanel({ state }: { state: EvolveState }) {
  const replication = state.replication ?? null;
  if (!replication) return null;

  return (
    <div className="panel replication-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">
            PAPER RESEARCH <span className="paper-tag">PAPER</span>
          </p>
          <h2>Multi-dataset replication (Phase 5C)</h2>
        </div>
        <FlaskConical size={20} />
      </div>

      {replication.available ? (
        <>
          <div className="health-grid">
            <div className="health-item">
              <span>Freeze</span>
              <strong>{replication.freezeVersion ?? "—"}</strong>
            </div>
            <div className="health-item">
              <span>Freeze digest</span>
              <strong className="mono">{(replication.freezeDigest ?? "—").slice(0, 12)}</strong>
            </div>
            <div className="health-item">
              <span>Replication status</span>
              <strong>{replication.status ?? "—"}</strong>
            </div>
            <div className="health-item">
              <span>Real datasets</span>
              <strong>{replication.realDatasets ?? "—"}</strong>
            </div>
            <div className="health-item">
              <span>Clean replication datasets</span>
              <strong>{replication.cleanReplicationDatasets ?? "—"}</strong>
            </div>
            <div className="health-item">
              <span>Development / contaminated</span>
              <strong>
                {replication.developmentDatasets ?? "—"} / {replication.contaminatedDatasets ?? "—"}
              </strong>
            </div>
            <div className="health-item">
              <span>Unknown leakage / synthetic</span>
              <strong>
                {replication.unknownLeakageDatasets ?? "—"} / {replication.syntheticDatasets ?? "—"}
              </strong>
            </div>
            <div className="health-item">
              <span>Frozen cohorts</span>
              <strong>
                {Object.entries(replication.cohorts ?? {})
                  .map(([key, cohort]) => `${key} ${cohort.count ?? "?"}`)
                  .join(" · ") || "—"}
              </strong>
            </div>
            <div className="health-item">
              <span>Units completed</span>
              <strong>
                {replication.units?.completed ?? 0} / {replication.units?.total ?? 0}
              </strong>
            </div>
            <div className="health-item">
              <span>Units pending / failed</span>
              <strong>
                {replication.units?.pending ?? 0} / {replication.units?.failed ?? 0}
              </strong>
            </div>
          </div>
          <p className="health-note">
            Research cohorts are frozen; each independent real dataset re-evaluates the SAME cohorts against a freshly
            generated species-matched control. The dataset is the replication unit, overlapping captures are not
            independent, and no significance or profitability claim is made.
          </p>
        </>
      ) : (
        <p className="health-note">
          {replication.note ??
            "No Phase 5C replication run has been prepared yet — run npm run replicate:research -- --cohorts to freeze the research cohorts."}
        </p>
      )}
    </div>
  );
}

function JevShadowPanel({ state }: { state: EvolveState }) {
  const jev = state.jevShadow ?? null;
  if (!jev) return null;

  return (
    <div className="panel jev-shadow-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">
            SHADOW SUPERVISOR <span className="paper-tag">PAPER</span>
          </p>
          <h2>Jev shadow decisions (Phase 5D)</h2>
        </div>
        <FlaskConical size={20} />
      </div>

      {jev.available ? (
        <>
          <div className="health-grid">
            <div className="health-item">
              <span>Provider</span>
              <strong>{jev.provider ?? "—"}</strong>
            </div>
            <div className="health-item">
              <span>Model</span>
              <strong className="mono">{jev.model ?? "—"}</strong>
            </div>
            <div className="health-item">
              <span>Mode</span>
              <strong>{jev.mode ?? "shadow"}</strong>
            </div>
            <div className="health-item">
              <span>Health</span>
              <strong>{jev.health ?? "—"}</strong>
            </div>
            <div className="health-item">
              <span>Question-set version</span>
              <strong>{jev.questionSetVersion ?? "—"}</strong>
            </div>
            <div className="health-item">
              <span>Decision packet version</span>
              <strong>{jev.decisionPacketVersion ?? "—"}</strong>
            </div>
            <div className="health-item">
              <span>Calls / failures</span>
              <strong>
                {jev.calls ?? 0} / {jev.failures ?? 0}
              </strong>
            </div>
            <div className="health-item">
              <span>Cache hits</span>
              <strong>{jev.cacheHits ?? 0}</strong>
            </div>
            <div className="health-item">
              <span>Mean latency</span>
              <strong>{jev.meanLatencyMs != null ? `${jev.meanLatencyMs}ms` : "—"}</strong>
            </div>
            <div className="health-item">
              <span>Decisions recorded</span>
              <strong>{jev.decisionCount ?? 0}</strong>
            </div>
            <div className="health-item">
              <span>Calibration count</span>
              <strong>{jev.calibrationCount ?? "—"}</strong>
            </div>
            <div className="health-item">
              <span>Brier score</span>
              <strong>{jev.brierScore != null ? jev.brierScore.toFixed(4) : "—"}</strong>
            </div>
            <div className="health-item">
              <span>Last decision</span>
              <strong>{jev.lastDecisionAt ?? "—"}</strong>
            </div>
          </div>
          <p className="health-note">
            Jev is a SHADOW decision supervisor: it observes bounded TRAIN-safe evidence and returns typed
            probabilities/choices/scores that EVOLVE records. It has zero authority over trading, genome
            construction, research compilation, evolution, Arena scoring, gates, species matching, DeepSeek calls,
            deployment eligibility, or replication. A bad Jev result is acceptable; no threshold is promoted from one
            experiment.
          </p>
        </>
      ) : (
        <p className="health-note">
          {jev.note ?? "No Jev shadow experiment has been run in this workspace yet."}
        </p>
      )}
    </div>
  );
}

function ExternalIntelligencePanel({ state }: { state: EvolveState }) {
  const intelligence = state.externalIntelligence ?? null;
  if (!intelligence) return null;

  const channels = intelligence.channels ?? [];

  return (
    <div className="panel intelligence-shadow-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">
            EXTERNAL INTELLIGENCE <span className="paper-tag">PAPER</span>
          </p>
          <h2>Agent-Reach shadow observations (Phase 5E)</h2>
        </div>
        <RadioTower size={20} />
      </div>

      {intelligence.available ? (
        <>
          <div className="health-grid">
            <div className="health-item">
              <span>Provider</span>
              <strong>
                {intelligence.provider ?? "disabled"}
                {intelligence.providerEnabled ? "" : " (disabled)"}
              </strong>
            </div>
            <div className="health-item">
              <span>Mode</span>
              <strong>{intelligence.mode ?? "shadow"}</strong>
            </div>
            <div className="health-item">
              <span>Health</span>
              <strong>{intelligence.health ?? "—"}</strong>
            </div>
            <div className="health-item">
              <span>Agent-Reach version</span>
              <strong className="mono">{intelligence.agentReachVersion ?? "—"}</strong>
            </div>
            <div className="health-item">
              <span>License</span>
              <strong>{intelligence.agentReachLicense ?? "—"}</strong>
            </div>
            <div className="health-item">
              <span>Enabled channels</span>
              <strong>{(intelligence.enabledChannels ?? []).join(", ") || "—"}</strong>
            </div>
            <div className="health-item">
              <span>Captures</span>
              <strong>{intelligence.captures ?? 0}</strong>
            </div>
            <div className="health-item">
              <span>Records</span>
              <strong>
                {intelligence.records ?? 0}
                {intelligence.latestCaptureSynthetic ? " (synthetic)" : ""}
              </strong>
            </div>
            <div className="health-item">
              <span>Failures / timeouts</span>
              <strong>
                {intelligence.failures ?? 0} / {intelligence.timeouts ?? 0}
              </strong>
            </div>
            <div className="health-item">
              <span>Evidence quality</span>
              <strong>{intelligence.evidenceQuality ?? "—"}</strong>
            </div>
            <div className="health-item">
              <span>Replay mode</span>
              <strong>{intelligence.replayMode ?? "replay-only"}</strong>
            </div>
            <div className="health-item">
              <span>Last capture</span>
              <strong>{intelligence.lastCaptureAt ?? "—"}</strong>
            </div>
            <div className="health-item">
              <span>Latest capture digest</span>
              <strong className="mono">
                {intelligence.latestCaptureDigest ? `${intelligence.latestCaptureDigest.slice(0, 16)}…` : "—"}
              </strong>
            </div>
            <div className="health-item">
              <span>Channel statuses</span>
              <strong>{channels.length > 0 ? channels.map((row) => `${row.channel}:${row.status}`).join(" ") : "—"}</strong>
            </div>
          </div>
          <p className="health-note">
            External intelligence is READ-ONLY and SHADOW ONLY. Agent-Reach observations are captured, frozen,
            fingerprinted and replayed from disk — the live internet is never read inside the Arena, and no capture can
            trade, post, sign, write, or change Arena scoring, gates, species matching, cohorts or replication. Jev and
            DeepSeek routing for external intelligence remain inactive, and social observations may be noisy or
            manipulated: external intelligence has to prove its value experimentally. Raw social text, URLs and
            credentials are never shown here.
          </p>
        </>
      ) : (
        <p className="health-note">
          {intelligence.note ??
            "No external-intelligence capture exists in this workspace yet; the provider is disabled by default."}
        </p>
      )}
    </div>
  );
}

function IslandsPanel({ state }: { state: EvolveState }) {
  const islands = state.islands ?? [];
  const totalPopulation = islands.reduce((sum, island) => sum + island.population, 0);
  const totalMigrations = islands.reduce((sum, island) => sum + island.migrationsIn, 0);
  const totalRevivals = islands.reduce((sum, island) => sum + island.revivals, 0);
  const floor = islands.reduce((min, island) => Math.min(min, island.floor ?? 0), Infinity);
  const cap = islands.reduce((max, island) => Math.max(max, island.cap ?? 0), 0);
  const hasPolicy = islands.some((island) => typeof island.floor === "number" && island.floor > 0);
  const maxPopulation = Math.max(...islands.map((island) => island.population), 1);

  return (
    <div className="panel islands-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">STRATEGY ISLANDS</p>
          <h2>Soft diversity-protected populations</h2>
        </div>
        <Map size={20} />
      </div>

      <div className="health-grid">
        <div className="health-item">
          <span>Total population</span>
          <strong>
            {totalPopulation} / {state.stats.populationTarget || state.stats.population}
          </strong>
        </div>
        <div className="health-item">
          <span>Islands</span>
          <strong>{islands.length}</strong>
        </div>
        <div className="health-item">
          <span>Diversity floor / cap</span>
          <strong>{hasPolicy && Number.isFinite(floor) ? `${floor} / ${cap}` : "—"}</strong>
        </div>
        <div className="health-item">
          <span>Migrations (lifetime in)</span>
          <strong>{totalMigrations}</strong>
        </div>
        <div className="health-item">
          <span>Revivals (extinct islands re-seeded)</span>
          <strong className={totalRevivals > 0 ? "tone-warn" : undefined}>{totalRevivals}</strong>
        </div>
      </div>

      <div className="survival-list">
        {islands.map((island) => (
          <div className="survival-row" key={island.name}>
            <div className="survival-meta">
              <strong>
                {island.name}
                {island.extinct ? " (extinct — reviving)" : ""}
              </strong>
              <span>
                pop {island.population} ({((island.share ?? 0) * 100).toFixed(0)}% of population) · soft target{" "}
                {island.softTarget ?? island.target} · weight {(island.reproductiveWeight ?? 1).toFixed(2)} · floor{" "}
                {island.floor ?? "—"} · cap {island.cap ?? "—"}
              </span>
              <span>
                births {island.births} · deaths {island.deaths} · migrations {island.migrationsIn}in/
                {island.migrationsOut}out · revivals {island.revivals} · evidence-sufficient{" "}
                {island.evidenceSufficientCount} ({((island.evidenceShare ?? 0) * 100).toFixed(0)}%)
              </span>
            </div>
            <div className="survival-track">
              <div
                className={`survival-alive${island.extinct ? " tone-bad" : island.overCap ? " tone-warn" : ""}`}
                style={{ width: `${Math.min(100, (island.population / maxPopulation) * 100)}%` }}
              />
            </div>
            <small className="species-role">
              paper return {pct((island.paperReturn ?? island.avgReturn ?? 0) * 100)} · mean fitness{" "}
              {(island.meanFitness ?? island.avgFitness ?? 0).toFixed(2)} · median fitness{" "}
              {(island.medianFitness ?? 0).toFixed(2)} · trades {island.trades}
            </small>
          </div>
        ))}
      </div>

      <p className="health-note">
        Islands are diversity-protected, not equal-by-quota: births follow each island&apos;s evidence-adjusted
        reproductive weight, movement is bounded per generation (EVOLVE_ISLAND_MAX_SHARE_DELTA), and each island is
        clamped into an explicit floor/cap (EVOLVE_ISLAND_MIN_SHARE / EVOLVE_ISLAND_MAX_SHARE). The total always
        equals the configured population size. A stronger, better-evidenced island earns share; a weak one shrinks
        substantially without being wiped out, and bounded migration / cross-species crossover / random immigration
        still apply (EVOLVE_ISLAND_MIGRATION_RATE / EVOLVE_CROSS_SPECIES_CROSSOVER_RATE / EVOLVE_RANDOM_IMMIGRANT_RATE).
      </p>
    </div>
  );
}

/**
 * Research Swarm panel (Phase 5A): researchers propose, a deterministic
 * compiler turns valid proposals into candidate genomes, and the same
 * evidence-ranked selection every other agent goes through decides whether
 * they survive. PAPER RESEARCH — never a profitability claim.
 */
function ResearchSwarmPanel({ state }: { state: EvolveState }) {
  const swarm = state.researchSwarm ?? null;
  const researchAgents = state.topAgents.filter((agent) => agent.research);
  // A snapshot written by an older engine may predate some of these fields;
  // render zeros rather than crashing the whole dashboard on a stale file.
  const watchdog = swarm?.watchdog ?? { normal: 0, watch: 0, quarantined: 0, evaluated: 0, lastEvaluatedAt: null };

  if (!swarm) {
    return (
      <div className="panel research-swarm-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">PAPER RESEARCH</p>
            <h2>Research swarm not reporting yet</h2>
          </div>
          <Microscope size={20} />
        </div>
        <p className="health-note">The research swarm reports here once the live engine has run its first cycle.</p>
      </div>
    );
  }

  return (
    <div className="panel research-swarm-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">PAPER RESEARCH</p>
          <h2>Controlled research swarm</h2>
        </div>
        <Microscope size={20} />
      </div>

      <div className="health-grid">
        <div className="health-item">
          <span>Enabled</span>
          <strong>{swarm.enabled ? "yes" : "no"}</strong>
        </div>
        <div className="health-item">
          <span>Research cycle</span>
          <strong>{swarm.cycle}</strong>
        </div>
        <div className="health-item">
          <span>Provider</span>
          <strong>{swarm.provider}</strong>
        </div>
        <div className="health-item">
          <span>Current research regime</span>
          <strong>{swarm.regime ?? "—"}</strong>
        </div>
        <div className="health-item">
          <span>Proposals generated</span>
          <strong>{swarm.proposalsGenerated}</strong>
        </div>
        <div className="health-item">
          <span>Proposals accepted</span>
          <strong>{swarm.proposalsAccepted ?? "—"}</strong>
        </div>
        <div className="health-item">
          <span>Proposals rejected</span>
          <strong>{swarm.proposalsRejected}</strong>
        </div>
        <div className="health-item">
          <span>Compiled families</span>
          <strong>{swarm.compiledFamilies ?? swarm.compiledCandidates}</strong>
        </div>
        <div className="health-item">
          <span>Injected candidates (live now)</span>
          <strong>{swarm.injectedCandidates ?? "—"}</strong>
        </div>
        <div className="health-item">
          <span>Research memory records</span>
          <strong>{swarm.memoryRecords}</strong>
        </div>
        <div className="health-item">
          <span>Conclusions / evaluations</span>
          <strong>
            {swarm.conclusions ?? "—"} / {swarm.evaluations ?? "—"}
          </strong>
        </div>
        <div className="health-item">
          <span>Watchdog NORMAL</span>
          <strong>{watchdog.normal}</strong>
        </div>
        <div className="health-item">
          <span>WATCH</span>
          <strong className={watchdog.watch > 0 ? "tone-warn" : undefined}>{watchdog.watch}</strong>
        </div>
        <div className="health-item">
          <span>QUARANTINED</span>
          <strong className={watchdog.quarantined > 0 ? "tone-bad" : undefined}>
            {watchdog.quarantined}
          </strong>
        </div>
        <div className="health-item">
          <span>Active in population now</span>
          <strong>{researchAgents.length}</strong>
        </div>
      </div>

      <div className="survival-list">
        {Object.entries(swarm.researcherRoles ?? {})
          .sort((a, b) => b[1] - a[1])
          .map(([role, count]) => (
            <div className="survival-row" key={role}>
              <div className="survival-meta">
                <strong>{role}</strong>
                <span>{count} memory records authored</span>
              </div>
            </div>
          ))}
      </div>

      {swarm.lastError ? (
        <p className="health-note tone-bad">
          <ShieldAlert size={14} /> last cycle error: {swarm.lastError}
        </p>
      ) : null}

      <div className="survival-list">
        {swarm.log.map((entry) => (
          <div className="survival-row" key={entry.cycle}>
            <div className="survival-meta">
              <strong>Cycle {entry.cycle}</strong>
              <span>
                proposed {entry.proposed} · accepted {entry.accepted ?? "—"} · compiled {entry.compiled} · rejected{" "}
                {entry.rejected} · watchdog-evaluated {entry.watchdogEvaluated}
              </span>
            </div>
          </div>
        ))}
      </div>

      {researchAgents.length > 0 ? (
        <div className="survival-list">
          {researchAgents.slice(0, 6).map((agent) => (
            <div className="survival-row" key={agent.id}>
              <div className="survival-meta">
                <strong>{agent.research?.authorRole ?? "researcher"}</strong>
                <span>
                  {agent.id} · {agent.species} · posture {agent.research?.posture ?? "ACTIVE"} · fitness{" "}
                  {agent.fitness.toFixed(2)} · trades {agent.trades}
                </span>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      <p className="health-note">
        PAPER RESEARCH. Research agents propose candidate genomes; deterministic EVOLVE machinery (selection, the
        watchdog, and the Champion Arena) decides everything else. Nothing here is a profitability claim, and no
        research candidate can promote itself — promotion to a Deployment Candidate only ever happens from a real
        Arena result.
        {swarm.source ? (
          <>
            {" "}
            Swarm state source: <code>{swarm.source}</code>
            {swarm.sourceUpdatedAt ? ` (written ${swarm.sourceUpdatedAt})` : ""}. Historical Phase 3/4 reference data
            lives separately under <code>historicalResearch</code>.
          </>
        ) : null}
      </p>
    </div>
  );
}

/** Species that suffered at least one extinction event during the run. */
function championLineages(experiment: ExperimentReport | null) {
  if (!experiment) return 0;
  return experiment.species.filter((entry) => (entry.extinctionEvents ?? 0) > 0).length;
}

function statusTone(status: string | null) {
  if (!status) return undefined;
  if (status === "DEPLOYMENT CANDIDATE" || status.startsWith("SHADOW")) return "tone-good";
  if (status === "ELIMINATED" || status === "INSUFFICIENT EVIDENCE") return "tone-bad";
  return "tone-warn";
}

/**
 * Champion Arena panel: the tournament funnel, leaderboard, real-vs-synthetic
 * evidence, and diversity/mutation health for the most recently completed
 * arena run. Everything here is a paper research result, never a profit
 * claim — see the disclaimer on every arena output.
 */
function ArenaPanel({ arena }: { arena: ArenaSummary | null }) {
  if (!arena) {
    return (
      <div className="panel arena-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">CHAMPION ARENA</p>
            <h2>No arena run yet</h2>
          </div>
          <Crosshair size={20} />
        </div>
        <p className="health-note">
          Run <code>npm run arena</code> to tournament evolved genomes, archived champions, and random immigrants
          across datasets, seeds, regimes, and stress profiles. Results will appear here once a run completes.
        </p>
      </div>
    );
  }

  const initialEntered = Math.max(arena.funnel[0]?.entered ?? 0, 1);
  const real = arena.datasets.filter((d) => d.sourceType === "REAL").length;
  const synthetic = arena.datasets.filter((d) => d.sourceType === "SYNTHETIC").length;
  const mixed = arena.datasets.filter((d) => d.sourceType === "MIXED").length;

  return (
    <div className="panel arena-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">CHAMPION ARENA · PAPER ONLY</p>
          <h2>Tournament funnel</h2>
          <span className="heading-note">{arena.arenaId ?? "—"}</span>
        </div>
        <Crosshair size={20} />
      </div>

      <div className="survival-list">
        {arena.funnel.map((row) => (
          <div className="survival-row" key={row.stage} title={row.rule ?? undefined}>
            <div className="survival-meta">
              <strong>{row.stage}</strong>
              <span>
                {row.entered} → {row.survivors}
              </span>
            </div>
            <div className="survival-track">
              <div className="survival-alive" style={{ width: `${(row.survivors / initialEntered) * 100}%` }} />
            </div>
          </div>
        ))}
      </div>

      <div className="health-grid" style={{ marginTop: 14 }}>
        <div className="health-item">
          <span>Entrants</span>
          <strong>{arena.entrants ?? "—"}</strong>
        </div>
        <div className="health-item">
          <span>Seeds</span>
          <strong>{arena.seeds.length}</strong>
        </div>
        <div className="health-item">
          <span>Stress profiles</span>
          <strong>{arena.stressProfiles.join(", ") || "—"}</strong>
        </div>
        <div className="health-item">
          <span>Evidence datasets</span>
          <strong>
            real {real} · synthetic {synthetic}
            {mixed > 0 ? ` · mixed ${mixed}` : ""}
          </strong>
        </div>
        <div className="health-item">
          <span>Diversity</span>
          <strong className={arena.diversityVerdict?.healthy === false ? "tone-warn" : "tone-good"}>
            {arena.diversity ? `${((arena.diversity.genomeDiversity ?? 0) * 100).toFixed(0)}%` : "—"} unique ·{" "}
            {arena.diversityVerdict?.action ?? "—"}
          </strong>
        </div>
        <div className="health-item">
          <span>Adaptive mutation</span>
          <strong>
            {arena.adaptiveMutation?.previousScale ?? "—"} → {arena.adaptiveMutation?.scale ?? "—"}
          </strong>
        </div>
      </div>

      <p className="eyebrow" style={{ marginTop: 16 }}>
        LEADERBOARD (PAPER SCORES, NOT PROFIT)
      </p>
      <div className="survival-list">
        {arena.leaderboard.slice(0, 8).map((row, index) => (
          <div className="survival-row" key={row.digest ?? `${row.species ?? "row"}-${index}`}>
            <div className="survival-meta">
              <strong>
                {row.digest ?? "—"} · {row.species ?? "—"}
              </strong>
              <span className={statusTone(row.status)}>
                {row.score?.toFixed(1) ?? "—"} · {row.status ?? "—"}
              </span>
            </div>
            <div className="survival-track">
              <div className="survival-alive" style={{ width: `${Math.max(0, Math.min(100, row.score ?? 0))}%` }} />
            </div>
            {row.failedGates.length > 0 ? (
              <p className="health-note" style={{ marginTop: 2 }}>
                Failed: {row.failedGates.join(", ")}
              </p>
            ) : null}
          </div>
        ))}
      </div>

      <p className="health-note">
        {real === 0
          ? "This run used no genuine live-Solana datasets — Deployment Candidate status is unreachable until at least one real dataset is included. "
          : ""}
        Arena Score is a robustness heuristic over paper results. It does NOT predict future profitability.
      </p>
    </div>
  );
}

/**
 * Champion League panel: Deployment Candidates and the Hall of Fame.
 * Hall of Fame membership is historical interest only — it never implies
 * Deployment Candidate status, and previous champions can lose.
 */
function ChampionLeaguePanel({ arena, hallOfFame }: { arena: ArenaSummary | null; hallOfFame: HallOfFame | null }) {
  const deploymentCandidates = arena?.deploymentCandidates ?? [];

  return (
    <div className="panel champion-league-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">CHAMPION LEAGUE</p>
          <h2>Deployment candidates &amp; Hall of Fame</h2>
        </div>
        <ShieldCheck size={20} />
      </div>

      <div className="health-grid">
        <div className="health-item">
          <span>Deployment candidates (latest arena)</span>
          <strong className={deploymentCandidates.length > 0 ? "tone-good" : undefined}>{deploymentCandidates.length}</strong>
        </div>
        <div className="health-item">
          <span>Hall of Fame members</span>
          <strong>{hallOfFame?.count ?? 0}</strong>
        </div>
      </div>

      {deploymentCandidates.length > 0 ? (
        <>
          <p className="eyebrow" style={{ marginTop: 14 }}>
            DEPLOYMENT CANDIDATES
          </p>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Digest</th>
                  <th>Species</th>
                  <th>Arena Score</th>
                </tr>
              </thead>
              <tbody>
                {deploymentCandidates.map((row) => (
                  <tr key={row.digest ?? row.species}>
                    <td>{row.digest ?? "—"}</td>
                    <td>{row.species ?? "—"}</td>
                    <td>{row.score?.toFixed(1) ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      <p className="eyebrow" style={{ marginTop: 14 }}>
        HALL OF FAME · HISTORICAL INTEREST ONLY
      </p>
      {hallOfFame && hallOfFame.rows.length > 0 ? (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Digest</th>
                <th>Species</th>
                <th>Appearances</th>
                <th>Defenses</th>
                <th>Eliminations</th>
                <th>Best score</th>
                <th>Latest score</th>
                <th>Best status</th>
              </tr>
            </thead>
            <tbody>
              {hallOfFame.rows.map((row) => (
                <tr key={row.digest ?? row.species}>
                  <td>{row.digest ?? "—"}</td>
                  <td>{row.species ?? "—"}</td>
                  <td>{row.arenaAppearances ?? 0}</td>
                  <td>{row.titleDefenses ?? 0}</td>
                  <td>{row.eliminations ?? 0}</td>
                  <td>{row.bestArenaScore?.toFixed(1) ?? "—"}</td>
                  <td>{row.latestArenaScore?.toFixed(1) ?? "—"}</td>
                  <td className={statusTone(row.bestStatus)}>{row.bestStatus ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="health-note">No Hall of Fame members yet. Run an arena to populate it.</p>
      )}

      <p className="health-note">
        {hallOfFame?.note ??
          "Hall of Fame membership is historical interest only. It does NOT imply deployment eligibility, profitability, or safety. Previous champions can re-enter a future arena and lose."}
      </p>
    </div>
  );
}

/**
 * Live Shadow League: frozen Deployment Candidate genomes paper-trading
 * against genuine current market observations. No evolution happens here —
 * no mutation, no crossover, no threshold adaptation, no learning from
 * results. Always PAPER MONEY, never presented as money earned.
 */
function ShadowLeaguePanel({ shadow, nowMs }: { shadow: ShadowLeague | null; nowMs: number }) {
  return (
    <div className="panel shadow-panel">
      <section className="market-banner shadow">
        <div className="market-banner-main">
          <span className="banner-dot" />
          <strong>LIVE SHADOW LEAGUE • PAPER MONEY</strong>
        </div>
        <div className="market-banner-sub">
          <span>Frozen genomes, simulated results — not money earned.</span>
          <span>{shadow?.count ?? 0} candidate(s)</span>
        </div>
      </section>

      {!shadow || shadow.rows.length === 0 ? (
        <p className="health-note">
          No shadow candidates yet. Only Deployment Candidates from a completed arena are admitted automatically —
          run <code>npm run shadow</code> once an arena has produced one, or <code>npm run shadow -- --dev &lt;genome&gt;</code>{" "}
          for a clearly labelled development test.
        </p>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Candidate</th>
                <th>Species</th>
                <th>Status</th>
                <th>Runtime</th>
                <th>Bankroll</th>
                <th>Net P&amp;L</th>
                <th>Drawdown</th>
                <th>Trades</th>
                <th>Mints</th>
                <th>Positions</th>
              </tr>
            </thead>
            <tbody>
              {shadow.rows.map((row) => {
                const runtimeMs = row.runtimeMs ?? (row.startTimestamp && nowMs > 0 ? nowMs - row.startTimestamp : null);
                return (
                  <tr key={row.candidateId ?? row.digest}>
                    <td>{row.candidateId ?? row.digest ?? "—"}</td>
                    <td>{row.species ?? "—"}</td>
                    <td className={statusTone(row.status)}>
                      {row.status ?? "—"}
                      {!row.qualified ? <small> (dev override)</small> : null}
                    </td>
                    <td>{runtimeMs !== null ? duration(runtimeMs) : "—"}</td>
                    <td>{row.bankroll !== null ? money2.format(row.bankroll) : "—"}</td>
                    <td className={(row.netPnl ?? 0) >= 0 ? "positive" : "negative"}>
                      {row.netPnl !== null ? signedMoney(row.netPnl) : "—"}
                    </td>
                    <td>{row.drawdown !== null ? pct(row.drawdown * 100) : "—"}</td>
                    <td>{row.trades ?? 0}</td>
                    <td>{row.distinctMints ?? 0}</td>
                    <td>{row.activePositions ?? 0}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="health-note">
        Shadow genomes are frozen for the life of the run: no mutation, no crossover, no threshold adaptation, and no
        learning from these results feeds back into the genome. Paper P&amp;L shown here is simulated, not money
        earned, even for a SHADOW VALIDATED candidate.
      </p>
    </div>
  );
}

function FeedHealth({ feed }: { feed: MarketFeed }) {
  const items: { label: string; value: string; tone?: string }[] = [
    { label: "Provider", value: feed.provider },
    { label: "Source", value: feed.source },
    { label: "Requested mode", value: feed.requestedMode },
    { label: "Effective mode", value: feed.effectiveMode },
    {
      label: "Health",
      value: feed.degraded ? "DEGRADED" : feed.effectiveMode === "live" ? "HEALTHY" : "SYNTHETIC",
      tone: feed.degraded ? "bad" : feed.effectiveMode === "live" ? "good" : "warn",
    },
    { label: "Entries", value: feed.allowNewEntries ? "OPEN" : "PAUSED", tone: feed.allowNewEntries ? "good" : "bad" },
    { label: "Last success", value: feed.lastSuccessAt ? `${duration(feed.ageMs)} ago` : "never" },
    { label: "Stale after", value: duration(feed.staleMs) },
    { label: "Tokens tracked", value: count(feed.tokensTracked) },
    { label: "Universe usable", value: `${count(feed.universe.usable)} / ${count(feed.universe.max)}` },
    { label: "Requests", value: count(feed.requestCount) },
    { label: "Errors", value: count(feed.errorCount), tone: feed.errorCount > 0 ? "bad" : undefined },
    { label: "Rate limits", value: count(feed.rateLimitCount), tone: feed.rateLimitCount > 0 ? "warn" : undefined },
    { label: "Auth errors", value: count(feed.authErrorCount), tone: feed.authErrorCount > 0 ? "bad" : undefined },
    { label: "Consecutive failures", value: count(feed.consecutiveFailures) },
    { label: "Backoff", value: feed.backoffMs > 0 ? duration(feed.backoffMs) : "none" },
    { label: "Poll interval", value: duration(feed.pollMs) },
    { label: "API key configured", value: feed.apiKeyConfigured ? "yes" : "no" },
    { label: "Keyless mode", value: feed.keyless ? "yes" : "no" },
    { label: "Last latency", value: feed.lastLatencyMs === null ? "—" : `${feed.lastLatencyMs}ms` },
    { label: "Last endpoint", value: feed.lastEndpoint ?? "—" },
    { label: "Last error", value: feed.lastErrorSafe ?? "none", tone: feed.lastErrorSafe ? "warn" : undefined },
  ];

  return (
    <div className="panel health-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">MARKET FEED</p>
          <h2>Observation health</h2>
        </div>
        <RadioTower size={20} />
      </div>

      <div className="health-grid">
        {items.map((item) => (
          <div className="health-item" key={item.label}>
            <span>{item.label}</span>
            <strong className={item.tone ? `tone-${item.tone}` : undefined}>{item.value}</strong>
          </div>
        ))}
      </div>

      <p className="health-note">
        {feed.fallbackActive
          ? `Fallback active: ${feed.fallbackReason ?? "live data unavailable"}. Fallback data is never labelled live.`
          : feed.effectiveMode === "synthetic"
            ? "Synthetic simulator active. These token prices are generated, not observed."
            : "Observation only: EVOLVE reads market data and cannot place, sign, or submit any order."}
      </p>
    </div>
  );
}

function MarketTable({ state }: { state: EvolveState }) {
  const feed = state.marketFeed;

  return (
    <section className="panel markets-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">
            {feed.effectiveMode === "live" ? "OBSERVED SOLANA MARKET" : "SYNTHETIC MARKET"}
          </p>
          <h2>
            Agent hunting ground
            <span className="heading-note">
              {state.marketSummary.observed} observed · {state.marketSummary.tradeable} tradeable ·{" "}
              {feed.source}
            </span>
          </h2>
        </div>
        <ScanSearch size={20} />
      </div>

      <div className="table-scroll">
        <table className="market-table">
          <thead>
            <tr>
              <th>Token</th>
              <th>Pool age</th>
              <th>Price</th>
              <th>5m %</th>
              <th>Liquidity</th>
              <th>Mkt cap</th>
              <th>Organic</th>
              <th>Holders</th>
              <th>Buy/Sell</th>
              <th>Org buyers</th>
              <th>Top holders</th>
              <th>Mint</th>
            </tr>
          </thead>
          <tbody>
            {state.markets.map((market) => (
              <tr key={market.mint}>
                <td>
                  <div className="agent-id">
                    <div>
                      <strong>{market.symbol ?? "—"}</strong>
                      <small>
                        {market.name ?? "unknown"}
                        {market.synthetic ? " · synthetic" : ""}
                        {market.fresh ? "" : " · stale"}
                      </small>
                    </div>
                  </div>
                </td>
                <td>{duration(market.poolAgeMs)}</td>
                <td>{price(market.price)}</td>
                <td className={market.changePct !== null && market.changePct >= 0 ? "positive" : "negative"}>
                  {market.changePct === null ? "—" : pct(market.changePct)}
                </td>
                <td>
                  {market.liquidity === null ? "—" : money.format(market.liquidity)}
                  {market.liquidityChange !== null ? (
                    <small className={market.liquidityChange >= 0 ? "positive" : "negative"}>
                      {" "}
                      {pct(market.liquidityChange, 1)}
                    </small>
                  ) : null}
                </td>
                <td>{market.mcap === null ? "—" : money.format(market.mcap)}</td>
                <td>
                  {market.organicScore === null ? "—" : market.organicScore.toFixed(1)}
                  <small> {market.organicScoreLabel ?? ""}</small>
                </td>
                <td>{count(market.holderCount)}</td>
                <td>{market.buySellRatio.toFixed(2)}×</td>
                <td>
                  {count(market.numOrganicBuyers)}
                  <small> net {count(market.numNetBuyers)}</small>
                </td>
                <td>{market.topHoldersPercentage === null ? "—" : `${market.topHoldersPercentage.toFixed(1)}%`}</td>
                <td className="mint-cell">
                  <span title={market.mint}>{market.shortMint}</span>
                  <small>
                    {market.verified ? "verified" : "unverified"}
                    {market.mintAuthorityDisabled && market.freezeAuthorityDisabled ? " · authorities off" : ""}
                  </small>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="health-note">
        Signals shown here are evolutionary features for agent genomes, not profit predictions. All prices are
        observations; nothing on this page represents a real position or real returns.
      </p>
    </section>
  );
}

function PositionsPanel({ state }: { state: EvolveState }) {
  return (
    <div className="panel agents-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">
            SIMULATED FILLS <span className="paper-tag">PAPER</span>
          </p>
          <h2>Open paper positions</h2>
        </div>
        <Crosshair size={20} />
      </div>

      {state.positions.length === 0 ? (
        <p className="muted">
          {state.marketFeed.allowNewEntries
            ? "No open paper positions right now."
            : "No open paper positions, and new entries are paused because the live feed is degraded."}
        </p>
      ) : (
        <div className="table-scroll">
          <table className="positions-table">
            <thead>
              <tr>
                <th>Agent</th>
                <th>Species</th>
                <th>Token</th>
                <th>Size</th>
                <th>Entry</th>
                <th>Mark</th>
                <th>Unrealised</th>
                <th>Held</th>
              </tr>
            </thead>
            <tbody>
              {state.positions.map((position) => (
                <tr key={`${position.agentId}-${position.symbol}`}>
                  <td>
                    <strong>{position.agentId}</strong>
                  </td>
                  <td>{position.species}</td>
                  <td>
                    {position.symbol}
                    <small className="mint-inline">{position.shortMint}</small>
                  </td>
                  <td>{money2.format(position.cost)}</td>
                  <td>{price(position.entryPrice)}</td>
                  <td>{price(position.markPrice)}</td>
                  <td className={position.unrealizedPnl >= 0 ? "positive" : "negative"}>
                    {signedMoney(position.unrealizedPnl)} ({pct(position.unrealizedPct)})
                  </td>
                  <td>{position.heldTicks} ticks</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Dashboard({
  state,
  nowMs,
  source,
  onSource,
}: {
  state: EvolveState;
  nowMs: number;
  source: string;
  onSource: (next: string) => void;
}) {
  const progress = state.generationTicks > 0 ? (state.tick / state.generationTicks) * 100 : 0;
  const best = state.topAgents[0];
  const feed = state.marketFeed;
  // Phase 5A.1: `historicalResearch` is Phase 3/4 reference data only. The
  // current research swarm is a separate field (`state.researchSwarm`) and is
  // never sourced from here.
  const historicalResearch = state.historicalResearch ?? null;
  const isReplay = state.stateSource === "replay" || historicalResearch?.mode === "replay";

  // The banner describes the feed as the engine saw it. If the snapshot itself
  // has stopped updating, say so plainly rather than implying live data. A
  // finished replay is not a stalled engine, so it is reported separately.
  const snapshotAgeMs = nowMs > 0 ? Math.max(0, nowMs - new Date(state.updatedAt).getTime()) : 0;
  const engineStale = nowMs > 0 && snapshotAgeMs > 15_000 && !isReplay;

  const speciesMax = Math.max(...state.species.map((s) => s.count), 1);

  const chart = useMemo(
    () =>
      state.history.map((point) => ({
        ...point,
        label: `G${point.generation}:${point.tick}`,
      })),
    [state.history],
  );

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">
            <Dna size={26} />
          </div>
          <div>
            <div className="brand-line">
              <h1>EVOLVE</h1>
              <span className="live-chip">
                <span className="pulse-dot" />
                {feed.healthy && feed.effectiveMode === "live" ? "LIVE FEED" : "ENGINE"}
              </span>
              <span className="paper-chip">PAPER ONLY</span>
            </div>
            <p>Autonomous Evolutionary Markets</p>
          </div>
        </div>

        <div className="header-meta">
          <span className="mode-chip">{state.mode} MODE</span>
          <span className="regime-chip">
            <Radio size={14} />
            {state.marketRegime}
          </span>
          <span className="regime-chip">
            <Signal size={14} />
            breadth {state.marketBreadth.toFixed(0)}%
          </span>
          <div className="source-switch" role="group" aria-label="Dashboard state source">
            {["auto", "live", "replay"].map((option) => (
              <button
                type="button"
                key={option}
                className={option === source ? "source-option active" : "source-option"}
                onClick={() => onSource(option)}
              >
                {option.toUpperCase()}
              </button>
            ))}
          </div>
        </div>
      </header>

      {engineStale ? (
        <div className="stale-strip">
          Engine snapshot is {duration(snapshotAgeMs)} old — the paper engine does not appear to be running. Everything
          below is the last written snapshot, not a live view.
        </div>
      ) : null}

      {isReplay ? (
        <div className="replay-strip">
          Historical replay state (written {duration(snapshotAgeMs)} ago). Showing <code>replay-state.json</code> — the
          live engine state is isolated in <code>state.json</code> and is not affected.
          {historicalResearch?.replay?.finished ? " This replay has finished; the numbers below are the final recorded snapshot." : ""}
        </div>
      ) : null}

      <MarketBanner feed={feed} stateSource={state.stateSource} research={historicalResearch} />

      <section className="hero panel">
        <div>
          <p className="eyebrow">GENERATION</p>
          <div className="generation-number">{state.generation}</div>
        </div>
        <div className="generation-track-wrap">
          <div className="generation-meta">
            <span>Selection cycle</span>
            <span>
              {state.tick} / {state.generationTicks} ticks
            </span>
          </div>
          <div className="generation-track">
            <div className="generation-fill" style={{ width: `${Math.min(100, progress)}%` }} />
          </div>
          <p className="muted">
            Strong genomes reproduce. Weak genomes are terminated. Random immigrants preserve exploration. Fitness is
            measured net of simulated fees and slippage.
          </p>
        </div>
        <div className="hero-best">
          <p className="eyebrow">LEADING GENOME</p>
          <strong>{best?.id ?? "—"}</strong>
          <span>{best?.species ?? "Waiting for engine"}</span>
          {best ? (
            <span className={best.returnPct >= 0 ? "positive" : "negative"}>
              {pct(best.returnPct)} paper return · fitness {best.fitness.toFixed(2)}
            </span>
          ) : null}
        </div>
      </section>

      <section className="stats-grid">
        <StatCard
          label="Population"
          value={state.stats.population.toString()}
          detail={`${state.stats.holding} holding · ${state.stats.scanning} scanning · ${state.stats.paused} paused`}
          icon={Users}
        />
        <StatCard
          label="Paper Equity"
          value={money.format(state.stats.totalEquity)}
          detail={`${pct(state.stats.avgReturn * 100)} population return · ${signedMoney(state.paper.netPnl)} net`}
          icon={WalletCards}
          paper
        />
        <StatCard
          label="Best Agent"
          value={pct(state.stats.bestReturn * 100)}
          detail={`fitness ${state.stats.bestFitness.toFixed(2)} · net of costs`}
          icon={TrendingUp}
          paper
        />
        <StatCard
          label="Simulated Costs"
          value={money2.format(state.paper.costs)}
          detail={`${state.paper.baseFeeBps}bps fee · ${state.paper.minSlippageBps}bps min slippage`}
          icon={Coins}
          paper
        />
        <StatCard
          label="Tokens Tracked"
          value={count(feed.tokensTracked)}
          detail={`${feed.source} · ${state.marketSummary.tradeable} tradeable`}
          icon={Database}
        />
        <StatCard
          label="Born / Culled"
          value={`${compact.format(state.stats.bornTotal)} / ${compact.format(state.stats.terminatedTotal)}`}
          detail="lifetime selection pressure"
          icon={Sparkles}
        />
      </section>

      {historicalResearch?.dataset || historicalResearch?.replay ? (
        <ResearchPanel research={historicalResearch} stateSource={state.stateSource} />
      ) : null}

      {historicalResearch ? (
        <section className="dashboard-grid research-grid">
          <OutOfSamplePanel experiment={historicalResearch.experiment ?? null} />
          <EvolutionResearchPanel state={state} research={historicalResearch} />
        </section>
      ) : null}

      {state.islands || state.researchSwarm ? (
        <section className="dashboard-grid research-grid">
          <IslandsPanel state={state} />
          <ResearchSwarmPanel state={state} />
        </section>
      ) : null}

      {state.replication ? (
        <section className="dashboard-grid research-grid">
          <ReplicationPanel state={state} />
        </section>
      ) : null}

      {state.jevShadow ? (
        <section className="dashboard-grid research-grid">
          <JevShadowPanel state={state} />
        </section>
      ) : null}

      {state.externalIntelligence ? (
        <section className="dashboard-grid research-grid">
          <ExternalIntelligencePanel state={state} />
        </section>
      ) : null}

      {historicalResearch?.arena || historicalResearch?.hallOfFame || historicalResearch?.shadow ? (
        <>
          <section className="dashboard-grid research-grid">
            <ArenaPanel arena={historicalResearch.arena ?? null} />
            <ChampionLeaguePanel
              arena={historicalResearch.arena ?? null}
              hallOfFame={historicalResearch.hallOfFame ?? null}
            />
          </section>
          <ShadowLeaguePanel shadow={historicalResearch.shadow ?? null} nowMs={nowMs} />
        </>
      ) : null}

      <FeedHealth feed={feed} />

      <section className="dashboard-grid">
        <div className="panel chart-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">
                POPULATION <span className="paper-tag">PAPER</span>
              </p>
              <h2>Average return</h2>
            </div>
            <div className="chart-value">{pct(state.stats.avgReturn * 100)}</div>
          </div>

          <div className="chart-wrap">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chart} margin={{ top: 10, right: 4, left: -18, bottom: 0 }}>
                <defs>
                  <linearGradient id="returnFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="currentColor" stopOpacity={0.38} />
                    <stop offset="100%" stopColor="currentColor" stopOpacity={0.01} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="rgba(255,255,255,.06)" vertical={false} />
                <XAxis dataKey="label" hide />
                <YAxis
                  tick={{ fill: "#6f7c92", fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  width={54}
                  tickFormatter={(value) => `${value}%`}
                />
                <Tooltip
                  contentStyle={{
                    background: "#0b111c",
                    border: "1px solid #243147",
                    borderRadius: 12,
                    fontSize: 12,
                  }}
                  formatter={(value) => [`${Number(value).toFixed(3)}%`, "Paper return"]}
                />
                <Area
                  type="monotone"
                  dataKey="avgReturn"
                  stroke="currentColor"
                  strokeWidth={2}
                  fill="url(#returnFill)"
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="panel species-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">ECOSYSTEM</p>
              <h2>Species specialisation</h2>
            </div>
            <BrainCircuit size={20} />
          </div>

          <div className="species-list">
            {state.species.map((species) => (
              <div className="species-row" key={species.name}>
                <div className="species-meta">
                  <span>{species.name}</span>
                  <span>
                    {species.count} · {pct(species.avgReturn * 100)}
                  </span>
                </div>
                <div className="species-track">
                  <div className="species-fill" style={{ width: `${(species.count / speciesMax) * 100}%` }} />
                </div>
                <small className="species-role">{species.role}</small>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="dashboard-grid lower-grid">
        <div className="panel agents-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">
                FITNESS LEADERBOARD <span className="paper-tag">PAPER</span>
              </p>
              <h2>Living agents</h2>
            </div>
            <Gauge size={20} />
          </div>

          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Agent</th>
                  <th>Species</th>
                  <th>Status</th>
                  <th>Return</th>
                  <th>Net</th>
                  <th>Costs</th>
                  <th>Fitness</th>
                  <th>Trades</th>
                  <th>Win rate</th>
                  <th>Drawdown</th>
                  <th>Last action</th>
                </tr>
              </thead>
              <tbody>
                {state.topAgents.map((agent, index) => (
                  <tr key={agent.id}>
                    <td>
                      <div className="agent-id">
                        <span className="rank">{String(index + 1).padStart(2, "0")}</span>
                        <div>
                          <strong>{agent.id}</strong>
                          <small>
                            {agent.parents.length ? `from ${agent.parents.join(" × ")}` : "founder"} · gen{" "}
                            {agent.born}
                          </small>
                        </div>
                      </div>
                    </td>
                    <td>{agent.species}</td>
                    <td>
                      <span
                        className={
                          agent.status === "HOLDING"
                            ? "status holding"
                            : agent.status === "PAUSED"
                              ? "status paused"
                              : "status scanning"
                        }
                      >
                        {agent.status}
                      </span>
                    </td>
                    <td className={agent.returnPct >= 0 ? "positive" : "negative"}>{pct(agent.returnPct)}</td>
                    <td className={agent.netPnl >= 0 ? "positive" : "negative"}>{signedMoney(agent.netPnl)}</td>
                    <td>{money2.format(agent.costs)}</td>
                    <td>{agent.fitness.toFixed(2)}</td>
                    <td>{agent.trades}</td>
                    <td>{pct(agent.winRate * 100, 0)}</td>
                    <td className="negative">-{(agent.maxDrawdown * 100).toFixed(1)}%</td>
                    <td className="action-cell">{agent.lastAction}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="side-stack">
          <div className="panel feed-panel">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">SELECTION LOG</p>
                <h2>Evolution feed</h2>
              </div>
              <Activity size={20} />
            </div>
            <div className="feed">
              {state.events.slice(0, 9).map((event) => (
                <div className="feed-item" key={event.id}>
                  <span className={`event-dot ${event.type.toLowerCase()}`} />
                  <div>
                    <strong>{event.type}</strong>
                    <p>{event.message}</p>
                    <small>{relativeTime(event.at, nowMs)}</small>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="panel feed-panel trades-panel">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">
                  SIMULATED FILLS <span className="paper-tag">PAPER</span>
                </p>
                <h2>Recent exits</h2>
              </div>
              <CircleDollarSign size={20} />
            </div>
            {state.recentTrades.length === 0 ? (
              <p className="muted">No closed paper trades yet.</p>
            ) : (
              <div className="feed">
                {state.recentTrades.slice(0, 7).map((trade) => (
                  <div className="feed-item" key={trade.id}>
                    <span className={`event-dot ${trade.netPnl >= 0 ? "birth" : "death"}`} />
                    <div>
                      <strong>
                        {trade.reason} · {trade.symbol}
                      </strong>
                      <p>
                        {trade.agentId} {signedMoney(trade.netPnl)} net after {money2.format(trade.costUsd)} costs
                      </p>
                      <small>
                        {trade.heldTicks} ticks held · {relativeTime(trade.at, nowMs)}
                      </small>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </section>

      <PositionsPanel state={state} />

      <MarketTable state={state} />

      <section className="panel guards-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">SAFETY</p>
            <h2>Paper-only guarantees</h2>
          </div>
          <ShieldCheck size={20} />
        </div>
        <div className="guards-grid">
          <div className="guard">
            <FlaskConical size={16} />
            <span>All P&amp;L on this dashboard is simulated paper accounting.</span>
          </div>
          <div className="guard">
            <ShieldCheck size={16} />
            <span>No wallet keys are loaded and no signer exists in this codebase.</span>
          </div>
          <div className="guard">
            <Crosshair size={16} />
            <span>Execution: {state.guards.onChainExecution} · submission: {state.guards.submissionCapability}.</span>
          </div>
          <div className="guard">
            <Radio size={16} />
            <span>
              Provider calls: {state.guards.providerCalls}. There is no order, swap, or transaction code path in
              this repository.
            </span>
          </div>
        </div>
      </section>

      <footer>
        <span>EVOLVE · Built by Cobalt</span>
        <span>PAPER ONLY · no wallet keys · no real-money execution · simulated results only</span>
      </footer>
    </main>
  );
}

export default function Home() {
  const [state, setState] = useState<EvolveState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(0);
  const [source, setSource] = useState("auto");

  /**
   * `?source=live|replay|auto` selects which isolated state file the dashboard
   * reads, so a historical replay can be inspected without disturbing the live
   * view. Clicking a switch keeps the URL in sync instead of fighting it.
   */
  const selectSource = (next: string) => {
    setSource(next);
    const url = new URL(window.location.href);
    url.searchParams.set("source", next);
    window.history.replaceState(null, "", url);
  };

  useEffect(() => {
    let active = true;

    async function refresh() {
      try {
        const fromUrl = new URLSearchParams(window.location.search).get("source");
        const requested = fromUrl && ["auto", "live", "replay"].includes(fromUrl) ? fromUrl : source;
        const response = await fetch(`/api/state?source=${requested}`, { cache: "no-store" });
        if (!response.ok) throw new Error("Waiting for evolutionary engine");
        const next = (await response.json()) as EvolveState;
        if (active) {
          setState(next);
          setError(null);
        }
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : "Engine offline");
      } finally {
        if (active) setNowMs(Date.now());
      }
    }

    refresh();
    const timer = window.setInterval(refresh, 1000);

    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [source]);

  if (!state) {
    return (
      <main className="loading-shell">
        <div className="loading-card">
          <div className="brand-mark loading-mark">
            <Dna size={28} />
          </div>
          <p className="eyebrow">EVOLVE</p>
          <h1>{error ?? "Starting evolutionary engine…"}</h1>
          <p>
            Run <code>npm run dev:all</code> and this dashboard will attach to the live paper population
            automatically. Everything here is paper trading only.
          </p>
        </div>
      </main>
    );
  }

  return <Dashboard state={state} nowMs={nowMs} source={source} onSource={selectSource} />;
}
