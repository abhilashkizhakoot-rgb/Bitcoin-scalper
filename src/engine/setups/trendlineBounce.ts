import { MarketStructureConfig } from "../../types.js";
import { isMultiCandleLongRejection, isMultiCandleShortRejection } from "../candlestick.js";
import { SetupContext } from "./context.js";

export interface TrendlineBounceResult {
  isValid: boolean;
  direction: "LONG" | "SHORT" | "NEUTRAL";
  trendlinePrice: number;
  trendlineSlope: number;
  trendlineAngleDegrees: number;
  touchesCount: number;
  touchIndices: number[];
  isGoldenThirdTouch: boolean;
  isLiquiditySweepReclaim: boolean;
  liquiditySweepWickAtr: number;
  rejectionPattern: string;
  volumeContractionRatio: number;
  bounceVolumeExpansionRatio: number;
  isConfluenceWithHorizontal: boolean;
  isConfluenceWithFib: boolean;
  isConfluenceWithEma: boolean;
  confluenceFactors: string[];
  confluenceScore: number;
  confluenceLevel?: number;
  stopLoss: number;
  takeProfit: number;
  riskReward: number;
  description: string;
}

interface Trendline {
  slope: number;
  intercept: number;
  startIndex: number;
  touches: number[];
  rSquared: number;
  angleDegrees: number;
  sweptTouches: number[];
}

/**
 * FEATURE: Setup 15 - Trendline Bounce & Retest Strategy
 * Enhanced based on Pro Trading School's Master Trendline Trading Framework:
 * 
 * 1. STRUCTURAL TRENDLINE WITH DYNAMIC ANGLE FILTER:
 *    - Identifies ascending support (swing lows) or descending resistance (swing highs).
 *    - Calculates normalized slope angle in degrees to reject flat sideways ranges (< 15°)
 *      and unsustainable parabolic blow-offs (> 60°).
 * 
 * 2. THE "3 TOUCHES RULE" (GOLDEN SETUP):
 *    - Touch 1 & 2 establish the trendline.
 *    - Touch 3 is the highest-probability, golden bounce entry with maximum trend runway.
 *    - Touch count and prime status are distinctly identified and tagged.
 * 
 * 3. LIQUIDITY SWEEP & RECLAIM (SMART MONEY TRAP):
 *    - Institutional stop run detection: price pokes beyond the trendline to trigger retail stops,
 *      then violently reclaims back inside the trendline structure with a long rejection wick.
 *    - Instead of treating this as a breakdown, it confirms high-conviction institutional accumulation.
 * 
 * 4. MULTI-FACTOR HIGH-CONFLUENCE ZONES:
 *    - Horizontal Support/Resistance Alignment (prior fractal polarity flip).
 *    - Fibonacci Golden Pocket (50% - 61.8% retracement of the swing leg).
 *    - Dynamic EMA Alignment (20 EMA, 50 EMA, 200 EMA).
 * 
 * 5. VOLUME DYNAMICS:
 *    - Retest Volume Contraction (exhaustion of counter-trend sellers/buyers).
 *    - Bounce Volume Expansion (aggressive market participant absorption).
 * 
 * 6. STRUCTURAL TARGETING & RISK MANAGEMENT:
 *    - Target: High-probability structural target with favorable risk/reward.
 */
