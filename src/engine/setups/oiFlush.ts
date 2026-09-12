import { MarketRegime, MarketStructureConfig } from "../../types.js";
import { SetupContext } from "./context.js";

export interface OiFlushCascadeFadeSetupResult {
  isValid: boolean;
  direction: "LONG" | "SHORT" | "NEUTRAL";
  flushExtreme: number;
  cascadeType: "LONG_LIQUIDATION_CASCADE_FADE" | "SHORT_LIQUIDATION_CASCADE_FADE" | "";
  oiContractionPct: number;
  volumeMult: number;
  reversalWickPct: number;
  stopLoss: number;
  takeProfit: number;
  riskReward: number;
  description: string;
}

/**
 * FEATURE: Setup 13 - Open Interest (OI) Flush & Cascade Fade
 * Tracks sudden Open Interest contractions coinciding with aggressive liquidation-driven spikes.
 * - Long Cascade Fade: Long liquidation cascade flushes price downward with massive volume (>= 1.8x)
 *   and sudden Open Interest contraction (>= 1.0%), leaving an order book air pocket.
 *   Once the exhaustion candle forms a long lower wick (>= 45%) and stops making lower lows, fades the cascade.
 * - Short Cascade Fade: Short squeeze cascade flushes price upward with massive volume and OI contraction,
 *   printing an exhaustion upper wick (>= 45%), fading the squeeze back to mean.
 */
