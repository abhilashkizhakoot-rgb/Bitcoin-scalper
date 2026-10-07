import { MarketRegime, MarketStructureConfig } from "../../types.js";
import { isMultiCandleLongRejection, isMultiCandleShortRejection } from "../candlestick.js";
import { detectOrderFlowAbsorption } from "../orderflow.js";
import { SetupContext } from "./context.js";

export interface VwapBandRejectionResult {
  isValid: boolean;
  direction: "LONG" | "SHORT" | "NEUTRAL";
  vwapPrice: number;
  bandPrice: number;
  bandDeviationSigma: number;
  reversalType: string;
  stopLoss: number;
  takeProfit: number;
  riskReward: number;
  description: string;
}

/**
 * FEATURE 12: Setup 10 - Dedicated VWAP / Range Band Rejection (Mean Reversion Scalp)
 * Exploits institutional mean-reversion pull when price stretches to the +/- 1.5 sigma or +/- 2.0 sigma
 * standard deviation bands of the Session VWAP and prints an inward-facing reversal rejection candle.
 */
export function evaluateVwapBandRejectionSetup(
  direction: "LONG" | "SHORT" | "NEUTRAL",
  ctx: SetupContext
): VwapBandRejectionResult {
  const { candles1m, currentPrice, currentRegime, indicators, orderFlowStats, orderBookStats, config } = ctx;
  const ms = config.market_structure || ({} as MarketStructureConfig);

  if (ms.vwap_band_reversal_enabled === false || direction === "NEUTRAL") {
    return {
      isValid: false,
      direction,
      vwapPrice: 0,
      bandPrice: 0,
      bandDeviationSigma: 0,
      reversalType: "",
      stopLoss: 0,
      takeProfit: 0,
      riskReward: 0,
      description: ms.vwap_band_reversal_enabled === false ? "VWAP Band Rejection strategy disabled" : "Neutral direction"
    };
  }

  // Protection 1: Block counter-trend execution during strongly trending regimes
  if (direction === "SHORT" && currentRegime === MarketRegime.STRONG_UPTREND) {
    return {
      isValid: false,
      direction: "SHORT",
      vwapPrice: 0,
      bandPrice: 0,
      bandDeviationSigma: 0,
      reversalType: "",
      stopLoss: 0,
      takeProfit: 0,
      riskReward: 0,
      description: "Blocked: Counter-trend Bearish VWAP Band Short prohibited in STRONG_UPTREND regime."
    };
  }
  if (direction === "LONG" && currentRegime === MarketRegime.STRONG_DOWNTREND) {
    return {
      isValid: false,
      direction: "LONG",
      vwapPrice: 0,
      bandPrice: 0,
      bandDeviationSigma: 0,
      reversalType: "",
      stopLoss: 0,
      takeProfit: 0,
      riskReward: 0,
      description: "Blocked: Counter-trend Bullish VWAP Band Long prohibited in STRONG_DOWNTREND regime."
    };
  }

  if (candles1m.length < 25) {
    return {
      isValid: false,
      direction,
      vwapPrice: 0,
      bandPrice: 0,
      bandDeviationSigma: 0,
      reversalType: "",
      stopLoss: 0,
      takeProfit: 0,
      riskReward: 0,
      description: "Insufficient candle history for VWAP calculation"
    };
  }

  const lastIdx = candles1m.length - 1;
  const currentCandle = candles1m[lastIdx];

  const atr14 = indicators.calculateATR(candles1m, 14);
  const currentAtr = atr14[lastIdx] || 50;

  const mult = ms.vwap_band_reversal_deviation_mult || 1.5;
  indicators.calculateVWAP(candles1m, mult);

  const vwapVal = currentCandle.vwap !== undefined ? currentCandle.vwap : currentPrice;
  const vwapUpper = currentCandle.vwap_upper !== undefined ? currentCandle.vwap_upper : currentPrice + mult * currentAtr;
  const vwapLower = currentCandle.vwap_lower !== undefined ? currentCandle.vwap_lower : currentPrice - mult * currentAtr;

  const minWickRatio = ms.vwap_band_reversal_min_wick_ratio || 0.30;
  const rsi14 = indicators.calculateRSI(candles1m.map(c => c.close), 14);
  const currentRsi = rsi14[lastIdx] ?? 50;
  const absorption = detectOrderFlowAbsorption(direction, candles1m, currentPrice, orderFlowStats, orderBookStats);

  // Look at recent 3 candles for band touch and inward rejection
  const recentCandles = candles1m.slice(-3);

  if (direction === "LONG") {
    // Long: Price stretched to lower VWAP band (vwap_lower), rejected upward, closing back toward VWAP
    const touchedLowerBand = recentCandles.some(c => c.low <= vwapLower + 0.15 * currentAtr);
    if (!touchedLowerBand) {
      return {
        isValid: false,
        direction: "LONG",
        vwapPrice: vwapVal,
        bandPrice: vwapLower,
        bandDeviationSigma: mult,
        reversalType: "",
        stopLoss: 0,
        takeProfit: 0,
        riskReward: 0,
        description: "Price has not touched lower VWAP deviation band"
      };
    }

    // Anti-band-walking guard: Candle must close back on or inside lower band toward VWAP
    const isClosedInsideBand = currentCandle.close >= vwapLower - 0.05 * currentAtr;
    if (!isClosedInsideBand) {
      return {
        isValid: false,
        direction: "LONG",
        vwapPrice: vwapVal,
        bandPrice: vwapLower,
        bandDeviationSigma: mult,
        reversalType: "",
        stopLoss: 0,
        takeProfit: 0,
        riskReward: 0,
        description: "Awaiting candle close back inside lower VWAP band (band walking guard)"
      };
    }

    // Bullish candlestick rejection check
    const rejectionCheck = isMultiCandleLongRejection(candles1m, lastIdx, currentPrice, currentAtr, orderFlowStats, orderBookStats, config, indicators);
    const isCandleGreen = currentCandle.close > currentCandle.open || currentPrice > currentCandle.open;
    const candleRange = currentCandle.high - currentCandle.low;
    const lowerWick = Math.min(currentCandle.open, currentCandle.close) - currentCandle.low;
    const hasWickRejection = candleRange > 0 && (lowerWick / candleRange >= minWickRatio);
    const isReversalPattern = rejectionCheck.confirmed || (isCandleGreen && hasWickRejection);

    if (!isReversalPattern && ms.vwap_band_reversal_require_reversal_candle !== false) {
      return {
        isValid: false,
        direction: "LONG",
        vwapPrice: vwapVal,
        bandPrice: vwapLower,
        bandDeviationSigma: mult,
        reversalType: "",
        stopLoss: 0,
        takeProfit: 0,
        riskReward: 0,
        description: "Awaiting confirmed bullish rejection candle at lower VWAP band"
      };
    }

    const lowestPoint = Math.min(...recentCandles.map(c => c.low));
    const stopLoss = lowestPoint - Math.max(25, 0.45 * currentAtr);
    const takeProfit = vwapVal;
    const riskDistance = currentPrice - stopLoss;
    const rewardDistance = takeProfit - currentPrice;
    const rrRatio = riskDistance > 0 ? rewardDistance / riskDistance : 0;

    if (rrRatio < 1.25) {
      return {
        isValid: false,
        direction: "LONG",
        vwapPrice: vwapVal,
        bandPrice: vwapLower,
        bandDeviationSigma: mult,
        reversalType: rejectionCheck.type || "Bullish Reversal",
        stopLoss,
        takeProfit,
        riskReward: Number(rrRatio.toFixed(2)),
        description: `VWAP Mean Reversion R:R too low (${rrRatio.toFixed(2)} < 1.25)`
      };
    }

    // Confluence: RSI oversold or Order flow absorption
    const isRsiValid = currentRsi <= 48;
    const isDeltaSupported = absorption.isAbsorption || orderFlowStats.takerBuyRatio >= 0.46;

    if (isRsiValid || isDeltaSupported) {
      const patternName = rejectionCheck.type || "Bullish Hammer / Pin Bar Rejection";
      return {
        isValid: true,
        direction: "LONG",
        vwapPrice: vwapVal,
        bandPrice: vwapLower,
        bandDeviationSigma: mult,
        reversalType: patternName,
        stopLoss,
        takeProfit,
        riskReward: Number(rrRatio.toFixed(2)),
        description: `Bullish VWAP Band Mean-Reversion: Price rejected from -${mult.toFixed(1)}sigma band ($${vwapLower.toFixed(2)}) with ${patternName} (RSI: ${currentRsi.toFixed(1)}, R:R ${rrRatio.toFixed(2)}x) targeting Session VWAP $${vwapVal.toFixed(2)} (SL: $${stopLoss.toFixed(2)}).`
      };
    }

    return {
      isValid: false,
      direction: "LONG",
      vwapPrice: vwapVal,
      bandPrice: vwapLower,
      bandDeviationSigma: mult,
      reversalType: "",
      stopLoss: 0,
      takeProfit: 0,
      riskReward: 0,
      description: "Awaiting RSI oversold condition or order flow absorption at lower VWAP band"
    };
  } else {
    // Short: Price stretched to upper VWAP band (vwap_upper), rejected downward, closing back toward VWAP
    const touchedUpperBand = recentCandles.some(c => c.high >= vwapUpper - 0.15 * currentAtr);
    if (!touchedUpperBand) {
      return {
        isValid: false,
        direction: "SHORT",
        vwapPrice: vwapVal,
        bandPrice: vwapUpper,
        bandDeviationSigma: mult,
        reversalType: "",
        stopLoss: 0,
        takeProfit: 0,
        riskReward: 0,
        description: "Price has not touched upper VWAP deviation band"
      };
    }

    // Anti-band-walking guard: Candle must close back on or inside upper band toward VWAP
    const isClosedInsideBand = currentCandle.close <= vwapUpper + 0.05 * currentAtr;
    if (!isClosedInsideBand) {
      return {
        isValid: false,
        direction: "SHORT",
        vwapPrice: vwapVal,
        bandPrice: vwapUpper,
        bandDeviationSigma: mult,
        reversalType: "",
        stopLoss: 0,
        takeProfit: 0,
        riskReward: 0,
        description: "Awaiting candle close back inside upper VWAP band (band walking guard)"
      };
    }

    // Bearish candlestick rejection check
    const rejectionCheck = isMultiCandleShortRejection(candles1m, lastIdx, currentPrice, currentAtr, orderFlowStats, orderBookStats, config, indicators);
    const isCandleRed = currentCandle.close < currentCandle.open || currentPrice < currentCandle.open;
    const candleRange = currentCandle.high - currentCandle.low;
    const upperWick = currentCandle.high - Math.max(currentCandle.open, currentCandle.close);
    const hasWickRejection = candleRange > 0 && (upperWick / candleRange >= minWickRatio);
    const isReversalPattern = rejectionCheck.confirmed || (isCandleRed && hasWickRejection);

    if (!isReversalPattern && ms.vwap_band_reversal_require_reversal_candle !== false) {
      return {
        isValid: false,
        direction: "SHORT",
        vwapPrice: vwapVal,
        bandPrice: vwapUpper,
        bandDeviationSigma: mult,
        reversalType: "",
        stopLoss: 0,
        takeProfit: 0,
        riskReward: 0,
        description: "Awaiting confirmed bearish rejection candle at upper VWAP band"
      };
    }

    const highestPoint = Math.max(...recentCandles.map(c => c.high));
    const stopLoss = highestPoint + Math.max(25, 0.45 * currentAtr);
    const takeProfit = vwapVal;
    const riskDistance = stopLoss - currentPrice;
    const rewardDistance = currentPrice - takeProfit;
    const rrRatio = riskDistance > 0 ? rewardDistance / riskDistance : 0;

    if (rrRatio < 1.25) {
      return {
        isValid: false,
        direction: "SHORT",
        vwapPrice: vwapVal,
        bandPrice: vwapUpper,
        bandDeviationSigma: mult,
        reversalType: rejectionCheck.type || "Bearish Reversal",
        stopLoss,
        takeProfit,
        riskReward: Number(rrRatio.toFixed(2)),
        description: `VWAP Mean Reversion R:R too low (${rrRatio.toFixed(2)} < 1.25)`
      };
    }

    // Confluence: RSI overbought or Order flow absorption
    const isRsiValid = currentRsi >= 52;
    const isDeltaSupported = absorption.isAbsorption || orderFlowStats.takerBuyRatio <= 0.54;

    if (isRsiValid || isDeltaSupported) {
      const patternName = rejectionCheck.type || "Bearish Shooting Star / Pin Bar Rejection";
      return {
        isValid: true,
        direction: "SHORT",
        vwapPrice: vwapVal,
        bandPrice: vwapUpper,
        bandDeviationSigma: mult,
        reversalType: patternName,
        stopLoss,
        takeProfit,
        riskReward: Number(rrRatio.toFixed(2)),
        description: `Bearish VWAP Band Mean-Reversion: Price rejected from +${mult.toFixed(1)}sigma band ($${vwapUpper.toFixed(2)}) with ${patternName} (RSI: ${currentRsi.toFixed(1)}, R:R ${rrRatio.toFixed(2)}x) targeting Session VWAP $${vwapVal.toFixed(2)} (SL: $${stopLoss.toFixed(2)}).`
      };
    }

    return {
      isValid: false,
      direction: "SHORT",
      vwapPrice: vwapVal,
      bandPrice: vwapUpper,
      bandDeviationSigma: mult,
      reversalType: "",
      stopLoss: 0,
      takeProfit: 0,
      riskReward: 0,
      description: "Awaiting RSI overbought condition or order flow absorption at upper VWAP band"
    };
  }
}
