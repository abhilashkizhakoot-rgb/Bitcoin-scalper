import { MarketRegime } from "../../types.js";
import { SetupContext } from "./context.js";

export interface FairValueGapResult {
  isValid: boolean;
  direction: "LONG" | "SHORT" | "NEUTRAL";
  fvgTop: number;
  fvgBottom: number;
  consequentEncroachment: number;
  fvgMitigationPrice: number;
  rejectionType: string;
  gapSizeAtr: number;
  stopLoss: number;
  takeProfit: number;
  description: string;
  ema200Price?: number;
  ema200DistanceAtr?: number;
  ema200SlopeAngle?: number;
}

/**
 * FEATURE: Setup 4 - Fair Value Gap (FVG) / Institutional Imbalance Retest Setup
 * Optimized for 1-minute scalping with:
 * 1. Institutional Displacement Validation (Candle 2 volume >= 1.25x & body ratio >= 60%)
 * 2. Consequent Encroachment (50% CE) Invalidation Rule (no candle body closes past 50% CE)
 * 3. Two-Step Tap & Rejection Confirmation (reversal close or >= 35% wick rejection)
 * 4. Micro-Trend & Anti-Knife-Catching Guard (EMA 50 / VWAP alignment and cascade rejection check)
 * 5. 200 EMA Macro Overextension & Proximity Guard (prevents buying/selling at extreme mean-reversion stretch or directly into adverse 200 EMA)
 */
