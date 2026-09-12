/**
 * Market Structure & Regime Engine
 * Evaluates swing highs/lows, higher-highs/higher-lows (HH/HL) fractals,
 * pullbacks, and macro/micro regime detection.
 */

import { Candlestick, MarketRegime } from "../types.js";
import { IndicatorCalculator } from "./indicators.js";

export interface SwingPoint {
  price: number;
  index: number;
  time?: number;
}

export interface TrendMarketStructure {
  current_HH: SwingPoint | null;
  prev_HH: SwingPoint | null;
  current_HL: SwingPoint | null;
  prev_HL: SwingPoint | null;
  current_LH: SwingPoint | null;
  prev_LH: SwingPoint | null;
  current_LL: SwingPoint | null;
  prev_LL: SwingPoint | null;
  isLongStructureConfirmed: boolean;
  isShortStructureConfirmed: boolean;
  pullbackLongMet: boolean;
  pullbackShortMet: boolean;
  swingHigh: number;
  swingLow: number;
}

export interface MarketRegimeResult {
  regime: MarketRegime;
  confidence: number;
}

export class StructureEngine {
  private structureCache = new Map<string, TrendMarketStructure>();

  public clearCache() {
    this.structureCache.clear();
  }

  public getTrendMarketStructure(
    candles1m: Candlestick[],
    currentRegime: MarketRegime,
    msConfig: any,
    indicators: IndicatorCalculator
  ): TrendMarketStructure {
    if (candles1m.length === 0) {
      return {
        current_HH: null, prev_HH: null, current_HL: null, prev_HL: null,
        current_LH: null, prev_LH: null, current_LL: null, prev_LL: null,
        isLongStructureConfirmed: false, isShortStructureConfirmed: false,
        pullbackLongMet: false, pullbackShortMet: false,
        swingHigh: 100000, swingLow: 100000
      };
    }

    const timeframeMinutes = msConfig?.timeframe_minutes !== undefined ? msConfig.timeframe_minutes : 5;

    let candles = indicators.aggregateCandles(candles1m, timeframeMinutes);
    if (candles.length < 35 && timeframeMinutes > 1) {
      candles = indicators.aggregateCandles(candles1m, 3);
      if (candles.length < 35) {
        candles = candles1m;
      }
    }

    const last = candles1m[candles1m.length - 1];
    const cacheKey = `${candles1m.length}_${last.time}_${last.close}_${currentRegime}_${timeframeMinutes}`;
    if (this.structureCache.has(cacheKey)) {
      return this.structureCache.get(cacheKey)!;
    }
    if (this.structureCache.size > 200) {
      this.structureCache.clear();
    }

    const closes = candles.map(c => c.close);
    const highs = candles.map(c => c.high);
    const lows = candles.map(c => c.low);
    const lastIdx = closes.length - 1;

    if (closes.length < 30) {
      const defaultStruct: TrendMarketStructure = {
        current_HH: null, prev_HH: null, current_HL: null, prev_HL: null,
        current_LH: null, prev_LH: null, current_LL: null, prev_LL: null,
        isLongStructureConfirmed: false, isShortStructureConfirmed: false,
        pullbackLongMet: false, pullbackShortMet: false,
        swingHigh: highs[lastIdx] || 100000, swingLow: lows[lastIdx] || 100000
      };
      this.structureCache.set(cacheKey, defaultStruct);
      return defaultStruct;
    }

    let windowSize = 5;
    if (currentRegime === MarketRegime.STRONG_UPTREND || currentRegime === MarketRegime.STRONG_DOWNTREND) {
      windowSize = 9;
    } else if (currentRegime === MarketRegime.HIGH_VOLATILITY) {
      windowSize = 7;
    }
    const halfWindow = Math.floor(windowSize / 2);

    const rawHighs: { index: number; price: number; time: number }[] = [];
    const rawLows: { index: number; price: number; time: number }[] = [];

    for (let i = halfWindow; i <= lastIdx - halfWindow; i++) {
      let isSwingHigh = true;
      let isSwingLow = true;
      for (let j = 1; j <= halfWindow; j++) {
        if (highs[i] < highs[i - j] || highs[i] < highs[i + j]) {
          isSwingHigh = false;
        }
        if (lows[i] > lows[i - j] || lows[i] > lows[i + j]) {
          isSwingLow = false;
        }
      }

      if (isSwingHigh) {
        rawHighs.push({ index: i, price: highs[i], time: candles[i].time });
      }
      if (isSwingLow) {
        rawLows.push({ index: i, price: lows[i], time: candles[i].time });
      }
    }

    const current_HH = rawHighs.length > 0 ? rawHighs[rawHighs.length - 1] : null;
    const prev_HH = rawHighs.length > 1 ? rawHighs[rawHighs.length - 2] : null;

    const current_HL = rawLows.length > 0 ? rawLows[rawLows.length - 1] : null;
    const prev_HL = rawLows.length > 1 ? rawLows[rawLows.length - 2] : null;

    const current_LH = current_HH;
    const prev_LH = prev_HH;

    const current_LL = current_HL;
    const prev_LL = prev_HL;

    const isLongStructureConfirmed =
      current_HH !== null &&
      prev_HH !== null &&
      current_HL !== null &&
      prev_HL !== null &&
      current_HH.price > prev_HH.price &&
      current_HL.price > prev_HL.price;

    const isShortStructureConfirmed =
      current_HH !== null &&
      prev_HH !== null &&
      current_HL !== null &&
      prev_HL !== null &&
      current_HH.price < prev_HH.price &&
      current_HL.price < prev_HL.price;

    let pullbackLongMet = false;
    let pullbackShortMet = false;

    const ema20 = indicators.calculateEMA(closes, 20);
    const ema20Val = ema20[lastIdx] || closes[lastIdx];

    if (current_HH && current_HL) {
      const fib38 = current_HH.price - 0.382 * (current_HH.price - current_HL.price);
      const startIndex = Math.max(current_HH.index, lastIdx - 12);
      const candlesAfterHH = candles.slice(startIndex);
      for (const candle of candlesAfterHH) {
        if (
          candle.low <= ema20Val ||
          (prev_HH && candle.low <= prev_HH.price) ||
          candle.low <= fib38
        ) {
          pullbackLongMet = true;
          break;
        }
      }
    }

    if (current_LL && current_LH) {
      const fib38 = current_LL.price + 0.382 * (current_LH.price - current_LL.price);
      const startIndex = Math.max(current_LL.index, lastIdx - 12);
      const candlesAfterLL = candles.slice(startIndex);
      for (const candle of candlesAfterLL) {
        if (
          candle.high >= ema20Val ||
          (prev_LL && candle.high >= prev_LL.price) ||
          candle.high >= fib38
        ) {
          pullbackShortMet = true;
          break;
        }
      }
    }

    const swingHigh = rawHighs.length > 0 ? rawHighs[rawHighs.length - 1].price : highs[lastIdx];
    const swingLow = rawLows.length > 0 ? rawLows[rawLows.length - 1].price : lows[lastIdx];

    const result: TrendMarketStructure = {
      current_HH,
      prev_HH,
      current_HL,
      prev_HL,
      current_LH,
      prev_LH,
      current_LL,
      prev_LL,
      isLongStructureConfirmed,
      isShortStructureConfirmed,
      pullbackLongMet,
      pullbackShortMet,
      swingHigh,
      swingLow
    };
    this.structureCache.set(cacheKey, result);
    return result;
  }

