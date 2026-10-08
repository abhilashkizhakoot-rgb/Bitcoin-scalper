import { Candlestick, MarketRegime } from "../../types.js";
import { SetupContext } from "./context.js";

export type LiquidityTimeframeTier =
  | "PDH_PDL"
  | "15M_MACRO"
  | "SESSION_EXTREME"
  | "5M_STRUCTURAL"
  | "1M_INTERNAL";

export interface LiquiditySweepSetupResult {
  isValid: boolean;
  isSweep: boolean;
  direction: "LONG" | "SHORT" | "NEUTRAL";
  sweptLevel: number;
  reclaimPrice: number;
  wickRatio: number;
  volumeMult: number;
  stopLoss: number;
  takeProfit: number;
  riskReward: number;
  description: string;
  // Research-backed microstructure & MTF fields:
  poolType: string;
  timeframeTier: LiquidityTimeframeTier;
  hasCvdDivergence: boolean;
  hasAbsorption: boolean;
  microstructureScore: number; // 0 - 100
  fvgConsequentEncroachment?: number;
  optimalLimitEntry?: number;
  isSecondarySweep: boolean;
  mssConfirmed: boolean;
  chochLevel: number;
}

interface SwingPoint {
  price: number;
  idx: number;
  volume: number;
}

interface EqualLevel {
  price: number;
  touchCount: number;
  touches: SwingPoint[];
}

/**
 * FEATURE: Setup 3 - Advanced Liquidity Sweep Engine
 * Grounded in "Algorithmic Efficacy and Microstructure Dynamics of Liquidity Sweeps in Bitcoin 1-Minute Scalping":
 * 1. Multi-Timeframe Topography: Maps 15m / 5m Equal Highs/Lows, Session Extremes (Asia High/Low), and PDH/PDL
 *    to eliminate solitary 1m stochastic noise (-0.01R expectancy).
 * 2. Anti-Inducement & Double-Sweep Trap Protection: Filters out weak initial pokes and identifies high-probability secondary purges.
 * 3. Market Microstructure Corroboration: Validates CVD Delta Divergence, Footprint Absorption, and Order Flow Imbalance.
 * 4. Market Structure Shift (MSS): Demands candle close beyond the internal lower-high/higher-low structural chain.
 * 5. FVG Consequent Encroachment (50% CE) Optimization: Targets displacement gap midpoint limit entry to capture Maker fees and enforce >= 2.0R payoff.
 */
