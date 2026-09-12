import { MarketRegime, MarketStructureConfig } from "../../types.js";
import { detectOrderFlowAbsorption } from "../orderflow.js";
import { SetupContext } from "./context.js";

export interface FailedAuctionResult {
  isValid: boolean;
  direction: "LONG" | "SHORT" | "NEUTRAL";
  rangeBoundary: number;
  reclaimPrice: number;
  deviationAtr: number;
  candlesOutside: number;
  stopLoss: number;
  takeProfit: number;
  description: string;
}

/**
 * FEATURE 11: Setup 9 - Range Failed Auction / Swing Failure Pattern (SFP) Reclaim
 * Captures false breakouts outside established range boundaries that fail within 1-3 candles
 * and decisively close back inside the range with delta/order flow absorption.
 */
export function evaluateFailedAuctionSetup(
  direction: "LONG" | "SHORT" | "NEUTRAL",
  ctx: SetupContext
): FailedAuctionResult {
  const { candles1m, currentPrice, currentRegime, indicators, orderFlowStats, orderBookStats, config } = ctx;
  const ms = config.market_structure || ({} as MarketStructureConfig);

  if (ms.failed_auction_strategy_enabled === false || direction === "NEUTRAL") {
    return {
      isValid: false,
      direction,
      rangeBoundary: 0,
      reclaimPrice: 0,
      deviationAtr: 0,
      candlesOutside: 0,
      stopLoss: 0,
      takeProfit: 0,
      description: ms.failed_auction_strategy_enabled === false ? "Failed Auction strategy disabled" : "Neutral direction"
    };
  }

  // Regime Safeguard: Avoid knife-catching runaway trending breakouts
  if (direction === "LONG" && currentRegime === MarketRegime.STRONG_DOWNTREND) {
    return {
      isValid: false,
      direction: "LONG",
      rangeBoundary: 0,
      reclaimPrice: 0,
      deviationAtr: 0,
      candlesOutside: 0,
      stopLoss: 0,
      takeProfit: 0,
      description: "Blocked: Bullish Range Failed Auction prohibited in STRONG_DOWNTREND regime."
    };
  }
  if (direction === "SHORT" && currentRegime === MarketRegime.STRONG_UPTREND) {
    return {
      isValid: false,
      direction: "SHORT",
      rangeBoundary: 0,
      reclaimPrice: 0,
      deviationAtr: 0,
      candlesOutside: 0,
      stopLoss: 0,
      takeProfit: 0,
      description: "Blocked: Bearish Range Failed Auction prohibited in STRONG_UPTREND regime."
    };
  }

  if (candles1m.length < 25) {
    return {
      isValid: false,
      direction,
      rangeBoundary: 0,
      reclaimPrice: 0,
      deviationAtr: 0,
      candlesOutside: 0,
      stopLoss: 0,
      takeProfit: 0,
      description: "Insufficient candle history"
    };
  }

  const lastIdx = candles1m.length - 1;
  const currentCandle = candles1m[lastIdx];

  const atr14 = indicators.calculateATR(candles1m, 14);
  const currentAtr = atr14[lastIdx] || 50;

  const maxDeviationAtr = ms.failed_auction_max_deviation_atr_mult !== undefined ? ms.failed_auction_max_deviation_atr_mult : 0.8;
  const maxCandlesOutside = ms.failed_auction_max_candles_outside !== undefined ? ms.failed_auction_max_candles_outside : 3;

  // Define the range bounding box from the prior 25-30 candles (excluding current/recent poke)
  const rangeLookback = 30;
  const rangeStartIdx = Math.max(0, lastIdx - rangeLookback);
  const rangeSlice = candles1m.slice(rangeStartIdx, Math.max(rangeStartIdx + 10, lastIdx - 4));
  if (rangeSlice.length < 10) {
    return {
      isValid: false,
      direction,
      rangeBoundary: 0,
      reclaimPrice: 0,
      deviationAtr: 0,
      candlesOutside: 0,
      stopLoss: 0,
      takeProfit: 0,
      description: "Insufficient range window"
    };
  }

  const rangeHigh = Math.max(...rangeSlice.map(c => c.high));
  const rangeLow = Math.min(...rangeSlice.map(c => c.low));
  const rangeMedian = (rangeHigh + rangeLow) / 2;

  const absorption = detectOrderFlowAbsorption(direction, candles1m, currentPrice, orderFlowStats, orderBookStats);

  if (direction === "LONG") {
    // Bullish Failed Auction / SFP at Range Low
    let pokeLowest = rangeLow;
    let pokeCount = 0;
    let pokeStartIndex = -1;

    const currentLowPoked = currentCandle.low < rangeLow;
    if (currentLowPoked) {
      pokeLowest = Math.min(pokeLowest, currentCandle.low);
      pokeCount++;
    }

    for (let i = 1; i <= Math.min(6, lastIdx - rangeStartIdx); i++) {
      const c = candles1m[lastIdx - i];
      if (c.low < rangeLow) {
        pokeLowest = Math.min(pokeLowest, c.low);
        pokeCount++;
        if (pokeStartIndex === -1) pokeStartIndex = lastIdx - i;
      } else if (pokeCount > 0) {
        break;
      }
    }

    if (pokeCount >= 1 && pokeCount <= maxCandlesOutside) {
      const deviationAmount = rangeLow - pokeLowest;
      const deviationAtrRatio = deviationAmount / currentAtr;

      if (deviationAtrRatio <= maxDeviationAtr && deviationAmount > 0.02 * currentAtr) {
        const isReclaimed = currentCandle.close >= rangeLow - 0.05 * currentAtr;
        const isBullishCandle = currentCandle.close > currentCandle.open || (currentCandle.close - currentCandle.low) > (currentCandle.high - currentCandle.close) * 1.5;
        const isOrderFlowSupported = absorption.isAbsorption || orderFlowStats.takerBuyRatio >= 0.45 || orderBookStats.imbalanceRatio >= -0.15;

        if (isReclaimed && isBullishCandle && isOrderFlowSupported) {
          const stopLoss = pokeLowest - Math.max(25, 0.45 * currentAtr);
          const takeProfit = rangeMedian > currentPrice + 0.5 * currentAtr ? rangeMedian : rangeHigh - Math.max(20, 0.35 * currentAtr);

          return {
            isValid: true,
            direction: "LONG",
            rangeBoundary: rangeLow,
            reclaimPrice: currentPrice,
            deviationAtr: Number(deviationAtrRatio.toFixed(2)),
            candlesOutside: pokeCount,
            stopLoss,
            takeProfit,
            description: `Bullish Range Failed Auction (SFP Reclaim): Price false-breakdown low $${pokeLowest.toFixed(2)} (-${(deviationAtrRatio).toFixed(2)}x ATR for ${pokeCount}c) reclaimed back above Range Low $${rangeLow.toFixed(2)}. ${absorption.type || "Bullish delta reversal"} targeting median $${rangeMedian.toFixed(2)} (SL: $${stopLoss.toFixed(2)}, TP: $${takeProfit.toFixed(2)}).`
          };
        }
      }
    }

    return {
      isValid: false,
      direction: "LONG",
      rangeBoundary: rangeLow,
      reclaimPrice: 0,
      deviationAtr: 0,
      candlesOutside: 0,
      stopLoss: 0,
      takeProfit: 0,
      description: "No active bullish range failed auction setup"
    };
  } else {
    // SHORT: Bearish Failed Auction / SFP at Range High
    let pokeHighest = rangeHigh;
    let pokeCount = 0;

    const currentHighPoked = currentCandle.high > rangeHigh;
    if (currentHighPoked) {
      pokeHighest = Math.max(pokeHighest, currentCandle.high);
      pokeCount++;
    }

    for (let i = 1; i <= Math.min(6, lastIdx - rangeStartIdx); i++) {
      const c = candles1m[lastIdx - i];
      if (c.high > rangeHigh) {
        pokeHighest = Math.max(pokeHighest, c.high);
        pokeCount++;
      } else if (pokeCount > 0) {
        break;
      }
    }

    if (pokeCount >= 1 && pokeCount <= maxCandlesOutside) {
      const deviationAmount = pokeHighest - rangeHigh;
      const deviationAtrRatio = deviationAmount / currentAtr;

      if (deviationAtrRatio <= maxDeviationAtr && deviationAmount > 0.02 * currentAtr) {
        const isReclaimed = currentCandle.close <= rangeHigh + 0.05 * currentAtr;
        const isBearishCandle = currentCandle.close < currentCandle.open || (currentCandle.high - currentCandle.close) > (currentCandle.close - currentCandle.low) * 1.5;
        const isOrderFlowSupported = absorption.isAbsorption || orderFlowStats.takerBuyRatio <= 0.55 || orderBookStats.imbalanceRatio <= 0.15;

        if (isReclaimed && isBearishCandle && isOrderFlowSupported) {
          const stopLoss = pokeHighest + Math.max(25, 0.45 * currentAtr);
          const takeProfit = rangeMedian < currentPrice - 0.5 * currentAtr ? rangeMedian : rangeLow + Math.max(20, 0.35 * currentAtr);

          return {
            isValid: true,
            direction: "SHORT",
            rangeBoundary: rangeHigh,
            reclaimPrice: currentPrice,
            deviationAtr: Number(deviationAtrRatio.toFixed(2)),
            candlesOutside: pokeCount,
            stopLoss,
            takeProfit,
            description: `Bearish Range Failed Auction (SFP Reclaim): Price false-breakout high $${pokeHighest.toFixed(2)} (+${(deviationAtrRatio).toFixed(2)}x ATR for ${pokeCount}c) reclaimed back below Range High $${rangeHigh.toFixed(2)}. ${absorption.type || "Bearish delta reversal"} targeting median $${rangeMedian.toFixed(2)} (SL: $${stopLoss.toFixed(2)}, TP: $${takeProfit.toFixed(2)}).`
          };
        }
      }
    }

    return {
      isValid: false,
      direction: "SHORT",
      rangeBoundary: rangeHigh,
      reclaimPrice: 0,
      deviationAtr: 0,
      candlesOutside: 0,
      stopLoss: 0,
      takeProfit: 0,
      description: "No active bearish range failed auction setup"
    };
  }
}
