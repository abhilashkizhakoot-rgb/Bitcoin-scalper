import { MarketRegime, MarketStructureConfig } from "../../types.js";
import { isMultiCandleLongRejection, isMultiCandleShortRejection } from "../candlestick.js";
import { detectOrderFlowAbsorption } from "../orderflow.js";
import { structureEngine } from "../structure.js";
import { SetupContext } from "./context.js";

export interface EqhEqlDoubleTouchResult {
  isValid: boolean;
  direction: "LONG" | "SHORT" | "NEUTRAL";
  levelPrice: number;
  touchCount: number;
  hasVolumeDecay: boolean;
  hasMomentumDivergence: boolean;
  reversalType: string;
  stopLoss: number;
  takeProfit: number;
  riskReward: number;
  description: string;
}

/**
 * FEATURE 13: Setup 11 - Equal Highs / Equal Lows (EQH/EQL) Double Rejection with Momentum Divergence
 * Targets high-expectancy double top / double bottom boundary rejections at established EQH/EQL pools
 * exhibiting volume decay on the 2nd touch and RSI/CVD momentum divergence.
 */
export function evaluateEqhEqlDoubleTouchSetup(
  direction: "LONG" | "SHORT" | "NEUTRAL",
  ctx: SetupContext
): EqhEqlDoubleTouchResult {
  const { candles1m, currentPrice, currentRegime, indicators, orderFlowStats, orderBookStats, config } = ctx;
  const ms = config.market_structure || ({} as MarketStructureConfig);

  if (ms.eqh_eql_strategy_enabled === false || direction === "NEUTRAL") {
    return {
      isValid: false,
      direction,
      levelPrice: 0,
      touchCount: 0,
      hasVolumeDecay: false,
      hasMomentumDivergence: false,
      reversalType: "",
      stopLoss: 0,
      takeProfit: 0,
      riskReward: 0,
      description: ms.eqh_eql_strategy_enabled === false ? "EQH/EQL Double Touch strategy disabled" : "Neutral direction"
    };
  }

  // Protection 1: Block counter-trend execution during strongly trending regimes
  if (direction === "SHORT" && currentRegime === MarketRegime.STRONG_UPTREND) {
    return {
      isValid: false,
      direction: "SHORT",
      levelPrice: 0,
      touchCount: 0,
      hasVolumeDecay: false,
      hasMomentumDivergence: false,
      reversalType: "",
      stopLoss: 0,
      takeProfit: 0,
      riskReward: 0,
      description: "Blocked: Counter-trend Bearish EQH Double Top Short prohibited in STRONG_UPTREND regime."
    };
  }
  if (direction === "LONG" && currentRegime === MarketRegime.STRONG_DOWNTREND) {
    return {
      isValid: false,
      direction: "LONG",
      levelPrice: 0,
      touchCount: 0,
      hasVolumeDecay: false,
      hasMomentumDivergence: false,
      reversalType: "",
      stopLoss: 0,
      takeProfit: 0,
      riskReward: 0,
      description: "Blocked: Counter-trend Bullish EQL Double Bottom Long prohibited in STRONG_DOWNTREND regime."
    };
  }

  if (candles1m.length < 30) {
    return {
      isValid: false,
      direction,
      levelPrice: 0,
      touchCount: 0,
      hasVolumeDecay: false,
      hasMomentumDivergence: false,
      reversalType: "",
      stopLoss: 0,
      takeProfit: 0,
      riskReward: 0,
      description: "Insufficient candle history"
    };
  }

  const lastIdx = candles1m.length - 1;
  const currentCandle = candles1m[lastIdx];

  const atr14 = indicators.calculateATR(candles1m, 14);
  const currentAtr = atr14[lastIdx] || 50;
  const closes = candles1m.map(c => c.close);
  const ema9 = indicators.calculateEMA(closes, 9);
  const ema21 = indicators.calculateEMA(closes, 21);
  const ema100 = indicators.calculateEMA(closes, 100);

  const eqLevels = structureEngine.detectEqualHighsLows(candles1m, ms, indicators);
  const minTouches = ms.eqh_eql_min_touch_count || 2;

  const rangeLookback = 30;
  const recentRangeSlice = candles1m.slice(-rangeLookback);
  const rangeHigh = Math.max(...recentRangeSlice.map(c => c.high));
  const rangeLow = Math.min(...recentRangeSlice.map(c => c.low));
  const rangeEq = (rangeHigh + rangeLow) / 2;

  if (direction === "LONG") {
    // Find matching EQL support level near current price
    const matchedEql = eqLevels.eqlLevels.find(
      eql => eql.touchCount >= minTouches &&
             (Math.abs(currentCandle.low - eql.price) / eql.price * 100 <= 0.15 ||
              Math.abs(currentPrice - eql.price) <= 0.35 * currentAtr)
    );

    if (!matchedEql) {
      return {
        isValid: false,
        direction: "LONG",
        levelPrice: 0,
        touchCount: 0,
        hasVolumeDecay: false,
        hasMomentumDivergence: false,
        reversalType: "",
        stopLoss: 0,
        takeProfit: 0,
        riskReward: 0,
        description: "No active Equal Lows (EQL) double bottom level tested"
      };
    }

    // Block EQL setups at overextended trend tops (price extended far above 21/100 EMA)
    const currentEma21 = ema21[lastIdx] || currentPrice;
    const currentEma100 = ema100[lastIdx] || currentPrice;
    const distAboveEma21 = currentPrice - currentEma21;
    const distAboveEma100 = currentPrice - currentEma100;
    const isOverextendedAboveEmas = distAboveEma21 > 2.0 * currentAtr || (currentAtr > 0 && distAboveEma100 > 2.5 * currentAtr);
    if (isOverextendedAboveEmas) {
      return {
        isValid: false,
        direction: "LONG",
        levelPrice: matchedEql.price,
        touchCount: matchedEql.touchCount,
        hasVolumeDecay: false,
        hasMomentumDivergence: false,
        reversalType: "",
        stopLoss: 0,
        takeProfit: 0,
        riskReward: 0,
        description: `Blocked: EQL Double Bottom invalidated by top-of-trend overextension (+$${distAboveEma21.toFixed(1)} above 21 EMA, +$${distAboveEma100.toFixed(1)} above 100 EMA)`
      };
    }

    // Micro-trend 9 EMA momentum guard - don't catch falling knives
    const isEma9Falling = lastIdx >= 1 && ema9[lastIdx] < ema9[lastIdx - 1];
    const isDroppingBelowEma9 = isEma9Falling && currentCandle.close <= ema9[lastIdx];
    if (isDroppingBelowEma9) {
      return {
        isValid: false,
        direction: "LONG",
        levelPrice: matchedEql.price,
        touchCount: matchedEql.touchCount,
        hasVolumeDecay: false,
        hasMomentumDivergence: false,
        reversalType: "",
        stopLoss: 0,
        takeProfit: 0,
        riskReward: 0,
        description: "Blocked: Price is falling below declining 9 EMA during EQL test (downward micro-trend active)"
      };
    }

    // Check candlestick reversal at double bottom (must strictly close green and hold above EQL support)
    const rejectionCheck = isMultiCandleLongRejection(candles1m, lastIdx, currentPrice, currentAtr, orderFlowStats, orderBookStats, config, indicators);
    const closedCandle = (lastIdx === candles1m.length - 1 && candles1m.length >= 2) ? candles1m[lastIdx - 1] : currentCandle;
    const isCandleGreen = (rejectionCheck.confirmed && currentCandle.close >= (closedCandle.low - 0.08 * currentAtr)) || (closedCandle.close >= closedCandle.open) || (currentCandle.close > currentCandle.open);
    const isAboveEql = Math.max(currentCandle.close, closedCandle.close) > matchedEql.price && currentCandle.low >= (matchedEql.price - 0.20 * currentAtr);
    const isReversalConfirmed = rejectionCheck.confirmed || (isCandleGreen && isAboveEql);

    if ((!isReversalConfirmed || !isCandleGreen || !isAboveEql) && ms.eqh_eql_require_candlestick_reversal !== false) {
      return {
        isValid: false,
        direction: "LONG",
        levelPrice: matchedEql.price,
        touchCount: matchedEql.touchCount,
        hasVolumeDecay: false,
        hasMomentumDivergence: false,
        reversalType: "",
        stopLoss: 0,
        takeProfit: 0,
        riskReward: 0,
        description: `Awaiting confirmed bullish green rejection candle closing above EQL support $${matchedEql.price.toFixed(2)}`
      };
    }

    // Check volume decay & momentum divergence between touches
    let hasVolumeDecay = true;
    let hasMomentumDivergence = true;

    if (matchedEql.touches && matchedEql.touches.length >= 2) {
      const t1 = matchedEql.touches[matchedEql.touches.length - 2];
      const t2 = matchedEql.touches[matchedEql.touches.length - 1];
      hasVolumeDecay = t2.volume <= t1.volume * 1.20 || t2.volume <= currentCandle.volume * 1.5;
      hasMomentumDivergence = (t2.rsi !== undefined && t1.rsi !== undefined)
        ? t2.rsi >= t1.rsi - 2.0
        : true;
    }

    const absorption = detectOrderFlowAbsorption("LONG", candles1m, currentPrice, orderFlowStats, orderBookStats);
    const isDeltaConfirmed = absorption.isAbsorption || orderFlowStats.takerBuyRatio >= 0.47;

    if (ms.eqh_eql_require_divergence !== false && !hasVolumeDecay && !hasMomentumDivergence && !isDeltaConfirmed) {
      return {
        isValid: false,
        direction: "LONG",
        levelPrice: matchedEql.price,
        touchCount: matchedEql.touchCount,
        hasVolumeDecay,
        hasMomentumDivergence,
        reversalType: rejectionCheck.type || "Bullish Reversal",
        stopLoss: 0,
        takeProfit: 0,
        riskReward: 0,
        description: `EQL double bottom lacks volume decay and momentum divergence at $${matchedEql.price.toFixed(2)}`
      };
    }

    const touchLows = (matchedEql.touches || []).map(t => t.price || matchedEql.price);
    const lowestPoolPoint = Math.min(currentCandle.low, matchedEql.price, ...touchLows);
    const stopLoss = lowestPoolPoint - Math.max(25, 0.45 * currentAtr);
    const takeProfit = rangeEq > currentPrice + 0.5 * currentAtr ? rangeEq : rangeHigh - Math.max(20, 0.35 * currentAtr);
    const riskDistance = currentPrice - stopLoss;
    const rewardDistance = takeProfit - currentPrice;
    const rrRatio = riskDistance > 0 ? rewardDistance / riskDistance : 0;

    const patternDesc = rejectionCheck.type || "Bullish Double Bottom Rejection";
    return {
      isValid: true,
      direction: "LONG",
      levelPrice: matchedEql.price,
      touchCount: matchedEql.touchCount,
      hasVolumeDecay,
      hasMomentumDivergence,
      reversalType: patternDesc,
      stopLoss,
      takeProfit,
      riskReward: Number(rrRatio.toFixed(2)),
      description: `Bullish EQL Double Bottom Rejection: Price successfully tested Equal Lows pool ($${matchedEql.price.toFixed(2)}, ${matchedEql.touchCount} touches) with ${patternDesc}${hasVolumeDecay ? " [Volume Decay]" : ""}${hasMomentumDivergence ? " [RSI/CVD Divergence]" : ""} targeting Range Equilibrium $${takeProfit.toFixed(2)} (SL: $${stopLoss.toFixed(2)}).`
    };
  } else {
    // Find matching EQH resistance level near current price
    const matchedEqh = eqLevels.eqhLevels.find(
      eqh => eqh.touchCount >= minTouches &&
             (Math.abs(currentCandle.high - eqh.price) / eqh.price * 100 <= 0.15 ||
              Math.abs(currentPrice - eqh.price) <= 0.35 * currentAtr)
    );

    if (!matchedEqh) {
      return {
        isValid: false,
        direction: "SHORT",
        levelPrice: 0,
        touchCount: 0,
        hasVolumeDecay: false,
        hasMomentumDivergence: false,
        reversalType: "",
        stopLoss: 0,
        takeProfit: 0,
        riskReward: 0,
        description: "No active Equal Highs (EQH) double top level tested"
      };
    }

    // Block EQH setups at overextended trend bottoms (price extended far below 21/100 EMA)
    const currentEma21 = ema21[lastIdx] || currentPrice;
    const currentEma100 = ema100[lastIdx] || currentPrice;
    const distBelowEma21 = currentEma21 - currentPrice;
    const distBelowEma100 = currentEma100 - currentPrice;
    const isOverextendedBelowEmas = distBelowEma21 > 2.0 * currentAtr || (currentAtr > 0 && distBelowEma100 > 2.5 * currentAtr);
    if (isOverextendedBelowEmas) {
      return {
        isValid: false,
        direction: "SHORT",
        levelPrice: matchedEqh.price,
        touchCount: matchedEqh.touchCount,
        hasVolumeDecay: false,
        hasMomentumDivergence: false,
        reversalType: "",
        stopLoss: 0,
        takeProfit: 0,
        riskReward: 0,
        description: `Blocked: EQH Double Top invalidated by bottom-of-trend overextension (-$${distBelowEma21.toFixed(1)} below 21 EMA, -$${distBelowEma100.toFixed(1)} below 100 EMA)`
      };
    }

    // Micro-trend 9 EMA momentum guard - don't short into surging green impulse
    const isEma9Rising = lastIdx >= 1 && ema9[lastIdx] > ema9[lastIdx - 1];
    const isRidingAboveEma9 = isEma9Rising && currentCandle.close >= ema9[lastIdx];
    if (isRidingAboveEma9) {
      return {
        isValid: false,
        direction: "SHORT",
        levelPrice: matchedEqh.price,
        touchCount: matchedEqh.touchCount,
        hasVolumeDecay: false,
        hasMomentumDivergence: false,
        reversalType: "",
        stopLoss: 0,
        takeProfit: 0,
        riskReward: 0,
        description: "Blocked: Price is riding above rising 9 EMA during EQH test (upward micro-trend active)"
      };
    }

    // Check candlestick reversal at double top (must strictly close red and stay below EQH resistance)
    const rejectionCheck = isMultiCandleShortRejection(candles1m, lastIdx, currentPrice, currentAtr, orderFlowStats, orderBookStats, config, indicators);
    const closedCandle = (lastIdx === candles1m.length - 1 && candles1m.length >= 2) ? candles1m[lastIdx - 1] : currentCandle;
    const isCandleRed = (rejectionCheck.confirmed && currentCandle.close <= (closedCandle.high + 0.08 * currentAtr)) || (closedCandle.close <= closedCandle.open) || (currentCandle.close < currentCandle.open);
    const isBelowEqh = Math.min(currentCandle.close, closedCandle.close) < matchedEqh.price && currentCandle.high <= (matchedEqh.price + 0.20 * currentAtr);
    const isReversalConfirmed = rejectionCheck.confirmed || (isCandleRed && isBelowEqh);

    if ((!isReversalConfirmed || !isCandleRed || !isBelowEqh) && ms.eqh_eql_require_candlestick_reversal !== false) {
      return {
        isValid: false,
        direction: "SHORT",
        levelPrice: matchedEqh.price,
        touchCount: matchedEqh.touchCount,
        hasVolumeDecay: false,
        hasMomentumDivergence: false,
        reversalType: "",
        stopLoss: 0,
        takeProfit: 0,
        riskReward: 0,
        description: `Awaiting confirmed bearish red rejection candle closing below EQH resistance $${matchedEqh.price.toFixed(2)}`
      };
    }

    // Check volume decay & momentum divergence between touches
    let hasVolumeDecay = true;
    let hasMomentumDivergence = true;

    if (matchedEqh.touches && matchedEqh.touches.length >= 2) {
      const t1 = matchedEqh.touches[matchedEqh.touches.length - 2];
      const t2 = matchedEqh.touches[matchedEqh.touches.length - 1];
      hasVolumeDecay = t2.volume <= t1.volume * 1.20 || t2.volume <= currentCandle.volume * 1.5;
      hasMomentumDivergence = (t2.rsi !== undefined && t1.rsi !== undefined)
        ? t2.rsi <= t1.rsi + 2.0
        : true;
    }

    const absorption = detectOrderFlowAbsorption("SHORT", candles1m, currentPrice, orderFlowStats, orderBookStats);
    const isDeltaConfirmed = absorption.isAbsorption || orderFlowStats.takerBuyRatio <= 0.53;

    if (ms.eqh_eql_require_divergence !== false && !hasVolumeDecay && !hasMomentumDivergence && !isDeltaConfirmed) {
      return {
        isValid: false,
        direction: "SHORT",
        levelPrice: matchedEqh.price,
        touchCount: matchedEqh.touchCount,
        hasVolumeDecay,
        hasMomentumDivergence,
        reversalType: rejectionCheck.type || "Bearish Reversal",
        stopLoss: 0,
        takeProfit: 0,
        riskReward: 0,
        description: `EQH double top lacks volume decay and momentum divergence at $${matchedEqh.price.toFixed(2)}`
      };
    }

    const touchHighs = (matchedEqh.touches || []).map(t => t.price || matchedEqh.price);
    const highestPoolPoint = Math.max(currentCandle.high, matchedEqh.price, ...touchHighs);
    const stopLoss = highestPoolPoint + Math.max(25, 0.45 * currentAtr);
    const takeProfit = rangeEq < currentPrice - 0.5 * currentAtr ? rangeEq : rangeLow + Math.max(20, 0.35 * currentAtr);
    const riskDistance = stopLoss - currentPrice;
    const rewardDistance = currentPrice - takeProfit;
    const rrRatio = riskDistance > 0 ? rewardDistance / riskDistance : 0;

    const patternDesc = rejectionCheck.type || "Bearish Double Top Rejection";
    return {
      isValid: true,
      direction: "SHORT",
      levelPrice: matchedEqh.price,
      touchCount: matchedEqh.touchCount,
      hasVolumeDecay,
      hasMomentumDivergence,
      reversalType: patternDesc,
      stopLoss,
      takeProfit,
      riskReward: Number(rrRatio.toFixed(2)),
      description: `Bearish EQH Double Top Rejection: Price successfully tested Equal Highs pool ($${matchedEqh.price.toFixed(2)}, ${matchedEqh.touchCount} touches) with ${patternDesc}${hasVolumeDecay ? " [Volume Decay]" : ""}${hasMomentumDivergence ? " [RSI/CVD Divergence]" : ""} targeting Range Equilibrium $${takeProfit.toFixed(2)} (SL: $${stopLoss.toFixed(2)}).`
    };
  }
}
