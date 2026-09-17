/**
 * Public surface of the EVOLVE market layer.
 *
 * Observation only: this layer can read market data and describe feed health.
 * It cannot place an order, sign anything, or submit anything.
 */

export { createMarketConfig, publicConfig, MARKET_MODES } from "./config.mjs";
export { JupiterTokensClient, FAILURE_KIND, FAILURE_LABELS } from "./jupiter.mjs";
export {
  MARKET_SOURCE_JUPITER,
  MARKET_SOURCE_SYNTHETIC,
  MOMENTUM_REFERENCE,
  EMPTY_STATS_5M,
  normalizeJupiterToken,
  deriveFeatures,
  deriveMarket,
  safeRatio,
  toFiniteNumber,
  toFiniteInteger,
  toText,
  timestampMs,
  clamp01,
  clampSigned,
} from "./normalize.mjs";
export { MarketUniverse, mergeToken } from "./universe.mjs";
export { SyntheticMarketProvider, syntheticMint } from "./synthetic.mjs";
export { createMarketFeed, MODE, BANNER, bannerFor, SOURCE_LABEL } from "./feed.mjs";
export {
  openReplayFeed,
  parseReplaySpeed,
  REPLAY_BANNER,
  REPLAY_SOURCE,
  REPLAY_SPEED_MAX,
} from "./replay.mjs";
