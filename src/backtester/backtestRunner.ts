/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Candlestick, MarketRegime, StrategyConfig } from "../types.js";
import {
  BacktestRequest,
  BacktestResult,
  BacktestTrade,
  BacktestSetupOption,
  RegimePerformance,
  BacktestRankItem,
  BacktestRankResult,
} from "./types.js";
import { fetchBinanceHistoricalKlines } from "./binanceFetcher.js";
import {
  SetupContext,
  evaluateTrendlineBounceSetup,
  evaluateFailedAuctionSetup,
  evaluateFairValueGapSetup,
  evaluateVwapBandRejectionSetup,
  evaluateEqhEqlDoubleTouchSetup,
  evaluateCvdAbsorptionSetup,
  evaluateOiFlushCascadeFadeSetup,
  evaluateFreshMomentumImpulseSetup,
  evaluateLiquiditySweepSetup,
} from "../engine/setups/index.js";
import { IndicatorCalculator } from "../engine/indicators.js";
import { rollingBufferManager, isWeekend } from "./rollingBuffer.js";

export const AVAILABLE_SETUPS: BacktestSetupOption[] = [
  {
    id: "setup_1_pullback_retest",
    name: "Setup 1: Pullback & Retest",
    description: "Breakout of key horizontal range boundary followed by retest of broken level as new support/resistance with rejection confirmation.",
    category: "trend",
  },
  {
    id: "setup_2_dynamic_ema_pushback",
    name: "Setup 2: Dynamic EMA Pushback",
    description: "Trend continuation bounce off dynamic EMA 20/50 support/resistance band with trend alignment and volume expansion.",
    category: "trend",
  },
  {
    id: "setup_3_liquidity_sweep",
    name: "Setup 3: Liquidity Sweep Reversal",
    description: "Aggressive multi-timeframe swing high/low sweep that rapidly reclaims internal structure with CVD delta absorption.",
    category: "reversal",
  },
  {
    id: "setup_4_fvg_retest",
    name: "Setup 4: Fair Value Gap Retest",
    description: "Impulse imbalance mitigation at consequent encroachment (50% CE) with institutional volume validation.",
    category: "trend",
  },
  {
    id: "setup_9_range_failed_auction",
    name: "Setup 9: Range Failed Auction Reclaim",
    description: "Swing Failure Pattern (SFP) outside range boundary that snaps back inside with order flow absorption.",
    category: "reversal",
  },
  {
    id: "setup_10_vwap_band_rejection",
    name: "Setup 10: VWAP Band Rejection",
    description: "Mean-reversion bounce off ±2 standard deviation VWAP bands with CVD exhaustion and delta divergence.",
    category: "reversal",
  },
  {
    id: "setup_11_eqh_eql_double_touch",
    name: "Setup 11: EQH/EQL Double Touch",
    description: "Equal Highs/Equal Lows liquidity grab sweep with rapid pin-bar reclaim.",
    category: "reversal",
  },
  {
    id: "setup_12_cvd_absorption",
    name: "Setup 12: CVD Absorption & Delta Divergence",
    description: "Heavy delta divergence where aggressive taker market orders fail to push price through passive limit walls.",
    category: "orderflow",
  },
  {
    id: "setup_13_oi_flush_cascade",
    name: "Setup 13: OI Flush & Cascade Fade",
    description: "Fades sudden liquidation-driven cascade extremes coinciding with rapid Open Interest contraction and exhaustion wicks.",
    category: "orderflow",
  },
  {
    id: "setup_14_fresh_momentum_impulse",
    name: "Setup 14: Fresh Momentum Impulse",
    description: "High-velocity breakout continuation with volume expansion and trend alignment.",
    category: "trend",
  },
  {
    id: "setup_15_trendline_bounce",
    name: "Setup 15: Trendline Bounce & Retest",
    description: "Multi-touch ascending/descending dynamic trendline bounce with golden 3rd touch and liquidity sweep reclaim.",
    category: "trend",
  },
  {
    id: "all",
    name: "All Core Setups Combined",
    description: "Evaluates all 11 setups collectively using global multi-regime priority rules.",
    category: "trend",
  },
];

/**
 * Institutional Dynamic Market Regime Gating Matrix
 * Matches the live trading engine's strict regime permissions.
 * Any setup not included in the allowed list for the current regime is strictly blocked.
 */
export const DYNAMIC_REGIME_GATING_MATRIX: Record<string, MarketRegime[]> = {
  setup_1_pullback_retest: [MarketRegime.STRONG_UPTREND, MarketRegime.STRONG_DOWNTREND],
  setup_2_dynamic_ema_pushback: [MarketRegime.STRONG_UPTREND, MarketRegime.STRONG_DOWNTREND],
  setup_3_liquidity_sweep: [MarketRegime.RANGE_BOUND, MarketRegime.HIGH_VOLATILITY, MarketRegime.LOW_VOLATILITY],
  setup_4_fvg_retest: [MarketRegime.STRONG_UPTREND, MarketRegime.STRONG_DOWNTREND, MarketRegime.RANGE_BOUND, MarketRegime.HIGH_VOLATILITY],
  setup_9_range_failed_auction: [MarketRegime.RANGE_BOUND, MarketRegime.LOW_VOLATILITY],
  setup_10_vwap_band_rejection: [MarketRegime.RANGE_BOUND, MarketRegime.LOW_VOLATILITY],
  setup_11_eqh_eql_double_touch: [MarketRegime.RANGE_BOUND, MarketRegime.LOW_VOLATILITY],
  setup_12_cvd_absorption: [MarketRegime.RANGE_BOUND, MarketRegime.HIGH_VOLATILITY],
  setup_13_oi_flush_cascade: [MarketRegime.HIGH_VOLATILITY, MarketRegime.RANGE_BOUND],
  setup_14_fresh_momentum_impulse: [MarketRegime.STRONG_UPTREND, MarketRegime.STRONG_DOWNTREND, MarketRegime.HIGH_VOLATILITY],
  setup_15_trendline_bounce: [MarketRegime.STRONG_UPTREND, MarketRegime.STRONG_DOWNTREND, MarketRegime.HIGH_VOLATILITY, MarketRegime.RANGE_BOUND],
};

