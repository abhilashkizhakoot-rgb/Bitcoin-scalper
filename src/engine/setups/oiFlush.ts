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

  // Regime Safeguards: In strong runaway regimes, ensure confirmed exhaustion wick and stabilization
  // (Note: Do not unconditionally block STRONG_DOWNTREND/STRONG_UPTREND because liquidation cascades inherently create waterfall candles that trigger trend regimes!)
  if (direction === "LONG" && currentRegime === MarketRegime.STRONG_DOWNTREND) {
    // Only block if current candle continues to dump hard with no stabilization wick
    const curC = candles1m[candles1m.length - 1];
    const curRange = Math.max(1.0, curC.high - curC.low);
    const lowerWick = Math.min(curC.open, curC.close) - curC.low;
    if (lowerWick / curRange < 0.25 && curC.close <= curC.open) {
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
        description: "Blocked: Active runaway selloff in STRONG_DOWNTREND with no stabilization wick."
      };
    }
  }
  if (direction === "SHORT" && currentRegime === MarketRegime.STRONG_UPTREND) {
    const curC = candles1m[candles1m.length - 1];
    const curRange = Math.max(1.0, curC.high - curC.low);
    const upperWick = curC.high - Math.max(curC.open, curC.close);
    if (upperWick / curRange < 0.25 && curC.close >= curC.open) {
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
        description: "Blocked: Active runaway breakout in STRONG_UPTREND with no exhaustion wick."
      };
    }
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

  const minContractionPct = ms.oi_flush_min_contraction_pct !== undefined ? ms.oi_flush_min_contraction_pct : 0.05;
  const minVolMult = ms.oi_flush_min_vol_mult !== undefined ? ms.oi_flush_min_vol_mult : 1.20;
  const minWickPct = (ms.oi_flush_min_reversal_wick_pct !== undefined ? ms.oi_flush_min_reversal_wick_pct : 30) / 100;
  const requireConfirmation = ms.oi_flush_require_second_candle_confirmation !== false;

  const currentCandle = candles1m[lastIdx];
  const prevCandle = candles1m[lastIdx - 1];
  const atr14 = indicators.calculateATR(candles1m, 14);
  const currentAtr = Math.max(10, atr14[lastIdx] || 50);

  // Compute 20-period average volume
  const volSlice = candles1m.slice(Math.max(0, lastIdx - 20), lastIdx);
  const sumVol = volSlice.reduce((sum, c) => sum + (c.volume || 0), 0);
  const avgVol = volSlice.length > 0 ? Math.max(1.0, sumVol / volSlice.length) : 15.0;

  // Measure OI contraction: negative change in OI during flush
  const oiDropPct1m = -openInterestStats.oiChangePct1m;
  const oiDropPct5m = -openInterestStats.oiChangePct5m;
  const effectiveOiContraction = Math.max(0, Math.max(oiDropPct1m, oiDropPct5m));

  // Evaluate candidate candles: prefer prevCandle with 2nd candle stabilization if requireConfirmation is set,
  // or currentCandle if it has already formed the flush rejection
  const candidates: {
    candle: typeof currentCandle;
    isPrev: boolean;
    volMult: number;
    range: number;
    wickRatio: number;
  }[] = [];

  if (requireConfirmation && lastIdx >= 2) {
    const pRange = Math.max(1.0, prevCandle.high - prevCandle.low);
    const pVolMult = (prevCandle.volume || avgVol) / avgVol;
    const pWick = direction === "LONG"
      ? Math.min(prevCandle.open, prevCandle.close) - prevCandle.low
      : prevCandle.high - Math.max(prevCandle.open, prevCandle.close);
    candidates.push({
      candle: prevCandle,
      isPrev: true,
      volMult: pVolMult,
      range: pRange,
      wickRatio: pWick / pRange
    });
  }

  // Also consider current candle if it formed significant rejection
  const cRange = Math.max(1.0, currentCandle.high - currentCandle.low);
  const cVolMult = (currentCandle.volume || avgVol) / avgVol;
  const cWick = direction === "LONG"
    ? Math.min(currentCandle.open, currentCandle.close) - currentCandle.low
    : currentCandle.high - Math.max(currentCandle.open, currentCandle.close);
  candidates.push({
    candle: currentCandle,
    isPrev: false,
    volMult: cVolMult,
    range: cRange,
    wickRatio: cWick / cRange
  });

  if (direction === "LONG") {
    for (const cand of candidates) {
      const flushCandle = cand.candle;
      const flushRange = cand.range;
      const volMult = cand.volMult;
      const lowerWickRatio = cand.wickRatio;

      const isVolumeSurge = volMult >= minVolMult * 0.85 || volMult >= 1.15;
      const isOiContractionMet =
        effectiveOiContraction >= Math.min(minContractionPct, 0.02) ||
        openInterestStats.oiChange1m < 0 ||
        openInterestStats.oiChange5m < 0 ||
        openInterestStats.oiChangePct1m <= -0.02 ||
        (volMult >= 1.20 && flushRange >= 0.40 * currentAtr) ||
        orderFlowStats.takerBuyRatio <= 0.40;
      const isDisplacementSufficient = flushRange >= 0.35 * currentAtr;

      if (!isVolumeSurge || !isOiContractionMet || !isDisplacementSufficient || lowerWickRatio < minWickPct) {
        continue;
      }

      // Anti-falling-knife safeguard if checking previous candle
      if (cand.isPrev) {
        if (currentCandle.low < flushCandle.low - 0.05 * currentAtr) {
          continue; // cascade breached flush low
        }
        if (orderFlowStats.takerBuyRatio < 0.32) {
          continue; // severe selling still active
        }
      }

      const stopLoss = flushCandle.low - Math.max(25, 0.45 * currentAtr);
      const risk = currentPrice - stopLoss;
      const takeProfit = Math.max(flushCandle.high, currentPrice + Math.max(risk * 2.2, 2.0 * currentAtr));
      const rrRatio = risk > 0 ? (takeProfit - currentPrice) / risk : 0;

      return {
        isValid: true,
        direction: "LONG",
        flushExtreme: flushCandle.low,
        cascadeType: "LONG_LIQUIDATION_CASCADE_FADE",
        oiContractionPct: Number(effectiveOiContraction.toFixed(2)),
        volumeMult: Number(volMult.toFixed(2)),
        reversalWickPct: Number((lowerWickRatio * 100).toFixed(0)),
        stopLoss,
        takeProfit,
        riskReward: Number(rrRatio.toFixed(2)),
        description: `Long Liquidation Cascade Fade: Forced liquidations flushed price down to $${flushCandle.low.toFixed(2)} with ${volMult.toFixed(2)}x volume surge & ${effectiveOiContraction.toFixed(2)}% OI contraction. Liquidation wick confirmed (${(lowerWickRatio * 100).toFixed(0)}% lower wick). Fading air pocket back to origin $${takeProfit.toFixed(2)} (Strict SL: $${stopLoss.toFixed(2)}, R:R ${rrRatio.toFixed(2)}:1).`
      };
    }

    const primary = candidates[0];
    return {
      isValid: false,
      direction,
      flushExtreme: primary.candle.low,
      cascadeType: "",
      oiContractionPct: effectiveOiContraction,
      volumeMult: primary.volMult,
      reversalWickPct: primary.wickRatio * 100,
      stopLoss: 0,
      takeProfit: 0,
      riskReward: 0,
      description: `No long liquidation cascade flush (Vol: ${primary.volMult.toFixed(2)}x/${minVolMult}x, OI Contraction: ${effectiveOiContraction.toFixed(2)}%/${minContractionPct}%, Lower Wick: ${(primary.wickRatio * 100).toFixed(0)}%/${(minWickPct * 100).toFixed(0)}%)`
    };
  } else {
    // SHORT
    for (const cand of candidates) {
      const flushCandle = cand.candle;
      const flushRange = cand.range;
      const volMult = cand.volMult;
      const upperWickRatio = cand.wickRatio;

      const isVolumeSurge = volMult >= minVolMult * 0.85 || volMult >= 1.15;
      const isOiContractionMet =
        effectiveOiContraction >= Math.min(minContractionPct, 0.02) ||
        openInterestStats.oiChange1m < 0 ||
        openInterestStats.oiChange5m < 0 ||
        openInterestStats.oiChangePct1m <= -0.02 ||
        (volMult >= 1.20 && flushRange >= 0.40 * currentAtr) ||
        orderFlowStats.takerBuyRatio >= 0.60;
      const isDisplacementSufficient = flushRange >= 0.35 * currentAtr;

      if (!isVolumeSurge || !isOiContractionMet || !isDisplacementSufficient || upperWickRatio < minWickPct) {
        continue;
      }

      // Anti-falling-knife safeguard if checking previous candle
      if (cand.isPrev) {
        if (currentCandle.high > flushCandle.high + 0.05 * currentAtr) {
          continue; // cascade breached flush high
        }
        if (orderFlowStats.takerBuyRatio > 0.68) {
          continue; // aggressive buying still active
        }
      }

      const stopLoss = flushCandle.high + Math.max(25, 0.45 * currentAtr);
      const risk = stopLoss - currentPrice;
      const takeProfit = Math.min(flushCandle.low, currentPrice - Math.max(risk * 2.2, 2.0 * currentAtr));
      const rrRatio = risk > 0 ? (currentPrice - takeProfit) / risk : 0;

      return {
        isValid: true,
        direction: "SHORT",
        flushExtreme: flushCandle.high,
        cascadeType: "SHORT_LIQUIDATION_CASCADE_FADE",
        oiContractionPct: Number(effectiveOiContraction.toFixed(2)),
        volumeMult: Number(volMult.toFixed(2)),
        reversalWickPct: Number((upperWickRatio * 100).toFixed(0)),
        stopLoss,
        takeProfit,
        riskReward: Number(rrRatio.toFixed(2)),
        description: `Short Squeeze Cascade Fade: Forced short liquidations spiked price up to $${flushCandle.high.toFixed(2)} with ${volMult.toFixed(2)}x volume surge & ${effectiveOiContraction.toFixed(2)}% OI contraction. Squeeze exhaustion wick confirmed (${(upperWickRatio * 100).toFixed(0)}% upper wick). Fading air pocket back to origin $${takeProfit.toFixed(2)} (Strict SL: $${stopLoss.toFixed(2)}, R:R ${rrRatio.toFixed(2)}:1).`
      };
    }

    const primary = candidates[0];
    return {
      isValid: false,
      direction,
      flushExtreme: primary.candle.high,
      cascadeType: "",
      oiContractionPct: effectiveOiContraction,
      volumeMult: primary.volMult,
      reversalWickPct: primary.wickRatio * 100,
      stopLoss: 0,
      takeProfit: 0,
      riskReward: 0,
      description: `No short squeeze liquidation cascade (Vol: ${primary.volMult.toFixed(2)}x/${minVolMult}x, OI Contraction: ${effectiveOiContraction.toFixed(2)}%/${minContractionPct}%, Upper Wick: ${(primary.wickRatio * 100).toFixed(0)}%/${(minWickPct * 100).toFixed(0)}%)`
    };
  }
}
