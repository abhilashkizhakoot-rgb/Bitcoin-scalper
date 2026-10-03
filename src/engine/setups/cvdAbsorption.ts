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
  const minWickPct = (ms.cvd_divergence_min_rejection_wick_pct !== undefined ? ms.cvd_divergence_min_rejection_wick_pct : 30) / 100;
  const imbalanceRatio = ms.cvd_divergence_min_delta_imbalance_ratio !== undefined ? ms.cvd_divergence_min_delta_imbalance_ratio : 0.50;
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

  const prevCandle = lastIdx >= 1 ? candles1m[lastIdx - 1] : null;
  const candidates: {
    candle: typeof currentCandle;
    isPrev: boolean;
    range: number;
    wickRatio: number;
  }[] = [];

  if (prevCandle) {
    const pRange = Math.max(1.0, prevCandle.high - prevCandle.low);
    const pWick = direction === "LONG"
      ? Math.min(prevCandle.open, prevCandle.close) - prevCandle.low
      : prevCandle.high - Math.max(prevCandle.open, prevCandle.close);
    candidates.push({
      candle: prevCandle,
      isPrev: true,
      range: pRange,
      wickRatio: pWick / pRange
    });
  }

  const cRange = Math.max(1.0, currentCandle.high - currentCandle.low);
  const cWick = direction === "LONG"
    ? Math.min(currentCandle.open, currentCandle.close) - currentCandle.low
    : currentCandle.high - Math.max(currentCandle.open, currentCandle.close);
  candidates.push({
    candle: currentCandle,
    isPrev: false,
    range: cRange,
    wickRatio: cWick / cRange
  });

  const takerBuyRatio = orderFlowStats.takerBuyRatio;
  const netCVD = orderFlowStats.netCVD;
  const obImbalance = orderBookStats.imbalanceRatio;

  if (direction === "LONG") {
    for (const cand of candidates) {
      const targetCandle = cand.candle;
      const lowerWickRatio = cand.wickRatio;
      const candleRange = cand.range;

      // Regime safeguard: In strong downtrends, only block if price continues dumping with no absorption wick
      if (currentRegime === MarketRegime.STRONG_DOWNTREND && lowerWickRatio < 0.25 && targetCandle.close <= targetCandle.open) {
        continue;
      }

      // Structural extreme check (swing low, range lower boundary, or recent channel support)
      const isAtPriorLow = targetCandle.low <= priorLow * 1.0020 || currentPrice <= priorLow * 1.0020;
      const isNearRangeLow = targetCandle.low <= (rangeLow + 0.35 * Math.max(10, rangeHigh - rangeLow));
      if (requireExtreme && !isAtPriorLow && !isNearRangeLow) {
        continue;
      }

      // Absorption signature: Lower rejection wick + seller aggression absorbed + stabilization
      const hasWick = lowerWickRatio >= minWickPct;
      const hasSellerAggression = takerBuyRatio <= (1 - imbalanceRatio + 0.08) || netCVD < 0 || obImbalance <= -0.08;
      const isStabilizing = cand.isPrev
        ? (currentCandle.low >= targetCandle.low - 0.05 * currentAtr && (currentCandle.close >= targetCandle.low + 0.20 * candleRange || currentCandle.close >= currentCandle.open))
        : ((currentCandle.close >= currentCandle.low + 0.25 * candleRange || currentPrice >= currentCandle.open) && takerBuyRatio >= 0.30);

      if (!hasWick || !hasSellerAggression || !isStabilizing) {
        continue;
      }

      const stopLoss = Math.min(targetCandle.low, currentCandle.low) - Math.max(25, 0.45 * currentAtr);
      const risk = currentPrice - stopLoss;
      const takeProfit = currentPrice + Math.max(risk * 2.0, 1.8 * currentAtr);
      const rrRatio = risk > 0 ? (takeProfit - currentPrice) / risk : 0;

      return {
        isValid: true,
        direction: "LONG",
        extremePrice: targetCandle.low,
        divergenceType: "BULLISH_CVD_ABSORPTION",
        takerBuyRatio,
        netCVD,
        rejectionWickPct: Number((lowerWickRatio * 100).toFixed(0)),
        stopLoss,
        takeProfit,
        riskReward: Number(rrRatio.toFixed(2)),
        description: `Bullish CVD Absorption: Institutional iceberg passive bids absorbed aggressive market selling at structural low $${targetCandle.low.toFixed(2)} (${(lowerWickRatio * 100).toFixed(0)}% lower wick, Taker Buy: ${(takerBuyRatio * 100).toFixed(1)}%, CVD: ${netCVD.toFixed(2)}). Invalidation SL: $${stopLoss.toFixed(2)}, Target: $${takeProfit.toFixed(2)} (R:R ${rrRatio.toFixed(2)}:1).`
      };
    }

    const primary = candidates[0];
    return {
      isValid: false,
      direction,
      extremePrice: primary.candle.low,
      divergenceType: "",
      takerBuyRatio,
      netCVD,
      rejectionWickPct: primary.wickRatio * 100,
      stopLoss: 0,
      takeProfit: 0,
      riskReward: 0,
      description: `Absorption criteria not met (Lower Wick: ${(primary.wickRatio * 100).toFixed(0)}%/${(minWickPct * 100).toFixed(0)}%, Taker Buy: ${(takerBuyRatio * 100).toFixed(1)}%)`
    };
  } else {
    // SHORT
    for (const cand of candidates) {
      const targetCandle = cand.candle;
      const upperWickRatio = cand.wickRatio;
      const candleRange = cand.range;

      // Regime safeguard: In strong uptrends, only block if price continues rocketing with no rejection wick
      if (currentRegime === MarketRegime.STRONG_UPTREND && upperWickRatio < 0.25 && targetCandle.close >= targetCandle.open) {
        continue;
      }

      // Structural extreme check (swing high, range upper boundary, or recent channel resistance)
      const isAtPriorHigh = targetCandle.high >= priorHigh * 0.9980 || currentPrice >= priorHigh * 0.9980;
      const isNearRangeHigh = targetCandle.high >= (rangeHigh - 0.35 * Math.max(10, rangeHigh - rangeLow));
      if (requireExtreme && !isAtPriorHigh && !isNearRangeHigh) {
        continue;
      }

      // Absorption signature: Upper rejection wick + buyer aggression absorbed + rotation
      const hasWick = upperWickRatio >= minWickPct;
      const hasBuyerAggression = takerBuyRatio >= (imbalanceRatio - 0.08) || netCVD > 0 || obImbalance >= 0.08;
      const isRejecting = cand.isPrev
        ? (currentCandle.high <= targetCandle.high + 0.05 * currentAtr && (currentCandle.close <= targetCandle.high - 0.20 * candleRange || currentCandle.close <= currentCandle.open))
        : ((currentCandle.close <= currentCandle.high - 0.25 * candleRange || currentPrice <= currentCandle.open) && takerBuyRatio <= 0.70);

      if (!hasWick || !hasBuyerAggression || !isRejecting) {
        continue;
      }

      const stopLoss = Math.max(targetCandle.high, currentCandle.high) + Math.max(25, 0.45 * currentAtr);
      const risk = stopLoss - currentPrice;
      const takeProfit = currentPrice - Math.max(risk * 2.0, 1.8 * currentAtr);
      const rrRatio = risk > 0 ? (currentPrice - takeProfit) / risk : 0;

      return {
        isValid: true,
        direction: "SHORT",
        extremePrice: targetCandle.high,
        divergenceType: "BEARISH_CVD_ABSORPTION",
        takerBuyRatio,
        netCVD,
        rejectionWickPct: Number((upperWickRatio * 100).toFixed(0)),
        stopLoss,
        takeProfit,
        riskReward: Number(rrRatio.toFixed(2)),
        description: `Bearish CVD Absorption: Institutional iceberg passive asks absorbed aggressive market buying at structural high $${targetCandle.high.toFixed(2)} (${(upperWickRatio * 100).toFixed(0)}% upper wick, Taker Buy: ${(takerBuyRatio * 100).toFixed(1)}%, CVD: ${netCVD.toFixed(2)}). Invalidation SL: $${stopLoss.toFixed(2)}, Target: $${takeProfit.toFixed(2)} (R:R ${rrRatio.toFixed(2)}:1).`
      };
    }

    const primary = candidates[0];
    return {
      isValid: false,
      direction,
      extremePrice: primary.candle.high,
      divergenceType: "",
      takerBuyRatio,
      netCVD,
      rejectionWickPct: primary.wickRatio * 100,
      stopLoss: 0,
      takeProfit: 0,
      riskReward: 0,
      description: `Absorption criteria not met (Upper Wick: ${(primary.wickRatio * 100).toFixed(0)}%/${(minWickPct * 100).toFixed(0)}%, Taker Buy: ${(takerBuyRatio * 100).toFixed(1)}%)`
    };
  }
}