export function isSetupGatedByRegimeMatrix(
  setupId: string,
  direction: "LONG" | "SHORT",
  currentRegime: MarketRegime,
  currentAdx: number = 25
): { allowed: boolean; reason?: string } {
  const allowedRegimes = DYNAMIC_REGIME_GATING_MATRIX[setupId] || Object.values(MarketRegime);

  // 1. Dynamic Market Regime Gating Matrix Check
  if (!allowedRegimes.includes(currentRegime)) {
    return {
      allowed: false,
      reason: `Prohibited in current ${currentRegime} regime by Dynamic Market Regime Gating Matrix. Allowed: [${allowedRegimes.join(", ")}].`,
    };
  }

  // 2. Directional Counter-trend Safeguard for Mean Reversion setups
  const isMeanReversion = [
    "setup_3_liquidity_sweep",
    "setup_9_range_failed_auction",
    "setup_10_vwap_band_rejection",
    "setup_11_eqh_eql_double_touch",
  ].includes(setupId);

  if (isMeanReversion) {
    if (direction === "LONG" && currentRegime === MarketRegime.STRONG_DOWNTREND) {
      return { allowed: false, reason: "Counter-trend Long prohibited in STRONG_DOWNTREND." };
    }
    if (direction === "SHORT" && currentRegime === MarketRegime.STRONG_UPTREND) {
      return { allowed: false, reason: "Counter-trend Short prohibited in STRONG_UPTREND." };
    }
    // Fix E: Specific sideways ADX ceiling for Setup 10 (ADX <= 22), otherwise 32 for general mean reversion
    const maxMeanRevAdx = setupId === "setup_10_vwap_band_rejection" ? 22 : 32;
    if (currentAdx > maxMeanRevAdx) {
      return { allowed: false, reason: `ADX (${currentAdx.toFixed(1)}) exceeds mean-reversion ceiling (${maxMeanRevAdx}).` };
    }
  }

  // 3. Dynamic Condition Rules: Trend setups minimum momentum requirement
  if (["setup_1_pullback_retest", "setup_2_dynamic_ema_pushback", "setup_15_trendline_bounce"].includes(setupId)) {
    const minAdxReq = setupId === "setup_2_dynamic_ema_pushback" ? 22 : 20;
    if (currentAdx < minAdxReq) {
      return { allowed: false, reason: `ADX (${currentAdx.toFixed(1)}) below minimum trend threshold (${minAdxReq}).` };
    }
  }

  return { allowed: true };
}

