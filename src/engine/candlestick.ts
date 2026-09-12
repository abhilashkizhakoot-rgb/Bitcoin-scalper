import { Candlestick, StrategyConfig } from "../types.js";
import { IndicatorCalculator } from "./indicators.js";
import { OrderFlowStats, OrderBookStats, detectOrderFlowAbsorption } from "./orderflow.js";

export interface RejectionResult {
  confirmed: boolean;
  type: string;
}

export function isMultiCandleLongRejection(
  candles1m: Candlestick[],
  lastIdx: number,
  currentPrice: number,
  currentAtr: number,
  orderFlowStats: OrderFlowStats,
  orderBookStats: OrderBookStats,
  config: StrategyConfig,
  indicators: IndicatorCalculator
): RejectionResult {
  if (lastIdx < 0 || candles1m.length === 0) return { confirmed: false, type: "" };
  const ms = config.market_structure;
  const requirePinBarConfirmation = ms.pinbar_two_candle_confirmation_enabled !== false;
  const minWickRatio = ms.pinbar_min_wick_ratio || 0.50;

  const candlestickEnhancements = ms.candlestick_enhancements_enabled !== false;
  const minCsi = ms.csi_min_threshold !== undefined ? ms.csi_min_threshold : 0.50;
  const maxAtrMult = ms.max_confirmation_candle_atr !== undefined ? ms.max_confirmation_candle_atr : 1.8;
  const allowThreeMethods = ms.rising_falling_three_methods_enabled !== false;
  const allowInvertedHammer = ms.inverted_hammer_hanging_man_enabled !== false;
  const allowDojiBreakout = ms.doji_breakout_confirmation_enabled !== false;

  const closedIdx = (lastIdx === candles1m.length - 1 && candles1m.length >= 2) ? lastIdx - 1 : lastIdx;
  if (closedIdx < 0) return { confirmed: false, type: "" };

  const confirmCandle = candles1m[closedIdx];
  const confirmRange = confirmCandle.high - confirmCandle.low;
  const confirmBody = Math.abs(confirmCandle.close - confirmCandle.open);
  const confirmUpperWick = confirmCandle.high - Math.max(confirmCandle.close, confirmCandle.open);
  const confirmLowerWick = Math.min(confirmCandle.close, confirmCandle.open) - confirmCandle.low;
  const isBullish = confirmCandle.close > confirmCandle.open;
  const setupCandle = closedIdx >= 1 ? candles1m[closedIdx - 1] : null;

  const isClimaxExhausted = candlestickEnhancements && confirmRange > maxAtrMult * currentAtr;

  const bullishCloseProximity = confirmRange > 0 ? (confirmCandle.close - confirmCandle.low) / confirmRange : 0;
  const bullishBodyRatio = confirmRange > 0 ? confirmBody / confirmRange : 0;
  const bullishCsi = confirmRange > 0 ? Number((bullishCloseProximity * bullishBodyRatio).toFixed(4)) : 0;
  const hasStrongCsi = isBullish && bullishCsi >= minCsi && (confirmUpperWick <= 0.25 * confirmRange);

  const isPinBar = confirmRange > 0 && confirmLowerWick >= minWickRatio * confirmRange && confirmUpperWick <= 0.25 * confirmRange;
  const isMajorWickRejection = confirmRange > 0 && confirmLowerWick >= 0.65 * confirmRange;
  const hasStrongClose = confirmRange > 0 && (confirmCandle.close - confirmCandle.low) / confirmRange >= 0.70;
  const isMomentumCandle = isBullish && confirmBody >= 0.65 * currentAtr && (candlestickEnhancements ? hasStrongCsi : true);
  const isIndecision = confirmRange > 0 && 
    ((confirmBody / confirmRange < 0.18) || (confirmBody / confirmRange < 0.30 && confirmRange < 0.25 * currentAtr)) && 
    !isPinBar && !isMajorWickRejection;

  let isConfirmedBullishPinBar = false;
  let isConfirmedMajorWickRejection = false;
  if (setupCandle) {
    const setupRange = setupCandle.high - setupCandle.low;
    const setupLowerWick = Math.min(setupCandle.open, setupCandle.close) - setupCandle.low;
    const setupUpperWick = setupCandle.high - Math.max(setupCandle.open, setupCandle.close);
    const setupIsPinBar = setupRange > 0 && setupLowerWick >= minWickRatio * setupRange && setupUpperWick <= 0.30 * setupRange;
    const setupIsMajorWick = setupRange > 0 && setupLowerWick >= 0.65 * setupRange;

    const isConfirmGreen = confirmCandle.close > confirmCandle.open;
    const greenBody = confirmCandle.close - confirmCandle.open;
    const hasVerifiedBodyExpansion = confirmRange > 0 && ((greenBody / confirmRange >= 0.35) || (greenBody >= 0.25 * currentAtr)) && (greenBody / (confirmRange || 1) >= 0.20);
    const holdsPinLow = confirmCandle.low >= setupCandle.low - 0.05 * currentAtr;
    const breaksPinUpper = confirmCandle.close >= (setupCandle.low + setupRange * 0.50) || confirmCandle.close >= setupCandle.high;
    const hasUpwardFollowThrough = confirmCandle.close > setupCandle.close;

    if (setupIsPinBar && isConfirmGreen && hasVerifiedBodyExpansion && holdsPinLow && (breaksPinUpper || hasUpwardFollowThrough)) {
      isConfirmedBullishPinBar = true;
    }
    if (setupIsMajorWick && isConfirmGreen && hasVerifiedBodyExpansion && holdsPinLow && (breaksPinUpper || hasUpwardFollowThrough)) {
      isConfirmedMajorWickRejection = true;
    }
  }

  let isConfirmedInvertedHammer = false;
  if (candlestickEnhancements && allowInvertedHammer && setupCandle) {
    const setupRange = setupCandle.high - setupCandle.low;
    const setupBody = Math.abs(setupCandle.close - setupCandle.open);
    const setupUpperWick = setupCandle.high - Math.max(setupCandle.open, setupCandle.close);
    const setupLowerWick = Math.min(setupCandle.open, setupCandle.close) - setupCandle.low;

    const setupIsInvHammer = setupRange > 0 &&
      setupUpperWick >= 0.45 * setupRange &&
      setupUpperWick >= 1.8 * Math.max(setupBody, 0.01 * currentAtr) &&
      setupLowerWick <= 0.25 * setupRange &&
      (Math.max(setupCandle.open, setupCandle.close) - setupCandle.low) <= 0.45 * setupRange;

    const isConfirmGreen = confirmCandle.close > confirmCandle.open;
    const holdsInvLow = confirmCandle.low >= setupCandle.low - 0.05 * currentAtr;
    const breaksInvBody = confirmCandle.close > Math.max(setupCandle.open, setupCandle.close);
    const hasExpansion = confirmBody >= 0.22 * currentAtr || (confirmRange > 0 && confirmBody >= 0.30 * confirmRange);

    if (setupIsInvHammer && isConfirmGreen && holdsInvLow && breaksInvBody && hasExpansion) {
      isConfirmedInvertedHammer = true;
    }
  }

  const minEngulfBody = Math.max(0.35 * currentAtr, 0.35 * confirmRange);
  const prevBody = setupCandle ? Math.abs(setupCandle.close - setupCandle.open) : 0;
  const isBullishEngulfing = setupCandle && 
    (setupCandle.close < setupCandle.open) && 
    isBullish && 
    (confirmCandle.close >= setupCandle.open) && 
    (confirmCandle.open <= setupCandle.close + 0.08 * currentAtr) &&
    (confirmBody >= minEngulfBody) &&
    (prevBody >= 0.12 * currentAtr || (setupCandle.high - setupCandle.low) >= 0.25 * currentAtr);

  const hasMultiWickRejection = setupCandle && 
    (confirmLowerWick >= 0.35 * confirmRange) && 
    ((Math.min(setupCandle.close, setupCandle.open) - setupCandle.low) >= 0.35 * (setupCandle.high - setupCandle.low)) && 
    Math.abs(confirmCandle.low - setupCandle.low) < 0.15 * currentAtr;

  let isTweezerBottom = false;
  if (setupCandle) {
    const prevRange = setupCandle.high - setupCandle.low;
    const prevLowerWick = Math.min(setupCandle.open, setupCandle.close) - setupCandle.low;
    const matchingLows = Math.abs(confirmCandle.low - setupCandle.low) < 0.05 * currentAtr;
    const currentHasLowerWick = confirmRange > 0 && confirmLowerWick >= 0.25 * confirmRange;
    const prevHasLowerWick = prevRange > 0 && prevLowerWick >= 0.25 * prevRange;
    const hasPositiveClose = isBullish && (confirmBody >= 0.20 * confirmRange || confirmBody >= 0.20 * currentAtr);
    if (matchingLows && currentHasLowerWick && prevHasLowerWick && (hasPositiveClose || hasStrongClose)) {
      isTweezerBottom = true;
    }
  }

  let isPiercingLine = false;
  if (setupCandle) {
    const prevRange = setupCandle.high - setupCandle.low;
    const prevBody = setupCandle.open - setupCandle.close;
    const isPrevStrongBearish = setupCandle.close < setupCandle.open && prevBody >= 0.3 * prevRange;
    const opensBelowPrevClose = confirmCandle.open < setupCandle.close + 0.05 * currentAtr;
    const closesAboveMidpoint = confirmCandle.close >= (setupCandle.open + setupCandle.close) / 2;
    const hasPiercingBody = isBullish && confirmBody >= 0.25 * confirmRange && confirmBody >= 0.20 * currentAtr;
    if (isPrevStrongBearish && opensBelowPrevClose && closesAboveMidpoint && hasPiercingBody && confirmCandle.close < setupCandle.open) {
      isPiercingLine = true;
    }
  }

  let isBullishHarami = false;
  if (setupCandle) {
    const prevRange = setupCandle.high - setupCandle.low;
    const prevBody = setupCandle.open - setupCandle.close;
    const isPrevBearish = setupCandle.close < setupCandle.open && prevBody >= 0.30 * prevRange && prevBody >= 0.25 * currentAtr;
    const opensInsideMotherBody = confirmCandle.open >= setupCandle.close - 0.05 * currentAtr;
    const closesInsideMotherBody = confirmCandle.close <= setupCandle.open + 0.05 * currentAtr;
    const isInsideMotherRange = confirmCandle.high <= setupCandle.high + 0.05 * currentAtr && confirmCandle.low >= setupCandle.low - 0.05 * currentAtr;
    
    const hasMeaningfulBody = confirmBody >= 0.25 * currentAtr || (confirmRange > 0 && confirmBody >= 0.35 * confirmRange && confirmRange >= 0.30 * currentAtr);
    const hasRetracedMotherBar = confirmBody >= 0.25 * prevBody || confirmCandle.close >= setupCandle.close + (prevBody * 0.25);
    const hasPositiveDisplacement = isBullish && hasMeaningfulBody && hasRetracedMotherBar;

    if (isPrevBearish && isBullish && opensInsideMotherBody && closesInsideMotherBody && isInsideMotherRange && hasPositiveDisplacement) {
      isBullishHarami = true;
    }
  }

  let isPostDojiBreakout = false;
  if (candlestickEnhancements && allowDojiBreakout && setupCandle) {
    const setupRange = setupCandle.high - setupCandle.low;
    const setupBody = Math.abs(setupCandle.close - setupCandle.open);
    const setupIsDoji = setupRange > 0 && (setupBody / setupRange <= 0.22);

    if (setupIsDoji && isBullish && confirmCandle.close > setupCandle.high && (confirmBody >= 0.25 * currentAtr || hasStrongCsi)) {
      isPostDojiBreakout = true;
    }
  }

  let isMorningStar = false;
  if (closedIdx >= 2) {
    const c2 = candles1m[closedIdx - 2];
    const c1 = candles1m[closedIdx - 1];
    const c0 = confirmCandle;

    const r2 = c2.high - c2.low;
    const b2 = c2.open - c2.close;
    const isC2StrongBearish = c2.close < c2.open && b2 >= 0.3 * r2;

    const r1 = c1.high - c1.low;
    const b1 = Math.abs(c1.close - c1.open);
    const isC1Indecision = r1 > 0 && (b1 / r1 < 0.3);
    const isC1Low = c1.low <= Math.min(c2.low, c0.low) + 0.1 * currentAtr;

    const c0Body = c0.close - c0.open;
    const c0Range = c0.high - c0.low;
    const isC0BullishStarRetest = c0.close > c0.open && c0.close >= (c2.open + c2.close) / 2 && (c0Range > 0 && c0Body / c0Range >= 0.30);

    if (isC2StrongBearish && isC1Indecision && isC1Low && isC0BullishStarRetest) {
      isMorningStar = true;
    }
  }

  let isThreeWhiteSoldiers = false;
  if (closedIdx >= 2) {
    const c2 = candles1m[closedIdx - 2];
    const c1 = candles1m[closedIdx - 1];
    const c0 = confirmCandle;

    const c2Bullish = c2.close > c2.open;
    const c1Bullish = c1.close > c1.open;
    const c0Bullish = c0.close > c0.open;

    const ascendingCloses = c0.close > c1.close && c1.close > c2.close;
    
    const b2 = c2.close - c2.open;
    const b1 = c1.close - c1.open;
    const b0 = c0.close - c0.open;

    const c0UpperWick = c0.high - Math.max(c0.open, c0.close);
    const c0Range = c0.high - c0.low;
    const noUpperWickExhaustion = c0Range > 0 && (c0UpperWick / c0Range <= 0.35);

    const healthyBodies = b2 >= 0.2 * currentAtr && b1 >= 0.2 * currentAtr && b0 >= 0.2 * currentAtr;
    const isCurrentCandleHoldingHighs = currentPrice >= c0.low;

    if (c2Bullish && c1Bullish && c0Bullish && ascendingCloses && healthyBodies && noUpperWickExhaustion && isCurrentCandleHoldingHighs) {
      isThreeWhiteSoldiers = true;
    }
  }

  let isRisingThreeMethods = false;
  if (candlestickEnhancements && allowThreeMethods && closedIdx >= 3) {
    const testLengths = [3, 2];
    for (const restCount of testLengths) {
      if (closedIdx < restCount + 1) continue;
      const motherIdx = closedIdx - restCount - 1;
      const cMother = candles1m[motherIdx];
      const motherRange = cMother.high - cMother.low;
      const motherBody = cMother.close - cMother.open;
      const isMotherBullish = cMother.close > cMother.open && motherBody >= 0.35 * currentAtr && (motherRange > 0 && motherBody / motherRange >= 0.45);

      if (!isMotherBullish) continue;

      let restContained = true;
      let avgRestBody = 0;
      for (let i = 1; i <= restCount; i++) {
        const rCandle = candles1m[motherIdx + i];
        const rBody = Math.abs(rCandle.close - rCandle.open);
        avgRestBody += rBody;
        if (rCandle.low < cMother.low - 0.05 * currentAtr || rCandle.high > cMother.high + 0.15 * currentAtr) {
          restContained = false;
          break;
        }
      }
      avgRestBody /= restCount;

      const isBreakoutBar = isBullish && confirmCandle.close > cMother.close && confirmBody >= 0.28 * currentAtr;
      const restBarsConsolidated = avgRestBody <= 0.60 * motherBody;

      if (restContained && restBarsConsolidated && isBreakoutBar) {
        isRisingThreeMethods = true;
        break;
      }
    }
  }

  if (isClimaxExhausted && !isConfirmedBullishPinBar && !isConfirmedInvertedHammer && !isRisingThreeMethods) {
    return { confirmed: false, type: "Blocked: 1m Candle Climax Exhaustion (> 1.8 ATR blow-off)" };
  }

  const absorptionLong = detectOrderFlowAbsorption("LONG", candles1m, currentPrice, orderFlowStats, orderBookStats);
  if (absorptionLong.isAbsorption && isBullish && (confirmLowerWick / (confirmRange || 1) >= 0.25 || confirmBody >= 0.20 * currentAtr)) {
    return { confirmed: true, type: `${absorptionLong.type} with Green Reversal Close` };
  }
  const isEarlyWickAbsorption = isBullish && confirmRange > 0 && (confirmLowerWick / confirmRange >= 0.38) && confirmBody >= 0.20 * confirmRange;
  if (isEarlyWickAbsorption) {
    return { confirmed: true, type: "Early Lower Wick Absorption Support Rejection" };
  }

  if (isRisingThreeMethods) return { confirmed: true, type: "Rising Three Methods Continuation Pattern" };
  if (isConfirmedBullishPinBar) return { confirmed: true, type: "2-Candle Confirmed Bullish Pin Bar" };
  if (isConfirmedInvertedHammer) return { confirmed: true, type: "2-Candle Confirmed Inverted Hammer Reversal" };
  if (isConfirmedMajorWickRejection) return { confirmed: true, type: "2-Candle Confirmed 65%+ Lower Wick Rejection" };
  if (isPostDojiBreakout) return { confirmed: true, type: "Post-Doji Bullish Breakout Confirmation" };
  if (isBullishEngulfing) return { confirmed: true, type: "Bullish Engulfing Pattern" };
  if (hasMultiWickRejection && isBullish) return { confirmed: !isIndecision, type: "Multi-Candle Wick Rejection" };
  if (isTweezerBottom && isBullish) return { confirmed: true, type: "Tweezer Bottom Reversal Pattern" };
  if (isPiercingLine) return { confirmed: true, type: "Piercing Line Reversal Pattern" };
  if (isBullishHarami) return { confirmed: !isIndecision, type: "Bullish Harami Reversal Pattern" };
  if (isMorningStar) return { confirmed: true, type: "Morning Star Reversal Pattern" };
  if (isThreeWhiteSoldiers) return { confirmed: true, type: "Three White Soldiers Continuation Pattern" };
  if (isMomentumCandle && (hasStrongCsi || hasStrongClose) && isBullish) return { confirmed: !isIndecision, type: `Bullish Momentum (CSI ${(bullishCsi * 100).toFixed(0)}%)` };
  if (hasStrongClose && isBullish && confirmLowerWick > confirmUpperWick) return { confirmed: !isIndecision, type: "Strong Close Support Rejection" };

  const relVolumeLong = indicators.calculateAccurateRelativeVolume(candles1m);
  const hasVolumeOrFlowConfirmationLong = relVolumeLong >= 1.15 || (orderFlowStats && orderFlowStats.takerBuyRatio >= 0.55);
  if (!requirePinBarConfirmation || hasVolumeOrFlowConfirmationLong) {
    if (isPinBar && hasStrongClose && isBullish) return { confirmed: !isIndecision, type: `Bullish Pin Bar (${hasVolumeOrFlowConfirmationLong ? "Volume/Flow Confirmed" : "1-Candle"})` };
    if (isMajorWickRejection && isBullish && hasStrongClose) return { confirmed: true, type: `65%+ Wick-to-Range Lower Rejection (${hasVolumeOrFlowConfirmationLong ? "Volume/Flow Confirmed" : "1-Candle"})` };
  }

  return { confirmed: false, type: "" };
}