export function evaluateLiquiditySweepSetup(
  direction: "LONG" | "SHORT" | "NEUTRAL",
  ctx: SetupContext
): LiquiditySweepSetupResult {
  const { candles1m, currentPrice, currentRegime, orderFlowStats, orderBookStats, indicators, config } = ctx;
  const ms: any = config.market_structure || {};

  const defaultFail = (desc: string): LiquiditySweepSetupResult => ({
    isValid: false,
    isSweep: false,
    direction,
    sweptLevel: 0,
    reclaimPrice: 0,
    wickRatio: 0,
    volumeMult: 0,
    stopLoss: 0,
    takeProfit: 0,
    riskReward: 0,
    description: desc,
    poolType: "None",
    timeframeTier: "1M_INTERNAL",
    hasCvdDivergence: false,
    hasAbsorption: false,
    microstructureScore: 50,
    isSecondarySweep: false,
    mssConfirmed: false,
    chochLevel: 0,
  });

  if (direction === "NEUTRAL") {
    return defaultFail("Neutral direction");
  }

  if (ms.liquidity_sweep_enabled === false) {
    return defaultFail("Liquidity sweep strategy disabled in configuration");
  }

  // Macro intraday trend alignment (Research Table 1 & Table 3)
  if (direction === "LONG" && currentRegime === MarketRegime.STRONG_DOWNTREND) {
    return defaultFail("Blocked: Bullish Liquidity Sweep prohibited against STRONG_DOWNTREND macro bias (anti-knife-catching rule).");
  }
  if (direction === "SHORT" && currentRegime === MarketRegime.STRONG_UPTREND) {
    return defaultFail("Blocked: Bearish Liquidity Sweep prohibited against STRONG_UPTREND macro bias (anti-knife-catching rule).");
  }

  if (!candles1m || candles1m.length < 25) {
    return defaultFail("Insufficient 1m candle history (minimum 25 required)");
  }

  const lastIdx = candles1m.length - 1;
  const currentCandle = candles1m[lastIdx];
  const atr14 = indicators.calculateATR(candles1m, 14);
  const currentAtr = Math.max(10, atr14[lastIdx] || 50);

  const lookback = ms.liquidity_sweep_lookback_candles || 20;
  const minWickRatio = ms.liquidity_sweep_min_wick_ratio !== undefined ? ms.liquidity_sweep_min_wick_ratio : 0.35;
  const reqVolMult = ms.liquidity_sweep_volume_mult !== undefined ? ms.liquidity_sweep_volume_mult : 1.0;
  const mtfEnabled = ms.liquidity_sweep_mtf_enabled !== false;
  const requireMicrostructure = ms.liquidity_sweep_microstructure_filter !== false;
  const requireFvgRetest = ms.liquidity_sweep_require_fvg_retest !== false;
  const minRrRatio = ms.liquidity_sweep_min_rr_ratio !== undefined ? ms.liquidity_sweep_min_rr_ratio : 2.0;

  // 20-period average volume calculation
  const volumes = candles1m.map(c => c.volume);
  const sumVol = volumes.slice(-20).reduce((a, b) => a + b, 0);
  const avgVol = volumes.length >= 20 ? sumVol / 20 : 1.0;

  // -------------------------------------------------------------
  // PILLAR 1: Multi-Timeframe Topography (15m, 5m, Session, PDH/PDL)
  // -------------------------------------------------------------
  // 1. Previous Day High (PDH) and Low (PDL) over last 24h (up to 1440 1m candles)
  const dayLookback = Math.min(candles1m.length, 1440);
  const dayCandles = candles1m.slice(-dayLookback);
  const pdh = Math.max(...dayCandles.map(c => c.high));
  const pdl = Math.min(...dayCandles.map(c => c.low));

  // 2. Asian Session Extremes (last 8 hours)
  const eightHoursAgo = (Date.now() / 1000) - 8 * 3600;
  const recentAsian = candles1m.filter(c => c.time >= eightHoursAgo);
  const asianHigh = recentAsian.length > 0 ? Math.max(...recentAsian.map(c => c.high)) : null;
  const asianLow = recentAsian.length > 0 ? Math.min(...recentAsian.map(c => c.low)) : null;

  // 3. Multi-timeframe aggregated candles
  const candles15m = indicators.aggregateCandles(candles1m, 15);
  const candles5m = indicators.aggregateCandles(candles1m, 5);

  const eqLevels15m = detectEqualHighsLowsInternal(candles15m, 35, 0.08);
  const eqLevels5m = detectEqualHighsLowsInternal(candles5m, 40, 0.10);
  const eqLevels1m = detectEqualHighsLowsInternal(candles1m, lookback, 0.12);

  // 15m & 5m Swings
  const swings15m = detectSwingPivots(candles15m, 20);
  const swings5m = detectSwingPivots(candles5m, 25);
  const swings1m = detectSwingPivots(candles1m, lookback);

  interface TargetPool {
    level: number;
    type: string;
    tier: LiquidityTimeframeTier;
  }

  const candidatePools: TargetPool[] = [];

  if (direction === "LONG") {
    // Sell-Side Liquidity (SSL) Pools
    // Tier 1: Macro & Session
    if (pdl > 0) candidatePools.push({ level: pdl, type: "Previous Day Low (PDL)", tier: "PDH_PDL" });
    if (asianLow && asianLow > 0) candidatePools.push({ level: asianLow, type: "Asian Session Low (SSL)", tier: "SESSION_EXTREME" });
    eqLevels15m.eqlLevels.forEach(e => candidatePools.push({ level: e.price, type: `15m Equal Lows (${e.touchCount} touches)`, tier: "15M_MACRO" }));
    swings15m.lows.forEach(p => candidatePools.push({ level: p.price, type: "15m Major Swing Low", tier: "15M_MACRO" }));

    // Tier 2: 5m Structural
    eqLevels5m.eqlLevels.forEach(e => candidatePools.push({ level: e.price, type: `5m Equal Lows (${e.touchCount} touches)`, tier: "5M_STRUCTURAL" }));
    swings5m.lows.forEach(p => candidatePools.push({ level: p.price, type: "5m Structural Swing Low", tier: "5M_STRUCTURAL" }));

    // Tier 3: 1m Internal
    eqLevels1m.eqlLevels.forEach(e => candidatePools.push({ level: e.price, type: `1m Equal Lows (${e.touchCount} touches)`, tier: "1M_INTERNAL" }));
    swings1m.lows.forEach(p => candidatePools.push({ level: p.price, type: "1m Local Swing Low", tier: "1M_INTERNAL" }));
  } else {
    // Buy-Side Liquidity (BSL) Pools
    // Tier 1: Macro & Session
    if (pdh > 0) candidatePools.push({ level: pdh, type: "Previous Day High (PDH)", tier: "PDH_PDL" });
    if (asianHigh && asianHigh > 0) candidatePools.push({ level: asianHigh, type: "Asian Session High (BSL)", tier: "SESSION_EXTREME" });
    eqLevels15m.eqhLevels.forEach(e => candidatePools.push({ level: e.price, type: `15m Equal Highs (${e.touchCount} touches)`, tier: "15M_MACRO" }));
    swings15m.highs.forEach(p => candidatePools.push({ level: p.price, type: "15m Major Swing High", tier: "15M_MACRO" }));

    // Tier 2: 5m Structural
    eqLevels5m.eqhLevels.forEach(e => candidatePools.push({ level: e.price, type: `5m Equal Highs (${e.touchCount} touches)`, tier: "5M_STRUCTURAL" }));
    swings5m.highs.forEach(p => candidatePools.push({ level: p.price, type: "5m Structural Swing High", tier: "5M_STRUCTURAL" }));

    // Tier 3: 1m Internal
    eqLevels1m.eqhLevels.forEach(e => candidatePools.push({ level: e.price, type: `1m Equal Highs (${e.touchCount} touches)`, tier: "1M_INTERNAL" }));
    swings1m.highs.forEach(p => candidatePools.push({ level: p.price, type: "1m Local Swing High", tier: "1M_INTERNAL" }));
  }

  // Deduplicate candidate levels within 0.10 ATR of each other, prioritizing higher tiers
  const uniquePools: TargetPool[] = [];
  for (const pool of candidatePools) {
    if (pool.level <= 0) continue;
    const exists = uniquePools.some(u => Math.abs(u.level - pool.level) <= 0.10 * currentAtr);
    if (!exists) {
      uniquePools.push(pool);
    }
  }

  // -------------------------------------------------------------
  // PILLAR 2: Sweep Identification & Anti-Inducement Check
  // -------------------------------------------------------------
  const recentCandles = candles1m.slice(-4); // Last 4 1m candles
  let matchedPool: TargetPool | null = null;
  let sweepCandleIdx = -1;
  let sweepCandle: Candlestick | null = null;

  for (const pool of uniquePools) {
    for (let cOffset = 0; cOffset < recentCandles.length; cOffset++) {
      const c = recentCandles[cOffset];
      const actualIdx = lastIdx - (recentCandles.length - 1 - cOffset);

      if (direction === "LONG") {
        // Bullish SSL Sweep: Low breached the pool level, but candle closed back above (or current candle has reclaimed)
        const isPierced = c.low < pool.level - 0.05 * currentAtr;
        const isReclaimed = currentCandle.close >= pool.level - 0.05 * currentAtr;
        const isCascadeHalted = currentCandle.low >= c.low - 0.05 * currentAtr;

        if (isPierced && isReclaimed && isCascadeHalted) {
          matchedPool = pool;
          sweepCandle = c;
          sweepCandleIdx = actualIdx;
          break;
        }
      } else {
        // Bearish BSL Sweep: High breached the pool level, but candle closed back below (or current candle has reclaimed)
        const isPierced = c.high > pool.level + 0.05 * currentAtr;
        const isReclaimed = currentCandle.close <= pool.level + 0.05 * currentAtr;
        const isCascadeHalted = currentCandle.high <= c.high + 0.05 * currentAtr;

        if (isPierced && isReclaimed && isCascadeHalted) {
          matchedPool = pool;
          sweepCandle = c;
          sweepCandleIdx = actualIdx;
          break;
        }
      }
    }
    if (matchedPool && sweepCandle) break;
  }

  if (!matchedPool || !sweepCandle || sweepCandleIdx < 0) {
    return defaultFail("No validated liquidity pool breach and reclaim found");
  }

  // Double-Sweep Trap & Inducement Detection:
  // Check prior 3-8 candles before the sweep candle for a weak initial poke
  let isSecondarySweep = false;
  const priorWindowStart = Math.max(0, sweepCandleIdx - 8);
  const priorWindow = candles1m.slice(priorWindowStart, sweepCandleIdx);

  for (const pc of priorWindow) {
    if (direction === "LONG") {
      if (pc.low <= matchedPool.level + 0.15 * currentAtr && pc.low >= sweepCandle.low) {
        // Prior test existed, current sweep cleared lower!
        const pcBody = Math.abs(pc.close - pc.open);
        const pcRange = Math.max(0.001, pc.high - pc.low);
        if (pc.volume < avgVol * 1.1 || (pcBody / pcRange) < 0.40) {
          isSecondarySweep = true;
          break;
        }
      }
    } else {
      if (pc.high >= matchedPool.level - 0.15 * currentAtr && pc.high <= sweepCandle.high) {
        // Prior test existed, current sweep cleared higher!
        const pcBody = Math.abs(pc.close - pc.open);
        const pcRange = Math.max(0.001, pc.high - pc.low);
        if (pc.volume < avgVol * 1.1 || (pcBody / pcRange) < 0.40) {
          isSecondarySweep = true;
          break;
        }
      }
    }
  }

  // Rejection Wick & Displacement Form
  const cRange = Math.max(0.001, sweepCandle.high - sweepCandle.low);
  let wickRatio = 0;
  if (direction === "LONG") {
    const lowerWick = Math.min(sweepCandle.open, sweepCandle.close) - sweepCandle.low;
    wickRatio = lowerWick / cRange;
  } else {
    const upperWick = sweepCandle.high - Math.max(sweepCandle.open, sweepCandle.close);
    wickRatio = upperWick / cRange;
  }

  const volMult = avgVol > 0 ? (sweepCandle.volume || avgVol) / avgVol : 1.0;
  const hasStrongWick = wickRatio >= minWickRatio;
  const hasReversalClose = direction === "LONG"
    ? (currentCandle.close > currentCandle.open && currentCandle.close >= sweepCandle.high)
    : (currentCandle.close < currentCandle.open && currentCandle.close <= sweepCandle.low);

  if (!hasStrongWick && !hasReversalClose) {
    return defaultFail(`Awaiting Rejection: Sweep at $${matchedPool.level.toFixed(2)} lack sufficient rejection wick (${(wickRatio * 100).toFixed(0)}% < ${(minWickRatio * 100).toFixed(0)}%) or reversal displacement.`);
  }

  if (volMult < reqVolMult * 0.75) {
    return defaultFail(`Insufficient Volume: Sweep volume (${volMult.toFixed(2)}x) below requirement (${(reqVolMult * 0.75).toFixed(2)}x).`);
  }

  // Multi-Timeframe Filter: If MTF is enabled, reject solitary 1m internal swings unless high tier or secondary inducement purge
  if (mtfEnabled && matchedPool.tier === "1M_INTERNAL") {
    const takerRatio = orderFlowStats ? orderFlowStats.takerBuyRatio : 0.50;
    const netCvd = orderFlowStats ? orderFlowStats.netCVD : 0;
    const hasExceptionalFlow = direction === "LONG"
      ? (takerRatio >= 0.54 && netCvd > 0 && isSecondarySweep)
      : (takerRatio <= 0.46 && netCvd < 0 && isSecondarySweep);

    if (!hasExceptionalFlow) {
      return defaultFail(`Blocked: 1-minute internal swing sweep ($${matchedPool.level.toFixed(2)}) rejected to prevent stochastic noise (-0.01R expectancy). Awaiting 15m/5m/Session pool breach or secondary purge.`);
    }
  }

  // -------------------------------------------------------------
  // PILLAR 3: Market Microstructure & Order Flow Corroboration
  // -------------------------------------------------------------
  const takerRatio = orderFlowStats ? orderFlowStats.takerBuyRatio : 0.50;
  const netCvd = orderFlowStats ? orderFlowStats.netCVD : 0;
  const imbalance = orderBookStats ? orderBookStats.imbalanceRatio : 0;

  // CVD Delta Divergence:
  // For Long: price made a new low, but CVD is non-negative or taker ratio >= 0.48 (passive limit absorption)
  // For Short: price made a new high, but CVD is non-positive or taker ratio <= 0.52 (passive limit distribution)
  const hasCvdDivergence = direction === "LONG"
    ? (netCvd >= 0 || takerRatio >= 0.48)
    : (netCvd <= 0 || takerRatio <= 0.52);

  // Footprint Absorption: Heavy volume with outsized wick and order book support
  const hasAbsorption = volMult >= 1.15 && (wickRatio >= 0.40 || (direction === "LONG" ? imbalance >= 0.05 : imbalance <= -0.05));

  let microstructureScore = 50;
  if (hasCvdDivergence) microstructureScore += 20;
  if (hasAbsorption) microstructureScore += 15;
  if (volMult >= 1.30) microstructureScore += 10;
  if (isSecondarySweep) microstructureScore += 15;
  microstructureScore = Math.min(100, microstructureScore);

  if (requireMicrostructure && microstructureScore < 55 && !hasCvdDivergence) {
    return defaultFail(`Microstructure Absorption Missing: Sweep at $${matchedPool.level.toFixed(2)} lacks institutional delta absorption (CVD/Taker divergence absent, score: ${microstructureScore}/100).`);
  }

  // -------------------------------------------------------------
  // PILLAR 4: Market Structure Shift (MSS / CHoCH)
  // -------------------------------------------------------------
  const mssCheck = detectMarketStructureShift(direction, candles1m, sweepCandleIdx);
  const requireChoch = ms.choch_confirmation_enabled !== false;

  if (requireChoch && !mssCheck.hasMss) {
    return {
      isValid: false,
      isSweep: false,
      direction,
      sweptLevel: matchedPool.level,
      reclaimPrice: currentCandle.close,
      wickRatio: Math.round(wickRatio * 100),
      volumeMult: Number(volMult.toFixed(2)),
      stopLoss: 0,
      takeProfit: 0,
      riskReward: 0,
      poolType: matchedPool.type,
      timeframeTier: matchedPool.tier,
      hasCvdDivergence,
      hasAbsorption,
      microstructureScore,
      isSecondarySweep,
      mssConfirmed: false,
      chochLevel: mssCheck.shiftLevel,
      description: `Sweep detected at ${matchedPool.type} $${matchedPool.level.toFixed(2)}, but awaiting Market Structure Shift (MSS) candle close (${mssCheck.description})`,
    };
  }

  // -------------------------------------------------------------
  // PILLAR 5: FVG Retracement, Consequent Encroachment (50% CE), & Payoff Geometry
  // -------------------------------------------------------------
  // Stop Loss: Anchored strictly beyond the sweep's extreme wick + protective ATR buffer, bounded to prevent blowout losses
  const sweepExtreme = direction === "LONG" ? sweepCandle.low : sweepCandle.high;
  const rawRisk = Math.abs(currentCandle.close - sweepExtreme) + Math.max(20, 0.35 * currentAtr);
  const boundedRisk = Math.min(1.20 * currentAtr, Math.max(0.60 * currentAtr, rawRisk));
  const stopLoss = direction === "LONG"
    ? currentCandle.close - boundedRisk
    : currentCandle.close + boundedRisk;

  // Scan displacement leg (from sweep candle to current candle) for a Fair Value Gap
  const displacementCandles = candles1m.slice(Math.max(0, sweepCandleIdx - 1));
  let fvgCe: number | undefined;
  let fvgTop = 0;
  let fvgBottom = 0;

  if (displacementCandles.length >= 3) {
    for (let k = 2; k < displacementCandles.length; k++) {
      const c0 = displacementCandles[k - 2];
      const c2 = displacementCandles[k];

      if (direction === "LONG" && c2.low > c0.high) {
        // Bullish BISI FVG
        fvgTop = c2.low;
        fvgBottom = c0.high;
        fvgCe = (fvgTop + fvgBottom) / 2;
        break;
      } else if (direction === "SHORT" && c2.high < c0.low) {
        // Bearish SIBI FVG
        fvgTop = c0.low;
        fvgBottom = c2.high;
        fvgCe = (fvgTop + fvgBottom) / 2;
        break;
      }
    }
  }

  // Optimal Entry: If FVG exists and trader seeks Maker fee optimization, use Consequent Encroachment
  const optimalLimitEntry = (requireFvgRetest && fvgCe !== undefined)
    ? fvgCe
    : currentCandle.close;

  // Target Profit calculation: ANCHORED TO ACTUAL EXECUTION PRICE (currentCandle.close) to prevent inverted / sub-fee targets
  const actualRisk = Math.abs(currentCandle.close - stopLoss);
  const minTargetDistance = Math.max(140, Math.max(actualRisk * minRrRatio, 2.20 * currentAtr));
  const takeProfit = direction === "LONG"
    ? currentCandle.close + minTargetDistance
    : currentCandle.close - minTargetDistance;

  const actualRr = actualRisk > 0 ? Math.round((minTargetDistance / actualRisk) * 100) / 100 : minRrRatio;

  const secondaryTag = isSecondarySweep ? " [SECONDARY PURGE: Inducement Cleared]" : "";
  const fvgTag = fvgCe !== undefined
    ? ` [FVG CE: $${fvgCe.toFixed(2)}]`
    : "";
  const mtfTag = ` [${matchedPool.tier}]`;
  const microTag = ` (Absorption Score: ${microstructureScore}/100, CVD: ${hasCvdDivergence ? "Bullish Divergence" : "Neutral"})`;

  const description = `${direction === "LONG" ? "Bullish" : "Bearish"} Liquidity Sweep${mtfTag}${secondaryTag}: Pierced ${matchedPool.type} at $${matchedPool.level.toFixed(2)} (Extreme $${sweepExtreme.toFixed(2)}) & reclaimed $${currentCandle.close.toFixed(2)} with ${(wickRatio * 100).toFixed(0)}% rejection wick and ${volMult.toFixed(1)}x volume.${microTag}${fvgTag} MSS Confirmed above $${mssCheck.shiftLevel.toFixed(2)} (Limit: $${optimalLimitEntry.toFixed(2)}, SL: $${stopLoss.toFixed(2)}, TP: $${takeProfit.toFixed(2)}, R:R ${actualRr}:1).`;

  return {
    isValid: true,
    isSweep: true,
    direction,
    sweptLevel: matchedPool.level,
    reclaimPrice: currentCandle.close,
    wickRatio: Math.round(wickRatio * 100),
    volumeMult: Number(volMult.toFixed(2)),
    stopLoss,
    takeProfit,
    riskReward: actualRr,
    poolType: matchedPool.type,
    timeframeTier: matchedPool.tier,
    hasCvdDivergence,
    hasAbsorption,
    microstructureScore,
    fvgConsequentEncroachment: fvgCe,
    optimalLimitEntry,
    isSecondarySweep,
    mssConfirmed: true,
    chochLevel: mssCheck.shiftLevel,
    description,
  };
}