export function evaluateOiFlushCascadeFadeSetup(
  direction: "LONG" | "SHORT" | "NEUTRAL",
  ctx: SetupContext
): OiFlushCascadeFadeSetupResult {
  const { candles1m, currentPrice, currentRegime, indicators, orderFlowStats, openInterestStats, config } = ctx;
  const ms = config.market_structure || ({} as MarketStructureConfig);

  if (ms.oi_flush_strategy_enabled === false || direction === "NEUTRAL") {
    return {
      isValid: false,
      direction,
      flushExtreme: 0,
      cascadeType: "",
      oiContractionPct: 0,
      volumeMult: 0,
      reversalWickPct: 0,
      stopLoss: 0,
      takeProfit: 0,
      riskReward: 0,
      description: ms.oi_flush_strategy_enabled === false ? "OI Flush & Cascade Fade strategy disabled" : "Neutral direction"
    };
  }

  // Regime Safeguards: Do not fade liquidation cascades against strong trending regimes
  if (direction === "LONG" && currentRegime === MarketRegime.STRONG_DOWNTREND) {
    return {
      isValid: false,
      direction,
      flushExtreme: 0,
      cascadeType: "",
      oiContractionPct: 0,
      volumeMult: 0,
      reversalWickPct: 0,
      stopLoss: 0,
      takeProfit: 0,
      riskReward: 0,
      description: "Blocked: Long Liquidation Flush fade prohibited in STRONG_DOWNTREND regime."
    };
  }
  if (direction === "SHORT" && currentRegime === MarketRegime.STRONG_UPTREND) {
    return {
      isValid: false,
      direction,
      flushExtreme: 0,
      cascadeType: "",
      oiContractionPct: 0,
      volumeMult: 0,
      reversalWickPct: 0,
      stopLoss: 0,
      takeProfit: 0,
      riskReward: 0,
      description: "Blocked: Short Squeeze Flush fade prohibited in STRONG_UPTREND regime."
    };
  }

  const lastIdx = candles1m.length - 1;
  if (lastIdx < 10) {
    return {
      isValid: false,
      direction,
      flushExtreme: 0,
      cascadeType: "",
      oiContractionPct: 0,
      volumeMult: 0,
      reversalWickPct: 0,
      stopLoss: 0,
      takeProfit: 0,
      riskReward: 0,
      description: "Insufficient candle history for OI Flush evaluation"
    };
  }

  const minContractionPct = ms.oi_flush_min_contraction_pct !== undefined ? ms.oi_flush_min_contraction_pct : 1.0;
  const minVolMult = ms.oi_flush_min_vol_mult !== undefined ? ms.oi_flush_min_vol_mult : 1.8;
  const minWickPct = (ms.oi_flush_min_reversal_wick_pct !== undefined ? ms.oi_flush_min_reversal_wick_pct : 45) / 100;
  const requireConfirmation = ms.oi_flush_require_second_candle_confirmation !== false;

  const currentCandle = candles1m[lastIdx];
  const prevCandle = candles1m[lastIdx - 1];
  const atr14 = indicators.calculateATR(candles1m, 14);
  const currentAtr = Math.max(10, atr14[lastIdx] || 50);

  // Compute 20-period average volume
  const volSlice = candles1m.slice(Math.max(0, lastIdx - 20), lastIdx);
  const sumVol = volSlice.reduce((sum, c) => sum + (c.volume || 0), 0);
  const avgVol = volSlice.length > 0 ? Math.max(1.0, sumVol / volSlice.length) : 15.0;

  // Detect cascade candidate: either prevCandle (with current candle confirming) or currentCandle
  const checkPrev = requireConfirmation && lastIdx >= 2;
  const flushCandle = checkPrev ? prevCandle : currentCandle;

  const flushRange = Math.max(1.0, flushCandle.high - flushCandle.low);
  const volMult = (flushCandle.volume || avgVol) / avgVol;

  // Measure OI contraction: negative change in OI during flush
  const oiDropPct1m = -openInterestStats.oiChangePct1m;
  const oiDropPct5m = -openInterestStats.oiChangePct5m;
  const effectiveOiContraction = Math.max(0, Math.max(oiDropPct1m, oiDropPct5m));

  const isVolumeSurge = volMult >= minVolMult * 0.90;
  const isOiContractionMet = effectiveOiContraction >= minContractionPct || (volMult >= 2.0 && flushRange >= 1.2 * currentAtr && (openInterestStats.oiChange1m < 0 || openInterestStats.oiChangePct1m <= -0.4));
  const isDisplacementSufficient = flushRange >= 0.9 * currentAtr;

  if (direction === "LONG") {
    // Long Liquidation Cascade Fade: Heavy longs liquidated -> price dropped -> long lower wick
    const lowerWick = Math.min(flushCandle.open, flushCandle.close) - flushCandle.low;
    const lowerWickRatio = lowerWick / flushRange;

    if (!isVolumeSurge || !isOiContractionMet || !isDisplacementSufficient || lowerWickRatio < minWickPct) {
      return {
        isValid: false,
        direction,
        flushExtreme: flushCandle.low,
        cascadeType: "",
        oiContractionPct: effectiveOiContraction,
        volumeMult: volMult,
        reversalWickPct: lowerWickRatio * 100,
        stopLoss: 0,
        takeProfit: 0,
        riskReward: 0,
        description: `No long liquidation cascade flush (Vol: ${volMult.toFixed(2)}x/${minVolMult}x, OI Contraction: ${effectiveOiContraction.toFixed(2)}%/${minContractionPct}%, Lower Wick: ${(lowerWickRatio * 100).toFixed(0)}%/${(minWickPct * 100).toFixed(0)}%)`
      };
    }

    // Anti-falling-knife safeguard:
    if (checkPrev) {
      if (currentCandle.low < flushCandle.low - 0.05 * currentAtr) {
        return {
          isValid: false,
          direction,
          flushExtreme: flushCandle.low,
          cascadeType: "",
          oiContractionPct: effectiveOiContraction,
          volumeMult: volMult,
          reversalWickPct: lowerWickRatio * 100,
          stopLoss: 0,
          takeProfit: 0,
          riskReward: 0,
          description: `Cascade still active: current candle breached flush low $${flushCandle.low.toFixed(2)}`
        };
      }
      if (orderFlowStats.takerBuyRatio < 0.44 && currentPrice < currentCandle.open) {
        return {
          isValid: false,
          direction,
          flushExtreme: flushCandle.low,
          cascadeType: "",
          oiContractionPct: effectiveOiContraction,
          volumeMult: volMult,
          reversalWickPct: lowerWickRatio * 100,
          stopLoss: 0,
          takeProfit: 0,
          riskReward: 0,
          description: `Awaiting 2nd candle delta stabilization after liquidation flush (Taker Buy: ${(orderFlowStats.takerBuyRatio * 100).toFixed(1)}%)`
        };
      }
    }

    const stopLoss = flushCandle.low - Math.max(25, 0.45 * currentAtr);
    const risk = currentPrice - stopLoss;
    const takeProfit = Math.max(flushCandle.high, currentPrice + Math.max(risk * 2.5, 2.2 * currentAtr));
    const rrRatio = risk > 0 ? (takeProfit - currentPrice) / risk : 0;

    return {
      isValid: true,
      direction: "LONG",
      flushExtreme: flushCandle.low,
      cascadeType: "LONG_LIQUIDATION_CASCADE_FADE",
      oiContractionPct: effectiveOiContraction,
      volumeMult: volMult,
      reversalWickPct: lowerWickRatio * 100,
      stopLoss,
      takeProfit,
      riskReward: Number(rrRatio.toFixed(2)),
      description: `Long Liquidation Cascade Fade: Forced liquidations flushed price down to $${flushCandle.low.toFixed(2)} with ${volMult.toFixed(2)}x volume surge & ${effectiveOiContraction.toFixed(2)}% OI contraction. Liquidation wick confirmed (${(lowerWickRatio * 100).toFixed(0)}% lower wick). Fading air pocket back to origin $${takeProfit.toFixed(2)} (Strict SL: $${stopLoss.toFixed(2)}, R:R ${rrRatio.toFixed(2)}:1).`
    };
  } else {
    // SHORT
    // Short Squeeze Liquidation Cascade Fade: Shorts liquidated -> price spiked -> long upper wick
    const upperWick = flushCandle.high - Math.max(flushCandle.open, flushCandle.close);
    const upperWickRatio = upperWick / flushRange;

    if (!isVolumeSurge || !isOiContractionMet || !isDisplacementSufficient || upperWickRatio < minWickPct) {
      return {
        isValid: false,
        direction,
        flushExtreme: flushCandle.high,
        cascadeType: "",
        oiContractionPct: effectiveOiContraction,
        volumeMult: volMult,
        reversalWickPct: upperWickRatio * 100,
        stopLoss: 0,
        takeProfit: 0,
        riskReward: 0,
        description: `No short squeeze liquidation cascade (Vol: ${volMult.toFixed(2)}x/${minVolMult}x, OI Contraction: ${effectiveOiContraction.toFixed(2)}%/${minContractionPct}%, Upper Wick: ${(upperWickRatio * 100).toFixed(0)}%/${(minWickPct * 100).toFixed(0)}%)`
      };
    }

    // Anti-falling-knife safeguard:
    if (checkPrev) {
      if (currentCandle.high > flushCandle.high + 0.05 * currentAtr) {
        return {
          isValid: false,
          direction,
          flushExtreme: flushCandle.high,
          cascadeType: "",
          oiContractionPct: effectiveOiContraction,
          volumeMult: volMult,
          reversalWickPct: upperWickRatio * 100,
          stopLoss: 0,
          takeProfit: 0,
          riskReward: 0,
          description: `Squeeze still active: current candle breached flush high $${flushCandle.high.toFixed(2)}`
        };
      }
      if (orderFlowStats.takerBuyRatio > 0.56 && currentPrice > currentCandle.open) {
        return {
          isValid: false,
          direction,
          flushExtreme: flushCandle.high,
          cascadeType: "",
          oiContractionPct: effectiveOiContraction,
          volumeMult: volMult,
          reversalWickPct: upperWickRatio * 100,
          stopLoss: 0,
          takeProfit: 0,
          riskReward: 0,
          description: `Awaiting 2nd candle delta stabilization after squeeze flush (Taker Buy: ${(orderFlowStats.takerBuyRatio * 100).toFixed(1)}%)`
        };
      }
    }

    const stopLoss = flushCandle.high + Math.max(25, 0.45 * currentAtr);
    const risk = stopLoss - currentPrice;
    const takeProfit = Math.min(flushCandle.low, currentPrice - Math.max(risk * 2.5, 2.2 * currentAtr));
    const rrRatio = risk > 0 ? (currentPrice - takeProfit) / risk : 0;

    return {
      isValid: true,
      direction: "SHORT",
      flushExtreme: flushCandle.high,
      cascadeType: "SHORT_LIQUIDATION_CASCADE_FADE",
      oiContractionPct: effectiveOiContraction,
      volumeMult: volMult,
      reversalWickPct: upperWickRatio * 100,
      stopLoss,
      takeProfit,
      riskReward: Number(rrRatio.toFixed(2)),
      description: `Short Squeeze Cascade Fade: Forced short liquidations spiked price up to $${flushCandle.high.toFixed(2)} with ${volMult.toFixed(2)}x volume surge & ${effectiveOiContraction.toFixed(2)}% OI contraction. Squeeze exhaustion wick confirmed (${(upperWickRatio * 100).toFixed(0)}% upper wick). Fading air pocket back to origin $${takeProfit.toFixed(2)} (Strict SL: $${stopLoss.toFixed(2)}, R:R ${rrRatio.toFixed(2)}:1).`
    };
  }
}