export function isMultiCandleShortRejection(
  candles1m: Candlestick[],
  lastIdx: number,
  currentPrice: number,
  currentAtr: number,
  orderFlowStats: OrderFlowStats,
  orderBookStats: OrderBookStats,
  config: StrategyConfig,
  indicators: IndicatorCalculator
): RejectionResult {
  if (lastIdx < 0 || candles1m.length === 0) return { confirmed: false, type: "" };
  const ms = config.market_structure;
  const requirePinBarConfirmation = ms.pinbar_two_candle_confirmation_enabled !== false;
  const minWickRatio = ms.pinbar_min_wick_ratio || 0.50;

  const candlestickEnhancements = ms.candlestick_enhancements_enabled !== false;
  const minCsi = ms.csi_min_threshold !== undefined ? ms.csi_min_threshold : 0.50;
  const maxAtrMult = ms.max_confirmation_candle_atr !== undefined ? ms.max_confirmation_candle_atr : 1.8;
  const allowThreeMethods = ms.rising_falling_three_methods_enabled !== false;
  const allowHangingMan = ms.inverted_hammer_hanging_man_enabled !== false;
  const allowDojiBreakout = ms.doji_breakout_confirmation_enabled !== false;

  const closedIdx = (lastIdx === candles1m.length - 1 && candles1m.length >= 2) ? lastIdx - 1 : lastIdx;
  if (closedIdx < 0) return { confirmed: false, type: "" };

  const confirmCandle = candles1m[closedIdx];
  const confirmRange = confirmCandle.high - confirmCandle.low;
  const confirmBody = Math.abs(confirmCandle.close - confirmCandle.open);
  const confirmUpperWick = confirmCandle.high - Math.max(confirmCandle.close, confirmCandle.open);
  const confirmLowerWick = Math.min(confirmCandle.close, confirmCandle.open) - confirmCandle.low;
  const isBearish = confirmCandle.close < confirmCandle.open;
  const setupCandle = closedIdx >= 1 ? candles1m[closedIdx - 1] : null;

  const isClimaxExhausted = candlestickEnhancements && confirmRange > maxAtrMult * currentAtr;

  const bearishCloseProximity = confirmRange > 0 ? (confirmCandle.high - confirmCandle.close) / confirmRange : 0;
  const bearishBodyRatio = confirmRange > 0 ? confirmBody / confirmRange : 0;
  const bearishCsi = confirmRange > 0 ? Number((bearishCloseProximity * bearishBodyRatio).toFixed(4)) : 0;
  const hasStrongCsi = isBearish && bearishCsi >= minCsi && (confirmLowerWick <= 0.25 * confirmRange);

  const isPinBar = confirmRange > 0 && confirmUpperWick >= minWickRatio * confirmRange && confirmLowerWick <= 0.25 * confirmRange;
  const isMajorWickRejection = confirmRange > 0 && confirmUpperWick >= 0.65 * confirmRange;
  const hasStrongClose = confirmRange > 0 && (confirmCandle.high - confirmCandle.close) / confirmRange >= 0.70;
  const isMomentumCandle = isBearish && confirmBody >= 0.65 * currentAtr && (candlestickEnhancements ? hasStrongCsi : true);
  const isIndecision = confirmRange > 0 && 
    ((confirmBody / confirmRange < 0.18) || (confirmBody / confirmRange < 0.30 && confirmRange < 0.25 * currentAtr)) && 
    !isPinBar && !isMajorWickRejection;

  let isConfirmedBearishPinBar = false;
  let isConfirmedMajorWickRejection = false;
  if (setupCandle) {
    const setupRange = setupCandle.high - setupCandle.low;
    const setupUpperWick = setupCandle.high - Math.max(setupCandle.open, setupCandle.close);
    const setupLowerWick = Math.min(setupCandle.open, setupCandle.close) - setupCandle.low;
    const setupIsPinBar = setupRange > 0 && setupUpperWick >= minWickRatio * setupRange && setupLowerWick <= 0.30 * setupRange;
    const setupIsMajorWick = setupRange > 0 && setupUpperWick >= 0.65 * setupRange;

    const isConfirmRed = confirmCandle.close < confirmCandle.open;
    const redBody = confirmCandle.open - confirmCandle.close;
    const hasVerifiedBodyExpansion = confirmRange > 0 && ((redBody / confirmRange >= 0.35) || (redBody >= 0.25 * currentAtr)) && (redBody / (confirmRange || 1) >= 0.20);
    const holdsPinHigh = confirmCandle.high <= setupCandle.high + 0.05 * currentAtr;
    const breaksPinLower = confirmCandle.close <= (setupCandle.high - setupRange * 0.50) || confirmCandle.close <= setupCandle.low;
    const hasDownwardFollowThrough = confirmCandle.close < setupCandle.close;

    if (setupIsPinBar && isConfirmRed && hasVerifiedBodyExpansion && holdsPinHigh && (breaksPinLower || hasDownwardFollowThrough)) {
      isConfirmedBearishPinBar = true;
    }
    if (setupIsMajorWick && isConfirmRed && hasVerifiedBodyExpansion && holdsPinHigh && (breaksPinLower || hasDownwardFollowThrough)) {
      isConfirmedMajorWickRejection = true;
    }
  }

  let isConfirmedHangingMan = false;
  if (candlestickEnhancements && allowHangingMan && setupCandle) {
    const setupRange = setupCandle.high - setupCandle.low;
    const setupBody = Math.abs(setupCandle.close - setupCandle.open);
    const setupLowerWick = Math.min(setupCandle.open, setupCandle.close) - setupCandle.low;
    const setupUpperWick = setupCandle.high - Math.max(setupCandle.open, setupCandle.close);

    const setupIsHangingMan = setupRange > 0 &&
      setupLowerWick >= 0.45 * setupRange &&
      setupLowerWick >= 1.8 * Math.max(setupBody, 0.01 * currentAtr) &&
      setupUpperWick <= 0.25 * setupRange &&
      (setupCandle.high - Math.min(setupCandle.open, setupCandle.close)) <= 0.45 * setupRange;

    const isConfirmRed = confirmCandle.close < confirmCandle.open;
    const holdsHangHigh = confirmCandle.high <= setupCandle.high + 0.05 * currentAtr;
    const breaksHangBody = confirmCandle.close < Math.min(setupCandle.open, setupCandle.close);
    const hasExpansion = confirmBody >= 0.22 * currentAtr || (confirmRange > 0 && confirmBody >= 0.30 * confirmRange);

    if (setupIsHangingMan && isConfirmRed && holdsHangHigh && breaksHangBody && hasExpansion) {
      isConfirmedHangingMan = true;
    }
  }

  const minEngulfBody = Math.max(0.35 * currentAtr, 0.35 * confirmRange);
  const prevBody = setupCandle ? Math.abs(setupCandle.close - setupCandle.open) : 0;
  const isBearishEngulfing = setupCandle && 
    (setupCandle.close > setupCandle.open) && 
    isBearish && 
    (confirmCandle.close <= setupCandle.open) && 
    (confirmCandle.open >= setupCandle.close - 0.08 * currentAtr) &&
    (confirmBody >= minEngulfBody) &&
    (prevBody >= 0.12 * currentAtr || (setupCandle.high - setupCandle.low) >= 0.25 * currentAtr);

  const hasMultiWickRejection = setupCandle && 
    (confirmUpperWick >= 0.35 * confirmRange) && 
    ((setupCandle.high - Math.max(setupCandle.close, setupCandle.open)) >= 0.35 * (setupCandle.high - setupCandle.low)) && 
    Math.abs(confirmCandle.high - setupCandle.high) < 0.15 * currentAtr;

  let isTweezerTop = false;
  if (setupCandle) {
    const prevRange = setupCandle.high - setupCandle.low;
    const prevUpperWick = setupCandle.high - Math.max(setupCandle.open, setupCandle.close);
    const matchingHighs = Math.abs(confirmCandle.high - setupCandle.high) < 0.05 * currentAtr;
    const currentHasUpperWick = confirmRange > 0 && confirmUpperWick >= 0.25 * confirmRange;
    const prevHasUpperWick = prevRange > 0 && prevUpperWick >= 0.25 * prevRange;
    const hasNegativeClose = isBearish && (confirmBody >= 0.20 * confirmRange || confirmBody >= 0.20 * currentAtr);
    if (matchingHighs && currentHasUpperWick && prevHasUpperWick && (hasNegativeClose || hasStrongClose)) {
      isTweezerTop = true;
    }
  }

  let isDarkCloudCover = false;
  if (setupCandle) {
    const prevRange = setupCandle.high - setupCandle.low;
    const prevBody = setupCandle.close - setupCandle.open;
    const isPrevStrongBullish = setupCandle.close > setupCandle.open && prevBody >= 0.3 * prevRange;
    const opensAbovePrevClose = confirmCandle.open > setupCandle.close - 0.05 * currentAtr;
    const closesBelowMidpoint = confirmCandle.close <= (setupCandle.open + setupCandle.close) / 2;
    const hasDarkCloudBody = isBearish && confirmBody >= 0.25 * confirmRange && confirmBody >= 0.20 * currentAtr;
    if (isPrevStrongBullish && opensAbovePrevClose && closesBelowMidpoint && hasDarkCloudBody && confirmCandle.close > setupCandle.open) {
      isDarkCloudCover = true;
    }
  }

  let isBearishHarami = false;
  if (setupCandle) {
    const prevRange = setupCandle.high - setupCandle.low;
    const prevBody = setupCandle.close - setupCandle.open;
    const isPrevBullish = setupCandle.close > setupCandle.open && prevBody >= 0.30 * prevRange && prevBody >= 0.25 * currentAtr;
    const opensInsideMotherBody = confirmCandle.open <= setupCandle.close + 0.05 * currentAtr;
    const closesInsideMotherBody = confirmCandle.close >= setupCandle.open - 0.05 * currentAtr;
    const isInsideMotherRange = confirmCandle.high <= setupCandle.high + 0.05 * currentAtr && confirmCandle.low >= setupCandle.low - 0.05 * currentAtr;
    
    const hasMeaningfulBody = confirmBody >= 0.25 * currentAtr || (confirmRange > 0 && confirmBody >= 0.35 * confirmRange && confirmRange >= 0.30 * currentAtr);
    const hasRetracedMotherBar = confirmBody >= 0.25 * prevBody || confirmCandle.close <= setupCandle.close - (prevBody * 0.25);
    const hasNegativeDisplacement = isBearish && hasMeaningfulBody && hasRetracedMotherBar;

    if (isPrevBullish && isBearish && opensInsideMotherBody && closesInsideMotherBody && isInsideMotherRange && hasNegativeDisplacement) {
      isBearishHarami = true;
    }
  }

  let isPostDojiBreakdown = false;
  if (candlestickEnhancements && allowDojiBreakout && setupCandle) {
    const setupRange = setupCandle.high - setupCandle.low;
    const setupBody = Math.abs(setupCandle.close - setupCandle.open);
    const setupIsDoji = setupRange > 0 && (setupBody / setupRange <= 0.22);

    if (setupIsDoji && isBearish && confirmCandle.close < setupCandle.low && (confirmBody >= 0.25 * currentAtr || hasStrongCsi)) {
      isPostDojiBreakdown = true;
    }
  }

  let isEveningStar = false;
  if (closedIdx >= 2) {
    const c2 = candles1m[closedIdx - 2];
    const c1 = candles1m[closedIdx - 1];
    const c0 = confirmCandle;

    const r2 = c2.high - c2.low;
    const b2 = c2.close - c2.open;
    const isC2StrongBullish = c2.close > c2.open && b2 >= 0.3 * r2;

    const r1 = c1.high - c1.low;
    const b1 = Math.abs(c1.close - c1.open);
    const isC1Indecision = r1 > 0 && (b1 / r1 < 0.3);
    const isC1High = c1.high >= Math.max(c2.high, c0.high) - 0.1 * currentAtr;

    const c0Body = c0.open - c0.close;
    const c0Range = c0.high - c0.low;
    const isC0BearishStarRetest = c0.close < c0.open && c0.close <= (c2.open + c2.close) / 2 && (c0Range > 0 && c0Body / c0Range >= 0.30);

    if (isC2StrongBullish && isC1Indecision && isC1High && isC0BearishStarRetest) {
      isEveningStar = true;
    }
  }

  let isThreeBlackCrows = false;
  if (closedIdx >= 2) {
    const c2 = candles1m[closedIdx - 2];
    const c1 = candles1m[closedIdx - 1];
    const c0 = confirmCandle;

    const c2Bearish = c2.close < c2.open;
    const c1Bearish = c1.close < c1.open;
    const c0Bearish = c0.close < c0.open;

    const descendingCloses = c0.close < c1.close && c1.close < c2.close;

    const b2 = c2.open - c2.close;
    const b1 = c1.open - c1.close;
    const b0 = c0.open - c0.close;

    const c0LowerWick = Math.min(c0.open, c0.close) - c0.low;
    const c0Range = c0.high - c0.low;
    const noLowerWickExhaustion = c0Range > 0 && (c0LowerWick / c0Range <= 0.35);

    const healthyBodies = b2 >= 0.2 * currentAtr && b1 >= 0.2 * currentAtr && b0 >= 0.2 * currentAtr;
    const isCurrentCandleHoldingLows = currentPrice <= c0.high;

    if (c2Bearish && c1Bearish && c0Bearish && descendingCloses && healthyBodies && noLowerWickExhaustion && isCurrentCandleHoldingLows) {
      isThreeBlackCrows = true;
    }
  }

  let isFallingThreeMethods = false;
  if (candlestickEnhancements && allowThreeMethods && closedIdx >= 3) {
    const testLengths = [3, 2];
    for (const restCount of testLengths) {
      if (closedIdx < restCount + 1) continue;
      const motherIdx = closedIdx - restCount - 1;
      const cMother = candles1m[motherIdx];
      const motherRange = cMother.high - cMother.low;
      const motherBody = cMother.open - cMother.close;
      const isMotherBearish = cMother.close < cMother.open && motherBody >= 0.35 * currentAtr && (motherRange > 0 && motherBody / motherRange >= 0.45);

      if (!isMotherBearish) continue;

      let restContained = true;
      let avgRestBody = 0;
      for (let i = 1; i <= restCount; i++) {
        const rCandle = candles1m[motherIdx + i];
        const rBody = Math.abs(rCandle.close - rCandle.open);
        avgRestBody += rBody;
        if (rCandle.high > cMother.high + 0.05 * currentAtr || rCandle.low < cMother.low - 0.15 * currentAtr) {
          restContained = false;
          break;
        }
      }
      avgRestBody /= restCount;

      const isBreakoutBar = isBearish && confirmCandle.close < cMother.close && confirmBody >= 0.28 * currentAtr;
      const restBarsConsolidated = avgRestBody <= 0.60 * motherBody;

      if (restContained && restBarsConsolidated && isBreakoutBar) {
        isFallingThreeMethods = true;
        break;
      }
    }
  }

  if (isClimaxExhausted && !isConfirmedBearishPinBar && !isConfirmedHangingMan && !isFallingThreeMethods) {
    return { confirmed: false, type: "Blocked: 1m Candle Climax Exhaustion (> 1.8 ATR blow-off)" };
  }

  const absorptionShort = detectOrderFlowAbsorption("SHORT", candles1m, currentPrice, orderFlowStats, orderBookStats);
  if (absorptionShort.isAbsorption && isBearish && (confirmUpperWick / (confirmRange || 1) >= 0.25 || confirmBody >= 0.20 * currentAtr)) {
    return { confirmed: true, type: `${absorptionShort.type} with Red Reversal Close` };
  }
  const isEarlyWickAbsorptionShort = isBearish && confirmRange > 0 && (confirmUpperWick / confirmRange >= 0.38) && confirmBody >= 0.20 * confirmRange;
  if (isEarlyWickAbsorptionShort) {
    return { confirmed: true, type: "Early Upper Wick Absorption Resistance Rejection" };
  }

  if (isFallingThreeMethods) return { confirmed: true, type: "Falling Three Methods Continuation Pattern" };
  if (isConfirmedBearishPinBar) return { confirmed: true, type: "2-Candle Confirmed Bearish Pin Bar" };
  if (isConfirmedHangingMan) return { confirmed: true, type: "2-Candle Confirmed Hanging Man Reversal" };
  if (isConfirmedMajorWickRejection) return { confirmed: true, type: "2-Candle Confirmed 65%+ Upper Wick Rejection" };
  if (isPostDojiBreakdown) return { confirmed: true, type: "Post-Doji Bearish Breakdown Confirmation" };
  if (isBearishEngulfing) return { confirmed: true, type: "Bearish Engulfing Pattern" };
  if (hasMultiWickRejection && isBearish) return { confirmed: !isIndecision, type: "Multi-Candle Wick Rejection" };
  if (isTweezerTop && isBearish) return { confirmed: true, type: "Tweezer Top Reversal Pattern" };
  if (isDarkCloudCover) return { confirmed: true, type: "Dark Cloud Cover Reversal Pattern" };
  if (isBearishHarami) return { confirmed: !isIndecision, type: "Bearish Harami Reversal Pattern" };
  if (isEveningStar) return { confirmed: true, type: "Evening Star Reversal Pattern" };
  if (isThreeBlackCrows) return { confirmed: true, type: "Three Black Crows Continuation Pattern" };
  if (isMomentumCandle && (hasStrongCsi || hasStrongClose) && isBearish) return { confirmed: !isIndecision, type: `Bearish Momentum (CSI ${(bearishCsi * 100).toFixed(0)}%)` };
  if (hasStrongClose && isBearish && confirmUpperWick > confirmLowerWick) return { confirmed: !isIndecision, type: "Strong Close Resistance Rejection" };

  const relVolumeShort = indicators.calculateAccurateRelativeVolume(candles1m);
  const hasVolumeOrFlowConfirmationShort = relVolumeShort >= 1.15 || (orderFlowStats && orderFlowStats.takerBuyRatio <= 0.45);
  if (!requirePinBarConfirmation || hasVolumeOrFlowConfirmationShort) {
    if (isPinBar && hasStrongClose && isBearish) return { confirmed: !isIndecision, type: `Bearish Pin Bar (${hasVolumeOrFlowConfirmationShort ? "Volume/Flow Confirmed" : "1-Candle"})` };
    if (isMajorWickRejection && isBearish && hasStrongClose) return { confirmed: true, type: `65%+ Wick-to-Range Upper Rejection (${hasVolumeOrFlowConfirmationShort ? "Volume/Flow Confirmed" : "1-Candle"})` };
  }

  return { confirmed: false, type: "" };
}