// -------------------------------------------------------------
// HELPER FUNCTIONS
// -------------------------------------------------------------

function detectSwingPivots(candles: Candlestick[], lookback: number): { highs: SwingPoint[]; lows: SwingPoint[] } {
  const highs: SwingPoint[] = [];
  const lows: SwingPoint[] = [];
  if (candles.length < 5) return { highs, lows };

  const scanStart = Math.max(1, candles.length - lookback);
  for (let i = scanStart; i < candles.length - 1; i++) {
    const c = candles[i];
    const prev = candles[i - 1];
    const next = candles[i + 1];

    if (c.high >= prev.high && c.high >= next.high) {
      highs.push({ price: c.high, idx: i, volume: c.volume || 1 });
    }
    if (c.low <= prev.low && c.low <= next.low) {
      lows.push({ price: c.low, idx: i, volume: c.volume || 1 });
    }
  }
  return { highs, lows };
}

function detectEqualHighsLowsInternal(
  candles: Candlestick[],
  lookback: number,
  tolerancePct: number = 0.10
): { eqhLevels: EqualLevel[]; eqlLevels: EqualLevel[] } {
  const { highs, lows } = detectSwingPivots(candles, lookback);
  const eqhLevels: EqualLevel[] = [];
  const eqlLevels: EqualLevel[] = [];

  for (const h of highs) {
    let matched = false;
    for (const eq of eqhLevels) {
      if (Math.abs(h.price - eq.price) / eq.price * 100 <= tolerancePct) {
        eq.touchCount++;
        eq.price = (eq.price * (eq.touchCount - 1) + h.price) / eq.touchCount;
        eq.touches.push(h);
        matched = true;
        break;
      }
    }
    if (!matched) {
      eqhLevels.push({ price: h.price, touchCount: 1, touches: [h] });
    }
  }

  for (const l of lows) {
    let matched = false;
    for (const eq of eqlLevels) {
      if (Math.abs(l.price - eq.price) / eq.price * 100 <= tolerancePct) {
        eq.touchCount++;
        eq.price = (eq.price * (eq.touchCount - 1) + l.price) / eq.touchCount;
        eq.touches.push(l);
        matched = true;
        break;
      }
    }
    if (!matched) {
      eqlLevels.push({ price: l.price, touchCount: 1, touches: [l] });
    }
  }

  return {
    eqhLevels: eqhLevels.filter(e => e.touchCount >= 2),
    eqlLevels: eqlLevels.filter(e => e.touchCount >= 2),
  };
}