  public detectMarketRegime(
    candles1m: Candlestick[],
    currentRegime: MarketRegime,
    generalConfig: any,
    indicators: IndicatorCalculator
  ): MarketRegimeResult | null {
    const adxThreshold = generalConfig?.adx_threshold !== undefined ? generalConfig.adx_threshold : 22.0;
    let intervalMinutes = generalConfig?.regime_candle_interval_minutes || 3;

    let candles = indicators.aggregateCandles(candles1m, intervalMinutes);
    if (candles.length < 50 && intervalMinutes > 1) {
      intervalMinutes = 1;
      candles = candles1m;
    }

    const closes = candles.map((c) => c.close);
    if (closes.length < 50) return null;

    const ema9 = indicators.calculateEMA(closes, 9);
    const ema21 = indicators.calculateEMA(closes, 21);
    const ema50 = indicators.calculateEMA(closes, 50);
    const atr14 = indicators.calculateATR(candles, 14);
    const adx14 = indicators.calculateADX(candles, 14);

    const lastIdx = closes.length - 1;
    const currentClose = closes[lastIdx];
    const currentAtr = atr14[lastIdx] || 50;
    const currentAdx = adx14[lastIdx] || 25;

    let sumAtrLong = 0;
    const lookback = Math.min(closes.length, 50);
    for (let i = lastIdx - lookback + 1; i <= lastIdx; i++) {
      sumAtrLong += atr14[i] || 50;
    }
    const longTermAtr = sumAtrLong / lookback;
    const atrExpansionRatio = currentAtr / longTermAtr;

    const isBullAligned = ema9[lastIdx] > ema21[lastIdx] && ema21[lastIdx] > ema50[lastIdx];
    const isBearAligned = ema9[lastIdx] < ema21[lastIdx] && ema21[lastIdx] < ema50[lastIdx];

    const ema100 = indicators.calculateEMA(closes, Math.min(closes.length, 100));
    const ema100Val = (ema100.length > lastIdx && ema100[lastIdx] !== undefined) ? ema100[lastIdx] : ema50[lastIdx];

    const isBullAlignedFull = isBullAligned && (ema50[lastIdx] > ema100Val);
    const isBearAlignedFull = isBearAligned && (ema50[lastIdx] < ema100Val);

    const ema9Val = ema9[lastIdx];
    const ema21Val = ema21[lastIdx];
    const ema50Val = ema50[lastIdx];
    const spread21to50Percent = Math.abs(ema21Val - ema50Val) / ema50Val;

    const slopeLookback = generalConfig?.regime_macro_slope_lookback !== undefined ? generalConfig.regime_macro_slope_lookback : 5;
    const slopeThreshold = generalConfig?.regime_macro_slope_threshold !== undefined ? generalConfig.regime_macro_slope_threshold : 0.0005;
    const slopeEma = (ema100.length > lastIdx && ema100[lastIdx] !== undefined) ? ema100 : ema50;
    const prevIdx = Math.max(0, lastIdx - slopeLookback);
    const currentEmaVal = slopeEma[lastIdx];
    const prevEmaVal = slopeEma[prevIdx];
    const macroSlope = prevEmaVal !== 0 ? Math.abs(currentEmaVal - prevEmaVal) / prevEmaVal : 0;
    const isSlopeFlat = macroSlope < slopeThreshold;

    const compressionThreshold = generalConfig?.regime_ribbon_compression_threshold !== undefined ? generalConfig.regime_ribbon_compression_threshold : 0.0015;
    const emaMean = (ema9Val + ema21Val + ema50Val) / 3;
    const emaVariance = (
      Math.pow(ema9Val - emaMean, 2) +
      Math.pow(ema21Val - emaMean, 2) +
      Math.pow(ema50Val - emaMean, 2)
    ) / 3;
    const emaStdDev = Math.sqrt(emaVariance);
    const normalizedSpread = emaStdDev / currentClose;
    const isRibbonCompressed = normalizedSpread < compressionThreshold;

    let upwardCount = 0;
    let downwardCount = 0;
    for (let i = lastIdx - 14; i <= lastIdx; i++) {
      if (closes[i] > closes[i - 1]) upwardCount++;
      else downwardCount++;
    }
    const trendStrength = Math.abs(upwardCount - downwardCount) / 15;

    const isStrongUptrend = isBullAligned && (
      currentAdx > adxThreshold ||
      trendStrength > 0.4 ||
      (isBullAlignedFull && (currentAdx > 15.0 || trendStrength > 0.25 || spread21to50Percent > 0.0005))
    );

    const isStrongDowntrend = isBearAligned && (
      currentAdx > adxThreshold ||
      trendStrength > 0.4 ||
      (isBearAlignedFull && (currentAdx > 15.0 || trendStrength > 0.25 || spread21to50Percent > 0.0005))
    );

    let regime = MarketRegime.RANGE_BOUND;
    let confidence = 0.5;

    if (atrExpansionRatio < 0.6) {
      regime = MarketRegime.LOW_VOLATILITY;
      confidence = 0.65 + (0.6 - atrExpansionRatio) * 0.5;
    } else if (atrExpansionRatio > 1.5) {
      regime = MarketRegime.HIGH_VOLATILITY;
      confidence = 0.7 + (atrExpansionRatio - 1.5) * 0.2;
    } else if (isSlopeFlat && isRibbonCompressed) {
      regime = MarketRegime.RANGE_BOUND;
      confidence = 0.8 + (1 - normalizedSpread / compressionThreshold) * 0.15;
    } else if (isStrongUptrend) {
      regime = MarketRegime.STRONG_UPTREND;
      confidence = 0.6 + (currentAdx / 100) * 0.35;
    } else if (isStrongDowntrend) {
      regime = MarketRegime.STRONG_DOWNTREND;
      confidence = 0.6 + (currentAdx / 100) * 0.35;
    } else {
      regime = MarketRegime.RANGE_BOUND;
      confidence = 0.5 + (1 - (currentAdx / 100)) * 0.3;
    }

    if (candles1m.length >= 25 && regime !== MarketRegime.HIGH_VOLATILITY) {
      const c1m = candles1m;
      const l1m = c1m.length - 1;
      const closes1m = c1m.map(c => c.close);
      const ema9List1m = indicators.calculateEMA(closes1m, 9);
      const ema21List1m = indicators.calculateEMA(closes1m, 21);
      const ema50List1m = indicators.calculateEMA(closes1m, 50);
      const ema9_1m = ema9List1m[l1m];
      const ema21_1m = ema21List1m[l1m];
      const ema50_1m = ema50List1m[l1m];
      const adx1mList = indicators.calculateADX(c1m, 14);
      const adx1m = adx1mList[l1m] || 20;

      const is1mBearWaterfall = (ema9_1m < ema21_1m && ema21_1m < ema50_1m && adx1m >= 24.0 && closes1m[l1m] < ema50_1m);
      const is1mBullRocket = (ema9_1m > ema21_1m && ema21_1m > ema50_1m && adx1m >= 24.0 && closes1m[l1m] > ema50_1m);

      if (is1mBearWaterfall) {
        regime = MarketRegime.STRONG_DOWNTREND;
        confidence = Math.max(confidence, 0.75 + (adx1m / 100) * 0.2);
      } else if (is1mBullRocket) {
        regime = MarketRegime.STRONG_UPTREND;
        confidence = Math.max(confidence, 0.75 + (adx1m / 100) * 0.2);
      }
    }

    confidence = Math.min(confidence, 0.99);

    return { regime, confidence };
  }