export async function runIsolatedBacktest(
  request: BacktestRequest
): Promise<BacktestResult> {
  const symbol = request.symbol || "BTCUSDT";
  const days = Math.min(30, Math.max(1, request.days || 3));
  const initialBalance = request.initialBalance || 10000;
  const positionSizeBtc = request.positionSizeBtc || 0.01;
  const leverage = request.leverage || 20;
  const simulateFees = request.simulateFees !== false;

  const nowMs = Date.now();
  const endTimeMs = request.endTime || nowMs;
  const startTimeMs = request.startTime || endTimeMs - days * 24 * 60 * 60 * 1000;
  const excludeWeekends = request.excludeWeekends !== false;

  // 1. Source authentic 1m data (prefer active rolling buffer to eliminate network latency)
  let allCandles: (Candlestick & { takerBuyVolume: number })[] = [];
  const targetCandleCount = days * 1440;
  const bufferedCandles = rollingBufferManager.getCandles({
    days,
    excludeWeekends,
    maxCandles: targetCandleCount,
  });

  if (bufferedCandles.length >= Math.min(targetCandleCount, 1440)) {
    allCandles = bufferedCandles;
  } else {
    // Fall back to direct fetch if buffer is warming up
    const fetched = await fetchBinanceHistoricalKlines(symbol, startTimeMs, endTimeMs);
    allCandles = excludeWeekends
      ? (fetched.filter((c) => !isWeekend(c.time * 1000)) as (Candlestick & { takerBuyVolume: number })[])
      : (fetched as (Candlestick & { takerBuyVolume: number })[]);
  }

  if (allCandles.length < 60) {
    throw new Error(
      `Insufficient historical candle data: got ${allCandles.length} candles (weekends excluded: ${excludeWeekends}), minimum 60 required.`
    );
  }

  const selectedSetupOption =
    AVAILABLE_SETUPS.find((s) => s.id === request.setupId) || AVAILABLE_SETUPS[0];

  // 2. Prepare simulation variables
  let currentBalance = initialBalance;
  let peakBalance = initialBalance;
  let maxDrawdownUsd = 0;
  let maxDrawdownPercent = 0;
  let gatedSignalsCount = 0;

  const trades: BacktestTrade[] = [];
  const indicatorCalculator = new IndicatorCalculator();

  const equityCurve: { timestamp: string; equity: number }[] = [
    { timestamp: new Date(allCandles[0].time * 1000).toISOString(), equity: initialBalance },
  ];

  // Baseline ATR across whole period for regime normalization
  const fullCloses = allCandles.map((c) => c.close);
  const fullAtrSeries = indicatorCalculator.calculateATR(allCandles, 14);
  const baselineAtr = fullAtrSeries[fullAtrSeries.length - 1] || 50;

  // 3. Step candle-by-candle through historical stream
  const warmup = 45;
  let i = warmup;

  while (i < allCandles.length - 10) {
    const currentCandle = allCandles[i];
    const currentPrice = currentCandle.close;

    // Sliding window of candles up to the current moment
    const candleSlice = allCandles.slice(Math.max(0, i - 60), i + 1);
    const sliceCloses = candleSlice.map((c) => c.close);
    const sliceHighs = candleSlice.map((c) => c.high);
    const sliceLows = candleSlice.map((c) => c.low);
    const sliceLastIdx = candleSlice.length - 1;

    // Indicators on current slice
    const atrSeries = indicatorCalculator.calculateATR(candleSlice, 14);
    const currentAtr = atrSeries[sliceLastIdx] || (sliceHighs[sliceLastIdx] - sliceLows[sliceLastIdx]) || 50;

    const adxSeries = indicatorCalculator.calculateADX(candleSlice, 14);
    const currentAdx = adxSeries[sliceLastIdx] || 20;

    const ema9 = indicatorCalculator.calculateEMA(sliceCloses, 9)[sliceLastIdx] || currentPrice;
    const ema20Series = indicatorCalculator.calculateEMA(sliceCloses, 20);
    const ema20 = ema20Series[sliceLastIdx] || currentPrice;
    const ema20Prev = ema20Series[sliceLastIdx - 2] || ema20;
    const ema50 = indicatorCalculator.calculateEMA(sliceCloses, 50)[sliceLastIdx] || currentPrice;
    const ema200 = indicatorCalculator.calculateEMA(sliceCloses, 200)[sliceLastIdx] || currentPrice;

    // Real order flow metrics from Binance kline taker data
    const recent3 = candleSlice.slice(-3);
    const recent3Vol = recent3.reduce((s, c) => s + c.volume, 0);
    const recent3Taker = recent3.reduce((s, c) => s + ((c as any).takerBuyVolume || c.volume * 0.5), 0);
    const takerBuyRatio = recent3Vol > 0 ? recent3Taker / recent3Vol : 0.5;

    const orderFlowStats = {
      takerBuyVolume: recent3Taker,
      takerSellVolume: recent3Vol - recent3Taker,
      takerBuyRatio,
      netCVD: (recent3Taker - (recent3Vol - recent3Taker)),
      cvdSlope: (takerBuyRatio - 0.5) * 100,
      deltaDivergence: false,
      lastUpdateSecs: Math.floor(currentCandle.time),
    };

    const orderBookStats = {
      imbalanceRatio: (takerBuyRatio - 0.5) * 0.6,
      spreadUsd: currentPrice * 0.0001,
      bidLiquidity: 100,
      askLiquidity: 100,
      bidDepthBTC: 100,
      askDepthBTC: 100,
      lastUpdateSecs: Math.floor(currentCandle.time),
    };

    const openInterestStats = {
      currentOI: 10000,
      prevOI_1m: 10000,
      prevOI_5m: 10000,
      oiChange1m: 0,
      oiChangePct1m: 0,
      oiChange5m: 0,
      oiChangePct5m: 0,
      lastUpdateSecs: Math.floor(currentCandle.time),
    };

    // Determine Market Regime (Using 50-bar rolling ATR expansion & multi-EMA alignment)
    const lookbackAtr = Math.min(candleSlice.length, 50);
    let sumAtrLong = 0;
    for (let k = sliceLastIdx - lookbackAtr + 1; k <= sliceLastIdx; k++) {
      sumAtrLong += atrSeries[k] || 50;
    }
    const longTermAtr = sumAtrLong / lookbackAtr;
    const atrExpansionRatio = currentAtr / (longTermAtr || 1);

    // EMA Alignment for Regime
    const isBullAligned = ema9 > ema20 && ema20 > ema50;
    const isBearAligned = ema9 < ema20 && ema20 < ema50;

    let currentRegime: MarketRegime = MarketRegime.RANGE_BOUND;
    if (atrExpansionRatio < 0.65) {
      currentRegime = MarketRegime.LOW_VOLATILITY;
    } else if (atrExpansionRatio > 1.45) {
      currentRegime = MarketRegime.HIGH_VOLATILITY;
    } else if (isBullAligned && (currentAdx > 22 || (currentPrice > ema20 && currentAdx > 18))) {
      currentRegime = MarketRegime.STRONG_UPTREND;
    } else if (isBearAligned && (currentAdx > 22 || (currentPrice < ema20 && currentAdx > 18))) {
      currentRegime = MarketRegime.STRONG_DOWNTREND;
    } else {
      currentRegime = MarketRegime.RANGE_BOUND;
    }

    const mockConfig = {
      market_structure: {
        pullback_retest_enabled: true,
        ema_pushback_enabled: true,
        liquidity_sweep_enabled: true,
        trendline_bounce_strategy_enabled: true,
        failed_auction_strategy_enabled: true,
        fvg_strategy_enabled: true,
        vwap_strategy_enabled: true,
        vwap_band_reversal_enabled: true,
        vwap_band_reversal_deviation_mult: 2.2,
        vwap_band_reversal_min_reward_usd: 120,
        vwap_band_reversal_max_adx: 22,
        double_touch_strategy_enabled: true,
        cvd_absorption_strategy_enabled: true,
        oi_flush_strategy_enabled: true,
        momentum_impulse_strategy_enabled: true,
        fresh_momentum_strategy_enabled: true,
        fresh_momentum_min_vol_mult: 1.60,
        fresh_momentum_min_body_ratio: 0.60,
      },
      risk_management: {
        default_stop_loss_atr: 1.25,
        default_take_profit_atr: 1.5,
        min_rr_ratio_floor: 1.35,
      },
    } as unknown as StrategyConfig;

    const ctx: SetupContext = {
      candles1m: candleSlice,
      currentPrice,
      currentRegime,
      indicators: indicatorCalculator,
      orderFlowStats,
      orderBookStats,
      openInterestStats,
      config: mockConfig,
    };

    // 4. Evaluate Setup Signals with Strict Dynamic Market Regime Gating Matrix
    let signal: {
      direction: "LONG" | "SHORT";
      setupId: string;
      setupName: string;
      stopLoss: number;
      takeProfit: number;
      description: string;
    } | null = null;

    const targetSetup = request.setupId;

    // Helper to evaluate and apply strict Dynamic Market Regime Gating Matrix
    const tryEmitSignal = (
      setupId: string,
      direction: "LONG" | "SHORT",
      setupName: string,
      stopLoss: number,
      takeProfit: number,
      description: string
    ) => {
      const gate = isSetupGatedByRegimeMatrix(setupId, direction, currentRegime, currentAdx);
      if (gate.allowed) {
        signal = {
          direction,
          setupId,
          setupName,
          stopLoss,
          takeProfit,
          description,
        };
      } else {
        gatedSignalsCount++;
      }
    };

    // Setup 1: Pullback & Retest
    if (!signal && (targetSetup === "setup_1_pullback_retest" || targetSetup === "all")) {
      const rangeSlice = candleSlice.slice(-35, -5);
      if (rangeSlice.length >= 20) {
        const rHigh = Math.max(...rangeSlice.map((c) => c.high));
        const rLow = Math.min(...rangeSlice.map((c) => c.low));
        const recentCandles = candleSlice.slice(-5);

        // LONG: prior breakout above rHigh, current candle pulls back to rHigh and bounces
        const hadBreakoutHigh = recentCandles.some((c) => c.close > rHigh);
        const isRetestingHigh = currentCandle.low <= rHigh + 0.4 * currentAtr && currentCandle.close >= rHigh - 0.2 * currentAtr;
        const isBullishCandle = currentCandle.close > currentCandle.open && (currentCandle.close - currentCandle.low) > 0.4 * (currentCandle.high - currentCandle.low);

        if (hadBreakoutHigh && isRetestingHigh && isBullishCandle) {
          tryEmitSignal(
            "setup_1_pullback_retest",
            "LONG",
            "Setup 1: Pullback & Retest",
            Math.min(currentPrice - 1.25 * currentAtr, rHigh - 0.75 * currentAtr),
            currentPrice + 1.8 * currentAtr,
            `Pullback & retest of broken range high ($${rHigh.toFixed(2)}) as new support with bullish rejection.`
          );
        } else {
          // SHORT: prior breakdown below rLow, current candle pulls back to rLow and rejects
          const hadBreakdownLow = recentCandles.some((c) => c.close < rLow);
          const isRetestingLow = currentCandle.high >= rLow - 0.4 * currentAtr && currentCandle.close <= rLow + 0.2 * currentAtr;
          const isBearishCandle = currentCandle.close < currentCandle.open && (currentCandle.high - currentCandle.close) > 0.4 * (currentCandle.high - currentCandle.low);

          if (hadBreakdownLow && isRetestingLow && isBearishCandle) {
            tryEmitSignal(
              "setup_1_pullback_retest",
              "SHORT",
              "Setup 1: Pullback & Retest",
              Math.max(currentPrice + 1.25 * currentAtr, rLow + 0.75 * currentAtr),
              currentPrice - 1.8 * currentAtr,
              `Pullback & retest of broken range low ($${rLow.toFixed(2)}) as new resistance with bearish rejection.`
            );
          }
        }
      }
    }

    // Setup 2: Dynamic EMA Pushback
    if (!signal && (targetSetup === "setup_2_dynamic_ema_pushback" || targetSetup === "all")) {
      const hasEmaSeparation = Math.abs(ema20 - ema50) >= 0.40 * currentAtr;
      if (hasEmaSeparation && ema20 > ema50 && currentPrice > ema50 && ema20 >= ema20Prev) {
        const touchedEma = currentCandle.low <= ema20 + 0.25 * currentAtr && currentCandle.close >= ema20 - 0.2 * currentAtr;
        const isBullishBounce = currentCandle.close > currentCandle.open && (currentCandle.close - currentCandle.low) > 0.4 * (currentCandle.high - currentCandle.low);
        if (touchedEma && isBullishBounce) {
          const targetDist = Math.max(140, 2.40 * currentAtr);
          const stopDist = Math.min(1.20 * currentAtr, Math.max(0.65 * currentAtr, currentPrice - ema50 + 0.20 * currentAtr));
          tryEmitSignal(
            "setup_2_dynamic_ema_pushback",
            "LONG",
            "Setup 2: Dynamic EMA Pushback",
            currentPrice - stopDist,
            currentPrice + targetDist,
            `Dynamic EMA 20 ($${ema20.toFixed(2)}) / 50 ($${ema50.toFixed(2)}) trend bounce with fee-positive target (+$${targetDist.toFixed(1)}) and bounded risk.`
          );
        }
      } else if (hasEmaSeparation && ema20 < ema50 && currentPrice < ema50 && ema20 <= ema20Prev) {
        const touchedEma = currentCandle.high >= ema20 - 0.25 * currentAtr && currentCandle.close <= ema20 + 0.2 * currentAtr;
        const isBearishReject = currentCandle.close < currentCandle.open && (currentCandle.high - currentCandle.close) > 0.4 * (currentCandle.high - currentCandle.low);
        if (touchedEma && isBearishReject) {
          const targetDist = Math.max(140, 2.40 * currentAtr);
          const stopDist = Math.min(1.20 * currentAtr, Math.max(0.65 * currentAtr, ema50 - currentPrice + 0.20 * currentAtr));
          tryEmitSignal(
            "setup_2_dynamic_ema_pushback",
            "SHORT",
            "Setup 2: Dynamic EMA Pushback",
            currentPrice + stopDist,
            currentPrice - targetDist,
            `Dynamic EMA 20 ($${ema20.toFixed(2)}) / 50 ($${ema50.toFixed(2)}) trend pushback with fee-positive target (-$${targetDist.toFixed(1)}) and bounded risk.`
          );
        }
      }
    }

    // Setup 3: Liquidity Sweep Reversal
    if (!signal && (targetSetup === "setup_3_liquidity_sweep" || targetSetup === "all")) {
      const longRes = evaluateLiquiditySweepSetup("LONG", ctx);
      if (longRes.isValid) {
        tryEmitSignal(
          "setup_3_liquidity_sweep",
          "LONG",
          "Setup 3: Liquidity Sweep Reversal",
          longRes.stopLoss,
          longRes.takeProfit,
          longRes.description
        );
      } else {
        const shortRes = evaluateLiquiditySweepSetup("SHORT", ctx);
        if (shortRes.isValid) {
          tryEmitSignal(
            "setup_3_liquidity_sweep",
            "SHORT",
            "Setup 3: Liquidity Sweep Reversal",
            shortRes.stopLoss,
            shortRes.takeProfit,
            shortRes.description
          );
        }
      }
    }

    // Setup 15: Trendline Bounce
    if (!signal && (targetSetup === "setup_15_trendline_bounce" || targetSetup === "all")) {
      const longRes = evaluateTrendlineBounceSetup("LONG", ctx);
      if (longRes.isValid) {
        tryEmitSignal(
          "setup_15_trendline_bounce",
          "LONG",
          "Setup 15: Trendline Bounce & Retest",
          longRes.stopLoss,
          longRes.takeProfit,
          longRes.description
        );
      } else {
        const shortRes = evaluateTrendlineBounceSetup("SHORT", ctx);
        if (shortRes.isValid) {
          tryEmitSignal(
            "setup_15_trendline_bounce",
            "SHORT",
            "Setup 15: Trendline Bounce & Retest",
            shortRes.stopLoss,
            shortRes.takeProfit,
            shortRes.description
          );
        }
      }
    }

    // Setup 9: Range Failed Auction
    if (!signal && (targetSetup === "setup_9_range_failed_auction" || targetSetup === "all")) {
      const longRes = evaluateFailedAuctionSetup("LONG", ctx);
      if (longRes.isValid) {
        tryEmitSignal(
          "setup_9_range_failed_auction",
          "LONG",
          "Setup 9: Range Failed Auction / Support Bounce",
          longRes.stopLoss,
          longRes.takeProfit,
          longRes.description
        );
      } else {
        const shortRes = evaluateFailedAuctionSetup("SHORT", ctx);
        if (shortRes.isValid) {
          tryEmitSignal(
            "setup_9_range_failed_auction",
            "SHORT",
            "Setup 9: Range Failed Auction / Resistance Rejection",
            shortRes.stopLoss,
            shortRes.takeProfit,
            shortRes.description
          );
        }
      }
    }

    // Setup 4: Fair Value Gap Retest
    if (!signal && (targetSetup === "setup_4_fvg_retest" || targetSetup === "all")) {
      const longRes = evaluateFairValueGapSetup("LONG", ctx);
      if (longRes.isValid) {
        tryEmitSignal(
          "setup_4_fvg_retest",
          "LONG",
          "Setup 4: Fair Value Gap Retest",
          longRes.stopLoss,
          longRes.takeProfit,
          longRes.description
        );
      } else {
        const shortRes = evaluateFairValueGapSetup("SHORT", ctx);
        if (shortRes.isValid) {
          tryEmitSignal(
            "setup_4_fvg_retest",
            "SHORT",
            "Setup 4: Fair Value Gap Retest",
            shortRes.stopLoss,
            shortRes.takeProfit,
            shortRes.description
          );
        }
      }
    }

    // Setup 10: VWAP Band Rejection
    if (!signal && (targetSetup === "setup_10_vwap_band_rejection" || targetSetup === "all")) {
      const longRes = evaluateVwapBandRejectionSetup("LONG", ctx);
      if (longRes.isValid) {
        tryEmitSignal(
          "setup_10_vwap_band_rejection",
          "LONG",
          "Setup 10: VWAP Band Rejection",
          longRes.stopLoss,
          longRes.takeProfit,
          longRes.description
        );
      } else {
        const shortRes = evaluateVwapBandRejectionSetup("SHORT", ctx);
        if (shortRes.isValid) {
          tryEmitSignal(
            "setup_10_vwap_band_rejection",
            "SHORT",
            "Setup 10: VWAP Band Rejection",
            shortRes.stopLoss,
            shortRes.takeProfit,
            shortRes.description
          );
        }
      }
    }

    // Setup 11: EQH/EQL Double Touch
    if (!signal && (targetSetup === "setup_11_eqh_eql_double_touch" || targetSetup === "all")) {
      const longRes = evaluateEqhEqlDoubleTouchSetup("LONG", ctx);
      if (longRes.isValid) {
        tryEmitSignal(
          "setup_11_eqh_eql_double_touch",
          "LONG",
          "Setup 11: EQH/EQL Double Touch",
          longRes.stopLoss,
          longRes.takeProfit,
          longRes.description
        );
      } else {
        const shortRes = evaluateEqhEqlDoubleTouchSetup("SHORT", ctx);
        if (shortRes.isValid) {
          tryEmitSignal(
            "setup_11_eqh_eql_double_touch",
            "SHORT",
            "Setup 11: EQH/EQL Double Touch",
            shortRes.stopLoss,
            shortRes.takeProfit,
            shortRes.description
          );
        }
      }
    }

    // Setup 12: CVD Absorption
    if (!signal && (targetSetup === "setup_12_cvd_absorption" || targetSetup === "all")) {
      const longRes = evaluateCvdAbsorptionSetup("LONG", ctx);
      if (longRes.isValid) {
        tryEmitSignal(
          "setup_12_cvd_absorption",
          "LONG",
          "Setup 12: CVD Absorption",
          longRes.stopLoss,
          longRes.takeProfit,
          longRes.description
        );
      } else {
        const shortRes = evaluateCvdAbsorptionSetup("SHORT", ctx);
        if (shortRes.isValid) {
          tryEmitSignal(
            "setup_12_cvd_absorption",
            "SHORT",
            "Setup 12: CVD Absorption",
            shortRes.stopLoss,
            shortRes.takeProfit,
            shortRes.description
          );
        }
      }
    }

    // Setup 13: OI Flush & Cascade Fade
    if (!signal && (targetSetup === "setup_13_oi_flush_cascade" || targetSetup === "all")) {
      const longRes = evaluateOiFlushCascadeFadeSetup("LONG", ctx);
      if (longRes.isValid) {
        tryEmitSignal(
          "setup_13_oi_flush_cascade",
          "LONG",
          "Setup 13: OI Flush & Cascade Fade",
          longRes.stopLoss,
          longRes.takeProfit,
          longRes.description
        );
      } else {
        const shortRes = evaluateOiFlushCascadeFadeSetup("SHORT", ctx);
        if (shortRes.isValid) {
          tryEmitSignal(
            "setup_13_oi_flush_cascade",
            "SHORT",
            "Setup 13: OI Flush & Cascade Fade",
            shortRes.stopLoss,
            shortRes.takeProfit,
            shortRes.description
          );
        }
      }
    }

    // Setup 14: Fresh Momentum Impulse
    if (!signal && (targetSetup === "setup_14_fresh_momentum_impulse" || targetSetup === "all")) {
      const longRes = evaluateFreshMomentumImpulseSetup("LONG", ctx);
      if (longRes.isValid) {
        tryEmitSignal(
          "setup_14_fresh_momentum_impulse",
          "LONG",
          "Setup 14: Fresh Momentum Impulse",
          longRes.stopLoss,
          longRes.takeProfit,
          longRes.description
        );
      } else {
        const shortRes = evaluateFreshMomentumImpulseSetup("SHORT", ctx);
        if (shortRes.isValid) {
          tryEmitSignal(
            "setup_14_fresh_momentum_impulse",
            "SHORT",
            "Setup 14: Fresh Momentum Impulse",
            shortRes.stopLoss,
            shortRes.takeProfit,
            shortRes.description
          );
        }
      }
    }

    // 5. If a Trade Signal Triggered, Simulate Forward Candle Pathing
    if (signal) {
      const entryPrice = currentPrice;
      const entryTimeMs = currentCandle.time * 1000;
      const entryAtr = currentAtr;
      const targetSl = signal.stopLoss;
      const targetTp = signal.takeProfit;
      let currentSl = targetSl;

      let exitPrice = entryPrice;
      let exitTimeMs = entryTimeMs;
      let exitReason: "TAKE_PROFIT" | "STOP_LOSS" | "TIME_LIMIT" = "TIME_LIMIT";
      let peakFavorablePrice = entryPrice;
      let peakAdversePrice = entryPrice;

      const maxForwardCandles = 29; // Standard 29m hard duration limit
      let forwardIdx = 1;

      while (forwardIdx <= maxForwardCandles && i + forwardIdx < allCandles.length) {
        const futureCandle = allCandles[i + forwardIdx];
        exitTimeMs = futureCandle.time * 1000;

        if (signal.direction === "LONG") {
          peakFavorablePrice = Math.max(peakFavorablePrice, futureCandle.high);
          peakAdversePrice = Math.min(peakAdversePrice, futureCandle.low);

          // 1. Check TP first if high breached target
          if (futureCandle.high >= targetTp) {
            exitPrice = targetTp;
            exitReason = "TAKE_PROFIT";
            break;
          }
          // 2. Check existing SL before ratcheting
          if (futureCandle.low <= currentSl) {
            exitPrice = currentSl;
            exitReason = "STOP_LOSS";
            break;
          }

          // 3. Fix B & Win-Rate Calibration: Fee-Positive Dynamic Breakeven Ratchet for Setup 14 and Setup 2
          // On 0.01 BTC position, $84 BTC offset is required to overcome round-trip exchange fees ($0.84)
          // Lock in Math.max(88, 0.40 * entryAtr) once price moves favorably by >= 1.15 * entryAtr
          if (signal.setupId === "setup_14_fresh_momentum_impulse" || signal.setupId === "setup_2_dynamic_ema_pushback") {
            const feeBufferBtc = Math.max(88, 0.40 * entryAtr);
            const favorableDist = futureCandle.close - entryPrice;
            if (favorableDist >= 1.15 * entryAtr) {
              currentSl = Math.max(currentSl, entryPrice + feeBufferBtc);
            }
          }
        } else {
          // SHORT
          peakFavorablePrice = Math.min(peakFavorablePrice, futureCandle.low);
          peakAdversePrice = Math.max(peakAdversePrice, futureCandle.high);

          // 1. Check TP first
          if (futureCandle.low <= targetTp) {
            exitPrice = targetTp;
            exitReason = "TAKE_PROFIT";
            break;
          }
          // 2. Check existing SL before ratcheting
          if (futureCandle.high >= currentSl) {
            exitPrice = currentSl;
            exitReason = "STOP_LOSS";
            break;
          }

          // 3. Fix B & Win-Rate Calibration: Fee-Positive Dynamic Breakeven Ratchet for Setup 14 and Setup 2
          if (signal.setupId === "setup_14_fresh_momentum_impulse" || signal.setupId === "setup_2_dynamic_ema_pushback") {
            const feeBufferBtc = Math.max(88, 0.40 * entryAtr);
            const favorableDist = entryPrice - futureCandle.close;
            if (favorableDist >= 1.15 * entryAtr) {
              currentSl = Math.min(currentSl, entryPrice - feeBufferBtc);
            }
          }
        }

        exitPrice = futureCandle.close;
        forwardIdx++;
      }

      // Calculations for PnL & Excursions
      const favorableDistance =
        signal.direction === "LONG"
          ? peakFavorablePrice - entryPrice
          : entryPrice - peakFavorablePrice;
      const adverseDistance =
        signal.direction === "LONG"
          ? entryPrice - peakAdversePrice
          : peakAdversePrice - entryPrice;

      const grossPnlPoints =
        signal.direction === "LONG" ? exitPrice - entryPrice : entryPrice - exitPrice;
      const grossPnlUsd = grossPnlPoints * positionSizeBtc;

      // Fix C & E: Setup 10 utilizes Post-Only Maker limit entry (0.015%) and resting limit TP exit (0.015%)
      // Setup 14 & Setup 2 utilize Taker entry (0.05%) and resting limit TP exit (0.015% Maker)
      // Stop Loss exit triggers as a stop-market taker order (0.05%)
      const isSetup10Maker = signal.setupId === "setup_10_vwap_band_rejection";
      const isMakerTpSetup = signal.setupId === "setup_10_vwap_band_rejection" || signal.setupId === "setup_14_fresh_momentum_impulse" || signal.setupId === "setup_2_dynamic_ema_pushback";

      const entryFeeRate = isSetup10Maker ? 0.00015 : 0.0005;
      const exitFeeRate = (isMakerTpSetup && exitReason === "TAKE_PROFIT") ? 0.00015 : 0.0005;

      const notionalEntryUsd = entryPrice * positionSizeBtc;
      const notionalExitUsd = exitPrice * positionSizeBtc;
      const feesUsd = simulateFees ? (notionalEntryUsd * entryFeeRate + notionalExitUsd * exitFeeRate) : 0;
      const netPnlUsd = grossPnlUsd - feesUsd;
      const pnlPercent = (netPnlUsd / (notionalEntryUsd / leverage)) * 100;

      currentBalance += netPnlUsd;
      peakBalance = Math.max(peakBalance, currentBalance);
      const currentDrawdown = peakBalance - currentBalance;
      const currentDrawdownPct = peakBalance > 0 ? (currentDrawdown / peakBalance) * 100 : 0;

      maxDrawdownUsd = Math.max(maxDrawdownUsd, currentDrawdown);
      maxDrawdownPercent = Math.max(maxDrawdownPercent, currentDrawdownPct);

      const holdDurationSeconds = Math.max(60, Math.round((exitTimeMs - entryTimeMs) / 1000));

      trades.push({
        id: `bt_${trades.length + 1}`,
        timestamp: new Date(entryTimeMs).toISOString(),
        entryTimestampMs: entryTimeMs,
        exitTimestampMs: exitTimeMs,
        setupId: signal.setupId,
        setupName: signal.setupName,
        direction: signal.direction,
        entryPrice,
        exitPrice,
        stopLoss: targetSl,
        takeProfit: targetTp,
        entryAtr,
        maxFavorableExcursionUsd: Math.max(0, favorableDistance),
        maxFavorableExcursionAtr: Math.max(0, favorableDistance / entryAtr),
        maxAdverseExcursionUsd: Math.max(0, adverseDistance),
        maxAdverseExcursionAtr: Math.max(0, adverseDistance / entryAtr),
        exitReason,
        holdDurationSeconds,
        grossPnlUsd,
        feesUsd,
        netPnlUsd,
        pnlPercent,
        marketRegime: currentRegime,
        entryDescription: signal.description,
      });

      equityCurve.push({
        timestamp: new Date(exitTimeMs).toISOString(),
        equity: Number(currentBalance.toFixed(2)),
      });

      // Jump pointer forward to candle after exit to prevent overlapping duplicate entries
      i += forwardIdx;
      continue;
    }

    i++;
  }

  // 6. Aggregate Statistics
  const totalTrades = trades.length;
  const winningTrades = trades.filter((t) => t.netPnlUsd > 0).length;
  const losingTrades = trades.filter((t) => t.netPnlUsd <= 0).length;
  const winRate = totalTrades > 0 ? (winningTrades / totalTrades) * 100 : 0;

  const grossProfitUsd = trades
    .filter((t) => t.grossPnlUsd > 0)
    .reduce((s, t) => s + t.grossPnlUsd, 0);
  const grossLossUsd = Math.abs(
    trades.filter((t) => t.grossPnlUsd < 0).reduce((s, t) => s + t.grossPnlUsd, 0)
  );
  const totalFeesUsd = trades.reduce((s, t) => s + t.feesUsd, 0);
  const netPnlUsd = currentBalance - initialBalance;
  const netPnlPercent = (netPnlUsd / initialBalance) * 100;

  const profitFactor = grossLossUsd > 0 ? grossProfitUsd / grossLossUsd : grossProfitUsd > 0 ? 99 : 0;
  const expectancyUsd = totalTrades > 0 ? netPnlUsd / totalTrades : 0;

  const winTradesList = trades.filter((t) => t.netPnlUsd > 0);
  const lossTradesList = trades.filter((t) => t.netPnlUsd <= 0);
  const averageWinUsd = winTradesList.length > 0 ? winTradesList.reduce((s, t) => s + t.netPnlUsd, 0) / winTradesList.length : 0;
  const averageLossUsd = lossTradesList.length > 0 ? Math.abs(lossTradesList.reduce((s, t) => s + t.netPnlUsd, 0) / lossTradesList.length) : 0;
  const winLossRatio = averageLossUsd > 0 ? averageWinUsd / averageLossUsd : 0;

  const averageMfeUsd = totalTrades > 0 ? trades.reduce((s, t) => s + t.maxFavorableExcursionUsd, 0) / totalTrades : 0;
  const averageMfeAtr = totalTrades > 0 ? trades.reduce((s, t) => s + t.maxFavorableExcursionAtr, 0) / totalTrades : 0;
  const averageMaeUsd = totalTrades > 0 ? trades.reduce((s, t) => s + t.maxAdverseExcursionUsd, 0) / totalTrades : 0;
  const averageMaeAtr = totalTrades > 0 ? trades.reduce((s, t) => s + t.maxAdverseExcursionAtr, 0) / totalTrades : 0;
  const averageHoldDurationSeconds = totalTrades > 0 ? trades.reduce((s, t) => s + t.holdDurationSeconds, 0) / totalTrades : 0;

  const longTrades = trades.filter((t) => t.direction === "LONG");
  const shortTrades = trades.filter((t) => t.direction === "SHORT");
  const longWinRate = longTrades.length > 0 ? (longTrades.filter((t) => t.netPnlUsd > 0).length / longTrades.length) * 100 : 0;
  const shortWinRate = shortTrades.length > 0 ? (shortTrades.filter((t) => t.netPnlUsd > 0).length / shortTrades.length) * 100 : 0;

  // Breakdown by Regime
  const regimeBreakdown: Record<string, RegimePerformance> = {};
  const regimes = [
    MarketRegime.STRONG_UPTREND,
    MarketRegime.STRONG_DOWNTREND,
    MarketRegime.RANGE_BOUND,
    MarketRegime.HIGH_VOLATILITY,
    MarketRegime.LOW_VOLATILITY,
  ];

  for (const reg of regimes) {
    const regTrades = trades.filter((t) => t.marketRegime === reg);
    const regWins = regTrades.filter((t) => t.netPnlUsd > 0).length;
    const regLosses = regTrades.filter((t) => t.netPnlUsd <= 0).length;
    const regGrossProfit = regTrades.filter((t) => t.grossPnlUsd > 0).reduce((s, t) => s + t.grossPnlUsd, 0);
    const regGrossLoss = Math.abs(regTrades.filter((t) => t.grossPnlUsd < 0).reduce((s, t) => s + t.grossPnlUsd, 0));
    const regNetPnl = regTrades.reduce((s, t) => s + t.netPnlUsd, 0);

    regimeBreakdown[reg] = {
      regime: reg,
      tradesCount: regTrades.length,
      winCount: regWins,
      lossCount: regLosses,
      winRate: regTrades.length > 0 ? (regWins / regTrades.length) * 100 : 0,
      netPnlUsd: regNetPnl,
      profitFactor: regGrossLoss > 0 ? regGrossProfit / regGrossLoss : regGrossProfit > 0 ? 99 : 0,
    };
  }

  return {
    runId: `run_${Date.now()}`,
    setupId: selectedSetupOption.id,
    setupName: selectedSetupOption.name,
    symbol,
    days,
    periodStart: new Date(startTimeMs).toISOString(),
    periodEnd: new Date(endTimeMs).toISOString(),
    totalCandlesAnalyzed: allCandles.length,
    initialBalance,
    finalBalance: Number(currentBalance.toFixed(2)),
    totalTrades,
    winningTrades,
    losingTrades,
    winRate: Number(winRate.toFixed(2)),
    profitFactor: Number(profitFactor.toFixed(2)),
    expectancyUsd: Number(expectancyUsd.toFixed(2)),
    grossProfitUsd: Number(grossProfitUsd.toFixed(2)),
    grossLossUsd: Number(grossLossUsd.toFixed(2)),
    totalFeesUsd: Number(totalFeesUsd.toFixed(2)),
    netPnlUsd: Number(netPnlUsd.toFixed(2)),
    netPnlPercent: Number(netPnlPercent.toFixed(2)),
    maxDrawdownUsd: Number(maxDrawdownUsd.toFixed(2)),
    maxDrawdownPercent: Number(maxDrawdownPercent.toFixed(2)),
    averageWinUsd: Number(averageWinUsd.toFixed(2)),
    averageLossUsd: Number(averageLossUsd.toFixed(2)),
    winLossRatio: Number(winLossRatio.toFixed(2)),
    averageMfeUsd: Number(averageMfeUsd.toFixed(2)),
    averageMfeAtr: Number(averageMfeAtr.toFixed(2)),
    averageMaeUsd: Number(averageMaeUsd.toFixed(2)),
    averageMaeAtr: Number(averageMaeAtr.toFixed(2)),
    averageHoldDurationSeconds: Math.round(averageHoldDurationSeconds),
    longTradesCount: longTrades.length,
    longWinRate: Number(longWinRate.toFixed(2)),
    shortTradesCount: shortTrades.length,
    shortWinRate: Number(shortWinRate.toFixed(2)),
    gatedSignalsCount,
    regimeBreakdown,
    trades,
    equityCurve,
  };
}

