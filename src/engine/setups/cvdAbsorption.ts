import { MarketRegime, MarketStructureConfig } from "../../types.js";
import { SetupContext } from "./context.js";

export interface CvdAbsorptionSetupResult {
  isValid: boolean;
  direction: "LONG" | "SHORT" | "NEUTRAL";
  extremePrice: number;
  divergenceType: "BULLISH_CVD_ABSORPTION" | "BEARISH_CVD_ABSORPTION" | "";
  takerBuyRatio: number;
  netCVD: number;
  rejectionWickPct: number;
  stopLoss: number;
  takeProfit: number;
  riskReward: number;
  description: string;
}

/**
 * FEATURE: Setup 12 - CVD Absorption & Delta Divergence
 * Monitors Cumulative Volume Delta (CVD) and Taker Buy/Sell flow at structural extremes.
 * - Long: Price makes or sweeps a local low / range low, but aggressive market sells fail to displace
 *   price lower due to passive institutional iceberg absorption (long lower wick >= 35%, delta divergence).
 * - Short: Price makes or sweeps a local high / range high, but aggressive market buys fail to displace
 *   price higher due to passive institutional limit asks (long upper wick >= 35%, delta divergence).
 */
export function evaluateCvdAbsorptionSetup(
  direction: "LONG" | "SHORT" | "NEUTRAL",
  ctx: SetupContext
): CvdAbsorptionSetupResult {
  const { candles1m, currentPrice, currentRegime, indicators, orderFlowStats, orderBookStats, config } = ctx;
  const ms = config.market_structure || ({} as MarketStructureConfig);

  if (ms.cvd_divergence_strategy_enabled === false || direction === "NEUTRAL") {
    return {
      isValid: false,
      direction,
      extremePrice: 0,
      divergenceType: "",
      takerBuyRatio: 0,
      netCVD: 0,
      rejectionWickPct: 0,
      stopLoss: 0,
      takeProfit: 0,
      riskReward: 0,
      description: ms.cvd_divergence_strategy_enabled === false ? "CVD Absorption & Delta Divergence strategy disabled" : "Neutral direction"
    };
  }

  const lastIdx = candles1m.length - 1;
  if (lastIdx < 10) {
    return {
      isValid: false,
      direction,
      extremePrice: 0,
      divergenceType: "",
      takerBuyRatio: 0,
      netCVD: 0,
      rejectionWickPct: 0,
      stopLoss: 0,
      takeProfit: 0,
      riskReward: 0,
      description: "Insufficient candle history for CVD Absorption evaluation"
    };
  }

  const currentCandle = candles1m[lastIdx];
  const atr14 = indicators.calculateATR(candles1m, 14);
  const currentAtr = Math.max(10, atr14[lastIdx] || 50);
  const minWickPct = (ms.cvd_divergence_min_rejection_wick_pct !== undefined ? ms.cvd_divergence_min_rejection_wick_pct : 35) / 100;
  const imbalanceRatio = ms.cvd_divergence_min_delta_imbalance_ratio !== undefined ? ms.cvd_divergence_min_delta_imbalance_ratio : 0.55;
  const lookback = ms.cvd_divergence_lookback_candles !== undefined ? ms.cvd_divergence_lookback_candles : 20;
  const requireExtreme = ms.cvd_divergence_require_structural_extreme !== false;

  // Structural swing extremes over lookback
  const startSlice = Math.max(0, lastIdx - lookback);
  const lookbackSlice = candles1m.slice(startSlice, lastIdx);
  const priorHigh = Math.max(...lookbackSlice.map(c => c.high));
  const priorLow = Math.min(...lookbackSlice.map(c => c.low));

  // Dynamic range boundaries
  const rangeCandles = candles1m.slice(Math.max(0, lastIdx - 30));
  const rangeHigh = rangeCandles.length > 0 ? Math.max(...rangeCandles.map(c => c.high)) : priorHigh;
  const rangeLow = rangeCandles.length > 0 ? Math.min(...rangeCandles.map(c => c.low)) : priorLow;

  const candleRange = Math.max(1.0, currentCandle.high - currentCandle.low);
  const lowerWick = Math.min(currentCandle.open, currentCandle.close) - currentCandle.low;
  const upperWick = currentCandle.high - Math.max(currentCandle.open, currentCandle.close);
  const lowerWickRatio = lowerWick / candleRange;
  const upperWickRatio = upperWick / candleRange;

  const takerBuyRatio = orderFlowStats.takerBuyRatio;
  const netCVD = orderFlowStats.netCVD;
  const obImbalance = orderBookStats.imbalanceRatio;

  if (direction === "LONG") {
    // Regime safeguard: No knife catching in strong trend
    if (currentRegime === MarketRegime.STRONG_DOWNTREND) {
      return {
        isValid: false,
        direction,
        extremePrice: 0,
        divergenceType: "",
        takerBuyRatio,
        netCVD,
        rejectionWickPct: lowerWickRatio * 100,
        stopLoss: 0,
        takeProfit: 0,
        riskReward: 0,
        description: "Blocked: Long CVD Absorption prohibited in STRONG_DOWNTREND regime."
      };
    }

    // Structural extreme check
    const isAtPriorLow = currentCandle.low <= priorLow * 1.0008 || currentPrice <= priorLow * 1.0008;
    const isNearRangeLow = currentRegime === MarketRegime.RANGE_BOUND && currentPrice <= (rangeLow + 0.28 * (rangeHigh - rangeLow));
    if (requireExtreme && !isAtPriorLow && !isNearRangeLow) {
      return {
        isValid: false,
        direction,
        extremePrice: priorLow,
        divergenceType: "",
        takerBuyRatio,
        netCVD,
        rejectionWickPct: lowerWickRatio * 100,
        stopLoss: 0,
        takeProfit: 0,
        riskReward: 0,
        description: `No structural low tested for CVD absorption (Price not at swing low $${priorLow.toFixed(2)} or range boundary)`
      };
    }

    // Absorption signature: Lower rejection wick + seller aggression absorbed + stabilization
    const hasWick = lowerWickRatio >= minWickPct;
    const hasSellerAggression = takerBuyRatio <= (1 - imbalanceRatio + 0.05) || netCVD < 0 || obImbalance <= -0.15;
    const isStabilizing = (currentCandle.close >= currentCandle.low + 0.35 * candleRange || currentPrice >= currentCandle.open) && takerBuyRatio >= 0.35;

    if (!hasWick || !hasSellerAggression || !isStabilizing) {
      return {
        isValid: false,
        direction,
        extremePrice: currentCandle.low,
        divergenceType: "",
        takerBuyRatio,
        netCVD,
        rejectionWickPct: lowerWickRatio * 100,
        stopLoss: 0,
        takeProfit: 0,
        riskReward: 0,
        description: `Absorption criteria not met (Lower Wick: ${(lowerWickRatio * 100).toFixed(0)}%/${(minWickPct * 100).toFixed(0)}%, Taker Buy: ${(takerBuyRatio * 100).toFixed(1)}%)`
      };
    }

    const stopLoss = currentCandle.low - Math.max(25, 0.45 * currentAtr);
    const risk = currentPrice - stopLoss;
    const takeProfit = currentPrice + Math.max(risk * 2.0, 1.8 * currentAtr);
    const rrRatio = risk > 0 ? (takeProfit - currentPrice) / risk : 0;

    return {
      isValid: true,
      direction: "LONG",
      extremePrice: currentCandle.low,
      divergenceType: "BULLISH_CVD_ABSORPTION",
      takerBuyRatio,
      netCVD,
      rejectionWickPct: lowerWickRatio * 100,
      stopLoss,
      takeProfit,
      riskReward: Number(rrRatio.toFixed(2)),
      description: `Bullish CVD Absorption: Institutional iceberg passive bids absorbed aggressive market selling at structural low $${currentCandle.low.toFixed(2)} (${(lowerWickRatio * 100).toFixed(0)}% lower wick, Taker Buy: ${(takerBuyRatio * 100).toFixed(1)}%, CVD: ${netCVD.toFixed(2)}). Invalidation SL: $${stopLoss.toFixed(2)}, Target: $${takeProfit.toFixed(2)} (R:R ${rrRatio.toFixed(2)}:1).`
    };
  } else {
    // SHORT
    // Regime safeguard: No shorting strong uptrend
    if (currentRegime === MarketRegime.STRONG_UPTREND) {
      return {
        isValid: false,
        direction,
        extremePrice: 0,
        divergenceType: "",
        takerBuyRatio,
        netCVD,
        rejectionWickPct: upperWickRatio * 100,
        stopLoss: 0,
        takeProfit: 0,
        riskReward: 0,
        description: "Blocked: Short CVD Absorption prohibited in STRONG_UPTREND regime."
      };
    }

    // Structural extreme check
    const isAtPriorHigh = currentCandle.high >= priorHigh * 0.9992 || currentPrice >= priorHigh * 0.9992;
    const isNearRangeHigh = currentRegime === MarketRegime.RANGE_BOUND && currentPrice >= (rangeHigh - 0.28 * (rangeHigh - rangeLow));
    if (requireExtreme && !isAtPriorHigh && !isNearRangeHigh) {
      return {
        isValid: false,
        direction,
        extremePrice: priorHigh,
        divergenceType: "",
        takerBuyRatio,
        netCVD,
        rejectionWickPct: upperWickRatio * 100,
        stopLoss: 0,
        takeProfit: 0,
        riskReward: 0,
        description: `No structural high tested for CVD absorption (Price not at swing high $${priorHigh.toFixed(2)} or range boundary)`
      };
    }

    // Absorption signature: Upper rejection wick + buyer aggression absorbed + rotation
    const hasWick = upperWickRatio >= minWickPct;
    const hasBuyerAggression = takerBuyRatio >= imbalanceRatio || netCVD > 0 || obImbalance >= 0.15;
    const isRejecting = (currentCandle.close <= currentCandle.high - 0.35 * candleRange || currentPrice <= currentCandle.open) && takerBuyRatio <= 0.65;

    if (!hasWick || !hasBuyerAggression || !isRejecting) {
      return {
        isValid: false,
        direction,
        extremePrice: currentCandle.high,
        divergenceType: "",
        takerBuyRatio,
        netCVD,
        rejectionWickPct: upperWickRatio * 100,
        stopLoss: 0,
        takeProfit: 0,
        riskReward: 0,
        description: `Absorption criteria not met (Upper Wick: ${(upperWickRatio * 100).toFixed(0)}%/${(minWickPct * 100).toFixed(0)}%, Taker Buy: ${(takerBuyRatio * 100).toFixed(1)}%)`
      };
    }

    const stopLoss = currentCandle.high + Math.max(25, 0.45 * currentAtr);
    const risk = stopLoss - currentPrice;
    const takeProfit = currentPrice - Math.max(risk * 2.0, 1.8 * currentAtr);
    const rrRatio = risk > 0 ? (currentPrice - takeProfit) / risk : 0;

    return {
      isValid: true,
      direction: "SHORT",
      extremePrice: currentCandle.high,
      divergenceType: "BEARISH_CVD_ABSORPTION",
      takerBuyRatio,
      netCVD,
      rejectionWickPct: upperWickRatio * 100,
      stopLoss,
      takeProfit,
      riskReward: Number(rrRatio.toFixed(2)),
      description: `Bearish CVD Absorption: Institutional iceberg passive asks absorbed aggressive breakout buying at structural high $${currentCandle.high.toFixed(2)} (${(upperWickRatio * 100).toFixed(0)}% upper wick, Taker Buy: ${(takerBuyRatio * 100).toFixed(1)}%, CVD: ${netCVD.toFixed(2)}). Invalidation SL: $${stopLoss.toFixed(2)}, Target: $${takeProfit.toFixed(2)} (R:R ${rrRatio.toFixed(2)}:1).`
    };
  }
}