  public detectEqualHighsLows(
    candles1m: Candlestick[],
    ms: any = {},
    indicators: IndicatorCalculator
  ): {
    eqhLevels: { price: number; touchCount: number; touches?: { price: number; idx: number; volume: number; rsi?: number }[] }[];
    eqlLevels: { price: number; touchCount: number; touches?: { price: number; idx: number; volume: number; rsi?: number }[] }[];
  } {
    const tolerancePct = ms.eqh_eql_tolerance_pct || 0.08;
    if (ms.eqh_eql_detection_enabled === false || candles1m.length < 30) {
      return { eqhLevels: [], eqlLevels: [] };
    }

    const lookback = Math.min(100, candles1m.length);
    const recent = candles1m.slice(-lookback);
    const rsi14 = indicators.calculateRSI(candles1m.map(c => c.close), 14);

    const highs: { price: number; idx: number; volume: number; rsi?: number }[] = [];
    const lows: { price: number; idx: number; volume: number; rsi?: number }[] = [];
    for (let i = 1; i < recent.length - 1; i++) {
      const globalIdx = candles1m.length - lookback + i;
      if (recent[i].high >= recent[i - 1].high && recent[i].high >= recent[i + 1].high) {
        highs.push({ price: recent[i].high, idx: globalIdx, volume: recent[i].volume, rsi: rsi14[globalIdx] });
      }
      if (recent[i].low <= recent[i - 1].low && recent[i].low <= recent[i + 1].low) {
        lows.push({ price: recent[i].low, idx: globalIdx, volume: recent[i].volume, rsi: rsi14[globalIdx] });
      }
    }

    const minBarSeparation = ms.eqh_eql_min_bar_separation || 3;

    const eqhLevels: { price: number; touchCount: number; touches: { price: number; idx: number; volume: number; rsi?: number }[] }[] = [];
    for (const h of highs) {
      let matched = false;
      for (const eqh of eqhLevels) {
        if (Math.abs(h.price - eqh.price) / eqh.price * 100 <= tolerancePct) {
          const lastTouch = eqh.touches[eqh.touches.length - 1];
          if (lastTouch && (h.idx - lastTouch.idx < minBarSeparation)) {
            if (h.price > lastTouch.price) {
              lastTouch.price = h.price;
              lastTouch.idx = h.idx;
            }
            matched = true;
            break;
          }
          eqh.touchCount++;
          eqh.price = (eqh.price * (eqh.touchCount - 1) + h.price) / eqh.touchCount;
          eqh.touches.push(h);
          matched = true;
          break;
        }
      }
      if (!matched) {
        eqhLevels.push({ price: h.price, touchCount: 1, touches: [h] });
      }
    }

    const eqlLevels: { price: number; touchCount: number; touches: { price: number; idx: number; volume: number; rsi?: number }[] }[] = [];
    for (const l of lows) {
      let matched = false;
      for (const eql of eqlLevels) {
        if (Math.abs(l.price - eql.price) / eql.price * 100 <= tolerancePct) {
          const lastTouch = eql.touches[eql.touches.length - 1];
          if (lastTouch && (l.idx - lastTouch.idx < minBarSeparation)) {
            if (l.price < lastTouch.price) {
              lastTouch.price = l.price;
              lastTouch.idx = l.idx;
            }
            matched = true;
            break;
          }
          eql.touchCount++;
          eql.price = (eql.price * (eql.touchCount - 1) + l.price) / eql.touchCount;
          eql.touches.push(l);
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

  public detectAsianSessionRange(candles1m: Candlestick[]): {
    asianHigh: number | null;
    asianLow: number | null;
  } {
    if (candles1m.length === 0) return { asianHigh: null, asianLow: null };

    const eightHoursAgo = (Date.now() / 1000) - 8 * 3600;
    const recentAsian = candles1m.filter(c => c.time >= eightHoursAgo);
    if (recentAsian.length === 0) return { asianHigh: null, asianLow: null };

    return {
      asianHigh: Math.max(...recentAsian.map(c => c.high)),
      asianLow: Math.min(...recentAsian.map(c => c.low)),
    };
  }

  public detectCHoCH(
    direction: "LONG" | "SHORT",
    candles1m: Candlestick[],
    ms: any = {}
  ): {
    hasChoch: boolean;
    chochLevel: number;
    description: string;
  } {
    if (ms.choch_confirmation_enabled === false) {
      return { hasChoch: true, chochLevel: 0, description: "CHoCH requirement bypassed via config" };
    }

    if (candles1m.length < 5) {
      return { hasChoch: false, chochLevel: 0, description: "Insufficient candles for CHoCH" };
    }

    const recent = candles1m.slice(-8);
    const last = candles1m[candles1m.length - 1];

    if (direction === "LONG") {
      let minLowIdx = 0;
      let minLow = Infinity;
      for (let i = 0; i < recent.length; i++) {
        if (recent[i].low < minLow) {
          minLow = recent[i].low;
          minLowIdx = i;
        }
      }

      let localSwingHigh = 0;
      const startIdx = Math.max(0, minLowIdx - 3);
      for (let i = startIdx; i <= Math.max(startIdx, minLowIdx - 1); i++) {
        if (recent[i].high > localSwingHigh) {
          localSwingHigh = recent[i].high;
        }
      }
      if (localSwingHigh === 0) {
        localSwingHigh = Math.max(recent[minLowIdx].high, recent[Math.max(0, minLowIdx - 1)].high);
      }

      const isAbovePriorHigh = recent.length >= 2 && last.close > recent[recent.length - 2].high && last.close > last.open;
      const isAboveLocalSwing = last.close > localSwingHigh;
      const hasChoch = isAboveLocalSwing || isAbovePriorHigh;
      const chochLevel = isAboveLocalSwing ? localSwingHigh : (recent.length >= 2 ? recent[recent.length - 2].high : localSwingHigh);

      return {
        hasChoch,
        chochLevel,
        description: hasChoch
          ? `Bullish CHoCH Confirmed: Price ($${last.close.toFixed(2)}) reclaimed counter-structure level ($${chochLevel.toFixed(2)}).`
          : `Awaiting Bullish CHoCH: Price ($${last.close.toFixed(2)}) must close above minor swing high $${chochLevel.toFixed(2)}.`,
      };
    } else {
      let maxHighIdx = 0;
      let maxHigh = -Infinity;
      for (let i = 0; i < recent.length; i++) {
        if (recent[i].high > maxHigh) {
          maxHigh = recent[i].high;
          maxHighIdx = i;
        }
      }

      let localSwingLow = Infinity;
      const startIdx = Math.max(0, maxHighIdx - 3);
      for (let i = startIdx; i <= Math.max(startIdx, maxHighIdx - 1); i++) {
        if (recent[i].low < localSwingLow) {
          localSwingLow = recent[i].low;
        }
      }
      if (localSwingLow === Infinity) {
        localSwingLow = Math.min(recent[maxHighIdx].low, recent[Math.max(0, maxHighIdx - 1)].low);
      }

      const isBelowPriorLow = recent.length >= 2 && last.close < recent[recent.length - 2].low && last.close < last.open;
      const isBelowLocalSwing = last.close < localSwingLow;
      const hasChoch = isBelowLocalSwing || isBelowPriorLow;
      const chochLevel = isBelowLocalSwing ? localSwingLow : (recent.length >= 2 ? recent[recent.length - 2].low : localSwingLow);

      return {
        hasChoch,
        chochLevel,
        description: hasChoch
          ? `Bearish CHoCH Confirmed: Price ($${last.close.toFixed(2)}) broke below counter-structure level ($${chochLevel.toFixed(2)}).`
          : `Awaiting Bearish CHoCH: Price ($${last.close.toFixed(2)}) must close below minor swing low $${chochLevel.toFixed(2)}.`,
      };
    }
  }

  public detectLiquiditySweep(
    direction: "LONG" | "SHORT" | "NEUTRAL",
    candles1m: Candlestick[],
    currentPrice: number,
    currentRegime: MarketRegime,
    ms: any = {},
    indicators: IndicatorCalculator
  ): {
    isSweep: boolean;
    sweptLevel: number;
    reclaimPrice: number;
    wickRatio: number;
    volumeMult: number;
    stopLoss: number;
    takeProfit: number;
    description: string;
  } {
    if (direction === "NEUTRAL") {
      return { isSweep: false, sweptLevel: 0, reclaimPrice: 0, wickRatio: 0, volumeMult: 0, stopLoss: 0, takeProfit: 0, description: "Neutral direction" };
    }

    if (direction === "LONG" && currentRegime === MarketRegime.STRONG_DOWNTREND) {
      return { isSweep: false, sweptLevel: 0, reclaimPrice: 0, wickRatio: 0, volumeMult: 0, stopLoss: 0, takeProfit: 0, description: "Blocked: Bullish Liquidity Sweep prohibited in STRONG_DOWNTREND regime." };
    }
    if (direction === "SHORT" && currentRegime === MarketRegime.STRONG_UPTREND) {
      return { isSweep: false, sweptLevel: 0, reclaimPrice: 0, wickRatio: 0, volumeMult: 0, stopLoss: 0, takeProfit: 0, description: "Blocked: Bearish Liquidity Sweep prohibited in STRONG_UPTREND regime." };
    }

    if (ms.liquidity_sweep_enabled === false) {
      return { isSweep: false, sweptLevel: 0, reclaimPrice: 0, wickRatio: 0, volumeMult: 0, stopLoss: 0, takeProfit: 0, description: "Liquidity sweep strategy disabled in config" };
    }

    const lookback = ms.liquidity_sweep_lookback_candles || 20;
    const minWickRatio = ms.liquidity_sweep_min_wick_ratio || 0.35;
    const reqVolMult = ms.liquidity_sweep_volume_mult || 1.0;

    if (candles1m.length < lookback + 2) {
      return { isSweep: false, sweptLevel: 0, reclaimPrice: 0, wickRatio: 0, volumeMult: 0, stopLoss: 0, takeProfit: 0, description: "Insufficient candle history" };
    }

    const lastIdx = candles1m.length - 1;
    const currentCandle = candles1m[lastIdx];
    const struct = this.getTrendMarketStructure(candles1m, currentRegime, ms, indicators);
    const atr14 = indicators.calculateATR(candles1m, 14);
    const currentAtr = Math.max(10, atr14[lastIdx] || 50);

    const volumes = candles1m.map(c => c.volume);
    const sumVol = volumes.slice(-20).reduce((a, b) => a + b, 0);
    const avgVol = volumes.length >= 20 ? sumVol / 20 : 1.0;

    const recentCandles = candles1m.slice(-3);
    const eqLevels = this.detectEqualHighsLows(candles1m, ms, indicators);
    const asianRange = ms.asian_session_sweep_enabled ? this.detectAsianSessionRange(candles1m) : { asianHigh: null, asianLow: null };

    if (direction === "LONG") {
      const rangeCandles = candles1m.slice(-lookback - 1, -1);
      const rangeLow = rangeCandles.length > 0 ? Math.min(...rangeCandles.map(c => c.low)) : struct.swingLow;

      const eqlPrices = eqLevels.eqlLevels.map(e => e.price);
      const levelsToTest = Array.from(new Set([
        struct.swingLow,
        struct.prev_LL ? struct.prev_LL.price : 0,
        struct.current_LL ? struct.current_LL.price : 0,
        struct.current_HL ? struct.current_HL.price : 0,
        rangeLow,
        asianRange.asianLow || 0,
        ...eqlPrices,
      ])).filter(p => p > 0);

      for (const level of levelsToTest) {
        const sweepCandle = recentCandles.find(c => c.low < level - 0.05 * currentAtr);
        if (sweepCandle) {
          const isReclaimed = currentCandle.close >= level - 0.05 * currentAtr;
          const isCascadeHalted = currentCandle.low >= sweepCandle.low - 0.05 * currentAtr;

          if (isReclaimed && isCascadeHalted) {
            const range = sweepCandle.high - sweepCandle.low;
            const lowerWick = Math.min(sweepCandle.open, sweepCandle.close) - sweepCandle.low;
            const wickRatio = range > 0 ? lowerWick / range : 0;
            const volMult = avgVol > 0 ? sweepCandle.volume / avgVol : 1.0;

            const hasReversalForm = wickRatio >= minWickRatio || (currentCandle.close > currentCandle.open && currentCandle.close >= sweepCandle.high);

            if (hasReversalForm && volMult >= reqVolMult * 0.8) {
              const chochResult = this.detectCHoCH("LONG", candles1m, ms);
              if (!chochResult.hasChoch && ms.choch_confirmation_enabled !== false) {
                return { isSweep: false, sweptLevel: level, reclaimPrice: currentCandle.close, wickRatio: wickRatio * 100, volumeMult: volMult, stopLoss: 0, takeProfit: 0, description: `Sweep detected at $${level.toFixed(2)}, but awaiting CHoCH confirmation (${chochResult.description})` };
              }

              const poolType = eqlPrices.includes(level)
                ? "Equal Lows (EQL) Sell-Side Liquidity Pool"
                : (asianRange.asianLow && Math.abs(level - asianRange.asianLow) < 1 ? "Asian Session Low" : "Support Level");

              const stopLoss = sweepCandle.low - Math.max(25, 0.45 * currentAtr);
              const risk = Math.max(10, currentCandle.close - stopLoss);
              const takeProfit = currentCandle.close + Math.max(risk * 2.0, 1.8 * currentAtr);

              return {
                isSweep: true,
                sweptLevel: level,
                reclaimPrice: currentCandle.close,
                wickRatio: wickRatio * 100,
                volumeMult: volMult,
                stopLoss,
                takeProfit,
                description: `Bullish Liquidity Sweep: Price pierced ${poolType} $${level.toFixed(2)} (low $${sweepCandle.low.toFixed(2)}), then reclaimed $${currentCandle.close.toFixed(2)} with ${(wickRatio * 100).toFixed(0)}% lower wick and ${volMult.toFixed(1)}x volume. ${chochResult.description} (SL: $${stopLoss.toFixed(2)}, TP: $${takeProfit.toFixed(2)})`,
              };
            }
          }
        }
      }
    } else if (direction === "SHORT") {
      const rangeCandles = candles1m.slice(-lookback - 1, -1);
      const rangeHigh = rangeCandles.length > 0 ? Math.max(...rangeCandles.map(c => c.high)) : struct.swingHigh;

      const eqhPrices = eqLevels.eqhLevels.map(e => e.price);
      const levelsToTest = Array.from(new Set([
        struct.swingHigh,
        struct.prev_HH ? struct.prev_HH.price : 0,
        struct.current_HH ? struct.current_HH.price : 0,
        struct.current_LH ? struct.current_LH.price : 0,
        rangeHigh,
        asianRange.asianHigh || 0,
        ...eqhPrices,
      ])).filter(p => p > 0);

      for (const level of levelsToTest) {
        const sweepCandle = recentCandles.find(c => c.high > level + 0.05 * currentAtr);
        if (sweepCandle) {
          const isReclaimed = currentCandle.close <= level + 0.05 * currentAtr;
          const isCascadeHalted = currentCandle.high <= sweepCandle.high + 0.05 * currentAtr;

          if (isReclaimed && isCascadeHalted) {
            const range = sweepCandle.high - sweepCandle.low;
            const upperWick = sweepCandle.high - Math.max(sweepCandle.open, sweepCandle.close);
            const wickRatio = range > 0 ? upperWick / range : 0;
            const volMult = avgVol > 0 ? sweepCandle.volume / avgVol : 1.0;

            const hasReversalForm = wickRatio >= minWickRatio || (currentCandle.close < currentCandle.open && currentCandle.close <= sweepCandle.low);

            if (hasReversalForm && volMult >= reqVolMult * 0.8) {
              const chochResult = this.detectCHoCH("SHORT", candles1m, ms);
              if (!chochResult.hasChoch && ms.choch_confirmation_enabled !== false) {
                return { isSweep: false, sweptLevel: level, reclaimPrice: currentCandle.close, wickRatio: wickRatio * 100, volumeMult: volMult, stopLoss: 0, takeProfit: 0, description: `Sweep detected at $${level.toFixed(2)}, but awaiting CHoCH confirmation (${chochResult.description})` };
              }

              const poolType = eqhPrices.includes(level)
                ? "Equal Highs (EQH) Buy-Side Liquidity Pool"
                : (asianRange.asianHigh && Math.abs(level - asianRange.asianHigh) < 1 ? "Asian Session High" : "Resistance Level");

              const stopLoss = sweepCandle.high + Math.max(25, 0.45 * currentAtr);
              const risk = Math.max(10, stopLoss - currentCandle.close);
              const takeProfit = currentCandle.close - Math.max(risk * 2.0, 1.8 * currentAtr);

              return {
                isSweep: true,
                sweptLevel: level,
                reclaimPrice: currentCandle.close,
                wickRatio: wickRatio * 100,
                volumeMult: volMult,
                stopLoss,
                takeProfit,
                description: `Bearish Liquidity Sweep: Price pierced ${poolType} $${level.toFixed(2)} (high $${sweepCandle.high.toFixed(2)}), then reclaimed $${currentCandle.close.toFixed(2)} with ${(wickRatio * 100).toFixed(0)}% upper wick and ${volMult.toFixed(1)}x volume. ${chochResult.description} (SL: $${stopLoss.toFixed(2)}, TP: $${takeProfit.toFixed(2)})`,
              };
            }
          }
        }
      }
    }

    return { isSweep: false, sweptLevel: 0, reclaimPrice: 0, wickRatio: 0, volumeMult: 0, stopLoss: 0, takeProfit: 0, description: "No liquidity sweep detected" };
  }
}

export const structureEngine = new StructureEngine();
