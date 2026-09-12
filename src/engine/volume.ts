import { MarketRegime, StrategyConfig } from "../types.js";

export interface ContextAwareVolumeResult {
  met: boolean;
  currentValue: string;
  requiredStr: string;
  description: string;
  softened: boolean;
  setupCategory: string;
}

export function evaluateContextAwareVolume(
  direction: "LONG" | "SHORT" | "NEUTRAL",
  relVolume: number,
  hasExtremeRealtimePressure: boolean,
  regime: MarketRegime,
  structCheck: { confirmed: boolean; setupType?: string; message?: string },
  config: StrategyConfig
): ContextAwareVolumeResult {
  const baseMinRelVol = config.general.relative_volume_threshold !== undefined ? config.general.relative_volume_threshold : 1.30;
  const softeningPercent = config.general.orderflow_softening_percent !== undefined ? config.general.orderflow_softening_percent : 10;
  
  // Determine active setup category from structCheck message or setupType
  const msg = (structCheck?.message || "").toLowerCase();
  const isFreshMomentum = msg.includes("fresh momentum") || msg.includes("setup 14");
  const isBreakout = msg.includes("breakout") || msg.includes("super strong") || msg.includes("immediate breakout");
  const isPullbackRetest = msg.includes("pullback") || msg.includes("retest") || msg.includes("mitigation");
  const isEmaRetrace = msg.includes("ema") || msg.includes("pushback") || msg.includes("bounce");
  const isLiquiditySweep = msg.includes("liquidity sweep") || msg.includes("setup 3");
  const isFailedAuction = msg.includes("failed auction") || msg.includes("sfp") || msg.includes("setup 9");
  const isCvdAbsorption = msg.includes("cvd absorption") || msg.includes("delta divergence") || msg.includes("setup 12");
  const isOiFlush = msg.includes("open interest") || msg.includes("oi flush") || msg.includes("cascade fade") || msg.includes("setup 13");
  const isRangeReversal = regime === MarketRegime.RANGE_BOUND || isFailedAuction || isCvdAbsorption || msg.includes("range reversal") || msg.includes("ranging bullish") || msg.includes("ranging bearish");

  let setupCategory = "General Momentum";
  let targetRelVol = baseMinRelVol; // default e.g. 1.30x
  let categoryDescription = "Standard momentum entry: requires clear transaction volume expansion above 20-period moving average.";

  if (isFreshMomentum) {
    setupCategory = "Fresh Momentum Impulse";
    targetRelVol = Math.min(baseMinRelVol, 1.15);
    categoryDescription = "Fresh Momentum Impulse: Early 1m displacement burst supported by volume expansion (>= 1.15x) and immediate taker aggression.";
  } else if (isOiFlush) {
    setupCategory = "Liquidation Cascade Fade (OI Flush)";
    targetRelVol = Math.max(1.30, baseMinRelVol);
    categoryDescription = "OI Flush Cascade Fade: Requires confirmed volume surge (>= 1.30x) during liquidation flush followed by exhaustion.";
  } else if (isCvdAbsorption) {
    setupCategory = "CVD Absorption & Delta Divergence";
    targetRelVol = Math.min(baseMinRelVol * 0.85, 1.10);
    categoryDescription = "CVD Absorption: Passive institutional absorption at structural extremes operates with steady turnover (>= 1.10x).";
  } else if (isFailedAuction) {
    setupCategory = "Range Failed Auction (SFP Reclaim)";
    targetRelVol = Math.min(baseMinRelVol * 0.85, 1.10);
    categoryDescription = "Range Failed Auction: False breakout liquidity poke reclaimed back inside range with absorption volume (>= 1.10x).";
  } else if (isBreakout && !isPullbackRetest) {
    setupCategory = "Momentum Breakout Expansion";
    targetRelVol = Math.max(1.25, baseMinRelVol);
    categoryDescription = "Momentum Breakout: Demands high institutional expansion volume (>= 1.25x - 1.30x) to confirm genuine range expansion without false breakouts.";
  } else if (isPullbackRetest || isEmaRetrace) {
    setupCategory = "Trend Retracement / Pullback Retest";
    targetRelVol = Math.min(baseMinRelVol * 0.80, 1.05);
    categoryDescription = "Pullback & Retest: Healthy trend retracements feature volume dry-up into support/resistance and steady retest volume (>= 1.05x).";
  } else if (isLiquiditySweep) {
    setupCategory = "Institutional SMC (Liquidity Sweep)";
    targetRelVol = Math.min(baseMinRelVol * 0.85, 1.10);
    categoryDescription = "Smart Money Setup: Institutional sweep reversals operate on targeted delta absorption, requiring baseline liquidity confirmation (>= 1.10x).";
  } else if (isRangeReversal) {
    setupCategory = "Range Boundary Reversal";
    targetRelVol = Math.min(baseMinRelVol * 0.90, 1.15);
    categoryDescription = "Range Boundary Reversal: Mean-reversion off established range extremes requires rejection volume (>= 1.15x).";
  }

  const softenedThreshold = targetRelVol * (1 - softeningPercent / 100);
  const requiredRelVol = hasExtremeRealtimePressure ? softenedThreshold : targetRelVol;
  const isSoftened = hasExtremeRealtimePressure && relVolume >= softenedThreshold && relVolume < targetRelVol;
  const isMet = relVolume >= requiredRelVol;

  let currentValueStr = `${relVolume.toFixed(2)}x [${setupCategory}]`;
  if (isSoftened) {
    currentValueStr += " (SOFTENED VIA LEADING ORDER FLOW)";
  }

  const requiredStr = `> ${requiredRelVol.toFixed(2)}x (${setupCategory})`;

  return {
    met: isMet,
    currentValue: currentValueStr,
    requiredStr,
    description: `Context-Aware Volume Matrix [${setupCategory}]: ${categoryDescription}`,
    softened: isSoftened,
    setupCategory,
  };
}