export function evaluateFairValueGapSetup(
  direction: "LONG" | "SHORT" | "NEUTRAL",
  ctx: SetupContext
): FairValueGapResult {
  const { candles1m, currentPrice, currentRegime, indicators, config } = ctx;
  const ms: any = config.market_structure || {};

  if (ms.fvg_strategy_enabled === false || direction === "NEUTRAL") {
    return {
      isValid: false,
      direction,
      fvgTop: 0,
      fvgBottom: 0,
      consequentEncroachment: 0,
      fvgMitigationPrice: 0,
      rejectionType: "",
      gapSizeAtr: 0,
      stopLoss: 0,
      takeProfit: 0,
      description: ms.fvg_strategy_enabled === false ? "Fair Value Gap (FVG) strategy disabled" : "Neutral direction",
    };
  }

  if (candles1m.length < 25) {
    return {
      isValid: false,
      direction,
      fvgTop: 0,
      fvgBottom: 0,
      consequentEncroachment: 0,
      fvgMitigationPrice: 0,
      rejectionType: "",
      gapSizeAtr: 0,
      stopLoss: 0,
      takeProfit: 0,
      description: "Insufficient candle history",
    };
  }

  const lastIdx = candles1m.length - 1;
  const currentCandle = candles1m[lastIdx];
  const prevCandle = candles1m[lastIdx - 1];

  const atr14 = indicators.calculateATR(candles1m, 14);
  const currentAtr = Math.max(10, atr14[lastIdx] || 50);

  const minGapAtrRatio = ms.fvg_min_gap_atr_ratio !== undefined ? ms.fvg_min_gap_atr_ratio : 0.25;
  const lookback = ms.fvg_lookback_candles || 20;
  const requireRejection = ms.fvg_require_reversal_confirmation !== false;
  const dispVolMult = ms.fvg_displacement_vol_mult !== undefined ? ms.fvg_displacement_vol_mult : 1.25;
  const minBodyRatio = ms.fvg_min_body_ratio !== undefined ? ms.fvg_min_body_ratio : 0.60;
  const ceInvalidationRule = ms.fvg_ce_invalidation_rule !== false;
  const trendFilterEnabled = ms.fvg_trend_filter_enabled !== false;
  const ema200ProximityBlock = ms.fvg_ema200_proximity_block !== false;
  const slowEmaPeriod = ms.slow_ema_period || 200;

  // Moving average volume calculation (20 periods)
  const volumes = candles1m.map((c) => c.volume);
  const sumVol20 = volumes.slice(-20).reduce((a, b) => a + b, 0);
  const avgVol20 = volumes.length >= 20 ? sumVol20 / 20 : 1.0;

  // Closes array for EMA and VWAP indicators
  const closes = candles1m.map((c) => c.close);
  const ema50Series = indicators.calculateEMA(closes, 50);
  const currentEma50 = ema50Series[lastIdx] || currentPrice;
  indicators.calculateVWAP(candles1m);
  const currentVwap = currentCandle.vwap !== undefined ? currentCandle.vwap : currentPrice;

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

  // Micro-Trend Guard: Block counter-trend scalp attempts during strong opposing momentum
  if (trendFilterEnabled) {
    if (direction === "LONG") {
      if (currentRegime === MarketRegime.STRONG_DOWNTREND) {
        return {
          isValid: false,
          direction,
          fvgTop: 0,
          fvgBottom: 0,
          consequentEncroachment: 0,
          fvgMitigationPrice: 0,
          rejectionType: "",
          gapSizeAtr: 0,
          stopLoss: 0,
          takeProfit: 0,
          ema200Price: currentEma200,
          ema200DistanceAtr: distFromEma200Atr,
          ema200SlopeAngle: ema200Angle,
          description: "Bullish FVG blocked: strong downtrend regime active (anti-knife-catching filter).",
        };
      }
      // Price must not be severely sunken below both 50 EMA and VWAP
      if (currentPrice < currentEma50 - 1.2 * currentAtr && currentPrice < currentVwap - 1.2 * currentAtr) {
        return {
          isValid: false,
          direction,
          fvgTop: 0,
          fvgBottom: 0,
          consequentEncroachment: 0,
          fvgMitigationPrice: 0,
          rejectionType: "",
          gapSizeAtr: 0,
          stopLoss: 0,
          takeProfit: 0,
          ema200Price: currentEma200,
          ema200DistanceAtr: distFromEma200Atr,
          ema200SlopeAngle: ema200Angle,
          description: "Bullish FVG blocked: price too deeply depressed below EMA50 & VWAP.",
        };
      }
    } else if (direction === "SHORT") {
      if (currentRegime === MarketRegime.STRONG_UPTREND) {
        return {
          isValid: false,
          direction,
          fvgTop: 0,
          fvgBottom: 0,
          consequentEncroachment: 0,
          fvgMitigationPrice: 0,
          rejectionType: "",
          gapSizeAtr: 0,
          stopLoss: 0,
          takeProfit: 0,
          ema200Price: currentEma200,
          ema200DistanceAtr: distFromEma200Atr,
          ema200SlopeAngle: ema200Angle,
          description: "Bearish FVG blocked: strong uptrend regime active (anti-knife-catching filter).",
        };
      }
      // Price must not be severely soaring above both 50 EMA and VWAP
      if (currentPrice > currentEma50 + 1.2 * currentAtr && currentPrice > currentVwap + 1.2 * currentAtr) {
        return {
          isValid: false,
          direction,
          fvgTop: 0,
          fvgBottom: 0,
          consequentEncroachment: 0,
          fvgMitigationPrice: 0,
          rejectionType: "",
          gapSizeAtr: 0,
          stopLoss: 0,
          takeProfit: 0,
          ema200Price: currentEma200,
          ema200DistanceAtr: distFromEma200Atr,
          ema200SlopeAngle: ema200Angle,
          description: "Bearish FVG blocked: price too far elevated above EMA50 & VWAP.",
        };
      }
    }
  }

  // Note: Macro value extension is strictly enforced globally by the Unified Value Extension Anchor Gate.

  // 200 EMA Adverse Barrier Proximity Guard: Prevent taking trades directly into an adverse 200 EMA ceiling/floor
  if (ema200ProximityBlock) {
    if (direction === "LONG") {
      const distToOverhead = currentEma200 - currentPrice;
      if (distToOverhead > 0 && distToOverhead < 1.2 * currentAtr) {
        return {
          isValid: false,
          direction,
          fvgTop: 0,
          fvgBottom: 0,
          consequentEncroachment: 0,
          fvgMitigationPrice: 0,
          rejectionType: "",
          gapSizeAtr: 0,
          stopLoss: 0,
          takeProfit: 0,
          ema200Price: currentEma200,
          ema200DistanceAtr: distFromEma200Atr,
          ema200SlopeAngle: ema200Angle,
          description: `Bullish FVG blocked: 200 EMA ($${currentEma200.toFixed(2)}) is immediate overhead resistance ($${distToOverhead.toFixed(1)} away, < 1.2x ATR).`,
        };
      }
      if (currentPrice < currentEma200 && ema200Angle < -15) {
        return {
          isValid: false,
          direction,
          fvgTop: 0,
          fvgBottom: 0,
          consequentEncroachment: 0,
          fvgMitigationPrice: 0,
          rejectionType: "",
          gapSizeAtr: 0,
          stopLoss: 0,
          takeProfit: 0,
          ema200Price: currentEma200,
          ema200DistanceAtr: distFromEma200Atr,
          ema200SlopeAngle: ema200Angle,
          description: `Bullish FVG blocked: 200 EMA is downward-sloping (Angle: ${ema200Angle.toFixed(1)} deg) presenting high overhead rejection risk.`,
        };
      }
    } else if (direction === "SHORT") {
      const distToFloor = currentPrice - currentEma200;
      if (distToFloor > 0 && distToFloor < 1.2 * currentAtr) {
        return {
          isValid: false,
          direction,
          fvgTop: 0,
          fvgBottom: 0,
          consequentEncroachment: 0,
          fvgMitigationPrice: 0,
          rejectionType: "",
          gapSizeAtr: 0,
          stopLoss: 0,
          takeProfit: 0,
          ema200Price: currentEma200,
          ema200DistanceAtr: distFromEma200Atr,
          ema200SlopeAngle: ema200Angle,
          description: `Bearish FVG blocked: 200 EMA ($${currentEma200.toFixed(2)}) is immediate dynamic support ($${distToFloor.toFixed(1)} away, < 1.2x ATR).`,
        };
      }
      if (currentPrice > currentEma200 && ema200Angle > 15) {
        return {
          isValid: false,
          direction,
          fvgTop: 0,
          fvgBottom: 0,
          consequentEncroachment: 0,
          fvgMitigationPrice: 0,
          rejectionType: "",
          gapSizeAtr: 0,
          stopLoss: 0,
          takeProfit: 0,
          ema200Price: currentEma200,
          ema200DistanceAtr: distFromEma200Atr,
          ema200SlopeAngle: ema200Angle,
          description: `Bearish FVG blocked: 200 EMA is upward-sloping (Angle: ${ema200Angle.toFixed(1)} deg) presenting high dynamic support bounce risk.`,
        };
      }
    }
  }

  // Scan backwards for the most recent unmitigated FVG in the direction of the trade
  const startIdx = Math.max(3, lastIdx - lookback);

  if (direction === "LONG") {
    // Bullish FVG (BISI): Formed by candles [i-2, i-1, i] where candle[i].low > candle[i-2].high
    for (let i = lastIdx - 1; i >= startIdx; i--) {
      const c0 = candles1m[i - 2];
      const c1 = candles1m[i - 1]; // Displacement candle
      const c2 = candles1m[i];

      if (c1.close <= c1.open) continue; // Must be bullish displacement

      // 1. Institutional Displacement Validation
      const c1Range = Math.max(0.001, c1.high - c1.low);
      const c1Body = c1.close - c1.open;
      const c1BodyRatio = c1Body / c1Range;
      if (c1BodyRatio < minBodyRatio) continue; // Reject dojis / indecision candles

      // Check displacement volume
      if (c1.volume < dispVolMult * avgVol20 && c1Range < 0.8 * currentAtr) continue;

      const fvgTop = c2.low;
      const fvgBottom = c0.high;
      const gapSize = fvgTop - fvgBottom;

      // Gap must be positive and meet minimum ATR threshold
      if (gapSize < minGapAtrRatio * currentAtr) continue;

      const ce = (fvgTop + fvgBottom) / 2; // Consequent Encroachment (50%)

      // 2. Consequent Encroachment & Deep Invalidation Checks
      let isInvalidated = false;
      let alreadyMitigatedDeep = false;
      for (let m = i + 1; m < lastIdx; m++) {
        const candleM = candles1m[m];
        if (candleM.close < fvgBottom || (ceInvalidationRule && candleM.close < ce)) {
          isInvalidated = true;
          break;
        }
        if (candleM.low <= fvgBottom + 0.1 * currentAtr) {
          alreadyMitigatedDeep = true;
        }
      }
      if (isInvalidated || alreadyMitigatedDeep) continue;

      // Current candle close must respect 50% CE if rule is active
      if (ceInvalidationRule && currentCandle.close < ce) continue;
      if (currentPrice < fvgBottom - 0.10 * currentAtr) continue;

      // 3. Two-Step Tap & Rejection Confirmation
      const currentTapped = currentCandle.low <= fvgTop && currentCandle.high >= fvgBottom;
      const prevTapped = prevCandle.low <= fvgTop && prevCandle.high >= fvgBottom;

      if (!currentTapped && !prevTapped) continue;

      // Verify Anti-Knife-Catching Cascade: Check candles leading into the tap
      const tapIdx = currentTapped ? lastIdx : lastIdx - 1;
      if (tapIdx >= 3) {
        const p1 = candles1m[tapIdx - 1];
        const p2 = candles1m[tapIdx - 2];
        const p3 = candles1m[tapIdx - 3];
        const isHeavyCascade = p1.close < p1.open && p2.close < p2.open && p3.close < p3.open &&
                               (p3.open - p1.close) > 1.4 * currentAtr;
        if (isHeavyCascade && currentCandle.close <= currentCandle.open) {
          return {
            isValid: false,
            direction,
            fvgTop,
            fvgBottom,
            consequentEncroachment: ce,
            fvgMitigationPrice: currentPrice,
            rejectionType: "Awaiting Reversal Candle",
            gapSizeAtr: gapSize / currentAtr,
            stopLoss: 0,
            takeProfit: 0,
            description: `Bullish FVG tapped during heavy bear cascade; awaiting clean green reversal close.`,
          };
        }
      }

      // Rejection / Reaction validation:
      const range = Math.max(0.001, currentCandle.high - currentCandle.low);
      const lowerWick = Math.min(currentCandle.open, currentCandle.close) - currentCandle.low;
      const lowerWickRatio = lowerWick / range;
      const isBullishClose = currentCandle.close > currentCandle.open;
      const isUpperHalfClose = currentCandle.close >= currentCandle.low + 0.5 * range;

      const isRejectionConfirmed = (lowerWickRatio >= 0.35 || (isBullishClose && isUpperHalfClose));

      if (requireRejection && !isRejectionConfirmed) {
        return {
          isValid: false,
          direction,
          fvgTop,
          fvgBottom,
          consequentEncroachment: ce,
          fvgMitigationPrice: currentPrice,
          rejectionType: "Awaiting Rejection",
          gapSizeAtr: gapSize / currentAtr,
          stopLoss: 0,
          takeProfit: 0,
          description: `Bullish FVG zone [$${fvgBottom.toFixed(2)} - $${fvgTop.toFixed(2)}] (CE: $${ce.toFixed(2)}) tapped, awaiting rejection wick (>=35%) or green reversal close.`,
        };
      }

      // Structural Stop Loss: Below the FVG Bottom (or below tap swing low) with a protective buffer
      const tapLow = Math.min(currentCandle.low, prevCandle.low);
      let stopLoss = Math.min(fvgBottom, tapLow) - Math.max(25, 0.45 * currentAtr);
      const nearestRoundBelow = Math.floor(currentPrice / 500) * 500;
      if (currentPrice > nearestRoundBelow && stopLoss >= nearestRoundBelow && (stopLoss - nearestRoundBelow) <= 45) {
        stopLoss = nearestRoundBelow - Math.max(35, 0.55 * currentAtr);
      }

      const slDist = Math.abs(currentPrice - stopLoss);
      const takeProfit = currentPrice + Math.max(slDist * 1.5, 1.4 * currentAtr);

      return {
        isValid: true,
        direction: "LONG",
        fvgTop,
        fvgBottom,
        consequentEncroachment: ce,
        fvgMitigationPrice: currentPrice,
        rejectionType: lowerWickRatio >= 0.35 ? `Bullish Wick (${(lowerWickRatio * 100).toFixed(0)}%)` : "Green Reversal Displacement",
        gapSizeAtr: gapSize / currentAtr,
        stopLoss,
        takeProfit,
        ema200Price: currentEma200,
        ema200DistanceAtr: distFromEma200Atr,
        ema200SlopeAngle: ema200Angle,
        description: `Bullish FVG [$${fvgBottom.toFixed(2)} - $${fvgTop.toFixed(2)}] (CE: $${ce.toFixed(2)}) mitigated & defended with ${lowerWickRatio >= 0.35 ? (lowerWickRatio * 100).toFixed(0) + '% wick rejection' : 'green reversal close'}.`,
      };
    }
  } else if (direction === "SHORT") {
    // Bearish FVG (SIBI): Formed by candles [i-2, i-1, i] where candle[i].high < candle[i-2].low
    for (let i = lastIdx - 1; i >= startIdx; i--) {
      const c0 = candles1m[i - 2];
      const c1 = candles1m[i - 1]; // Displacement candle
      const c2 = candles1m[i];

      if (c1.close >= c1.open) continue; // Must be bearish displacement

      // 1. Institutional Displacement Validation
      const c1Range = Math.max(0.001, c1.high - c1.low);
      const c1Body = c1.open - c1.close;
      const c1BodyRatio = c1Body / c1Range;
      if (c1BodyRatio < minBodyRatio) continue; // Reject dojis / indecision candles

      // Check displacement volume
      if (c1.volume < dispVolMult * avgVol20 && c1Range < 0.8 * currentAtr) continue;

      const fvgTop = c0.low;
      const fvgBottom = c2.high;
      const gapSize = fvgTop - fvgBottom;

      // Gap must be positive and meet minimum ATR threshold
      if (gapSize < minGapAtrRatio * currentAtr) continue;

      const ce = (fvgTop + fvgBottom) / 2; // Consequent Encroachment (50%)

      // 2. Consequent Encroachment & Deep Invalidation Checks
      let isInvalidated = false;
      let alreadyMitigatedDeep = false;
      for (let m = i + 1; m < lastIdx; m++) {
        const candleM = candles1m[m];
        if (candleM.close > fvgTop || (ceInvalidationRule && candleM.close > ce)) {
          isInvalidated = true;
          break;
        }
        if (candleM.high >= fvgTop - 0.1 * currentAtr) {
          alreadyMitigatedDeep = true;
        }
      }
      if (isInvalidated || alreadyMitigatedDeep) continue;

      // Current candle close must respect 50% CE if rule is active
      if (ceInvalidationRule && currentCandle.close > ce) continue;
      if (currentPrice > fvgTop + 0.10 * currentAtr) continue;

      // 3. Two-Step Tap & Rejection Confirmation
      const currentTapped = currentCandle.high >= fvgBottom && currentCandle.low <= fvgTop;
      const prevTapped = prevCandle.high >= fvgBottom && prevCandle.low <= fvgTop;

      if (!currentTapped && !prevTapped) continue;

      // Verify Anti-Knife-Catching Cascade: Check candles leading into the tap
      const tapIdx = currentTapped ? lastIdx : lastIdx - 1;
      if (tapIdx >= 3) {
        const p1 = candles1m[tapIdx - 1];
        const p2 = candles1m[tapIdx - 2];
        const p3 = candles1m[tapIdx - 3];
        const isHeavyPump = p1.close > p1.open && p2.close > p2.open && p3.close > p3.open &&
                            (p1.close - p3.open) > 1.4 * currentAtr;
        if (isHeavyPump && currentCandle.close >= currentCandle.open) {
          return {
            isValid: false,
            direction,
            fvgTop,
            fvgBottom,
            consequentEncroachment: ce,
            fvgMitigationPrice: currentPrice,
            rejectionType: "Awaiting Reversal Candle",
            gapSizeAtr: gapSize / currentAtr,
            stopLoss: 0,
            takeProfit: 0,
            description: `Bearish FVG tapped during heavy bull surge; awaiting clean red reversal close.`,
          };
        }
      }

      // Rejection / Reaction validation:
      const range = Math.max(0.001, currentCandle.high - currentCandle.low);
      const upperWick = currentCandle.high - Math.max(currentCandle.open, currentCandle.close);
      const upperWickRatio = upperWick / range;
      const isBearishClose = currentCandle.close < currentCandle.open;
      const isLowerHalfClose = currentCandle.close <= currentCandle.low + 0.5 * range;

      const isRejectionConfirmed = (upperWickRatio >= 0.35 || (isBearishClose && isLowerHalfClose));

      if (requireRejection && !isRejectionConfirmed) {
        return {
          isValid: false,
          direction,
          fvgTop,
          fvgBottom,
          consequentEncroachment: ce,
          fvgMitigationPrice: currentPrice,
          rejectionType: "Awaiting Rejection",
          gapSizeAtr: gapSize / currentAtr,
          stopLoss: 0,
          takeProfit: 0,
          description: `Bearish FVG zone [$${fvgBottom.toFixed(2)} - $${fvgTop.toFixed(2)}] (CE: $${ce.toFixed(2)}) tapped, awaiting rejection wick (>=35%) or red reversal close.`,
        };
      }

      // Structural Stop Loss: Above the FVG Top (or above tap swing high) with a protective buffer
      const tapHigh = Math.max(currentCandle.high, prevCandle.high);
      let stopLoss = Math.max(fvgTop, tapHigh) + Math.max(25, 0.45 * currentAtr);
      const nearestRoundAbove = Math.ceil(currentPrice / 500) * 500;
      if (currentPrice < nearestRoundAbove && stopLoss <= nearestRoundAbove && (nearestRoundAbove - stopLoss) <= 45) {
        stopLoss = nearestRoundAbove + Math.max(35, 0.55 * currentAtr);
      }

      const slDist = Math.abs(stopLoss - currentPrice);
      const takeProfit = currentPrice - Math.max(slDist * 1.5, 1.4 * currentAtr);

      return {
        isValid: true,
        direction: "SHORT",
        fvgTop,
        fvgBottom,
        consequentEncroachment: ce,
        fvgMitigationPrice: currentPrice,
        rejectionType: upperWickRatio >= 0.35 ? `Bearish Wick (${(upperWickRatio * 100).toFixed(0)}%)` : "Red Reversal Displacement",
        gapSizeAtr: gapSize / currentAtr,
        stopLoss,
        takeProfit,
        ema200Price: currentEma200,
        ema200DistanceAtr: distFromEma200Atr,
        ema200SlopeAngle: ema200Angle,
        description: `Bearish FVG [$${fvgBottom.toFixed(2)} - $${fvgTop.toFixed(2)}] (CE: $${ce.toFixed(2)}) mitigated & defended with ${upperWickRatio >= 0.35 ? (upperWickRatio * 100).toFixed(0) + '% wick rejection' : 'red reversal close'}.`,
      };
    }
  }

  return {
    isValid: false,
    direction,
    fvgTop: 0,
    fvgBottom: 0,
    consequentEncroachment: 0,
    fvgMitigationPrice: 0,
    rejectionType: "",
    gapSizeAtr: 0,
    stopLoss: 0,
    takeProfit: 0,
    ema200Price: currentEma200,
    ema200DistanceAtr: distFromEma200Atr,
    ema200SlopeAngle: ema200Angle,
    description: "No active unmitigated Fair Value Gap (FVG) retest setup detected.",
  };
}

export const evaluateFvgPullbackMitigationSetup = evaluateFairValueGapSetup;
