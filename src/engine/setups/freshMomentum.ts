import { MarketStructureConfig } from "../../types.js";
import { SetupContext } from "./context.js";

export interface FreshMomentumImpulseResult {
  isValid: boolean;
  direction: "LONG" | "SHORT" | "NEUTRAL";
  impulsePrice: number;
  impulseOrigin: number;
  volumeMult: number;
  bodyRatio: number;
  stopLoss: number;
  takeProfit: number;
  riskReward: number;
  description: string;
  ema200Price?: number;
  ema200DistanceAtr?: number;
  ema200SlopeAngle?: number;
}

/**
 * FEATURE: Setup 14 - Fresh Momentum Impulse Engine
 * Captures early 1m velocity and high-displacement breakouts before exhaustion or deep pullbacks.
 * Directly bypasses lagging macro regime (3m/50-period) and multi-timeframe 5m EMA alignment
 * when fresh institutional displacement, volume surge, and aggressive taker flow are confirmed.
 * Enforces 200 EMA Macro Overextension & Proximity Guard against entering into exhaustion extremes or dynamic barriers.
 */
export function evaluateFreshMomentumImpulseSetup(
  direction: "LONG" | "SHORT" | "NEUTRAL",
  ctx: SetupContext
): FreshMomentumImpulseResult {
  const { candles1m, currentPrice, indicators, orderFlowStats, orderBookStats, config } = ctx;
  const ms = config.market_structure || ({} as MarketStructureConfig);

  if (ms.fresh_momentum_strategy_enabled === false || direction === "NEUTRAL") {
    return {
      isValid: false,
      direction,
      impulsePrice: 0,
      impulseOrigin: 0,
      volumeMult: 0,
      bodyRatio: 0,
      stopLoss: 0,
      takeProfit: 0,
      riskReward: 0,
      description: ms.fresh_momentum_strategy_enabled === false ? "Fresh Momentum Impulse strategy disabled" : "Neutral direction"
    };
  }

  if (!candles1m || candles1m.length < 15) {
    return {
      isValid: false,
      direction,
      impulsePrice: 0,
      impulseOrigin: 0,
      volumeMult: 0,
      bodyRatio: 0,
      stopLoss: 0,
      takeProfit: 0,
      riskReward: 0,
      description: "Insufficient 1m candles for impulse scanning"
    };
  }

  const minBodyRatio = ms.fresh_momentum_min_body_ratio !== undefined ? ms.fresh_momentum_min_body_ratio : 0.48;
  const minVolMult = ms.fresh_momentum_min_vol_mult !== undefined ? ms.fresh_momentum_min_vol_mult : 1.15;
  const maxChaseAtr = ms.fresh_momentum_max_chase_atr !== undefined ? ms.fresh_momentum_max_chase_atr : 4.5;
  const ema200ProximityBlock = ms.fresh_momentum_ema200_proximity_block !== false;
  const slowEmaPeriod = ms.slow_ema_period || 200;

  const lastIdx = candles1m.length - 1;
  const atr14 = indicators.calculateATR(candles1m, 14);
  const currentAtr = Math.max(10, atr14[lastIdx] || 50);

  // Compute 20-period average volume
  const volSlice = candles1m.slice(Math.max(0, lastIdx - 20), lastIdx);
  const sumVol = volSlice.reduce((sum, c) => sum + (c.volume || 0), 0);
  const avgVol = volSlice.length > 0 ? Math.max(1.0, sumVol / volSlice.length) : 15.0;

  // Scan recent candidate candles: current candle [lastIdx] and last closed candle [lastIdx - 1]
  const scanIndices = [lastIdx, lastIdx - 1];

  const takerRatio = orderFlowStats ? orderFlowStats.takerBuyRatio : 0.50;
  const netCVD = orderFlowStats ? orderFlowStats.netCVD : 0;
  const imbalanceRatio = orderBookStats ? orderBookStats.imbalanceRatio : 0;
  const closes = candles1m.map(c => c.close);
  const rsi14 = indicators.calculateRSI(closes, 14);
  const currentRsi = rsi14[lastIdx] || 50;

  // EMA 20 Mean Distance Gate (Freshness check)
  const ema20 = indicators.calculateEMA(closes, 20);
  const currentEma20 = ema20[lastIdx] || currentPrice;
  const distToEma20 = Math.abs(currentPrice - currentEma20);
  const isDetachedFromEma20 = distToEma20 > 1.8 * currentAtr;

  // 200 EMA Macro Mean and Extension Calculation
  const ema200Series = indicators.calculateEMA(closes, Math.min(closes.length, slowEmaPeriod));
  const currentEma200 = ema200Series[lastIdx] || currentPrice;
  const distFromEma200 = currentPrice - currentEma200;
  const distFromEma200Atr = currentAtr > 0 ? Math.abs(distFromEma200) / currentAtr : 0;

  // Calculate 200 EMA Angle / Slope
  const slopeLookback = Math.min(20, ema200Series.length);
  let rawSlope200 = 0;
  if (slopeLookback >= 5) {
    let sumX = 0;
    let sumY = 0;
    let sumXY = 0;
    let sumXX = 0;
    const startIndex = ema200Series.length - slopeLookback;
    for (let k = 0; k < slopeLookback; k++) {
      const x = k;
      const y = ema200Series[startIndex + k];
      sumX += x;
      sumY += y;
      sumXY += x * y;
      sumXX += x * x;
    }
    const denom = slopeLookback * sumXX - sumX * sumX;
    if (Math.abs(denom) > 1e-8) {
      rawSlope200 = (slopeLookback * sumXY - sumX * sumY) / denom;
    }
  } else if (ema200Series.length > 1) {
    rawSlope200 = (ema200Series[ema200Series.length - 1] - ema200Series[0]) / ema200Series.length;
  }
  const normalizedSlope200 = currentAtr > 0 ? (rawSlope200 / currentAtr) * 100 : 0;
  const ema200Angle = Math.atan(normalizedSlope200 / 10) * (180 / Math.PI);

  const currentRelVol = indicators.calculateAccurateRelativeVolume(candles1m);

  if (direction === "SHORT") {
    // Note: Macro value extension is strictly enforced globally by the Unified Value Extension Anchor Gate.

    // 200 EMA Adverse Floor Barrier Guard for SHORT
    if (ema200ProximityBlock) {
      const distToFloor = currentPrice - currentEma200;
      if (distToFloor > 0 && distToFloor < 1.2 * currentAtr) {
        return {
          isValid: false,
          direction,
          impulsePrice: 0,
          impulseOrigin: 0,
          volumeMult: 0,
          bodyRatio: 0,
          stopLoss: 0,
          takeProfit: 0,
          riskReward: 0,
          ema200Price: currentEma200,
          ema200DistanceAtr: distFromEma200Atr,
          ema200SlopeAngle: ema200Angle,
          description: `Fresh Bearish Momentum blocked: 200 EMA ($${currentEma200.toFixed(2)}) is immediate dynamic support ($${distToFloor.toFixed(1)} away, < 1.2x ATR).`
        };
      }
      if (currentPrice > currentEma200 && ema200Angle > 15) {
        return {
          isValid: false,
          direction,
          impulsePrice: 0,
          impulseOrigin: 0,
          volumeMult: 0,
          bodyRatio: 0,
          stopLoss: 0,
          takeProfit: 0,
          riskReward: 0,
          ema200Price: currentEma200,
          ema200DistanceAtr: distFromEma200Atr,
          ema200SlopeAngle: ema200Angle,
          description: `Fresh Bearish Momentum blocked: 200 EMA is upward-sloping (Angle: ${ema200Angle.toFixed(1)} deg) presenting high dynamic support bounce risk.`
        };
      }
    }

    if (currentRsi < 28.0 || isDetachedFromEma20) {
      return {
        isValid: false,
        direction,
        impulsePrice: 0,
        impulseOrigin: 0,
        volumeMult: 0,
        bodyRatio: 0,
        stopLoss: 0,
        takeProfit: 0,
        riskReward: 0,
        ema200Price: currentEma200,
        ema200DistanceAtr: distFromEma200Atr,
        ema200SlopeAngle: ema200Angle,
        description: isDetachedFromEma20
          ? `Price detached from EMA 20 ($${distToEma20.toFixed(1)} > 1.8xATR $${(1.8 * currentAtr).toFixed(1)}) - Late-stage momentum, not fresh`
          : `RSI ${currentRsi.toFixed(1)} < 28.0 (Terminal Oversold) - Momentum exhausted`
      };
    }

    for (const idx of scanIndices) {
      if (idx < 5) continue;
      const c = candles1m[idx];
      const range = Math.max(1.0, c.high - c.low);
      const body = c.open - c.close; // positive if bearish
      const rawBodyRatio = range > 0 ? body / range : 0;
      const bodyRatio = Math.min(1.0, Math.max(0.0, rawBodyRatio));

      const isSingleDisplacement = body >= Math.max(25, 0.45 * currentAtr) && bodyRatio >= minBodyRatio;
      
      const prevC = candles1m[idx - 1];
      const twoCandleBody = prevC ? (prevC.open - c.close) : 0;
      const currentCandleDisplacement = body >= Math.max(18, 0.30 * currentAtr) && bodyRatio >= 0.35;
      const isTwoCandleDisplacement = prevC &&
        currentCandleDisplacement &&
        twoCandleBody >= Math.max(45, 0.85 * currentAtr) &&
        c.close < prevC.close &&
        prevC.close < prevC.open;

      if (!isSingleDisplacement && !isTwoCandleDisplacement) continue;

      const lowerWick = Math.max(0, c.close - c.low);
      const lowerWickRatio = lowerWick / range;
      if (lowerWickRatio > 0.35) continue;

      const cVol = c.volume || avgVol;
      const volMult = cVol / avgVol;
      const hasVolSurge = volMult >= minVolMult || currentRelVol >= minVolMult;
      if (!hasVolSurge) continue;

      const priorSlice = candles1m.slice(Math.max(0, idx - 5), idx);
      const priorLow = priorSlice.length > 0 ? Math.min(...priorSlice.map(p => p.low)) : c.open;
      const brokePriorLow = c.close < priorLow || c.low < priorLow;
      if (!brokePriorLow) continue;

      const hasBearishFlow = takerRatio <= 0.52 || imbalanceRatio <= -0.10 || netCVD < 0 || currentRsi <= 48;
      if (!hasBearishFlow) continue;

      const impulseOrigin = Math.max(c.high, prevC ? prevC.high : c.high);
      const distFromOrigin = impulseOrigin - currentPrice;
      if (distFromOrigin > maxChaseAtr * currentAtr) continue;

      const stopLoss = impulseOrigin + Math.max(25, 0.40 * currentAtr);
      const risk = stopLoss - currentPrice;
      if (risk <= 0) continue;

      const takeProfit = currentPrice - Math.max(risk * 2.2, 2.0 * currentAtr);
      const rrRatio = (currentPrice - takeProfit) / risk;

      return {
        isValid: true,
        direction: "SHORT",
        impulsePrice: c.close,
        impulseOrigin,
        volumeMult: Number(volMult.toFixed(2)),
        bodyRatio: Number(bodyRatio.toFixed(2)),
        stopLoss,
        takeProfit,
        riskReward: Number(rrRatio.toFixed(2)),
        ema200Price: currentEma200,
        ema200DistanceAtr: distFromEma200Atr,
        ema200SlopeAngle: ema200Angle,
        description: `Fresh Bearish Momentum Impulse: 1m displacement ($${body.toFixed(1)} body, ${(bodyRatio * 100).toFixed(0)}% body ratio) broke micro-support $${priorLow.toFixed(2)} with ${volMult.toFixed(2)}x volume surge & taker sell flow (${((1 - takerRatio) * 100).toFixed(1)}%). Early expansion phase active (SL: $${stopLoss.toFixed(2)}, TP: $${takeProfit.toFixed(2)}, R:R ${rrRatio.toFixed(2)}:1).`
      };
    }
  } else if (direction === "LONG") {
    // Note: Macro value extension is strictly enforced globally by the Unified Value Extension Anchor Gate.

    // 200 EMA Adverse Overhead Barrier Guard for LONG
    if (ema200ProximityBlock) {
      const distToOverhead = currentEma200 - currentPrice;
      if (distToOverhead > 0 && distToOverhead < 1.2 * currentAtr) {
        return {
          isValid: false,
          direction,
          impulsePrice: 0,
          impulseOrigin: 0,
          volumeMult: 0,
          bodyRatio: 0,
          stopLoss: 0,
          takeProfit: 0,
          riskReward: 0,
          ema200Price: currentEma200,
          ema200DistanceAtr: distFromEma200Atr,
          ema200SlopeAngle: ema200Angle,
          description: `Fresh Bullish Momentum blocked: 200 EMA ($${currentEma200.toFixed(2)}) is immediate overhead resistance ($${distToOverhead.toFixed(1)} away, < 1.2x ATR).`
        };
      }
      if (currentPrice < currentEma200 && ema200Angle < -15) {
        return {
          isValid: false,
          direction,
          impulsePrice: 0,
          impulseOrigin: 0,
          volumeMult: 0,
          bodyRatio: 0,
          stopLoss: 0,
          takeProfit: 0,
          riskReward: 0,
          ema200Price: currentEma200,
          ema200DistanceAtr: distFromEma200Atr,
          ema200SlopeAngle: ema200Angle,
          description: `Fresh Bullish Momentum blocked: 200 EMA is downward-sloping (Angle: ${ema200Angle.toFixed(1)} deg) presenting high overhead rejection risk.`
        };
      }
    }

    if (currentRsi > 72.0 || isDetachedFromEma20) {
      return {
        isValid: false,
        direction,
        impulsePrice: 0,
        impulseOrigin: 0,
        volumeMult: 0,
        bodyRatio: 0,
        stopLoss: 0,
        takeProfit: 0,
        riskReward: 0,
        ema200Price: currentEma200,
        ema200DistanceAtr: distFromEma200Atr,
        ema200SlopeAngle: ema200Angle,
        description: isDetachedFromEma20
          ? `Price detached from EMA 20 ($${distToEma20.toFixed(1)} > 1.8xATR $${(1.8 * currentAtr).toFixed(1)}) - Late-stage momentum, not fresh`
          : `RSI ${currentRsi.toFixed(1)} > 72.0 (Terminal Overbought) - Momentum exhausted`
      };
    }

    for (const idx of scanIndices) {
      if (idx < 5) continue;
      const c = candles1m[idx];
      const range = Math.max(1.0, c.high - c.low);
      const body = c.close - c.open; // positive if bullish
      const rawBodyRatio = range > 0 ? body / range : 0;
      const bodyRatio = Math.min(1.0, Math.max(0.0, rawBodyRatio));

      const isSingleDisplacement = body >= Math.max(25, 0.45 * currentAtr) && bodyRatio >= minBodyRatio;

      const prevC = candles1m[idx - 1];
      const twoCandleBody = prevC ? (c.close - prevC.open) : 0;
      const currentCandleDisplacement = body >= Math.max(18, 0.30 * currentAtr) && bodyRatio >= 0.35;
      const isTwoCandleDisplacement = prevC &&
        currentCandleDisplacement &&
        twoCandleBody >= Math.max(45, 0.85 * currentAtr) &&
        c.close > prevC.close &&
        prevC.close > prevC.open;

      if (!isSingleDisplacement && !isTwoCandleDisplacement) continue;

      const upperWick = Math.max(0, c.high - c.close);
      const upperWickRatio = upperWick / range;
      if (upperWickRatio > 0.35) continue;

      const cVol = c.volume || avgVol;
      const volMult = cVol / avgVol;
      const hasVolSurge = volMult >= minVolMult || currentRelVol >= minVolMult;
      if (!hasVolSurge) continue;

      const priorSlice = candles1m.slice(Math.max(0, idx - 5), idx);
      const priorHigh = priorSlice.length > 0 ? Math.max(...priorSlice.map(p => p.high)) : c.open;
      const brokePriorHigh = c.close > priorHigh || c.high > priorHigh;
      if (!brokePriorHigh) continue;

      const hasBullishFlow = takerRatio >= 0.48 || imbalanceRatio >= 0.10 || netCVD > 0 || currentRsi >= 52;
      if (!hasBullishFlow) continue;

      const impulseOrigin = Math.min(c.low, prevC ? prevC.low : c.low);
      const distFromOrigin = currentPrice - impulseOrigin;
      if (distFromOrigin > maxChaseAtr * currentAtr) continue;

      const stopLoss = impulseOrigin - Math.max(25, 0.40 * currentAtr);
      const risk = currentPrice - stopLoss;
      if (risk <= 0) continue;

      const takeProfit = currentPrice + Math.max(risk * 2.2, 2.0 * currentAtr);
      const rrRatio = (takeProfit - currentPrice) / risk;

      return {
        isValid: true,
        direction: "LONG",
        impulsePrice: c.close,
        impulseOrigin,
        volumeMult: Number(volMult.toFixed(2)),
        bodyRatio: Number(bodyRatio.toFixed(2)),
        stopLoss,
        takeProfit,
        riskReward: Number(rrRatio.toFixed(2)),
        ema200Price: currentEma200,
        ema200DistanceAtr: distFromEma200Atr,
        ema200SlopeAngle: ema200Angle,
        description: `Fresh Bullish Momentum Impulse: 1m displacement ($${body.toFixed(1)} body, ${(bodyRatio * 100).toFixed(0)}% body ratio) broke micro-resistance $${priorHigh.toFixed(2)} with ${volMult.toFixed(2)}x volume surge & taker buy flow (${(takerRatio * 100).toFixed(1)}%). Early expansion phase active (SL: $${stopLoss.toFixed(2)}, TP: $${takeProfit.toFixed(2)}, R:R ${rrRatio.toFixed(2)}:1).`
      };
    }
  }

  return {
    isValid: false,
    direction,
    impulsePrice: 0,
    impulseOrigin: 0,
    volumeMult: 0,
    bodyRatio: 0,
    stopLoss: 0,
    takeProfit: 0,
    riskReward: 0,
    ema200Price: currentEma200,
    ema200DistanceAtr: distFromEma200Atr,
    ema200SlopeAngle: ema200Angle,
    description: "No active fresh momentum impulse detected"
  };
}