export function evaluateTrendlineBounceSetup(
  direction: "LONG" | "SHORT" | "NEUTRAL",
  ctx: SetupContext
): TrendlineBounceResult {
  const { candles1m, currentPrice, indicators, orderFlowStats, orderBookStats, config } = ctx;
  const ms = config.market_structure || ({} as MarketStructureConfig);

  const defaultResult: TrendlineBounceResult = {
    isValid: false,
    direction,
    trendlinePrice: 0,
    trendlineSlope: 0,
    trendlineAngleDegrees: 0,
    touchesCount: 0,
    touchIndices: [],
    isGoldenThirdTouch: false,
    isLiquiditySweepReclaim: false,
    liquiditySweepWickAtr: 0,
    rejectionPattern: "",
    volumeContractionRatio: 1.0,
    bounceVolumeExpansionRatio: 1.0,
    isConfluenceWithHorizontal: false,
    isConfluenceWithFib: false,
    isConfluenceWithEma: false,
    confluenceFactors: [],
    confluenceScore: 0,
    stopLoss: 0,
    takeProfit: 0,
    riskReward: 0,
    description: "No active trendline bounce setup"
  };

  if (ms.trendline_bounce_strategy_enabled === false || direction === "NEUTRAL") {
    return {
      ...defaultResult,
      description: ms.trendline_bounce_strategy_enabled === false 
        ? "Trendline Bounce Strategy disabled in configuration" 
        : "Neutral direction scanning"
    };
  }

  if (!candles1m || candles1m.length < 25) {
    return {
      ...defaultResult,
      description: "Insufficient 1m candles for trendline detection (minimum 25 candles required)"
    };
  }

  const closes = candles1m.map(c => c.close);
  const highs = candles1m.map(c => c.high);
  const lows = candles1m.map(c => c.low);
  const opens = candles1m.map(c => c.open);
  const volumes = candles1m.map(c => c.volume);
  const lastIdx = closes.length - 1;

  const atrSeries = indicators.calculateATR(candles1m, 14);
  const currentAtr = atrSeries[lastIdx] || (highs[lastIdx] - lows[lastIdx]) || 30;

  // Scan lookback window for fractal swing points (default: 45 candles)
  const lookback = Math.min(50, lastIdx - 5);
  const startIdx = Math.max(0, lastIdx - lookback);

  const minTouches = ms.trendline_bounce_min_touches ?? 2;
  const maxPenetrationAtr = ms.trendline_bounce_max_penetration_atr ?? 0.25;
  const minSlopeAngle = ms.trendline_bounce_min_slope_angle ?? 15;
  const maxSlopeAngle = ms.trendline_bounce_max_slope_angle ?? 60;
  const allowLiquiditySweep = ms.trendline_bounce_allow_liquidity_sweep !== false;
  const maxSweepAtr = ms.trendline_bounce_max_sweep_atr ?? 0.85;
  const requireVolumeContraction = ms.trendline_bounce_require_volume_contraction ?? true;
  const requireCandleReversal = ms.trendline_bounce_require_candlestick_reversal ?? true;
  const requireBounceVolExpansion = ms.trendline_bounce_require_bounce_volume_expansion ?? false;
  const require3rdTouch = ms.trendline_bounce_require_3rd_touch ?? false;

  // Volume 20-period SMA
  const volSma20 = (() => {
    const volSlice = volumes.slice(-20);
    return volSlice.length > 0 ? volSlice.reduce((a, b) => a + b, 0) / volSlice.length : 100;
  })();

  // Multi-candle rejection checks
  const rejectionCheckLong = isMultiCandleLongRejection(candles1m, lastIdx, currentPrice, currentAtr, orderFlowStats, orderBookStats, config, indicators);
  const rejectionCheckShort = isMultiCandleShortRejection(candles1m, lastIdx, currentPrice, currentAtr, orderFlowStats, orderBookStats, config, indicators);

  // Common EMAs for confluence calculation
  const ema20 = indicators.calculateEMA(closes, 20)[lastIdx] || currentPrice;
  const ema50 = indicators.calculateEMA(closes, 50)[lastIdx] || currentPrice;
  const ema200 = indicators.calculateEMA(closes, 200)[lastIdx] || currentPrice;

  // -------------------------------------------------------------
  // LONG: ASCENDING TRENDLINE BOUNCE & RETEST
  // -------------------------------------------------------------
  if (direction === "LONG") {
    // 1. Find swing lows (fractal lows)
    const swingLows: { index: number; price: number }[] = [];
    const swingHighs: { index: number; price: number }[] = [];

    for (let i = startIdx + 2; i <= lastIdx - 1; i++) {
      if (
        lows[i] <= lows[i - 1] &&
        lows[i] <= lows[i - 2] &&
        lows[i] <= lows[i + 1] &&
        lows[i] <= (lows[i + 2] ?? lows[i + 1])
      ) {
        swingLows.push({ index: i, price: lows[i] });
      }
      if (
        highs[i] >= highs[i - 1] &&
        highs[i] >= highs[i - 2] &&
        highs[i] >= highs[i + 1] &&
        highs[i] >= (highs[i + 2] ?? highs[i + 1])
      ) {
        swingHighs.push({ index: i, price: highs[i] });
      }
    }

    if (swingLows.length < 2) {
      return { ...defaultResult, description: "Insufficient fractal swing lows to construct ascending trendline" };
    }

    // 2. Identify best ascending trendline connecting swing lows with positive slope & valid angle
    let bestLine: Trendline | null = null;
    let maxTouchScore = -1;

    for (let i = 0; i < swingLows.length - 1; i++) {
      for (let j = i + 1; j < swingLows.length; j++) {
        const p1 = swingLows[i];
        const p2 = swingLows[j];
        const dx = p2.index - p1.index;
        if (dx < 4) continue; // Minimum spacing between pivots

        const slope = (p2.price - p1.price) / dx;
        if (slope <= 0.02) continue; // Must be upward sloping

        // Calculate normalized slope angle in degrees
        const normalizedSlope = (slope * 5) / currentAtr;
        const angleDegrees = Math.min(89, Math.max(1, Math.atan(normalizedSlope) * (180 / Math.PI)));
        if (angleDegrees < minSlopeAngle || angleDegrees > maxSlopeAngle) {
          continue; // Filter flat ranges or unsustainable parabolic spikes
        }

        const intercept = p1.price - slope * p1.index;

        let bodyViolations = 0;
        const touches: number[] = [p1.index, p2.index];
        const sweptTouches: number[] = [];
        const touchTolerance = 0.38 * currentAtr;

        for (let k = p1.index; k <= lastIdx - 2; k++) {
          const lineVal = slope * k + intercept;
          const bodyMin = Math.min(opens[k], closes[k]);

          // Check for Liquidity Sweep vs True Violation
          if (bodyMin < lineVal - maxPenetrationAtr * currentAtr) {
            // If the candle closed back near the line and had a lower wick poke, it's a liquidity sweep
            if (allowLiquiditySweep && closes[k] >= lineVal - 0.15 * currentAtr && (lineVal - lows[k]) <= maxSweepAtr * currentAtr) {
              sweptTouches.push(k);
              touches.push(k);
            } else {
              bodyViolations++;
            }
          } else if (k !== p1.index && k !== p2.index) {
            // Clean touch within zone
            if (lows[k] <= lineVal + touchTolerance && bodyMin >= lineVal - 0.15 * currentAtr) {
              touches.push(k);
            }
          }
        }

        // Allow max 1 minor body violation in 1m candles
        if (bodyViolations <= 1) {
          const uniqueTouches = Array.from(new Set(touches)).sort((a, b) => a - b);
          const touchScore = uniqueTouches.length * 15 - bodyViolations * 10 + (sweptTouches.length > 0 ? 5 : 0) + slope;
          if (touchScore > maxTouchScore) {
            maxTouchScore = touchScore;
            bestLine = {
              slope,
              intercept,
              startIndex: p1.index,
              touches: uniqueTouches,
              rSquared: 1.0,
              angleDegrees: Math.round(angleDegrees * 10) / 10,
              sweptTouches,
            };
          }
        }
      }
    }

    if (!bestLine || bestLine.touches.length < minTouches) {
      return {
        ...defaultResult,
        description: `No valid ascending trendline found with >= ${minTouches} touches and slope angle ${minSlopeAngle}°-${maxSlopeAngle}°`
      };
    }

    // 3. Evaluate trendline value at current / recent candles
    const trendlineAtCurrent = bestLine.slope * lastIdx + bestLine.intercept;
    const recentCandles = candles1m.slice(-3);
    const touchTolerance = 0.38 * currentAtr;
    const recentLow = Math.min(...recentCandles.map(c => c.low));

    // Check if price tested the trendline zone recently
    const hasTestedTrendline = recentCandles.some(c => {
      const cIdx = candles1m.indexOf(c);
      const lineVal = bestLine!.slope * cIdx + bestLine!.intercept;
      return c.low <= lineVal + touchTolerance && c.close >= lineVal - (allowLiquiditySweep ? maxSweepAtr : maxPenetrationAtr) * currentAtr;
    });

    if (!hasTestedTrendline) {
      return {
        ...defaultResult,
        trendlinePrice: trendlineAtCurrent,
        trendlineSlope: bestLine.slope,
        trendlineAngleDegrees: bestLine.angleDegrees,
        touchesCount: bestLine.touches.length,
        description: `Price ($${currentPrice.toFixed(2)}) has not tested dynamic trendline ($${trendlineAtCurrent.toFixed(2)}) within zone (+${touchTolerance.toFixed(1)})`
      };
    }

    // 4. Pro Trading School "3 Touches Rule": Is this the Golden 3rd Touch?
    const isCurrentTouchNew = !bestLine.touches.includes(lastIdx) && !bestLine.touches.includes(lastIdx - 1);
    const totalEffectiveTouches = bestLine.touches.length + (isCurrentTouchNew ? 1 : 0);
    const isGoldenThirdTouch = totalEffectiveTouches === 3;

    if (require3rdTouch && !isGoldenThirdTouch) {
      return {
        ...defaultResult,
        trendlinePrice: trendlineAtCurrent,
        trendlineSlope: bestLine.slope,
        trendlineAngleDegrees: bestLine.angleDegrees,
        touchesCount: totalEffectiveTouches,
        description: `Trendline test detected (${totalEffectiveTouches} touches), but strict 3rd-touch golden rule is enabled (requires touch #3).`
      };
    }

    // 5. Pro Trading School Trendline Liquidity Sweep & Reclaim Check
    let isLiquiditySweepReclaim = false;
    let liquiditySweepWickAtr = 0;

    for (const c of recentCandles) {
      const cIdx = candles1m.indexOf(c);
      const lineVal = bestLine.slope * cIdx + bestLine.intercept;
      // Price poked below trendline, but candle closed back on or above the line
      if (c.low < lineVal && (c.close >= lineVal - 0.15 * currentAtr || c.close > c.open)) {
        const sweepDepth = (lineVal - c.low) / currentAtr;
        if (sweepDepth >= 0.05 && sweepDepth <= maxSweepAtr) {
          isLiquiditySweepReclaim = true;
          liquiditySweepWickAtr = Math.max(liquiditySweepWickAtr, Math.round(sweepDepth * 100) / 100);
        }
      }
    }

    // 6. Candle rejection check
    const lastClosed = candles1m[lastIdx - 1] || candles1m[lastIdx];
    const isGreenClose = lastClosed.close >= lastClosed.open || closes[lastIdx] >= opens[lastIdx];
    const rejectionPattern = rejectionCheckLong.confirmed 
      ? rejectionCheckLong.type 
      : (isLiquiditySweepReclaim 
          ? "Trendline Liquidity Sweep & Reclaim Wick" 
          : (isGreenClose ? "Bullish Candle Reaction" : ""));

    if (requireCandleReversal && (!rejectionCheckLong.confirmed && !isGreenClose && !isLiquiditySweepReclaim)) {
      return {
        ...defaultResult,
        trendlinePrice: trendlineAtCurrent,
        trendlineSlope: bestLine.slope,
        trendlineAngleDegrees: bestLine.angleDegrees,
        touchesCount: totalEffectiveTouches,
        description: `Tested ascending trendline at $${trendlineAtCurrent.toFixed(2)}, waiting for bullish candlestick rejection (Pin Bar, Engulfing, Hammer, or Reclaim)`
      };
    }

    // 7. Volume Dynamics (Volume Contraction on Retest + Bounce Volume Expansion)
    const pullbackCandles = candles1m.slice(-4, -1);
    const avgPullbackVol = pullbackCandles.length > 0 
      ? pullbackCandles.reduce((s, c) => s + c.volume, 0) / pullbackCandles.length 
      : volSma20;
    const volumeContractionRatio = avgPullbackVol / Math.max(1, volSma20);

    const isVolumeContracted = volumeContractionRatio <= 1.25;
    if (requireVolumeContraction && !isVolumeContracted) {
      return {
        ...defaultResult,
        trendlinePrice: trendlineAtCurrent,
        trendlineSlope: bestLine.slope,
        trendlineAngleDegrees: bestLine.angleDegrees,
        touchesCount: totalEffectiveTouches,
        volumeContractionRatio,
        description: `Trendline test at $${trendlineAtCurrent.toFixed(2)} blocked: high volume on pullback (${volumeContractionRatio.toFixed(2)}x SMA20) suggests heavy aggressive selling`
      };
    }

    const bounceVol = Math.max(volumes[lastIdx], volumes[lastIdx - 1] || 0);
    const bounceVolumeExpansionRatio = Math.round((bounceVol / Math.max(1, avgPullbackVol)) * 100) / 100;
    if (requireBounceVolExpansion && bounceVolumeExpansionRatio < 1.05) {
      return {
        ...defaultResult,
        trendlinePrice: trendlineAtCurrent,
        trendlineSlope: bestLine.slope,
        trendlineAngleDegrees: bestLine.angleDegrees,
        touchesCount: totalEffectiveTouches,
        volumeContractionRatio,
        bounceVolumeExpansionRatio,
        description: `Waiting for volume expansion on trendline bounce candle (${bounceVolumeExpansionRatio}x vs pullback avg)`
      };
    }

    // 8. Multi-Factor High-Confluence Zones (Horizontal S/R + Fibonacci + EMAs)
    const confluenceFactors: string[] = [];
    let isConfluenceWithHorizontal = false;
    let isConfluenceWithFib = false;
    let isConfluenceWithEma = false;
    let matchedConfluenceLevel: number | undefined;

    // A) Horizontal S/R Confluence (prior swing highs/lows)
    if (ms.trendline_bounce_horizontal_sr_confluence_enabled !== false) {
      const priorPivots = [...swingHighs, ...swingLows].filter(p => p.index < lastIdx - 3);
      for (const pivot of priorPivots) {
        if (Math.abs(trendlineAtCurrent - pivot.price) <= 0.40 * currentAtr) {
          isConfluenceWithHorizontal = true;
          matchedConfluenceLevel = pivot.price;
          confluenceFactors.push(`Horizontal S/R ($${pivot.price.toFixed(1)})`);
          break;
        }
      }
    }

    // B) Fibonacci Golden Pocket Confluence (50% - 61.8%)
    if (ms.trendline_bounce_fib_confluence_enabled !== false) {
      const swingOriginLow = Math.min(...lows.slice(bestLine.startIndex, lastIdx - 4));
      const swingLegHigh = Math.max(...highs.slice(bestLine.startIndex, lastIdx - 1));
      const legHeight = swingLegHigh - swingOriginLow;

      if (legHeight > 1.5 * currentAtr) {
        const fib50 = swingLegHigh - 0.50 * legHeight;
        const fib618 = swingLegHigh - 0.618 * legHeight;
        if (trendlineAtCurrent >= fib618 - 0.35 * currentAtr && trendlineAtCurrent <= fib50 + 0.35 * currentAtr) {
          isConfluenceWithFib = true;
          matchedConfluenceLevel = matchedConfluenceLevel || fib618;
          confluenceFactors.push(`Fib 50%-61.8% Golden Pocket ($${fib618.toFixed(1)}-$${fib50.toFixed(1)})`);
        }
      }
    }

    // C) Dynamic EMA Confluence (20, 50, 200 EMA)
    if (Math.abs(trendlineAtCurrent - ema50) <= 0.40 * currentAtr) {
      isConfluenceWithEma = true;
      matchedConfluenceLevel = matchedConfluenceLevel || ema50;
      confluenceFactors.push(`50 EMA ($${ema50.toFixed(1)})`);
    } else if (Math.abs(trendlineAtCurrent - ema20) <= 0.35 * currentAtr) {
      isConfluenceWithEma = true;
      matchedConfluenceLevel = matchedConfluenceLevel || ema20;
      confluenceFactors.push(`20 EMA ($${ema20.toFixed(1)})`);
    } else if (Math.abs(trendlineAtCurrent - ema200) <= 0.45 * currentAtr) {
      isConfluenceWithEma = true;
      matchedConfluenceLevel = matchedConfluenceLevel || ema200;
      confluenceFactors.push(`200 EMA ($${ema200.toFixed(1)})`);
    }

    // Calculate composite Confluence Score (0 - 100)
    let confluenceScore = 50;
    if (isGoldenThirdTouch) confluenceScore += 15;
    if (isLiquiditySweepReclaim) confluenceScore += 20;
    if (confluenceFactors.length > 0) confluenceScore += Math.min(25, confluenceFactors.length * 10);
    confluenceScore = Math.min(100, confluenceScore);

    // 9. Targets & Risk Management
    const recentSwingHigh = Math.max(...highs.slice(bestLine.startIndex, lastIdx));
    const bounceExtremeLow = Math.min(recentLow, trendlineAtCurrent - (isLiquiditySweepReclaim ? liquiditySweepWickAtr * currentAtr : 0));
    const stopLoss = bounceExtremeLow - 0.35 * currentAtr;
    const riskDistance = Math.max(1, currentPrice - stopLoss);

    const takeProfit = Math.max(currentPrice + Math.max(2.0 * riskDistance, 2.0 * currentAtr), recentSwingHigh);
    const riskReward = Math.round(((takeProfit - currentPrice) / riskDistance) * 100) / 100;

    // Formatting description
    const touchesFormatted = bestLine.touches.map(idx => `#${idx}`).join(", ");
    const touchLabel = isGoldenThirdTouch ? " [GOLDEN 3RD TOUCH]" : ` (Touch #${totalEffectiveTouches})`;
    const sweepLabel = isLiquiditySweepReclaim ? ` [LIQUIDITY SWEEP RECLAIM: -${liquiditySweepWickAtr}x ATR wick]` : "";
    const confluenceLabel = confluenceFactors.length > 0 ? ` [CONFLUENCE: ${confluenceFactors.join(" + ")}]` : "";

    return {
      isValid: true,
      direction: "LONG",
      trendlinePrice: trendlineAtCurrent,
      trendlineSlope: bestLine.slope,
      trendlineAngleDegrees: bestLine.angleDegrees,
      touchesCount: totalEffectiveTouches,
      touchIndices: bestLine.touches,
      isGoldenThirdTouch,
      isLiquiditySweepReclaim,
      liquiditySweepWickAtr,
      rejectionPattern: rejectionPattern || "Bullish Trendline Rebound",
      volumeContractionRatio,
      bounceVolumeExpansionRatio,
      isConfluenceWithHorizontal,
      isConfluenceWithFib,
      isConfluenceWithEma,
      confluenceFactors,
      confluenceScore,
      confluenceLevel: matchedConfluenceLevel,
      stopLoss,
      takeProfit,
      riskReward,
      description: `Ascending Trendline Bounce Confirmed${touchLabel}${sweepLabel}${confluenceLabel}: Tested dynamic trendline support at $${trendlineAtCurrent.toFixed(2)} (Angle ${bestLine.angleDegrees}°) with [${rejectionPattern || "Bullish Reaction"}] and contracting volume (${volumeContractionRatio.toFixed(2)}x SMA20). Target TP: $${takeProfit.toFixed(1)} (${riskReward.toFixed(1)}R).`,
    };
  }

  // -------------------------------------------------------------
  // SHORT: DESCENDING TRENDLINE BOUNCE & RETEST
  // -------------------------------------------------------------
  if (direction === "SHORT") {
    // 1. Find swing highs (fractal highs)
    const swingHighs: { index: number; price: number }[] = [];
    const swingLows: { index: number; price: number }[] = [];

    for (let i = startIdx + 2; i <= lastIdx - 1; i++) {
      if (
        highs[i] >= highs[i - 1] &&
        highs[i] >= highs[i - 2] &&
        highs[i] >= highs[i + 1] &&
        highs[i] >= (highs[i + 2] ?? highs[i + 1])
      ) {
        swingHighs.push({ index: i, price: highs[i] });
      }
      if (
        lows[i] <= lows[i - 1] &&
        lows[i] <= lows[i - 2] &&
        lows[i] <= lows[i + 1] &&
        lows[i] <= (lows[i + 2] ?? lows[i + 1])
      ) {
        swingLows.push({ index: i, price: lows[i] });
      }
    }

    if (swingHighs.length < 2) {
      return { ...defaultResult, description: "Insufficient fractal swing highs to construct descending trendline" };
    }

    // 2. Identify best descending trendline connecting swing highs with negative slope & valid angle
    let bestLine: Trendline | null = null;
    let maxTouchScore = -1;

    for (let i = 0; i < swingHighs.length - 1; i++) {
      for (let j = i + 1; j < swingHighs.length; j++) {
        const p1 = swingHighs[i];
        const p2 = swingHighs[j];
        const dx = p2.index - p1.index;
        if (dx < 4) continue;

        const slope = (p2.price - p1.price) / dx;
        if (slope >= -0.02) continue; // Must be downward sloping

        // Calculate normalized slope angle in degrees
        const normalizedSlope = (Math.abs(slope) * 5) / currentAtr;
        const angleDegrees = Math.min(89, Math.max(1, Math.atan(normalizedSlope) * (180 / Math.PI)));
        if (angleDegrees < minSlopeAngle || angleDegrees > maxSlopeAngle) {
          continue; // Filter flat ranges or unsustainable waterfall drops
        }

        const intercept = p1.price - slope * p1.index;

        let bodyViolations = 0;
        const touches: number[] = [p1.index, p2.index];
        const sweptTouches: number[] = [];
        const touchTolerance = 0.38 * currentAtr;

        for (let k = p1.index; k <= lastIdx - 2; k++) {
          const lineVal = slope * k + intercept;
          const bodyMax = Math.max(opens[k], closes[k]);

          // Check for Liquidity Sweep vs True Violation
          if (bodyMax > lineVal + maxPenetrationAtr * currentAtr) {
            if (allowLiquiditySweep && closes[k] <= lineVal + 0.15 * currentAtr && (highs[k] - lineVal) <= maxSweepAtr * currentAtr) {
              sweptTouches.push(k);
              touches.push(k);
            } else {
              bodyViolations++;
            }
          } else if (k !== p1.index && k !== p2.index) {
            if (highs[k] >= lineVal - touchTolerance && bodyMax <= lineVal + 0.15 * currentAtr) {
              touches.push(k);
            }
          }
        }

        if (bodyViolations <= 1) {
          const uniqueTouches = Array.from(new Set(touches)).sort((a, b) => a - b);
          const touchScore = uniqueTouches.length * 15 - bodyViolations * 10 + (sweptTouches.length > 0 ? 5 : 0) - slope;
          if (touchScore > maxTouchScore) {
            maxTouchScore = touchScore;
            bestLine = {
              slope,
              intercept,
              startIndex: p1.index,
              touches: uniqueTouches,
              rSquared: 1.0,
              angleDegrees: Math.round(angleDegrees * 10) / 10,
              sweptTouches,
            };
          }
        }
      }
    }

    if (!bestLine || bestLine.touches.length < minTouches) {
      return {
        ...defaultResult,
        description: `No valid descending trendline found with >= ${minTouches} touches and slope angle ${minSlopeAngle}°-${maxSlopeAngle}°`
      };
    }

    // 3. Evaluate trendline value at current / recent candles
    const trendlineAtCurrent = bestLine.slope * lastIdx + bestLine.intercept;
    const recentCandles = candles1m.slice(-3);
    const touchTolerance = 0.38 * currentAtr;
    const recentHigh = Math.max(...recentCandles.map(c => c.high));

    const hasTestedTrendline = recentCandles.some(c => {
      const cIdx = candles1m.indexOf(c);
      const lineVal = bestLine!.slope * cIdx + bestLine!.intercept;
      return c.high >= lineVal - touchTolerance && c.close <= lineVal + (allowLiquiditySweep ? maxSweepAtr : maxPenetrationAtr) * currentAtr;
    });

    if (!hasTestedTrendline) {
      return {
        ...defaultResult,
        trendlinePrice: trendlineAtCurrent,
        trendlineSlope: bestLine.slope,
        trendlineAngleDegrees: bestLine.angleDegrees,
        touchesCount: bestLine.touches.length,
        description: `Price ($${currentPrice.toFixed(2)}) has not tested dynamic trendline ($${trendlineAtCurrent.toFixed(2)}) within zone (-${touchTolerance.toFixed(1)})`
      };
    }

    // 4. Pro Trading School "3 Touches Rule": Is this the Golden 3rd Touch?
    const isCurrentTouchNew = !bestLine.touches.includes(lastIdx) && !bestLine.touches.includes(lastIdx - 1);
    const totalEffectiveTouches = bestLine.touches.length + (isCurrentTouchNew ? 1 : 0);
    const isGoldenThirdTouch = totalEffectiveTouches === 3;

    if (require3rdTouch && !isGoldenThirdTouch) {
      return {
        ...defaultResult,
        trendlinePrice: trendlineAtCurrent,
        trendlineSlope: bestLine.slope,
        trendlineAngleDegrees: bestLine.angleDegrees,
        touchesCount: totalEffectiveTouches,
        description: `Trendline test detected (${totalEffectiveTouches} touches), but strict 3rd-touch golden rule is enabled (requires touch #3).`
      };
    }

    // 5. Pro Trading School Trendline Liquidity Sweep & Reclaim Check
    let isLiquiditySweepReclaim = false;
    let liquiditySweepWickAtr = 0;

    for (const c of recentCandles) {
      const cIdx = candles1m.indexOf(c);
      const lineVal = bestLine.slope * cIdx + bestLine.intercept;
      if (c.high > lineVal && (c.close <= lineVal + 0.15 * currentAtr || c.close < c.open)) {
        const sweepDepth = (c.high - lineVal) / currentAtr;
        if (sweepDepth >= 0.05 && sweepDepth <= maxSweepAtr) {
          isLiquiditySweepReclaim = true;
          liquiditySweepWickAtr = Math.max(liquiditySweepWickAtr, Math.round(sweepDepth * 100) / 100);
        }
      }
    }

    // 6. Candle rejection check
    const lastClosed = candles1m[lastIdx - 1] || candles1m[lastIdx];
    const isRedClose = lastClosed.close <= lastClosed.open || closes[lastIdx] <= opens[lastIdx];
    const rejectionPattern = rejectionCheckShort.confirmed 
      ? rejectionCheckShort.type 
      : (isLiquiditySweepReclaim 
          ? "Trendline Liquidity Sweep & Reclaim Wick" 
          : (isRedClose ? "Bearish Candle Reaction" : ""));

    if (requireCandleReversal && (!rejectionCheckShort.confirmed && !isRedClose && !isLiquiditySweepReclaim)) {
      return {
        ...defaultResult,
        trendlinePrice: trendlineAtCurrent,
        trendlineSlope: bestLine.slope,
        trendlineAngleDegrees: bestLine.angleDegrees,
        touchesCount: totalEffectiveTouches,
        description: `Tested descending trendline at $${trendlineAtCurrent.toFixed(2)}, waiting for bearish candlestick rejection (Shooting Star, Engulfing, Pin Bar, or Reclaim)`
      };
    }

    // 7. Volume Dynamics
    const pullbackCandles = candles1m.slice(-4, -1);
    const avgPullbackVol = pullbackCandles.length > 0 
      ? pullbackCandles.reduce((s, c) => s + c.volume, 0) / pullbackCandles.length 
      : volSma20;
    const volumeContractionRatio = avgPullbackVol / Math.max(1, volSma20);

    const isVolumeContracted = volumeContractionRatio <= 1.25;
    if (requireVolumeContraction && !isVolumeContracted) {
      return {
        ...defaultResult,
        trendlinePrice: trendlineAtCurrent,
        trendlineSlope: bestLine.slope,
        trendlineAngleDegrees: bestLine.angleDegrees,
        touchesCount: totalEffectiveTouches,
        volumeContractionRatio,
        description: `Trendline test at $${trendlineAtCurrent.toFixed(2)} blocked: high volume on pullback (${volumeContractionRatio.toFixed(2)}x SMA20) suggests heavy aggressive buying`
      };
    }

    const bounceVol = Math.max(volumes[lastIdx], volumes[lastIdx - 1] || 0);
    const bounceVolumeExpansionRatio = Math.round((bounceVol / Math.max(1, avgPullbackVol)) * 100) / 100;
    if (requireBounceVolExpansion && bounceVolumeExpansionRatio < 1.05) {
      return {
        ...defaultResult,
        trendlinePrice: trendlineAtCurrent,
        trendlineSlope: bestLine.slope,
        trendlineAngleDegrees: bestLine.angleDegrees,
        touchesCount: totalEffectiveTouches,
        volumeContractionRatio,
        bounceVolumeExpansionRatio,
        description: `Waiting for volume expansion on trendline rejection candle (${bounceVolumeExpansionRatio}x vs pullback avg)`
      };
    }

    // 8. Multi-Factor High-Confluence Zones (Horizontal S/R + Fibonacci + EMAs)
    const confluenceFactors: string[] = [];
    let isConfluenceWithHorizontal = false;
    let isConfluenceWithFib = false;
    let isConfluenceWithEma = false;
    let matchedConfluenceLevel: number | undefined;

    // A) Horizontal S/R Confluence
    if (ms.trendline_bounce_horizontal_sr_confluence_enabled !== false) {
      const priorPivots = [...swingHighs, ...swingLows].filter(p => p.index < lastIdx - 3);
      for (const pivot of priorPivots) {
        if (Math.abs(trendlineAtCurrent - pivot.price) <= 0.40 * currentAtr) {
          isConfluenceWithHorizontal = true;
          matchedConfluenceLevel = pivot.price;
          confluenceFactors.push(`Horizontal S/R ($${pivot.price.toFixed(1)})`);
          break;
        }
      }
    }

    // B) Fibonacci Golden Pocket Confluence (50% - 61.8%)
    if (ms.trendline_bounce_fib_confluence_enabled !== false) {
      const swingOriginHigh = Math.max(...highs.slice(bestLine.startIndex, lastIdx - 4));
      const swingLegLow = Math.min(...lows.slice(bestLine.startIndex, lastIdx - 1));
      const legHeight = swingOriginHigh - swingLegLow;

      if (legHeight > 1.5 * currentAtr) {
        const fib50 = swingLegLow + 0.50 * legHeight;
        const fib618 = swingLegLow + 0.618 * legHeight;
        if (trendlineAtCurrent <= fib618 + 0.35 * currentAtr && trendlineAtCurrent >= fib50 - 0.35 * currentAtr) {
          isConfluenceWithFib = true;
          matchedConfluenceLevel = matchedConfluenceLevel || fib618;
          confluenceFactors.push(`Fib 50%-61.8% Golden Pocket ($${fib50.toFixed(1)}-$${fib618.toFixed(1)})`);
        }
      }
    }

    // C) Dynamic EMA Confluence
    if (Math.abs(trendlineAtCurrent - ema50) <= 0.40 * currentAtr) {
      isConfluenceWithEma = true;
      matchedConfluenceLevel = matchedConfluenceLevel || ema50;
      confluenceFactors.push(`50 EMA ($${ema50.toFixed(1)})`);
    } else if (Math.abs(trendlineAtCurrent - ema20) <= 0.35 * currentAtr) {
      isConfluenceWithEma = true;
      matchedConfluenceLevel = matchedConfluenceLevel || ema20;
      confluenceFactors.push(`20 EMA ($${ema20.toFixed(1)})`);
    } else if (Math.abs(trendlineAtCurrent - ema200) <= 0.45 * currentAtr) {
      isConfluenceWithEma = true;
      matchedConfluenceLevel = matchedConfluenceLevel || ema200;
      confluenceFactors.push(`200 EMA ($${ema200.toFixed(1)})`);
    }

    let confluenceScore = 50;
    if (isGoldenThirdTouch) confluenceScore += 15;
    if (isLiquiditySweepReclaim) confluenceScore += 20;
    if (confluenceFactors.length > 0) confluenceScore += Math.min(25, confluenceFactors.length * 10);
    confluenceScore = Math.min(100, confluenceScore);

    // 9. Targets & Risk Management
    const recentSwingLow = Math.min(...lows.slice(bestLine.startIndex, lastIdx));
    const bounceExtremeHigh = Math.max(recentHigh, trendlineAtCurrent + (isLiquiditySweepReclaim ? liquiditySweepWickAtr * currentAtr : 0));
    const stopLoss = bounceExtremeHigh + 0.35 * currentAtr;
    const riskDistance = Math.max(1, stopLoss - currentPrice);

    const takeProfit = Math.min(currentPrice - Math.max(2.0 * riskDistance, 2.0 * currentAtr), recentSwingLow);
    const riskReward = Math.round(((currentPrice - takeProfit) / riskDistance) * 100) / 100;

    const touchLabel = isGoldenThirdTouch ? " [GOLDEN 3RD TOUCH]" : ` (Touch #${totalEffectiveTouches})`;
    const sweepLabel = isLiquiditySweepReclaim ? ` [LIQUIDITY SWEEP RECLAIM: +${liquiditySweepWickAtr}x ATR wick]` : "";
    const confluenceLabel = confluenceFactors.length > 0 ? ` [CONFLUENCE: ${confluenceFactors.join(" + ")}]` : "";

    return {
      isValid: true,
      direction: "SHORT",
      trendlinePrice: trendlineAtCurrent,
      trendlineSlope: bestLine.slope,
      trendlineAngleDegrees: bestLine.angleDegrees,
      touchesCount: totalEffectiveTouches,
      touchIndices: bestLine.touches,
      isGoldenThirdTouch,
      isLiquiditySweepReclaim,
      liquiditySweepWickAtr,
      rejectionPattern: rejectionPattern || "Bearish Trendline Rebound",
      volumeContractionRatio,
      bounceVolumeExpansionRatio,
      isConfluenceWithHorizontal,
      isConfluenceWithFib,
      isConfluenceWithEma,
      confluenceFactors,
      confluenceScore,
      confluenceLevel: matchedConfluenceLevel,
      stopLoss,
      takeProfit,
      riskReward,
      description: `Descending Trendline Bounce Confirmed${touchLabel}${sweepLabel}${confluenceLabel}: Tested dynamic trendline resistance at $${trendlineAtCurrent.toFixed(2)} (Angle ${bestLine.angleDegrees}°) with [${rejectionPattern || "Bearish Reaction"}] and contracting volume (${volumeContractionRatio.toFixed(2)}x SMA20). Target TP: $${takeProfit.toFixed(1)} (${riskReward.toFixed(1)}R).`,
    };
  }

  return defaultResult;
}