function detectMarketStructureShift(
  direction: "LONG" | "SHORT",
  candles1m: Candlestick[],
  sweepIdx: number
): { hasMss: boolean; shiftLevel: number; description: string } {
  if (candles1m.length < 5 || sweepIdx < 1) {
    return { hasMss: true, shiftLevel: 0, description: "Insufficient candles for MSS evaluation" };
  }

  const lastCandle = candles1m[candles1m.length - 1];

  if (direction === "LONG") {
    // For Bullish MSS: find the minor lower-high that directly preceded the sweep
    let localHigh = 0;
    const startIdx = Math.max(0, sweepIdx - 5);
    for (let i = startIdx; i < sweepIdx; i++) {
      if (candles1m[i].high > localHigh) {
        localHigh = candles1m[i].high;
      }
    }
    if (localHigh === 0) {
      localHigh = candles1m[sweepIdx].high;
    }

    const hasClosedAbove = lastCandle.close > localHigh;
    return {
      hasMss: hasClosedAbove,
      shiftLevel: localHigh,
      description: hasClosedAbove
        ? `MSS Confirmed: 1m close ($${lastCandle.close.toFixed(2)}) broke above internal swing high ($${localHigh.toFixed(2)}).`
        : `Awaiting MSS: Price ($${lastCandle.close.toFixed(2)}) must close above internal swing high ($${localHigh.toFixed(2)}).`,
    };
  } else {
    // For Bearish MSS: find the minor higher-low that directly preceded the sweep
    let localLow = Infinity;
    const startIdx = Math.max(0, sweepIdx - 5);
    for (let i = startIdx; i < sweepIdx; i++) {
      if (candles1m[i].low < localLow) {
        localLow = candles1m[i].low;
      }
    }
    if (localLow === Infinity) {
      localLow = candles1m[sweepIdx].low;
    }

    const hasClosedBelow = lastCandle.close < localLow;
    return {
      hasMss: hasClosedBelow,
      shiftLevel: localLow,
      description: hasClosedBelow
        ? `MSS Confirmed: 1m close ($${lastCandle.close.toFixed(2)}) broke below internal swing low ($${localLow.toFixed(2)}).`
        : `Awaiting MSS: Price ($${lastCandle.close.toFixed(2)}) must close below internal swing low ($${localLow.toFixed(2)}).`,
    };
  }
}