export async function runRankAllBacktest(
  request: Omit<BacktestRequest, "setupId">
): Promise<BacktestRankResult> {
  const individualSetups = AVAILABLE_SETUPS.filter((s) => s.id !== "all");
  const rankItems: BacktestRankItem[] = [];

  let periodStart = "";
  let periodEnd = "";
  let totalCandlesAnalyzed = 0;
  let totalBacktestTrades = 0;

  for (const setup of individualSetups) {
    try {
      const res = await runIsolatedBacktest({
        ...request,
        setupId: setup.id,
        isolationMode: true,
      });

      if (!periodStart) {
        periodStart = res.periodStart;
        periodEnd = res.periodEnd;
        totalCandlesAnalyzed = res.totalCandlesAnalyzed;
      }

      totalBacktestTrades += res.totalTrades;

      // Bayesian adjusted win rate: (wins + 2) / (total + 4) * 100
      const bayesianWinRate = Number(
        (((res.winningTrades + 2) / (res.totalTrades + 4)) * 100).toFixed(1)
      );

      let tier: "TIER_1_ULTRA_HIGH" | "TIER_2_STRONG" | "TIER_3_MODERATE" | "TIER_4_LOW" = "TIER_4_LOW";
      if (res.winRate >= 70) tier = "TIER_1_ULTRA_HIGH";
      else if (res.winRate >= 60) tier = "TIER_2_STRONG";
      else if (res.winRate >= 50) tier = "TIER_3_MODERATE";

      let recommendation = "Standard Setup";
      if (res.winRate >= 75) recommendation = "Elite Alpha Trigger - High win rate with strong profit factor";
      else if (res.winRate >= 65) recommendation = "High Probability Core - Dependable trend/range capture";
      else if (res.winRate >= 50) recommendation = "Moderate Probability - Requires strict regime/confluence filter";
      else recommendation = "Low Probability - Sensitive to choppy conditions or wide ATR";

      rankItems.push({
        rank: 0,
        setupId: setup.id,
        setupName: setup.name,
        category: setup.category,
        totalTrades: res.totalTrades,
        winningTrades: res.winningTrades,
        losingTrades: res.losingTrades,
        winRate: res.winRate,
        bayesianWinRate,
        profitFactor: res.profitFactor,
        netPnlUsd: res.netPnlUsd,
        expectancyUsd: res.expectancyUsd,
        maxDrawdownPercent: res.maxDrawdownPercent,
        longTrades: res.longTradesCount,
        longWinRate: res.longWinRate,
        shortTrades: res.shortTradesCount,
        shortWinRate: res.shortWinRate,
        averageHoldDurationSeconds: res.averageHoldDurationSeconds,
        tier,
        recommendation,
      });
    } catch (err) {
      console.warn(`[runRankAllBacktest] Error evaluating ${setup.id}:`, err);
    }
  }

  // Sort by win rate descending (with bayesianWinRate as secondary)
  rankItems.sort((a, b) => {
    if (b.winRate !== a.winRate) return b.winRate - a.winRate;
    if (b.bayesianWinRate !== a.bayesianWinRate) return b.bayesianWinRate - a.bayesianWinRate;
    return b.netPnlUsd - a.netPnlUsd;
  });

  // Assign ranks and aliases
  rankItems.forEach((item, index) => {
    item.rank = index + 1;
    item.wins = item.winningTrades;
    item.losses = item.losingTrades;
    item.netPnl = item.netPnlUsd;
  });

  const avgWinRate =
    rankItems.length > 0
      ? Number((rankItems.reduce((acc, r) => acc + r.winRate, 0) / rankItems.length).toFixed(1))
      : 0;

  return {
    runId: `rank-${Date.now()}`,
    days: request.days || 3,
    symbol: request.symbol || "BTCUSDT",
    periodStart,
    periodEnd,
    totalCandlesAnalyzed,
    candlesEvaluated: totalCandlesAnalyzed,
    rankings: rankItems,
    summary: {
      totalSetupsEvaluated: rankItems.length,
      highestWinRateSetup: rankItems[0]?.setupName || "N/A",
      highestWinRate: rankItems[0]?.winRate || 0,
      averageWinRate: avgWinRate,
      totalBacktestTrades,
    },
  };
}
