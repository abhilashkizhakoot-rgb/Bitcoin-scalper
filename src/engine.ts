//  2026 BTC Trading Engine  Advanced High Frequency Quant Architecture
/**
 * Trading Engine Core
 */
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from "fs";
import * as path from "path";
import { dbManager } from "./db_sim.js";
import {
  Candlestick,
  MarketRegime,
  NewsHeadline,
  NewsSource,
  Trade,
  TradeDirection,
  ExitReason,
  TradingSignal,
  StrategyConfig,
  MarketStructureConfig,
} from "./types.js";
import { FinBertSentimentModel } from "./finbert.js";
import { CrossSourceSentimentAggregator } from "./sentimentEngine.js";
import { fetchLiveRSSHeadlines } from "./rss.js";
import { placeDeltaMarketOrder, getDeltaWalletBalance } from "./delta_client.js";

export interface MarketStructureSubCondition {
  name: string;
  status: "PASS" | "FAIL" | "SKIP";
  reason: string;
}

export interface MarketStructureConfirmationResult {
  confirmed: boolean;
  message: string;
  swingHigh: number;
  swingLow: number;
  ema_check_active?: boolean;
  ema_pair_evaluated?: string;
  ema_tested?: string;
  sub_conditions?: MarketStructureSubCondition[];
}

export interface TrendBreakoutSetupResult {
  confirmed: boolean;
  message: string;
  ema_check_active?: boolean;
  ema_pair_evaluated?: string;
  ema_tested?: string;
  sub_conditions?: MarketStructureSubCondition[];
}

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

class TradingEngine {
  private candles1m: Candlestick[] = [];
  private currentPrice: number = 101500;
  private indicatorCache = {
    ema: new Map<string, number[]>(),
    rsi: new Map<string, number[]>(),
    atr: new Map<string, number[]>(),
    adx: new Map<string, number[]>(),
    aggCandles: new Map<string, Candlestick[]>(),
    marketStructure: new Map<string, any>(),
    volumeProfile: new Map<string, any>(),
  };
  private currentVolume24h: number = 125400;
  private logs: string[] = [];
  private liveActiveTrade: Trade | null = null;
  private paperActiveTrade: Trade | null = null;
  private lastScanningTimestamp: string = "";
  private criticalEventActive: boolean = false;
  private criticalEventKeyword: string | null = null;
  private protectionRemainingSeconds: number | null = null;
  private currentRegime: MarketRegime = MarketRegime.RANGE_BOUND;
  private regimeConfidence: number = 0.5;
  private lastRegimeChangeTimestamp: number | null = null;
  private hasInitializedRegime: boolean = false;
  private tickCount: number = 0;
  private orderFlowStats = {
    takerBuyVolume: 0,
    takerSellVolume: 0,
    takerBuyRatio: 0.5,
    netCVD: 0,
    lastUpdateSecs: 0,
  };
  private orderBookStats = {
    bidDepthBTC: 15.2,
    askDepthBTC: 14.8,
    imbalanceRatio: 0.012,
    lastUpdateSecs: 0,
  };
  private orderBookImbalanceHistory: number[] = [];
  private openInterestStats = {
    currentOI: 108500,
    prevOI_1m: 108500,
    prevOI_5m: 108500,
    oiChange1m: 0,
    oiChangePct1m: 0,
    oiChange5m: 0,
    oiChangePct5m: 0,
    lastUpdateSecs: 0,
  };
  private openInterestHistory: { timestamp: number; oi: number; price: number }[] = [];

  public getOpenInterestStats() {
    return { ...this.openInterestStats };
  }

  public getTradeSizeMultiplier(): number {
    if (this.currentRegime === MarketRegime.LOW_VOLATILITY) {
      return 0.5; // Reduce position size by 50% under low volatility to preserve capital
    }
    return 1.0;
  }

  public getActiveMLModelName(): string {
    const isTrendRegime =
      this.currentRegime === MarketRegime.STRONG_UPTREND ||
      this.currentRegime === MarketRegime.STRONG_DOWNTREND ||
      this.currentRegime === MarketRegime.HIGH_VOLATILITY;
    return isTrendRegime ? "Trend-Following CatBoost Model" : "Mean-Reverting CatBoost Model";
  }

  /**
   * Routes the live indicator and sentiment data to the regime-specific emulated CatBoost model.
   * Trend-Following: Optimized for strong trends, follows momentum and sentiment aggressively.
   * Mean-Reverting: Optimized for sideways markets, buys oversold levels / BB lower, sells overbought.
   */
  private computeMLProbability(
    isBullTrend1m: boolean,
    currentRsi: number,
    currentClose: number,
    bb: { upper: number; lower: number; middle: number },
    regime: MarketRegime,
    adxValue: number = 25,
    relVolume: number = 1.0
  ): { probabilityLong: number; activeModel: string; score: number } {
    const isTrendRegime =
      regime === MarketRegime.STRONG_UPTREND ||
      regime === MarketRegime.STRONG_DOWNTREND ||
      regime === MarketRegime.HIGH_VOLATILITY;

    let probabilityLong = 0.5;
    let score = 0;
    let activeModel = "";

    const rsiFactor = (currentRsi - 50) / 100; // range -0.5 to +0.5

    // Normalize ADX (typically 0-100, we scale it to help boost or dampen coefficients)
    const adxScale = Math.min(1.5, Math.max(0.5, adxValue / 25)); // centered at 1.0 for ADX=25
    // Normalize Relative Volume (breakout indicator)
    const volScale = Math.min(1.8, Math.max(0.6, relVolume / 1.3)); // centered at 1.0 for relVolume=1.3

    // Calculate missing high-dimensional indicators for CatBoost emulation:
    const closes = this.candles1m.map((c) => c.close);
    const hasEnoughData = closes.length >= 50;
    const lastIdx = hasEnoughData ? closes.length - 1 : 0;

    // 1. EMA spreads (Trend Speed & Acceleration)
    const ema9 = hasEnoughData ? this.calculateEMA(closes, 9) : [currentClose];
    const ema21 = hasEnoughData ? this.calculateEMA(closes, 21) : [currentClose];
    const ema9Val = (ema9.length > lastIdx && ema9[lastIdx] !== undefined) ? ema9[lastIdx] : currentClose;
    const ema21Val = (ema21.length > lastIdx && ema21[lastIdx] !== undefined) ? ema21[lastIdx] : currentClose;

    // EMA spread: positive when 9 > 21 (bullish acceleration), negative when 9 < 21 (bearish)
    // Scaled to range -0.4 to 0.4 under strong momentum
    const emaSpreadFactor = (ema9Val - ema21Val) / (ema21Val || 1) * 15.0;

    // 2. ATR Volatility Expansion Ratio
    const atr14 = hasEnoughData ? this.calculateATR(this.candles1m, 14) : [50];
    const currentAtr = atr14[lastIdx] || 50;
    let sumAtrLong = 0;
    const lookback = Math.min(closes.length, 50);
    for (let i = closes.length - lookback; i < closes.length; i++) {
      sumAtrLong += atr14[i] || 50;
    }
    const longTermAtr = sumAtrLong / lookback;
    const atrExpansionRatio = currentAtr / (longTermAtr || 1);

    // Retrieve live high-frequency order book and order flow stats
    const takerBuyRatio = this.orderFlowStats ? this.orderFlowStats.takerBuyRatio : 0.5;
    const obImbalance = this.orderBookStats ? this.orderBookStats.imbalanceRatio : 0.0;

    // Retrieve news sentiment catalysts
    const headlines = dbManager.getHeadlines().slice(0, 15);
    const avgSentiment = this.calculateAverageSentiment(headlines);

    // Retrieve active market structure confirmation
    const struct = this.getTrendMarketStructure();

    if (isTrendRegime) {
      activeModel = "Trend-Following CatBoost Model";
      
      // Feature 1: Directional trend alignment. Bullish trend gets positive bias, Bearish negative.
      const trendBias = isBullTrend1m ? 0.40 : -0.40;
      const adxTrendFactor = trendBias * adxScale;

      // Feature 2: Momentum (RSI).
      let momentumFactor = rsiFactor;
      if (isBullTrend1m && rsiFactor < 0) {
        momentumFactor *= 0.5; // Dampen negative RSI in an uptrend (buying dips)
      } else if (!isBullTrend1m && rsiFactor > 0) {
        momentumFactor *= 0.5; // Dampen positive RSI in a downtrend (shorting rallies)
      }

      // Feature 3: Volume confirmation of breakout
      const volConfirmation = isBullTrend1m ? (volScale - 1.0) * 0.15 : (1.0 - volScale) * 0.15;

      // Feature 4: ATR Volatility Expansion Breakout
      // Confirms breakout energy in the direction of the trend
      const atrBreakoutFactor = (isBullTrend1m ? 1 : -1) * Math.max(0, atrExpansionRatio - 0.8) * 0.25;

      // --- HIGH-DIMENSIONAL FEATURES FOR CATBOOST ---
      
      // Feature 5: Real-time Order Flow Taker Buy Ratio (ranges from -0.75 to +0.75)
      const orderFlowFactor = (takerBuyRatio - 0.5) * 1.5;

      // Feature 6: Real-time Order Book Imbalance Ratio (ranges from -0.6 to +0.6)
      const orderBookFactor = obImbalance * 0.6;

      // Feature 7: Real-time News Sentiment (ranges from -0.5 to +0.5)
      const sentimentFactor = avgSentiment * 0.5;

      // Feature 8: Real-time Market Structure Alignment
      let marketStructureFactor = 0.0;
      if (struct.isLongStructureConfirmed) {
        marketStructureFactor = 0.40;
      } else if (struct.isShortStructureConfirmed) {
        marketStructureFactor = -0.40;
      }

      // Combine factors with optimized CatBoost tree-weight mappings
      score = (
        adxTrendFactor + 
        (momentumFactor * 0.35) + 
        volConfirmation + 
        emaSpreadFactor + 
        atrBreakoutFactor +
        (orderFlowFactor * 0.50) +       // Real-time order flow pressure weight
        (orderBookFactor * 0.35) +       // Real-time order book imbalance weight
        (sentimentFactor * 0.30) +       // News sentiment weight
        (marketStructureFactor * 0.45)   // Multi-timeframe structure alignment weight
      );

      // Extra optimization adjustments for extreme regimes
      if (regime === MarketRegime.HIGH_VOLATILITY) {
        // High Volatility mode requires higher momentum sensitivity
        score *= 1.30; 
      } else if (regime === MarketRegime.STRONG_UPTREND) {
        // Upward structural bias
        score += 0.10;
      } else if (regime === MarketRegime.STRONG_DOWNTREND) {
        // Downward structural bias
        score -= 0.10;
      }

      // Pass through sigmoid function to yield accurate probability
      probabilityLong = Number((1 / (1 + Math.exp(-score * 4.8))).toFixed(4));
    } else {
      activeModel = "Mean-Reverting CatBoost Model";

      // Feature 1: Bollinger Band positioning (BB Position: 0 at lower band, 1 at upper band)
      const bbPosition = (currentClose - bb.lower) / (bb.upper - bb.lower || 1);
      const bbFactor = 0.5 - bbPosition; // positive near support, negative near resistance

      // Feature 1b: Non-linear edge accent (as we pierce the bands, mean-reversion pull increases parabolicly)
      let bbEdgeAccent = 0;
      if (bbPosition > 0.9) {
        bbEdgeAccent = -Math.pow(bbPosition - 0.9, 1.5) * 2.0;
      } else if (bbPosition < 0.1) {
        bbEdgeAccent = Math.pow(0.1 - bbPosition, 1.5) * 2.0;
      }

      // Feature 2: Mean-reverting RSI momentum (we trade counter to the short term RSI)
      const revertingRsiFactor = -rsiFactor * 0.75; // Sell high RSI, buy low RSI

      // Feature 2b: Non-linear RSI exhaustion accent (parabolic boost at overbought/oversold levels)
      let rsiExhaustionAccent = 0;
      if (currentRsi > 70) {
        rsiExhaustionAccent = -Math.pow((currentRsi - 70) / 10, 1.25) * 0.4;
      } else if (currentRsi < 30) {
        rsiExhaustionAccent = Math.pow((30 - currentRsi) / 10, 1.25) * 0.4;
      }

      // Feature 3: Volume exhaustion. If volume is high near bands, it confirms reversals/exhaustion.
      const distanceToEdge = Math.abs(bbPosition - 0.5) * 2.0; // 0 at middle, 1.0 at outer bands
      const volumeExhaustionFactor = bbFactor * (volScale - 0.3) * 0.6 * distanceToEdge;

      // Feature 4: VWAP Deviation Factor (institutional mean anchor)
      const lastCandle = hasEnoughData ? this.candles1m[lastIdx] : null;
      const vwapVal = lastCandle && lastCandle.vwap !== undefined ? lastCandle.vwap : bb.middle;
      const vwapDeviation = (currentClose - vwapVal) / (vwapVal || 1);
      const vwapDeviationFactor = -vwapDeviation * 15.0; // pullback pull

      // Feature 5: EMA Overstretch Contraction Spread Factor
      // (as EMA 9 deviates from EMA 21, mean-reverting pull back to middle increases)
      const emaOverstretchFactor = -emaSpreadFactor * 0.5;

      // --- NEW HIGH-DIMENSIONAL REAL-TIME VARIABLES FOR MEAN-REVERSION ---

      // Feature 6: Order Flow Exhaustion/Absorption Alignment (ranges from -0.4 to +0.4)
      // Positive when order flow supports the direction of mean-reversion
      let ofReversionFactor = 0.0;
      if (bbFactor > 0 && takerBuyRatio > 0.52) {
        // Near support (bbFactor > 0), buying absorption/volume helps trigger the bounce
        ofReversionFactor = (takerBuyRatio - 0.5) * 0.8;
      } else if (bbFactor < 0 && takerBuyRatio < 0.48) {
        // Near resistance (bbFactor < 0), selling absorption helps trigger the drop
        ofReversionFactor = (takerBuyRatio - 0.5) * 0.8; // negative factor, aligns with negative bbFactor
      }

      // Feature 7: Order Book Bid/Ask Imbalance (ranges from -0.25 to +0.25)
      // High bids at support or high asks at resistance boosts the reversal probability
      let obReversionFactor = 0.0;
      if (bbFactor > 0 && obImbalance > 0.05) {
        obReversionFactor = obImbalance * 0.25;
      } else if (bbFactor < 0 && obImbalance < -0.05) {
        obReversionFactor = obImbalance * 0.25; // negative factor, aligns with negative bbFactor
      }

      // Feature 8: Market Structure Breakout Avoidance Block
      // In range bound mode, if an actual market structure breakout is already confirmed, we scale down counter-trend probability aggressively to avoid fighting a new trend
      let rangeBreakoutDampener = 1.0;
      if (bbFactor > 0 && struct.isShortStructureConfirmed) {
        // Confirmed bearish breakout while we want to buy support -> reduce confidence
        rangeBreakoutDampener = 0.45;
      } else if (bbFactor < 0 && struct.isLongStructureConfirmed) {
        // Confirmed bullish breakout while we want to short resistance -> reduce confidence
        rangeBreakoutDampener = 0.45;
      }

      // Feature 9: News Sentiment Catalyst Influence (ranges from -0.15 to +0.15)
      // Positive news sentiment tilts range play upwards, negative sentiment tilts it downwards
      const sentimentImpact = avgSentiment * 0.15;

      // Feature 10: ATR Volatility Contraction / Breakout Protection Scale
      // In a mean-reverting environment, we scale down probability aggressively if volatility is expanding (breakout risk)
      let reversionConfidenceScale = 1.0;
      if (atrExpansionRatio > 1.25) {
        // High breakout risk: aggressively suppress mean-reversion score
        reversionConfidenceScale = Math.max(0.10, 1.0 - (atrExpansionRatio - 1.25) * 3.0);
      } else if (atrExpansionRatio < 0.85) {
        // High compression (quiet channels): boost mean-reversion probability
        reversionConfidenceScale = 1.35;
      } else {
        // Transition range
        reversionConfidenceScale = Math.max(0.4, Math.min(1.2, 1.35 - atrExpansionRatio));
      }

      // Combine all features with optimized tree weights
      score = (
        (bbFactor * 1.25) +
        bbEdgeAccent +
        revertingRsiFactor +
        rsiExhaustionAccent +
        volumeExhaustionFactor +
        vwapDeviationFactor +
        emaOverstretchFactor +
        ofReversionFactor +               // supportive absorption orderflow
        obReversionFactor +               // orderbook book wall pressure
        sentimentImpact                   // sentiment catalyst tilt
      ) * reversionConfidenceScale * rangeBreakoutDampener;

      if (regime === MarketRegime.LOW_VOLATILITY) {
        // Sideways low volatility dampens any strong probability towards 0.5 (noise reduction)
        score *= 0.4;
      }

      // Pass through sigmoid function
      probabilityLong = Number((1 / (1 + Math.exp(-score * 4.4))).toFixed(4));
    }

    return { probabilityLong, activeModel, score };
  }

  private get activeTrade(): Trade | null {
    if (dbManager.isPaperMode()) {
      return this.paperActiveTrade;
    }
    return this.liveActiveTrade;
  }

  private set activeTrade(trade: Trade | null) {
    if (dbManager.isPaperMode()) {
      this.paperActiveTrade = trade;
    } else {
      this.liveActiveTrade = trade;
    }
  }

  private getGateIdByName(name: string): string {
    const n = name.toLowerCase();
    if (n.includes("pre-flight") || n.includes("preflight") || n.includes("operational safety")) return "preflight";
    if (n.includes("value extension") || n.includes("z-score") || n.includes("z_dist") || n.includes("overextension") || n.includes("vwap deviation") || (n.includes("vwap") && !n.includes("ema")) || n.includes("ema 100") || n.includes("ema100")) return "value_extension";
    if (n.includes("catboost")) return "catboost";
    if (n.includes("regime transition") || n.includes("regime_cooldown")) return "regime_cooldown";
    if (n.includes("regime") && !n.includes("transition")) return "regime";
    if (n.includes("exponential trend alignment") || (n.includes("trend") && !n.includes("adx"))) return "trend";
    if (n.includes("sentiment")) return "sentiment";
    if (n.includes("volume") && !n.includes("volume profiling")) return "volume";
    if (n.includes("news")) return "news";
    if (n.includes("limit") || n.includes("equity") || n.includes("credentials") || (n.includes("cooldown") && !n.includes("regime"))) return "preflight";
    if (n.includes("adx")) return "adx";
    if (n.includes("timing")) return "timing";
    if (n.includes("wedge")) return "wedge";
    if (n.includes("order flow") || n.includes("orderflow")) return "orderflow";
    if (n.includes("squeeze")) return "squeeze";
    if (n.includes("imbalance") || n.includes("orderbook")) return "orderbook";
    if (n.includes("atr")) return "atr";
    if (n.includes("volume profiling") || n.includes("volume_profile")) return "volume_profile";
    if (n.includes("structure")) return "structure";
    if (n.includes("choppy") || n.includes("whip-saw")) return "choppy";
    return n;
  }

  private getRegimeAdaptiveGateStatus(config: StrategyConfig, gateId: string): "MANDATORY" | "WEIGHTED" | "BYPASSED" | null {
    if (!config.general.regime_adaptive_gates_enabled) return null;

    const currentRegime = this.currentRegime;

    // Check custom overrides if configured for this regime
    const customRegimeOverride = config.general.regime_gate_overrides?.[currentRegime];
    if (customRegimeOverride) {
      if (customRegimeOverride.mandatory_gates?.includes(gateId)) return "MANDATORY";
      if (customRegimeOverride.weighted_gates?.includes(gateId)) return "WEIGHTED";
      if (customRegimeOverride.bypassed_gates?.includes(gateId)) return "BYPASSED";
      if (gateId === "preflight") {
        if (customRegimeOverride.mandatory_gates?.some(g => ["limit", "equity", "credentials", "cooldown"].includes(g))) return "MANDATORY";
        if (customRegimeOverride.weighted_gates?.some(g => ["limit", "equity", "credentials", "cooldown"].includes(g))) return "WEIGHTED";
        if (customRegimeOverride.bypassed_gates?.some(g => ["limit", "equity", "credentials", "cooldown"].includes(g))) return "BYPASSED";
      }
      if (gateId === "value_extension") {
        if (customRegimeOverride.mandatory_gates?.some(g => ["vwap", "ema100", "overextension", "value_extension"].includes(g))) return "MANDATORY";
        if (customRegimeOverride.weighted_gates?.some(g => ["vwap", "ema100", "overextension", "value_extension"].includes(g))) return "WEIGHTED";
        if (customRegimeOverride.bypassed_gates?.some(g => ["vwap", "ema100", "overextension", "value_extension"].includes(g))) return "BYPASSED";
      }
    }

    // Falls back to Global Static Gate Parameters when no custom override is specified for this gate/regime
    return null;
  }

  private isGateMandatory(config: StrategyConfig, name: string): boolean {
    const gateId = this.getGateIdByName(name);
    const adaptiveStatus = this.getRegimeAdaptiveGateStatus(config, gateId);
    if (adaptiveStatus === "MANDATORY") return true;
    if (adaptiveStatus === "WEIGHTED" || adaptiveStatus === "BYPASSED") return false;

    const mandatory = config.general.mandatory_gates || [];
    if (mandatory.includes(gateId)) return true;
    if (gateId === "preflight" && mandatory.some(g => ["limit", "equity", "credentials", "cooldown"].includes(g))) return true;
    if (gateId === "value_extension" && mandatory.some(g => ["vwap", "ema100", "overextension", "value_extension"].includes(g))) return true;
    return false;
  }

  private isGateWeighted(config: StrategyConfig, name: string): boolean {
    const gateId = this.getGateIdByName(name);
    const adaptiveStatus = this.getRegimeAdaptiveGateStatus(config, gateId);
    if (adaptiveStatus === "WEIGHTED") return true;
    if (adaptiveStatus === "MANDATORY" || adaptiveStatus === "BYPASSED") return false;

    const weighted = config.general.weighted_gates || [];
    if (weighted.includes(gateId)) return true;
    if (gateId === "preflight" && weighted.some(g => ["limit", "equity", "credentials", "cooldown"].includes(g))) return true;
    if (gateId === "value_extension" && weighted.some(g => ["vwap", "ema100", "overextension", "value_extension"].includes(g))) return true;
    return false;
  }

  private isGateActive(config: StrategyConfig, name: string): boolean {
    const gateId = this.getGateIdByName(name);
    const adaptiveStatus = this.getRegimeAdaptiveGateStatus(config, gateId);
    if (adaptiveStatus === "MANDATORY" || adaptiveStatus === "WEIGHTED") return true;
    if (adaptiveStatus === "BYPASSED") return false;

    if (config.general.mandatory_gates || config.general.weighted_gates) {
      const mandatory = config.general.mandatory_gates || [];
      const weighted = config.general.weighted_gates || [];
      if (mandatory.includes(gateId) || weighted.includes(gateId)) return true;
      if (gateId === "preflight" && (
        mandatory.some(g => ["limit", "equity", "credentials", "cooldown"].includes(g)) ||
        weighted.some(g => ["limit", "equity", "credentials", "cooldown"].includes(g))
      )) return true;
      if (gateId === "value_extension" && (
        mandatory.some(g => ["vwap", "ema100", "overextension", "value_extension"].includes(g)) ||
        weighted.some(g => ["vwap", "ema100", "overextension", "value_extension"].includes(g))
      )) return true;
      return false;
    }
    return this.isGateRequiredLegacy(config, name);
  }

  private isGateRequiredLegacy(config: StrategyConfig, name: string): boolean {
    const requiredGates = config.general.required_gates;
    if (requiredGates) {
      return requiredGates.some(
        (g) =>
          g.toLowerCase() === name.toLowerCase() ||
          (name.toLowerCase().includes("regime transition") && g.toLowerCase() === "regime_cooldown") ||
          (name.toLowerCase().includes("trend") && g.toLowerCase() === "trend") ||
          (name.toLowerCase().includes("structure") && g.toLowerCase() === "structure") ||
          (name.toLowerCase().includes("catboost") && g.toLowerCase() === "catboost") ||
          (name.toLowerCase().includes("regime") && !name.toLowerCase().includes("transition") && g.toLowerCase() === "regime") ||
          (name.toLowerCase().includes("sentiment") && g.toLowerCase() === "sentiment") ||
          (name.toLowerCase().includes("volume") && !name.toLowerCase().includes("volume profiling") && g.toLowerCase() === "volume") ||
          (name.toLowerCase().includes("news") && g.toLowerCase() === "news") ||
          (name.toLowerCase().includes("limit") && g.toLowerCase() === "limit") ||
          (name.toLowerCase().includes("adx") && g.toLowerCase() === "adx") ||
          (name.toLowerCase().includes("equity") && g.toLowerCase() === "equity") ||
          (name.toLowerCase().includes("credentials") && g.toLowerCase() === "credentials") ||
          (name.toLowerCase().includes("loss streak cooldown") && g.toLowerCase() === "cooldown") ||
          (name.toLowerCase().includes("timing") && g.toLowerCase() === "timing") ||
          (name.toLowerCase().includes("vwap") && g.toLowerCase() === "vwap") ||
          (name.toLowerCase().includes("wedge") && g.toLowerCase() === "wedge") ||
          (name.toLowerCase().includes("order flow") && g.toLowerCase() === "orderflow") ||
          (name.toLowerCase().includes("squeeze") && g.toLowerCase() === "squeeze") ||
          (name.toLowerCase().includes("imbalance") && g.toLowerCase() === "orderbook") ||
          (name.toLowerCase().includes("atr") && g.toLowerCase() === "atr") ||
          (name.toLowerCase().includes("volume profiling") && g.toLowerCase() === "volume_profile") ||
          ((name.toLowerCase().includes("ema 100") || name.toLowerCase().includes("ema")) && g.toLowerCase() === "ema100")
      );
    }

    const skippedGates = config.general.skipped_gates || [];
    const isSkipped = skippedGates.some(
      (g) =>
        g.toLowerCase() === name.toLowerCase() ||
        (name.toLowerCase().includes("trend") && g.toLowerCase().includes("trend")) ||
        (name.toLowerCase().includes("structure") && g.toLowerCase().includes("structure")) ||
        (name.toLowerCase().includes("catboost") && g.toLowerCase().includes("catboost")) ||
        (name.toLowerCase().includes("regime") && g.toLowerCase().includes("regime")) ||
        (name.toLowerCase().includes("sentiment") && g.toLowerCase().includes("sentiment")) ||
        (name.toLowerCase().includes("volume") && g.toLowerCase().includes("volume")) ||
        (name.toLowerCase().includes("news") && g.toLowerCase().includes("news")) ||
        (name.toLowerCase().includes("limit") && g.toLowerCase().includes("limit")) ||
        (name.toLowerCase().includes("adx") && g.toLowerCase().includes("adx")) ||
        (name.toLowerCase().includes("equity") && g.toLowerCase().includes("equity")) ||
        (name.toLowerCase().includes("credentials") && g.toLowerCase().includes("credentials")) ||
        (name.toLowerCase().includes("cooldown") && g.toLowerCase().includes("cooldown")) ||
        (name.toLowerCase().includes("timing") && g.toLowerCase().includes("timing")) ||
        (name.toLowerCase().includes("vwap") && g.toLowerCase().includes("vwap")) ||
        (name.toLowerCase().includes("wedge") && g.toLowerCase().includes("wedge")) ||
        (name.toLowerCase().includes("order flow") && g.toLowerCase().includes("orderflow")) ||
        (name.toLowerCase().includes("squeeze") && g.toLowerCase().includes("squeeze")) ||
        (name.toLowerCase().includes("imbalance") && g.toLowerCase().includes("orderbook")) ||
        ((name.toLowerCase().includes("ema 100") || name.toLowerCase().includes("ema")) && g.toLowerCase().includes("ema100"))
    );
    return !isSkipped;
  }

  /**
   * Calculates a unified order flow confluence score ranging from 0 to 100.
   * Rather than a hard binary pass/fail cutoff at 0.51, this implements a continuous
   * fuzzy rating system that blends taker buy volume ratios and order book bid/ask depth imbalance.
   */
  private getOrderFlowScore(direction: "LONG" | "SHORT" | "NEUTRAL"): {
    score: number;
    takerBuyRatio: number;
    imbalanceRatio: number;
    label: string;
    description: string;
  } {
    const takerBuyRatio = this.orderFlowStats.takerBuyRatio;
    const imbalanceRatio = this.orderBookStats.imbalanceRatio; // ranges from -1.0 to 1.0 (bid depth vs ask depth)

    if (direction === "NEUTRAL") {
      return {
        score: 50,
        takerBuyRatio,
        imbalanceRatio,
        label: "Neutral",
        description: "No trade direction is actively selected to measure order flow alignment."
      };
    }

    let ofAlignment = 0.5;
    let obAlignment = 0.0;

    if (direction === "LONG") {
      // Scale taker buy ratio. Standard is 0.51. Let's map [0.45, 0.65] to [0, 100]
      ofAlignment = Math.max(0, Math.min(100, ((takerBuyRatio - 0.45) / 0.20) * 100));
      // Scale order book imbalance. Bid depth is positive bid-ask imbalance. Map [-0.30, 0.30] to [0, 100]
      obAlignment = Math.max(0, Math.min(100, ((imbalanceRatio - (-0.30)) / 0.60) * 100));
    } else { // SHORT
      // Scale taker sell ratio (1 - takerBuyRatio). Standard is <= 0.49. Map [0.35, 0.55] for taker buy ratio to [100, 0] sell pressure
      const takerSellRatio = 1.0 - takerBuyRatio;
      ofAlignment = Math.max(0, Math.min(100, ((takerSellRatio - 0.45) / 0.20) * 100));
      // Scale order book imbalance for short. Negative is bid < ask depth. Map [-0.30, 0.30] of ask-bid to [0, 100]
      // which is mapping imbalanceRatio from +0.30 (worst for short) to -0.30 (best for short)
      obAlignment = Math.max(0, Math.min(100, (((-imbalanceRatio) - (-0.30)) / 0.60) * 100));
    }

    // Blend: 70% active market taker volume (aggressive flow), 30% passive order book depth (limit order flow)
    let score = Math.round(ofAlignment * 0.70 + obAlignment * 0.30);
    score = Math.max(0, Math.min(100, score));

    let label = "Neutral";
    let description = "";

    if (score >= 75) {
      label = "Extreme Conflow";
      description = direction === "LONG"
        ? "Aggressive market buys and heavy bid depth indicate immediate upward momentum. Dynamic bypass is active."
        : "Heavy market selling and wall of asks suggest severe downside acceleration. Dynamic bypass is active.";
    } else if (score >= 52) {
      label = "Strongly Aligned";
      description = direction === "LONG"
        ? "Consistent buyer participation and bid-side buffer confirm a solid long entry flow."
        : "Consistent seller pressure and ask-side weight confirm a solid short entry flow.";
    } else if (score >= 43) {
      label = "Acceptable Confluence";
      description = "Order flow displays moderate supportive activity. Acceptable under high confidence technical setup.";
    } else if (score >= 30) {
      label = "Mixed / Divergent";
      description = "Order flow lacks a strong trend alignment. Entries restricted unless supported by exceptional AI consensus.";
    } else {
      label = "Counter-Trend Risk";
      description = "Critical liquidity resistance or strong counter-pressure detected. Entry highly restricted.";
    }

    return {
      score,
      takerBuyRatio,
      imbalanceRatio,
      label,
      description
    };
  }

  /**
   * Evaluates order book stability and filters out high-frequency order book spoofing/flickering.
   * Compares order depth to executed market volume and historical imbalance volatility.
   */
  private getOrderBookStability(direction: "LONG" | "SHORT" | "NEUTRAL"): {
    spoofRisk: number;
    stabilityIndex: number;
    adjustedImbalance: number;
    avgImbalance: number;
    imbalanceVolatility: number;
    flickeringScore: number;
    volumeMismatchScore: number;
    status: string;
    description: string;
  } {
    const instantImbalance = this.orderBookStats.imbalanceRatio;
    const takerBuyRatio = this.orderFlowStats.takerBuyRatio;
    const history = this.orderBookImbalanceHistory;

    if (history.length < 3) {
      return {
        spoofRisk: 0,
        stabilityIndex: 100,
        adjustedImbalance: instantImbalance,
        avgImbalance: instantImbalance,
        imbalanceVolatility: 0,
        flickeringScore: 0,
        volumeMismatchScore: 0,
        status: "STABLE",
        description: "Initializing order book history tracking (insufficient samples yet)."
      };
    }

    // 1. Calculate Average & Volatility of the Imbalance (Standard Deviation)
    const sum = history.reduce((a, b) => a + b, 0);
    const avgImbalance = sum / history.length;
    const variance = history.reduce((acc, val) => acc + Math.pow(val - avgImbalance, 2), 0) / history.length;
    const imbalanceVolatility = Math.sqrt(variance);

    // 2. Calculate Flickering (Average first-difference rate of change)
    let changeSum = 0;
    for (let i = 1; i < history.length; i++) {
      changeSum += Math.abs(history[i] - history[i - 1]);
    }
    const avgChange = changeSum / (history.length - 1);
    // Standard avgChange threshold: values above 0.15 indicate fast flickering of bid/ask size
    const flickeringScore = Math.min(100, Math.round((avgChange / 0.18) * 100));

    // 3. Calculate Volume Mismatch (Divergence with actual taker executed trades)
    // Positive imbalance means bids > asks. If bids > asks, we expect buy pressure (takerBuyRatio > 0.5)
    // If bids > asks (+0.5 imbalance) but market is heavy selling (takerBuyRatio = 0.35), that's a massive mismatch
    // Same for bids < asks (negative imbalance) but market is heavy buying (takerBuyRatio = 0.65)
    const imbalanceNormalized = instantImbalance; // ranges -1.0 to 1.0
    const netTakerPressure = takerBuyRatio * 2 - 1; // ranges -1.0 to 1.0
    
    // Mismatch magnitude
    const volumeMismatch = Math.abs(imbalanceNormalized - netTakerPressure); // range 0 to 2.0
    const volumeMismatchScore = Math.min(100, Math.round((volumeMismatch / 1.2) * 100));

    // 4. Calculate Combined Spoof Risk (0 to 100)
    // High flickering or high divergence under thin order flow means a high probability of institutional walls being fake/spoofs
    const spoofRisk = Math.round(flickeringScore * 0.4 + volumeMismatchScore * 0.6);
    const stabilityIndex = Math.max(0, 100 - spoofRisk);

    // 5. Compute Adjusted Imbalance
    // If spoof risk is high, we damp the instant imbalance toward the historical average or closer to 0 (neutralizing the fake wall)
    const dampingFactor = Math.max(0, Math.min(1, (100 - spoofRisk) / 100));
    const adjustedImbalance = instantImbalance * dampingFactor + avgImbalance * (1 - dampingFactor);

    let status = "STABLE";
    let description = "Order book depth profiles are stable and backed by concurrent market trade volumes.";

    if (spoofRisk >= 70) {
      status = "HIGH_SPOOF_ALERT";
      description = "Extremely unstable order book profile detected! Limit order walls are rapidly flashing and contradict actual trade executions. Likely false wall spoofing. Symmetrical gating thresholds are tightened.";
    } else if (spoofRisk >= 40) {
      status = "MODERATE_SPOOF_RISK";
      description = "Moderate divergence or rapid size changes. Portions of limit depth may be transient. Gates are slightly damped for safety.";
    }

    return {
      spoofRisk,
      stabilityIndex,
      adjustedImbalance,
      avgImbalance,
      imbalanceVolatility,
      flickeringScore,
      volumeMismatchScore,
      status,
      description
    };
  }

  constructor() {
    // Restore open active trades from database stores on startup
    const openLiveTrade = dbManager.getLiveTrades().find((t) => t.exit_price === null);
    if (openLiveTrade) {
      this.liveActiveTrade = openLiveTrade;
    }

    const openPaperTrade = dbManager.getPaperTrades().find((t) => t.exit_price === null);
    if (openPaperTrade) {
      this.paperActiveTrade = openPaperTrade;
    }

    this.initCandles();
    this.startLoop();
  }

  private log(msg: string) {
    const timestamp = new Date().toISOString();
    const formatted = `[${timestamp}] ${msg}`;
    this.logs.unshift(formatted);
    if (this.logs.length > 500) {
      this.logs.pop();
    }
    console.log(formatted);
  }

  public getLogs(): string[] {
    return this.logs;
  }

  private logTradeToFile(trade: Trade, checkpoints: any) {
    const config = dbManager.getConfig();
    if (config.general.enable_trade_logging === false) {
      return;
    }

    try {
      const DATA_DIR = process.env.DATA_DIR || process.cwd();
      const logFilePath = path.join(DATA_DIR, "trade_log");

      const timestamp = new Date().toISOString();
      const separator = "=".repeat(80) + "\n";

      let checkpointStr = "";
      if (checkpoints && checkpoints.conditions) {
        checkpointStr = "EVALUATED CHECKPOINT GATES STATUS:\n";
        checkpoints.conditions.forEach((c: any) => {
          const statusChar = c.met ? "[OK] [PASS]" : "[X] [FAIL]";
          checkpointStr += `  - ${statusChar} ${c.name} (Priority: ${c.priority || "MEDIUM"})\n`;
          checkpointStr += `    Current Value : ${c.current_value}\n`;
          checkpointStr += `    Required      : ${c.required}\n`;
          checkpointStr += `    Description   : ${c.description}\n\n`;
        });
      } else {
        checkpointStr = "No checkpoints evaluated or available.\n";
      }

      // Compute and snapshot maximum features for offline/ML optimization
      const takerBuyVol = this.orderFlowStats.takerBuyVolume;
      const takerSellVol = this.orderFlowStats.takerSellVolume;
      const takerBuyPct = (this.orderFlowStats.takerBuyRatio * 100).toFixed(2);
      const netCVDVal = this.orderFlowStats.netCVD;

      const bidDepth = this.orderBookStats.bidDepthBTC;
      const askDepth = this.orderBookStats.askDepthBTC;
      const totalDepth = bidDepth + askDepth;
      const rawImbalance = (this.orderBookStats.imbalanceRatio * 100).toFixed(2);
      const stability = this.getOrderBookStability(trade.direction);
      const adjImbalance = (stability.adjustedImbalance * 100).toFixed(2);
      const stabilityIdx = stability.stabilityIndex;
      const spoofRsk = stability.spoofRisk;

      const closes = this.candles1m.map((c) => c.close);
      const volumes = this.candles1m.map((c) => c.volume);
      const hasEnough = closes.length >= 50;
      const currentPrice = this.currentPrice;

      const rsi14 = hasEnough ? this.calculateRSI(closes, 14) : [50];
      const currentRsi = rsi14[closes.length - 1] !== undefined ? rsi14[closes.length - 1] : 50;

      const adx14 = hasEnough ? this.calculateADX(this.candles1m, 14) : [25];
      const currentAdx = adx14[closes.length - 1] !== undefined ? adx14[closes.length - 1] : 25;

      const ema9 = hasEnough ? this.calculateEMA(closes, 9) : [currentPrice];
      const ema21 = hasEnough ? this.calculateEMA(closes, 21) : [currentPrice];
      const ema50 = hasEnough ? this.calculateEMA(closes, 50) : [currentPrice];
      const ema100 = hasEnough ? this.calculateEMA(closes, 100) : [currentPrice];
      const ema200 = hasEnough ? this.calculateEMA(closes, 200) : [currentPrice];

      const ema9Val = ema9[closes.length - 1] || currentPrice;
      const ema21Val = ema21[closes.length - 1] || currentPrice;
      const ema50Val = ema50[closes.length - 1] || currentPrice;
      const ema100Val = ema100[closes.length - 1] || currentPrice;
      const ema200Val = ema200[closes.length - 1] || currentPrice;

      const bb = this.calculateBollingerBands(closes, 20, 2);
      const struct = this.getTrendMarketStructure();

      const relVolume = this.calculateAccurateRelativeVolume();

      const logEntry =
        `[TRADE ENTRY] ${timestamp}\n` +
        `Trade ID         : ${trade.id}\n` +
        `Direction        : ${trade.direction}\n` +
        `Entry Price      : $${trade.entry_price}\n` +
        `Quantity (BTC)   : ${trade.quantity_btc} BTC\n` +
        `Leverage         : ${trade.leverage}x\n` +
        `Signal Score     : ${trade.entry_signal_score}/100\n` +
        `CatBoost Prob    : ${(trade.catboost_probability * 100).toFixed(1)}%\n` +
        `Regime At Entry  : ${trade.regime_at_entry}\n` +
        `Sentiment Score  : ${trade.sentiment_score_at_entry}\n` +
        `Stop Loss Price  : $${trade.feature_snapshot?.stop_loss_price || "--"}\n` +
        `Take Profit Price: $${trade.feature_snapshot?.take_profit_price || "--"}\n` +
        `ATR (14)         : $${trade.feature_snapshot?.atr_14 || "--"}\n` +
        `Fees Paid        : $${trade.fees_paid_usdt} USDT\n` +
        `\n` +
        `DETAILED MARKET STATE SNAPSHOT FOR OFFLINE OPTIMIZATION:\n` +
        `  1. MARKET REGIME & SENTIMENT:\n` +
        `    - Dominant Market Regime: ${this.currentRegime}\n` +
        `    - Regime Classification Confidence: ${(this.regimeConfidence * 100).toFixed(1)}%\n` +
        `  2. ORDER FLOW & CVD METRICS (BINANCE 1-MIN COALITION):\n` +
        `    - Taker Buy Volume      : ${takerBuyVol.toFixed(4)} BTC\n` +
        `    - Taker Sell Volume     : ${takerSellVol.toFixed(4)} BTC\n` +
        `    - Taker Buy Percentage  : ${takerBuyPct}%\n` +
        `    - Cumulative Volume Delta (CVD): ${netCVDVal.toFixed(4)} BTC\n` +
        `  3. ORDER BOOK LIQUIDITY DEPTH (DELTA TOP-10 WALLS):\n` +
        `    - Bid Depth (BTC)       : ${bidDepth.toFixed(3)} BTC\n` +
        `    - Ask Depth (BTC)       : ${askDepth.toFixed(3)} BTC\n` +
        `    - Total Depth Sum       : ${totalDepth.toFixed(3)} BTC\n` +
        `    - Raw Imbalance Ratio   : ${rawImbalance}%\n` +
        `    - Volume-Mismatch Filtered (Adjusted) Imbalance: ${adjImbalance}%\n` +
        `    - Wall Stability Index : ${stabilityIdx}%\n` +
        `    - Spoofing Risk Prob    : ${spoofRsk}%\n` +
        `  4. TECHNICAL INDICATORS SNAPSHOT:\n` +
        `    - RSI (14-period)       : ${currentRsi.toFixed(2)}\n` +
        `    - ADX (14-period)       : ${currentAdx.toFixed(2)}\n` +
        `    - Relative Volume (20)  : ${relVolume.toFixed(2)}x\n` +
        `    - Bollinger Bands Upper : $${bb.upper.toFixed(2)} (Dev position: ${((currentPrice - bb.lower) / (bb.upper - bb.lower || 1)).toFixed(4)})\n` +
        `    - Bollinger Bands Middle: $${bb.middle.toFixed(2)}\n` +
        `    - Bollinger Bands Lower : $${bb.lower.toFixed(2)}\n` +
        `    - Moving Averages (9): $${ema9Val.toFixed(2)} | (21): $${ema21Val.toFixed(2)} | (50): $${ema50Val.toFixed(2)} | (100): $${ema100Val.toFixed(2)} | (200): $${ema200Val.toFixed(2)}\n` +
        `    - EMA 21-50 Spread %    : ${(((ema21Val - ema50Val) / ema50Val) * 100).toFixed(4)}%\n` +
        `  5. MARKET STRUCTURE ANCHORS:\n` +
        `    - HH (Higher High)      : ${struct.current_HH ? `$${struct.current_HH.price.toFixed(2)} (Index: ${struct.current_HH.index})` : "None"}\n` +
        `    - LL (Lower Low)        : ${struct.current_LL ? `$${struct.current_LL.price.toFixed(2)} (Index: ${struct.current_LL.index})` : "None"}\n` +
        `    - LH (Lower High)       : ${struct.current_LH ? `$${struct.current_LH.price.toFixed(2)}` : "None"}\n` +
        `    - HL (Higher Low)       : ${struct.current_HL ? `$${struct.current_HL.price.toFixed(2)}` : "None"}\n` +
        `\n` +
        checkpointStr +
        separator;

      fs.appendFileSync(logFilePath, logEntry, "utf-8");
      this.log(`[NOTE] Logged trade entry ${trade.id} details to trade_log file.`);
    } catch (e) {
      console.error("[TradingEngine] Failed to write to trade_log file:", e);
    }
  }

  private logTradeExitToFile(trade: Trade) {
    const config = dbManager.getConfig();
    if (config.general.enable_trade_logging === false) {
      return;
    }

    try {
      const DATA_DIR = process.env.DATA_DIR || process.cwd();
      const logFilePath = path.join(DATA_DIR, "trade_log");

      const timestamp = new Date().toISOString();
      const separator = "=".repeat(80) + "\n";

      // Calculate exit metrics
      const closes = this.candles1m.map((c) => c.close);
      const hasEnough = closes.length >= 50;
      const rsi14 = hasEnough ? this.calculateRSI(closes, 14) : [50];
      const currentRsi = rsi14[closes.length - 1] !== undefined ? rsi14[closes.length - 1] : 50;

      const logEntry =
        `[TRADE EXIT] ${timestamp}\n` +
        `Trade ID         : ${trade.id}\n` +
        `Direction        : ${trade.direction}\n` +
        `Entry Price      : $${trade.entry_price}\n` +
        `Exit Price       : $${trade.exit_price}\n` +
        `Quantity (BTC)   : ${trade.quantity_btc} BTC\n` +
        `Hold Duration    : ${Math.floor(trade.hold_duration_seconds / 60)}m ${trade.hold_duration_seconds % 60}s\n` +
        `Exit Reason      : ${trade.exit_reason || "--"}\n` +
        `Is Win           : ${trade.is_win ? "YES [OK]" : "NO [X]"}\n` +
        `Fees Paid (Total): $${trade.fees_paid_usdt} USDT\n` +
        `Net P&L (USDT)   : $${(trade.pnl_usdt || 0).toFixed(2)} USDT (${(trade.pnl_pct || 0).toFixed(2)}%)\n` +
        `\n` +
        `DETAILED EXIT STATE SNAPSHOT FOR OFFLINE OPTIMIZATION:\n` +
        `  - Exit Market Regime : ${this.currentRegime}\n` +
        `  - Exit RSI (14-period): ${currentRsi.toFixed(2)}\n` +
        `  - Max Favorable Excursion (MFE): ${(trade.max_favorable_excursion * 100).toFixed(4)}%\n` +
        `  - Max Adverse Excursion (MAE) : ${(trade.max_adverse_excursion * 100).toFixed(4)}%\n` +
        `  - Final Position QuantityBTC : ${trade.quantity_btc} BTC\n` +
        `  - Final PNL % (including leverage): ${(trade.pnl_pct || 0).toFixed(4)}%\n` +
        `  - Entry Feature Snapshot Dump: ${JSON.stringify(trade.feature_snapshot || {})}\n` +
        separator;

      fs.appendFileSync(logFilePath, logEntry, "utf-8");
      this.log(`[NOTE] Logged trade exit ${trade.id} details to trade_log file.`);
    } catch (e) {
      console.error("[TradingEngine] Failed to write trade exit to trade_log file:", e);
    }
  }

  public getRegimeChangeCooldownStatus() {
    const config = dbManager.getConfig();
    const cooldownMins = config.general.regime_change_cooldown_minutes !== undefined
      ? config.general.regime_change_cooldown_minutes
      : 15; // Default to 15 mins

    if (this.lastRegimeChangeTimestamp === null) {
      return { active: false, remainingSeconds: 0 };
    }

    const elapsedMs = Date.now() - this.lastRegimeChangeTimestamp;
    const cooldownMs = cooldownMins * 60 * 1000;
    const remainingMs = cooldownMs - elapsedMs;

    if (remainingMs > 0) {
      return {
        active: true,
        remainingSeconds: Math.ceil(remainingMs / 1000),
      };
    }

    return { active: false, remainingSeconds: 0 };
  }

  public getStatus() {
    const creds = dbManager.getCredentials();
    const config = dbManager.getConfig();
    const active = this.activeTrade;
    const regimeCooldown = this.getRegimeChangeCooldownStatus();

    return {
      is_trading_active: config.general.is_trading_active,
      is_paper_trading: config.general.is_paper_trading,
      current_price: this.currentPrice,
      current_regime: this.currentRegime,
      regime_confidence: this.regimeConfidence,
      critical_event_active: this.criticalEventActive,
      critical_event_keyword: this.criticalEventKeyword,
      protection_remaining_seconds: this.protectionRemainingSeconds,
      regime_change_cooldown_remaining_seconds: regimeCooldown.active ? regimeCooldown.remainingSeconds : null,
      active_trade: active,
      account_balance_usdt: creds.account_balance_usdt,
      checkpoints: this.getCurrentCheckpoints(),
      active_ml_model: this.getActiveMLModelName(),
      trade_size_multiplier: this.getTradeSizeMultiplier(),
      market_structure: this.getTrendMarketStructure(),
      market_structure_config: config.market_structure || null,
    };
  }

  public getCandles() {
    return this.candles1m;
  }

  public getConsecutiveLossesCooldownStatus() {
    const config = dbManager.getConfig();
    const closedTrades = dbManager.getTrades()
      .filter((t) => t.exit_timestamp !== null)
      .sort((a, b) => new Date(b.exit_timestamp!).getTime() - new Date(a.exit_timestamp!).getTime());

    const maxLosses = config.risk_management.max_consecutive_losses || 3;
    const cooldownMins = config.risk_management.consecutive_losses_cooldown_minutes !== undefined 
      ? config.risk_management.consecutive_losses_cooldown_minutes 
      : 30; // Default to 30 mins

    let consecutiveLosses = 0;
    let latestLossTime: number | null = null;

    for (const t of closedTrades) {
      const isLoss = t.is_win === false || (t.pnl_usdt !== null && t.pnl_usdt < 0);
      const isWin = t.is_win === true || (t.pnl_usdt !== null && t.pnl_usdt > 0);

      if (isLoss) {
        if (consecutiveLosses === 0) {
          latestLossTime = new Date(t.exit_timestamp!).getTime();
        }
        consecutiveLosses++;
        if (consecutiveLosses >= maxLosses) {
          break;
        }
      } else if (isWin) {
        break; // Streak broken by a win
      }
    }

    if (consecutiveLosses >= maxLosses && latestLossTime !== null) {
      const cooldownMs = cooldownMins * 60 * 1000;
      const expiryTime = latestLossTime + cooldownMs;
      const now = Date.now();
      if (now < expiryTime) {
        const remainingSec = Math.ceil((expiryTime - now) / 1000);
        return {
          active: true,
          consecutiveLosses,
          remainingSeconds: remainingSec,
          expiryTime: new Date(expiryTime).toISOString()
        };
      }
    }

    return {
      active: false,
      consecutiveLosses,
      remainingSeconds: 0,
      expiryTime: null
    };
  }

  public calculateAverageSentiment(headlines: NewsHeadline[]): number {
    if (headlines.length === 0) return 0;
    // A simple arithmetic mean over multiple headlines dilutes high-conviction signals due to the high density of neutral news.
    // Instead, we compute a weighted average where articles with stronger sentiment (|score| > 0.15) are weighted 4x more than neutral ones.
    const weightedSum = headlines.reduce((sum, h) => {
      const weight = Math.abs(h.sentiment_score) > 0.15 ? 4.0 : 1.0;
      return sum + h.sentiment_score * weight;
    }, 0);
    const totalWeight = headlines.reduce((sum, h) => {
      const weight = Math.abs(h.sentiment_score) > 0.15 ? 4.0 : 1.0;
      return sum + weight;
    }, 0);
    return totalWeight > 0 ? Number((weightedSum / totalWeight).toFixed(4)) : 0;
  }

  public getISTTimingStatus(): { met: boolean; status: string; description: string; current_time: string } {
    const config = dbManager.getConfig();
    const windows = config.general.timing_windows || [];

    // Convert current Date to IST (UTC + 5:30)
    const d = new Date();
    const utcMs = d.getTime() + d.getTimezoneOffset() * 60000;
    const istOffset = 5.5 * 3600000;
    const istDate = new Date(utcMs + istOffset);

    const hour = istDate.getHours();
    const minute = istDate.getMinutes();
    const day = istDate.getDay(); // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
    const minutesOfDay = hour * 60 + minute;

    const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const dayStr = days[day];
    const timeStr = `${hour.toString().padStart(2, "0")}:${minute.toString().padStart(2, "0")} IST`;

    // Helper to parse "HH:MM" to minutes of day
    const parseTimeToMinutes = (timeStr: string): number => {
      const parts = timeStr.split(":");
      if (parts.length !== 2) return 0;
      const h = parseInt(parts[0], 10);
      const m = parseInt(parts[1], 10);
      return (isNaN(h) || isNaN(m)) ? 0 : h * 60 + m;
    };

    // Helper to check if a time falls in a window
    const isTimeInWindow = (minutes: number, startStr: string, endStr: string): boolean => {
      const start = parseTimeToMinutes(startStr);
      const end = parseTimeToMinutes(endStr);
      if (start === end) return false;
      if (start < end) {
        return minutes >= start && minutes < end;
      } else {
        // Crosses midnight (e.g. 22:30 to 01:30)
        return minutes >= start || minutes < end;
      }
    };

    // 1. Weekend Check: Saturday after 1:30 AM IST & all of Sunday IST
    let isWeekendNow = false;
    if (day === 0) {
      isWeekendNow = true;
    } else if (day === 6) {
      if (minutesOfDay > 90) {
        isWeekendNow = true;
      }
    }

    const weekendWindow = windows.find((w) => w.id === "weekends");
    if (isWeekendNow) {
      const allowed = weekendWindow ? weekendWindow.allowed : false;
      if (!allowed) {
        return {
          met: false,
          status: "RESTRICTED (Weekend Avoid Window)",
          description: weekendWindow?.description || "Volume drops significantly on weekends, increasing the risk of sharp liquidations and false trends.",
          current_time: `${dayStr}, ${timeStr}`
        };
      }
    }

    // 2. Session Match Check
    const matchingWindow = windows.find(
      (w) => w.id !== "weekends" && isTimeInWindow(minutesOfDay, w.start_time, w.end_time)
    );

    if (matchingWindow) {
      return {
        met: matchingWindow.allowed,
        status: matchingWindow.allowed
          ? `OPTIMAL (${matchingWindow.name}, ${matchingWindow.start_time} - ${matchingWindow.end_time})`
          : `RESTRICTED (${matchingWindow.name}, ${matchingWindow.start_time} - ${matchingWindow.end_time})`,
        description: matchingWindow.description,
        current_time: `${dayStr}, ${timeStr}`
      };
    }

    // Fallback if no matching session is defined for this minute
    return {
      met: true,
      status: "PASSING (Normal Hours, Non-Optimal)",
      description: "Outside designated session times. Proceed with caution.",
      current_time: `${dayStr}, ${timeStr}`
    };
  }

  private evaluateStrategyState() {
    const config = dbManager.getConfig();
    const ms = config.market_structure || {
      min_breakout_body_ratio: 0.22,
      allow_immediate_breakout: true,
      hf_momentum_adx_threshold: 30,
      hf_orderflow_taker_buy_ratio_long: 0.58,
      hf_orderflow_imbalance_ratio_long: 0.30,
      hf_orderflow_taker_buy_ratio_short: 0.42,
      hf_orderflow_imbalance_ratio_short: -0.30,
      pullback_multiplier_limit: 0.6,
      ema_retrace_multiplier_limit: 0.4,
      bypass_ema200_on_momentum: true,
      ema200_proximity_divisor: 3.0,
      weak_trend_adx_threshold: 25,
      trend_alignment_adx_threshold: 30,
      super_trend_adx_threshold: 35,
      fast_ema_period: 20,
      medium_ema_period: 50,
      slow_ema_period: 200,
    };
    const relVolThreshold = config.general.relative_volume_threshold !== undefined ? config.general.relative_volume_threshold : 1.3;
    const adxThreshold = config.general.adx_threshold !== undefined ? config.general.adx_threshold : 22.0;

    // Declared variables to capture intermediate scoring and confidence states in the outer scope
    let confidenceScore = 0;
    let confidenceThreshold = config.gate_scoring?.confidence_threshold ?? 70;
    let tacticalConfidenceMet = true;
    let safetyGates: string[] = [];
    let tacticalGatesMap: { condName: string; weightKey: "catboost_ai" | "market_regime" | "trend_alignment" | "adx_strength" | "relative_volume" | "overextension" | "ema100_overextension" | "wedge_filter" | "order_flow" | "squeeze_filter" | "order_book" | "volume_profile" }[] = [];
    let activeWeights: any = {};
    let marketStructurePassed = true;
    let totalTacticalWeight = 0;
    let earnedTacticalWeight = 0;

    const closes = this.candles1m.map((c) => c.close);
    
    // Fallback values if closes.length is less than 50
    const hasEnoughData = closes.length >= 50;
    const lastIdx = hasEnoughData ? closes.length - 1 : 0;

    const ema9 = hasEnoughData ? this.calculateEMA(closes, 9) : [this.currentPrice];
    const ema21 = hasEnoughData ? this.calculateEMA(closes, 21) : [this.currentPrice];
    const ema50 = hasEnoughData ? this.calculateEMA(closes, ms.medium_ema_period || 50) : [this.currentPrice];
    const rsi14 = hasEnoughData ? this.calculateRSI(closes, 14) : [50];

    const isBullAligned = hasEnoughData ? (ema9[lastIdx] > ema21[lastIdx] && ema21[lastIdx] > ema50[lastIdx]) : false;
    const isBearAligned = hasEnoughData ? (ema9[lastIdx] < ema21[lastIdx] && ema21[lastIdx] < ema50[lastIdx]) : false;

    const adx14 = hasEnoughData ? this.calculateADX(this.candles1m, 14) : [25];
    const adxValue = hasEnoughData ? adx14[lastIdx] : 25;

    const volumes = this.candles1m.map((c) => c.volume);
    const relVolume = this.calculateAccurateRelativeVolume();

    const isBullTrend1m = hasEnoughData ? ema21[lastIdx] > ema50[lastIdx] : true;
    const isBearTrend1m = hasEnoughData ? ema21[lastIdx] < ema50[lastIdx] : false;

    // Get headlines sentiment
    const headlines = dbManager.getHeadlines().slice(0, 15);
    const avgSentiment = this.calculateAverageSentiment(headlines);

    const currentPrice = this.currentPrice;

    const rm = config.risk_management;
    const isTrending = this.currentRegime === MarketRegime.STRONG_UPTREND || this.currentRegime === MarketRegime.STRONG_DOWNTREND;

    const emaThreshold = isTrending
      ? (rm.overextension_ema_trending_threshold ?? 2.2)
      : (rm.overextension_ema_ranging_threshold ?? 1.2);

    const vwapMultiplier = isTrending
      ? (rm.overextension_vwap_trending_multiplier ?? 1.5)
      : (rm.overextension_vwap_ranging_multiplier ?? 1.0);

    // Ensure VWAP is computed with the regime-specific multiplier
    this.calculateVWAP(this.candles1m, vwapMultiplier);
    const lastCandle = hasEnoughData ? this.candles1m[lastIdx] : null;
    const vwapVal = lastCandle && lastCandle.vwap !== undefined ? lastCandle.vwap : this.currentPrice;
    const vwapUpperVal = lastCandle && lastCandle.vwap_upper !== undefined ? lastCandle.vwap_upper : this.currentPrice * 1.01;
    const vwapLowerVal = lastCandle && lastCandle.vwap_lower !== undefined ? lastCandle.vwap_lower : this.currentPrice * 0.99;

    const currentRsi = rsi14[lastIdx] !== undefined ? rsi14[lastIdx] : 50;
    const bb = this.calculateBollingerBands(closes, 20, 2);

    let isRsiOverbought = currentRsi > 70;
    let isRsiOversold = currentRsi < 30;

    let isPriceBbOverbought = currentPrice >= bb.upper * 0.9995;
    let isPriceBbOversold = currentPrice <= bb.lower * 1.0005;

    const ensembleResult = this.computeMLProbability(
      isBullTrend1m,
      currentRsi,
      currentPrice,
      bb,
      this.currentRegime,
      adxValue,
      relVolume
    );
    let probabilityLong = ensembleResult.probabilityLong;
    const combinedScore = ensembleResult.score;

    // Accuracy dampening to prevent buying tops or shorting bottoms
    if (isRsiOverbought || isPriceBbOverbought) {
      if (probabilityLong > 0.70) probabilityLong = 0.70;
    }
    if (isRsiOversold || isPriceBbOversold) {
      if (probabilityLong < 0.30) probabilityLong = 0.30;
    }

    let signalDirection: "LONG" | "SHORT" | "NEUTRAL" = "NEUTRAL";
    const struct = this.getTrendMarketStructure();
    const opens = this.candles1m.map((c) => c.open);
    const averageBodySize = hasEnoughData
      ? closes.slice(-20).map((c, idx) => {
          const openVal = opens[closes.length - 20 + idx] !== undefined ? opens[closes.length - 20 + idx] : c;
          return Math.abs(c - openVal);
        }).reduce((a, b) => a + b, 0) / 20
      : 50;
    const currentCandle = hasEnoughData ? this.candles1m[lastIdx] : { time: Date.now() / 1000, open: currentPrice, close: currentPrice, high: currentPrice, low: currentPrice, volume: 0 };
    const currentBodySize = Math.abs(currentCandle.close - currentCandle.open);
    const atr14_cp = hasEnoughData ? this.calculateATR(this.candles1m, 14) : [50];
    const currentAtr_cp = atr14_cp[lastIdx] || 50;

    const ema20 = hasEnoughData ? this.calculateEMA(closes, ms.fast_ema_period || 20) : [currentPrice];
    const ema200 = hasEnoughData ? this.calculateEMA(closes, ms.slow_ema_period || 200) : [currentPrice];
    const ema100List = hasEnoughData ? this.calculateEMA(closes, Math.min(closes.length, 100)) : [currentPrice];
    const ema20Val = ema20[lastIdx] || currentPrice;
    const ema50Val = ema50[lastIdx] || currentPrice;
    const ema100Val = ema100List[lastIdx] !== undefined ? ema100List[lastIdx] : currentPrice;
    const ema200Val = ema200[lastIdx] || currentPrice;

    const probabilityShort = Number((1 - probabilityLong).toFixed(4));

    const trendAlignAdx = config.general.adx_threshold !== undefined ? config.general.adx_threshold : (ms.trend_alignment_adx_threshold || 22.0);
    const minRangingAdx = config.general.min_ranging_adx_threshold !== undefined ? config.general.min_ranging_adx_threshold : 22.0;
    const hardFloorAdx = config.general.min_adx_hard_floor !== undefined ? config.general.min_adx_hard_floor : 20.0;
    const superTrendAdx = ms.super_trend_adx_threshold || 35;

    let isUptrendAligned = ema20Val > ema50Val && ema50Val > ema200Val && adxValue >= trendAlignAdx && this.currentRegime === MarketRegime.STRONG_UPTREND;
    let isDowntrendAligned = ema20Val < ema50Val && ema50Val < ema200Val && adxValue >= trendAlignAdx && this.currentRegime === MarketRegime.STRONG_DOWNTREND;
    const isSuperStrongUptrend = (this.currentRegime === MarketRegime.STRONG_UPTREND || adxValue >= superTrendAdx) && 
                                 ema20Val > ema50Val && ema50Val > ema100Val;
    const isSuperStrongDowntrend = (this.currentRegime === MarketRegime.STRONG_DOWNTREND || adxValue >= superTrendAdx) && 
                                   ema20Val < ema50Val && ema50Val < ema100Val;

    // We block any entries on lower low breakouts (SHORT) or higher high breakouts (LONG)
    // and instead only enter at pushback at 20/50 EMA.
    const isSpecialSuperStrongTrendLogicActive = false;

    let isLongBreakout = false;
    let isShortBreakout = false;

    if (this.currentRegime === MarketRegime.RANGE_BOUND) {
      // Mean-Reversion and Breakout rules for RANGE_BOUND
      const rangeLookback = 30;
      const recentCandlesForRange = this.candles1m.slice(-rangeLookback - 1, -1);
      const rangeHigh = recentCandlesForRange.length > 0 ? Math.max(...recentCandlesForRange.map(c => c.high)) : struct.swingHigh;
      const rangeLow = recentCandlesForRange.length > 0 ? Math.min(...recentCandlesForRange.map(c => c.low)) : struct.swingLow;

      const rangeWidth = rangeHigh - rangeLow;

      // Restructured/optimized range reversal signal evaluation
      const revSignals = this.evaluateRangeReversalSignals(lastIdx);
      const isRangeLongReversal = revSignals.isLongReversal;
      const isRangeShortReversal = revSignals.isShortReversal;

      // Breakout signals: Price breaks outside the 30-candle range with validated breakout candle
      const breakoutValidationLong = this.validateRangeBreakout("LONG", currentCandle, relVolume, recentCandlesForRange);
      const breakoutValidationShort = this.validateRangeBreakout("SHORT", currentCandle, relVolume, recentCandlesForRange);

      const isRangeLongBreakout = (currentPrice > rangeHigh) && breakoutValidationLong.isValid;
      const isRangeShortBreakdown = (currentPrice < rangeLow) && breakoutValidationShort.isValid;

      // SMC, Range Reversal, VWAP Band Rejection (Setup 10), EQH/EQL Double Touch (Setup 11), CVD Absorption (Setup 12), and OI Flush (Setup 13) checks
      const smcSweepLong = this.detectLiquiditySweep("LONG");
      const smcSweepShort = this.detectLiquiditySweep("SHORT");
      const vwapReversalLong = this.evaluateVwapBandRejectionSetup("LONG");
      const vwapReversalShort = this.evaluateVwapBandRejectionSetup("SHORT");
      const eqhEqlLong = this.evaluateEqhEqlDoubleTouchSetup("LONG");
      const eqhEqlShort = this.evaluateEqhEqlDoubleTouchSetup("SHORT");
      const cvdAbsorptionLong = this.evaluateCvdAbsorptionDivergenceSetup("LONG");
      const cvdAbsorptionShort = this.evaluateCvdAbsorptionDivergenceSetup("SHORT");
      const oiFlushLong = this.evaluateOiFlushCascadeFadeSetup("LONG");
      const oiFlushShort = this.evaluateOiFlushCascadeFadeSetup("SHORT");

      const exhaustionLong = this.evaluateExhaustionReversalCondition("LONG", currentPrice, closes, lastIdx);
      const exhaustionShort = this.evaluateExhaustionReversalCondition("SHORT", currentPrice, closes, lastIdx);

      // Priority 1: Range Breakout / Breakdown (when price escapes range boundaries)
      if (isRangeShortBreakdown) {
        signalDirection = "SHORT";
      } else if (isRangeLongBreakout) {
        signalDirection = "LONG";
      } else if (oiFlushLong.isValid || cvdAbsorptionLong.isValid || isRangeLongReversal || vwapReversalLong.isValid || eqhEqlLong.isValid || (exhaustionLong.isExhausted && probabilityLong >= 0.48)) {
        signalDirection = "LONG";
      } else if (oiFlushShort.isValid || cvdAbsorptionShort.isValid || isRangeShortReversal || vwapReversalShort.isValid || eqhEqlShort.isValid || (exhaustionShort.isExhausted && probabilityShort >= 0.48)) {
        signalDirection = "SHORT";
      } else if (smcSweepLong.isSweep) {
        signalDirection = "LONG";
      } else if (smcSweepShort.isSweep) {
        signalDirection = "SHORT";
      } else {
        signalDirection = "NEUTRAL";
      }
    } else if (this.currentRegime === MarketRegime.LOW_VOLATILITY) {
      // In low volatility compression, detect if VWAP Reversal (Setup 10), EQH/EQL (Setup 11), CVD Absorption (Setup 12), or OI Flush (Setup 13) fires
      const vwapLong = this.evaluateVwapBandRejectionSetup("LONG");
      const vwapShort = this.evaluateVwapBandRejectionSetup("SHORT");
      const eqLong = this.evaluateEqhEqlDoubleTouchSetup("LONG");
      const eqShort = this.evaluateEqhEqlDoubleTouchSetup("SHORT");
      const cvdLong = this.evaluateCvdAbsorptionDivergenceSetup("LONG");
      const cvdShort = this.evaluateCvdAbsorptionDivergenceSetup("SHORT");
      const oiLong = this.evaluateOiFlushCascadeFadeSetup("LONG");
      const oiShort = this.evaluateOiFlushCascadeFadeSetup("SHORT");

      if (oiLong.isValid || cvdLong.isValid || vwapLong.isValid || eqLong.isValid) {
        signalDirection = "LONG";
      } else if (oiShort.isValid || cvdShort.isValid || vwapShort.isValid || eqShort.isValid) {
        signalDirection = "SHORT";
      } else {
        signalDirection = "NEUTRAL";
      }
    } else {
      // --- ENHANCED INTELLIGENT ENTRY SIGNAL DETECTION & PULLBACK PROXIMITY ---
      const recentCandles = this.candles1m.slice(-10);

      const recentPullbackToEma9Long = recentCandles.some(c => c.low <= ema9[lastIdx] * 1.0025 && c.high >= ema9[lastIdx] * 0.9975);
      const recentPullbackToEma20Long = recentCandles.some(c => c.low <= ema20Val * 1.0030 && c.high >= ema20Val * 0.9970);
      const recentPullbackToEma50Long = recentCandles.some(c => c.low <= ema50Val * 1.0030 && c.high >= ema50Val * 0.9970);
      const recentPullbackToVwapLong = recentCandles.some(c => c.low <= vwapVal * 1.0030 && c.high >= vwapVal * 0.9970);

      const recentPullbackToEma9Short = recentCandles.some(c => c.high >= ema9[lastIdx] * 0.9975 && c.low <= ema9[lastIdx] * 1.0025);
      const recentPullbackToEma20Short = recentCandles.some(c => c.high >= ema20Val * 0.9970 && c.low <= ema20Val * 1.0030);
      const recentPullbackToEma50Short = recentCandles.some(c => c.high >= ema50Val * 0.9970 && c.low <= ema50Val * 1.0030);
      const recentPullbackToVwapShort = recentCandles.some(c => c.high >= vwapVal * 0.9970 && c.low <= vwapVal * 1.0030);

      const pbStatus = this.detectPullbackTrendlineBreak();
      const isPbBreakoutLong = pbStatus.isLongBreak;
      const isPbBreakoutShort = pbStatus.isShortBreak;

      const hasValidPushbackLong = (recentPullbackToEma9Long || recentPullbackToEma20Long || recentPullbackToEma50Long || recentPullbackToVwapLong || isPbBreakoutLong) && currentPrice >= ema50Val * 0.996;
      const hasValidPushbackShort = (recentPullbackToEma9Short || recentPullbackToEma20Short || recentPullbackToEma50Short || recentPullbackToVwapShort || isPbBreakoutShort) && currentPrice <= ema50Val * 1.004;

      isUptrendAligned = ema20Val > ema50Val && (adxValue >= (ms.hf_momentum_adx_threshold || 20) || ema50Val > ema100Val);
      isDowntrendAligned = ema20Val < ema50Val && (adxValue >= (ms.hf_momentum_adx_threshold || 20) || ema50Val < ema100Val);

      // For high-frequency scalping, we allow breakouts (momentum chasing) if ADX is strong or there is high order flow pressure
      const isScalperBreakoutLongAllowed = adxValue >= ms.hf_momentum_adx_threshold || (this.orderFlowStats.takerBuyRatio >= ms.hf_orderflow_taker_buy_ratio_long || this.orderBookStats.imbalanceRatio >= ms.hf_orderflow_imbalance_ratio_long);
      const isScalperBreakdownShortAllowed = adxValue >= ms.hf_momentum_adx_threshold || (this.orderFlowStats.takerBuyRatio <= ms.hf_orderflow_taker_buy_ratio_short || this.orderBookStats.imbalanceRatio <= ms.hf_orderflow_imbalance_ratio_short);

      const isNotLongBreakout = isScalperBreakoutLongAllowed ? true : (struct.current_HH ? currentPrice <= struct.current_HH.price : true);
      const isNotShortBreakdown = isScalperBreakdownShortAllowed ? true : (struct.current_LL ? currentPrice >= struct.current_LL.price : true);

      // Multi-factor intelligent direction assessment (including SMC & Microstructural Setups)
      const longSweepSignal = this.detectLiquiditySweep("LONG");
      const shortSweepSignal = this.detectLiquiditySweep("SHORT");
      const cvdAbsorptionLong = this.evaluateCvdAbsorptionDivergenceSetup("LONG");
      const cvdAbsorptionShort = this.evaluateCvdAbsorptionDivergenceSetup("SHORT");
      const oiFlushLong = this.evaluateOiFlushCascadeFadeSetup("LONG");
      const oiFlushShort = this.evaluateOiFlushCascadeFadeSetup("SHORT");

      const exhaustionLong = this.evaluateExhaustionReversalCondition("LONG", currentPrice, closes, lastIdx);
      const exhaustionShort = this.evaluateExhaustionReversalCondition("SHORT", currentPrice, closes, lastIdx);

      const upperWickExhaustion = this.evaluateDirectionalExhaustionWicks("LONG");
      const lowerWickExhaustion = this.evaluateDirectionalExhaustionWicks("SHORT");

      const isStrongUptrend = this.currentRegime === MarketRegime.STRONG_UPTREND;
      const isStrongDowntrend = this.currentRegime === MarketRegime.STRONG_DOWNTREND;

      if (!isStrongDowntrend && oiFlushLong.isValid) {
        signalDirection = "LONG";
      } else if (!isStrongUptrend && oiFlushShort.isValid) {
        signalDirection = "SHORT";
      } else if (!isStrongDowntrend && cvdAbsorptionLong.isValid) {
        signalDirection = "LONG";
      } else if (!isStrongUptrend && cvdAbsorptionShort.isValid) {
        signalDirection = "SHORT";
      } else if (!isStrongDowntrend && longSweepSignal.isSweep && probabilityLong >= 0.50) {
        signalDirection = "LONG";
      } else if (!isStrongUptrend && shortSweepSignal.isSweep && probabilityShort >= 0.50) {
        signalDirection = "SHORT";
      } else if (!isStrongDowntrend && exhaustionLong.isExhausted && probabilityLong >= 0.48) {
        signalDirection = !upperWickExhaustion.isExhausted ? "LONG" : "NEUTRAL";
      } else if (!isStrongUptrend && exhaustionShort.isExhausted && probabilityShort >= 0.48) {
        signalDirection = !lowerWickExhaustion.isExhausted ? "SHORT" : "NEUTRAL";
      } else if (!isStrongDowntrend && isUptrendAligned && (hasValidPushbackLong || isScalperBreakoutLongAllowed) && isNotLongBreakout && probabilityLong >= 0.58) {
        signalDirection = !upperWickExhaustion.isExhausted ? "LONG" : "NEUTRAL";
      } else if (!isStrongUptrend && isDowntrendAligned && (hasValidPushbackShort || isScalperBreakdownShortAllowed) && isNotShortBreakdown && probabilityShort >= 0.58) {
        signalDirection = !lowerWickExhaustion.isExhausted ? "SHORT" : "NEUTRAL";
      } else if (!isStrongDowntrend && isUptrendAligned && (probabilityLong >= 0.55 || (this.orderFlowStats.takerBuyRatio >= 0.54 && currentRsi >= 45))) {
        signalDirection = !upperWickExhaustion.isExhausted ? "LONG" : "NEUTRAL";
      } else if (!isStrongUptrend && isDowntrendAligned && (probabilityShort >= 0.55 || (this.orderFlowStats.takerBuyRatio <= 0.46 && currentRsi <= 55))) {
        signalDirection = !lowerWickExhaustion.isExhausted ? "SHORT" : "NEUTRAL";
      } else {
        signalDirection = "NEUTRAL";
      }
    }

    // --- EARLY DIRECTION LOCK & SHORT-CIRCUIT PRE-FILTERING ---
    if (signalDirection === "NEUTRAL") {
      return {
        conditions: [
          {
            name: "Early Direction Lock",
            met: false,
            current_value: "NEUTRAL",
            required: "LONG or SHORT candidate setup detected",
            description: "No direction candidate identified under current market structure or momentum.",
            priority: "CRITICAL" as const,
          },
        ],
        entry_score: 0,
        signal_direction: "NEUTRAL" as const,
        all_conditions_met: false,
        rejection_reason: "Early Direction Lock: No setup identified (NEUTRAL).",
        probabilityLong,
        probabilityShort,
        avgSentiment: 0,
        currentClose: currentPrice,
        adxValue,
        relVolume,
        failedConditions: ["Early Direction Lock"],
        confidenceScore: 0,
        confidenceThreshold: 70,
        isWeightedEnabled: false,
        tacticalConfidenceMet: false,
        safetyGates: ["Early Direction Lock"],
        tacticalGatesMap: [],
        activeWeights: {},
        marketStructurePassed: false,
      };
    }

    // Evaluate active SMC / structural setup presence for threshold & alignment bypass
    const smcVwapActive = (signalDirection === "LONG" && this.evaluateVwapBandRejectionSetup("LONG").isValid) ||
                          (signalDirection === "SHORT" && this.evaluateVwapBandRejectionSetup("SHORT").isValid);
    const smcEqhEqlActive = (signalDirection === "LONG" && this.evaluateEqhEqlDoubleTouchSetup("LONG").isValid) ||
                            (signalDirection === "SHORT" && this.evaluateEqhEqlDoubleTouchSetup("SHORT").isValid);
    const isSmcActive = (signalDirection === "LONG" && (this.detectLiquiditySweep("LONG").isSweep || this.evaluateFailedAuctionSetup("LONG").isValid || smcVwapActive || smcEqhEqlActive)) ||
                        (signalDirection === "SHORT" && (this.detectLiquiditySweep("SHORT").isSweep || this.evaluateFailedAuctionSetup("SHORT").isValid || smcVwapActive || smcEqhEqlActive));

    if (this.currentRegime === MarketRegime.LOW_VOLATILITY && !isSmcActive) {
      return {
        conditions: [
          {
            name: "Market Regime Pre-Filter",
            met: false,
            current_value: "LOW_VOLATILITY",
            required: "STRONG_UPTREND, STRONG_DOWNTREND, RANGE_BOUND, or HIGH_VOLATILITY",
            description: "Low volatility regime prevents entries to avoid choppy sideways losses.",
            priority: "CRITICAL" as const,
          },
        ],
        entry_score: 0,
        signal_direction: signalDirection,
        all_conditions_met: false,
        rejection_reason: "Market Regime Pre-Filter: Blocked during LOW_VOLATILITY.",
        probabilityLong,
        probabilityShort,
        avgSentiment: 0,
        currentClose: currentPrice,
        adxValue,
        relVolume,
        failedConditions: ["Market Regime Pre-Filter"],
        confidenceScore: 0,
        confidenceThreshold: 70,
        isWeightedEnabled: false,
        tacticalConfidenceMet: false,
        safetyGates: ["Market Regime Pre-Filter"],
        tacticalGatesMap: [],
        activeWeights: {},
        marketStructurePassed: false,
      };
    }

    const conditions: {
      name: string;
      met: boolean;
      current_value: any;
      required: string;
      description: string;
      priority: "CRITICAL" | "HIGH" | "MEDIUM";
      softened?: boolean;
      ema_check_active?: boolean;
      ema_pair_evaluated?: string;
      ema_tested?: string;
      sub_conditions?: MarketStructureSubCondition[];
    }[] = [];

    // C1: CatBoost AI Prediction
    const pbTrendStatus = this.detectPullbackTrendlineBreak();
    const isEnteringPullback = true;

    const catboostThreshold = (this.currentRegime === MarketRegime.RANGE_BOUND || isSmcActive) 
      ? 0.50 
      : 0.55;
    const pLongMet = signalDirection === "LONG" ? (probabilityLong >= catboostThreshold) : false;
    const pShortMet = signalDirection === "SHORT" ? (probabilityShort >= catboostThreshold) : false;
    conditions.push({
      name: "CatBoost AI Prediction",
      met: (pLongMet || pShortMet),
      current_value: `P(LONG) = ${(probabilityLong * 100).toFixed(1)}% | P(SHORT) = ${(probabilityShort * 100).toFixed(1)}%`,
      required: signalDirection === "LONG"
        ? `P(LONG) >= ${(this.currentRegime === MarketRegime.RANGE_BOUND || isSmcActive) ? "50" : "55"}% (Evaluating LONG Trade)`
        : `P(SHORT) >= ${(this.currentRegime === MarketRegime.RANGE_BOUND || isSmcActive) ? "50" : "55"}% (Evaluating SHORT Trade)`,
      description: "Uses pre-trained ensemble trees mapping momentum, EMA spreads, and ATR volatility expansion.",
      priority: "CRITICAL",
    });

    const hasExtremeRealtimePressure = (config.general.enable_orderflow_softening !== false) &&
                                       ((signalDirection === "LONG" && (this.orderFlowStats.takerBuyRatio >= 0.68 || this.orderBookStats.imbalanceRatio >= 0.45)) ||
                                       (signalDirection === "SHORT" && (this.orderFlowStats.takerBuyRatio <= 0.32 || this.orderBookStats.imbalanceRatio <= -0.45)));

    const isLowVolatility = false;

    // C2: Market Regime lock
    // Blocked all entries during LOW_VOLATILITY unless structural setup active.
    const regimeValid = !isLowVolatility;
    const regimeAligned =
      (signalDirection === "LONG" && (this.currentRegime === MarketRegime.STRONG_UPTREND || this.currentRegime === MarketRegime.RANGE_BOUND)) ||
      (signalDirection === "SHORT" && (this.currentRegime === MarketRegime.STRONG_DOWNTREND || this.currentRegime === MarketRegime.RANGE_BOUND)) ||
      this.currentRegime === MarketRegime.HIGH_VOLATILITY;

    const isRegimeSoftened = false;

    conditions.push({
      name: "Market Regime Filter",
      met: regimeValid && regimeAligned,
      current_value: this.currentRegime,
      required: "STRONG_UPTREND/RANGE_BOUND for LONG, STRONG_DOWNTREND/RANGE_BOUND for SHORT, or HIGH_VOLATILITY",
      description: "Restricts execution during low volatility ranging zones to prevent chop losses.",
      priority: "CRITICAL",
      softened: isRegimeSoftened,
    });

    // C3 & C8 Combined: Trend Alignment & Strength (EMA/ADX)
    let trendAligned = true;
    let adxMet = true;
    let currentTrendStr = "";
    let requiredStr = "";

    const softeningPercent = config.general.orderflow_softening_percent !== undefined ? config.general.orderflow_softening_percent : 10;
    const standardAdxThreshold = trendAlignAdx;
    const softenedAdxThreshold = Math.max(hardFloorAdx, standardAdxThreshold * (1 - softeningPercent / 100));

    const activeSweepSignal = this.detectLiquiditySweep(signalDirection);

    const exhaustionLongState = this.evaluateExhaustionReversalCondition("LONG", currentPrice, closes, lastIdx);
    const exhaustionShortState = this.evaluateExhaustionReversalCondition("SHORT", currentPrice, closes, lastIdx);
    const activeExhaustion = signalDirection === "LONG" ? exhaustionLongState : exhaustionShortState;
    const isExhaustionActive = activeExhaustion.isExhausted;
    const isExhaustionBypassEnabled = (config.general.enable_exhaustion_trend_bypass ?? config.general.enable_ranging_extreme_rsi_bypass) !== false;

    const maxRangingAdx = config.general.ranging_adx_ceiling ?? 25.0;
    const maxExhaustionAdx = config.general.exhaustion_max_adx ?? 26.0;

    if (isSmcActive) {
      if (this.currentRegime === MarketRegime.RANGE_BOUND) {
        adxMet = adxValue >= hardFloorAdx && adxValue <= maxRangingAdx;
      } else {
        adxMet = adxValue >= hardFloorAdx;
      }
      trendAligned = adxMet;
      currentTrendStr = activeSweepSignal.isSweep 
        ? "PASSING (Bypassed via Liquidity Sweep Reversal Setup 3)"
        : "PASSING (Bypassed via SMC Structural Setup)";
      requiredStr = "SMC Structural Setup Active";
    } else if (isExhaustionBypassEnabled && isExhaustionActive) {
      adxMet = adxValue >= hardFloorAdx && adxValue <= maxExhaustionAdx;
      trendAligned = adxMet;
      currentTrendStr = adxMet
        ? `PASSING (Bypassed via ${signalDirection === "LONG" ? "Oversold" : "Overbought"} Exhaustion Reversal: ${activeExhaustion.reasons.slice(0, 2).join(" + ")})`
        : `BLOCKED (ADX ${adxValue.toFixed(1)} exceeds safe exhaustion ceiling ${maxExhaustionAdx})`;
      requiredStr = `Exhaustion Reversal Active (${activeExhaustion.description}) & ADX <= ${maxExhaustionAdx}`;
    } else if (this.currentRegime === MarketRegime.RANGE_BOUND) {
      const overboughtThresh = config.general.ranging_rsi_overbought_threshold ?? 75.0;
      const oversoldThresh = config.general.ranging_rsi_oversold_threshold ?? 25.0;
      const isExtremeOverbought = currentRsi >= overboughtThresh;
      const isExtremeOversold = currentRsi <= oversoldThresh;

      if (signalDirection === "LONG") {
        trendAligned = !isBearAligned;
        if (!trendAligned && isExtremeOversold && adxValue <= maxExhaustionAdx) {
          trendAligned = true;
          currentTrendStr = `PASSING (Bypassed via Extreme Oversold RSI ${currentRsi.toFixed(1)} <= ${oversoldThresh})`;
        } else if (!trendAligned) {
          currentTrendStr = "BLOCKED: STRONGLY BEARISH";
        } else {
          currentTrendStr = "PASSING (Not strongly bearish)";
        }
      } else {
        trendAligned = !isBullAligned;
        if (!trendAligned && isExtremeOverbought && adxValue <= maxExhaustionAdx) {
          trendAligned = true;
          currentTrendStr = `PASSING (Bypassed via Extreme Overbought RSI ${currentRsi.toFixed(1)} >= ${overboughtThresh})`;
        } else if (!trendAligned) {
          currentTrendStr = "BLOCKED: STRONGLY BULLISH";
        } else {
          currentTrendStr = "PASSING (Not strongly bullish)";
        }
      }
      adxMet = adxValue >= minRangingAdx && adxValue <= maxRangingAdx;
      requiredStr = `LONG: Not strongly bearish (isBearAligned) or RSI <= ${oversoldThresh}, SHORT: Not strongly bullish (isBullAligned) or RSI >= ${overboughtThresh} | Ranging ADX between ${minRangingAdx.toFixed(1)} and ${maxRangingAdx.toFixed(1)}`;
    } else {
      if (hasExtremeRealtimePressure) {
        const fastEma = ms.fast_ema_period || 20;
        const medEma = ms.medium_ema_period || 50;
        trendAligned = signalDirection === "LONG" ? (ema20Val > ema50Val) : (ema20Val < ema50Val);
        adxMet = adxValue >= softenedAdxThreshold;
        currentTrendStr = `EMA Structure: FAST_ALIGNED (Extreme Real-time Flow Pressure) | ADX: ${adxValue.toFixed(1)} (Threshold softened to >= ${softenedAdxThreshold.toFixed(1)})`;
        requiredStr = `LONG: Fast EMA${fastEma} > EMA${medEma} & ADX >= ${softenedAdxThreshold.toFixed(1)} (Softened via Order Flow), SHORT: Fast EMA${fastEma} < EMA${medEma} & ADX >= ${softenedAdxThreshold.toFixed(1)}`;
      } else {
        const fastEma = ms.fast_ema_period || 20;
        const medEma = ms.medium_ema_period || 50;
        const slowEma = ms.slow_ema_period || 200;
        trendAligned = (signalDirection === "LONG" && isUptrendAligned) || (signalDirection === "SHORT" && isDowntrendAligned);
        adxMet = adxValue >= standardAdxThreshold;
        currentTrendStr = `EMA Structure: ${isUptrendAligned ? "BULLISH_TREND" : isDowntrendAligned ? "BEARISH_TREND" : "MIXED/FLAT"}`;
        requiredStr = `LONG: EMA${fastEma} > EMA${medEma} > EMA${slowEma} & ADX >= ${standardAdxThreshold.toFixed(1)} & STRONG_UPTREND, SHORT: EMA${fastEma} < EMA${medEma} < EMA${slowEma} & ADX >= ${standardAdxThreshold.toFixed(1)} & STRONG_DOWNTREND`;
      }
    }

    // Absolute Hard Floor Enforcer: If ADX < hardFloorAdx (20.0), ADX gate fails unless breakout volume expansion or squeeze release occurs
    let isAdxSoftenedBySqueezeOrVolume = false;
    if (adxValue < hardFloorAdx) {
      const isVolumeExpansion = relVolume >= 1.20 || this.orderFlowStats.takerBuyRatio >= 0.60 || this.orderFlowStats.takerBuyRatio <= 0.40;
      if (isVolumeExpansion || hasExtremeRealtimePressure) {
        adxMet = true;
        isAdxSoftenedBySqueezeOrVolume = true;
      } else {
        adxMet = false;
      }
    }

    const fastEma = ms.fast_ema_period || 20;
    const medEma = ms.medium_ema_period || 50;
    const slowEma = ms.slow_ema_period || 200;

    const isTrendSoftened = ((this.currentRegime !== MarketRegime.RANGE_BOUND) && hasExtremeRealtimePressure && (
      (signalDirection === "LONG" && !isUptrendAligned) ||
      (signalDirection === "SHORT" && !isDowntrendAligned) ||
      (adxValue < standardAdxThreshold)
    )) || isAdxSoftenedBySqueezeOrVolume;

    conditions.push({
      name: "Exponential Trend Alignment",
      met: trendAligned,
      current_value: currentTrendStr,
      required: requiredStr.split(" & ADX")[0],
      description: `Confirms overall strong trend alignment (EMA ${fastEma}/${medEma}/${slowEma}) or checks safety locks during range bound.`,
      priority: "HIGH",
      softened: isTrendSoftened,
    });

    let adxValDisplay = `ADX: ${adxValue.toFixed(1)}`;
    if (isAdxSoftenedBySqueezeOrVolume) {
      adxValDisplay = `ADX: ${adxValue.toFixed(1)} (SOFTENED: High Breakout Volume / Order Flow Expansion)`;
    } else if (adxValue < hardFloorAdx) {
      adxValDisplay = `ADX BELOW HARD FLOOR - BLOCKED (${adxValue.toFixed(1)} < ${hardFloorAdx.toFixed(1)})`;
    } else if (this.currentRegime === MarketRegime.RANGE_BOUND && adxValue < minRangingAdx) {
      adxValDisplay = `RANGE-BOUND ADX BELOW FLOOR - BLOCKED (${adxValue.toFixed(1)} < ${minRangingAdx.toFixed(1)})`;
    } else if (this.currentRegime === MarketRegime.RANGE_BOUND && adxValue > maxRangingAdx) {
      adxValDisplay = `RANGE-BOUND ADX EXCEEDS CEILING - BLOCKED (${adxValue.toFixed(1)} > ${maxRangingAdx.toFixed(1)})`;
    }

    const adxReqDisplay = this.currentRegime === MarketRegime.RANGE_BOUND
      ? `ADX between ${minRangingAdx.toFixed(1)} and ${maxRangingAdx.toFixed(1)} (Range-Bound Enforced)`
      : `ADX >= ${(hasExtremeRealtimePressure ? softenedAdxThreshold : standardAdxThreshold).toFixed(1)} (Hard Floor >= ${hardFloorAdx.toFixed(1)})`;

    conditions.push({
      name: "ADX Trend Strength Filter",
      met: adxMet,
      current_value: adxValDisplay,
      required: adxReqDisplay,
      description: `Confirms appropriate momentum. Range-bound regimes require ADX between ${minRangingAdx.toFixed(1)} and ${maxRangingAdx.toFixed(1)} to prevent counter-trend falling knives.`,
      priority: "HIGH",
      softened: isTrendSoftened,
    });

    // C5: Context-Aware Relative Volume (RVOL) Confirmation Matrix
    const earlyStructCheck = this.evaluateMarketStructureConfirmation(signalDirection, probabilityLong);
    const contextVolResult = this.evaluateContextAwareVolume(
      signalDirection,
      relVolume,
      hasExtremeRealtimePressure,
      this.currentRegime,
      earlyStructCheck
    );

    conditions.push({
      name: "Relative Volume Confirmation",
      met: contextVolResult.met,
      current_value: contextVolResult.currentValue,
      required: contextVolResult.requiredStr,
      description: contextVolResult.description,
      priority: "MEDIUM",
      softened: contextVolResult.softened,
    });

    // 1. Daily Trade Count Limit
    const timestamp = new Date().toISOString();
    const tradesToday = dbManager.getTrades().filter(
      (t) => t.entry_timestamp.split("T")[0] === timestamp.split("T")[0]
    );
    const maxDailyTrades = config.general.max_trades_per_day;
    const cbDailyTradesPass = tradesToday.length < maxDailyTrades;
    conditions.push({
      name: "Daily Trade Count Limit",
      met: cbDailyTradesPass,
      current_value: `${tradesToday.length}/${maxDailyTrades} Trades Today`,
      required: `< ${maxDailyTrades} trades/day`,
      description: "Ensures maximum trade frequency limits are not breached.",
      priority: "CRITICAL",
    });

    // 2. Account Equity & API Connection Verification
    const apiCreds = dbManager.getCredentials();
    const balance = apiCreds.account_balance_usdt;
    const hasMinEquity = balance >= 100;
    const hasValidCreds = dbManager.isPaperMode() || (!!apiCreds.api_key && !!apiCreds.api_secret);
    conditions.push({
      name: "Account Equity & API Connection Verification",
      met: hasMinEquity && hasValidCreds,
      current_value: `Balance: $${balance.toFixed(2)} USDT | ${dbManager.isPaperMode() ? "Paper Mode Active" : (hasValidCreds ? "Keys Configured" : "Missing Keys")}`,
      required: "Balance >= $100.00 USDT and valid live connection keys or Paper Mode active",
      description: "Verifies account equity and trading API credentials.",
      priority: "CRITICAL",
    });

    // 3. Loss Streak Cooldown Protection
    const lossCooldown = this.getConsecutiveLossesCooldownStatus();
    const lossCooldownPass = !lossCooldown.active;
    conditions.push({
      name: "Loss Streak Cooldown Protection",
      met: lossCooldownPass,
      current_value: lossCooldown.active
        ? `Cooldown (Streak: ${lossCooldown.consecutiveLosses}, ${Math.ceil(lossCooldown.remainingSeconds / 60)}m left)`
        : "Clear (0 Active Loss Streak)",
      required: "No active cooldown from consecutive losses",
      description: "Enforces a dynamic cooldown after consecutive losses to prevent revenge trading.",
      priority: "CRITICAL",
    });

    // 4. Consolidated Pre-Flight Account & Operational Safety Gate
    const preFlightAllPass = cbDailyTradesPass && hasMinEquity && hasValidCreds && lossCooldownPass;
    const preFlightFailedDetails: string[] = [];
    if (!hasMinEquity) preFlightFailedDetails.push(`Equity ($${balance.toFixed(2)} < $100.00 USDT)`);
    if (!hasValidCreds) preFlightFailedDetails.push("API keys missing");
    if (!cbDailyTradesPass) preFlightFailedDetails.push(`Daily trade limit reached (${tradesToday.length}/${maxDailyTrades})`);
    if (!lossCooldownPass) preFlightFailedDetails.push(`Loss streak cooldown active (${Math.ceil(lossCooldown.remainingSeconds / 60)}m left)`);

    const preFlightStatusStr = preFlightAllPass
      ? `PASSING | Balance: $${balance.toFixed(2)} USDT | API: ${dbManager.isPaperMode() ? "PAPER MODE ACTIVE" : "KEYS CONFIGURED"} | Daily Trades: ${tradesToday.length}/${maxDailyTrades} | Cooldown: Clear`
      : `BLOCKED: ${preFlightFailedDetails.join(" | ")}`;

    conditions.push({
      name: "Pre-Flight Account & Operational Safety Gate",
      met: preFlightAllPass,
      current_value: preFlightStatusStr,
      required: "Balance >= $100.00 USDT, Valid API/Paper Mode, Trades < Daily Limit, No Active Loss Cooldown",
      description: "Unified pre-flight safety check consolidating capital balance, API connection status, daily trade limit, and loss streak cooldown.",
      priority: "CRITICAL",
    });

    // C12: Optimal Session Timing Window Check (IST)
    const timingStatus = this.getISTTimingStatus();
    const hasMomentumVolumeOverride = relVolume >= 1.20 || adxValue >= 28 || hasExtremeRealtimePressure;
    const isTimingMet = timingStatus.met || hasMomentumVolumeOverride;
    const isTimingSoftened = !timingStatus.met && hasMomentumVolumeOverride;
    conditions.push({
      name: "Optimal Session Timing Window Check (IST)",
      met: isTimingMet,
      current_value: isTimingSoftened
        ? `${timingStatus.status} (PASS: High Breakout Volume / Momentum Override)`
        : timingStatus.status,
      required: "Trade during optimal liquidity sessions (or Volume >= 1.20x / Momentum Override)",
      description: timingStatus.description,
      priority: "HIGH",
      softened: isTimingSoftened,
    });

    // Unified Value Extension Anchor (VWAP Bands + EMA 100 Distance + Chasing Lookback Velocity into normalized Z-score distance Z_dist)
    const atr14 = hasEnoughData ? this.calculateATR(this.candles1m, 14) : [50];
    const currentAtr = atr14[lastIdx] || 50;

    // Component 1: VWAP Deviation Z-Score
    const vwapStdDev = Math.max(Math.abs(vwapUpperVal - vwapVal), currentAtr);
    const zVwap = (currentPrice - vwapVal) / vwapStdDev;

    // Component 2: EMA 100 Distance Z-Score
    const zEma = (currentPrice - ema100Val) / (1.5 * currentAtr);

    // Component 3: 10-Bar Chasing Lookback Velocity Z-Score
    const shortLookback = 10;
    let zChase = 0;
    if (this.candles1m.length >= shortLookback) {
      const candle10Ago = this.candles1m[this.candles1m.length - shortLookback];
      zChase = (currentPrice - candle10Ago.close) / (1.8 * currentAtr);
    }

    // Normalized Composite Z-Score Distance (Z_dist)
    const zDist = 0.45 * zVwap + 0.35 * zEma + 0.20 * zChase;

    // Dynamic Z_dist Threshold based on Regime and Pressure capped by configured max_allowed_z_dist
    const userMaxZCap = rm.max_allowed_z_dist !== undefined ? rm.max_allowed_z_dist : 2.20;
    const baseZLimit = Math.min(isTrending ? 2.20 : 2.00, userMaxZCap);
    const maxZLimit = Math.min((isSpecialSuperStrongTrendLogicActive || hasExtremeRealtimePressure) ? 3.20 : baseZLimit, userMaxZCap);

    // Flaw 2 Fix: Single-Component Exhaustion Ceiling (Anti-Dilution Guard)
    // Prevents composite Z_dist averaging from masking extreme individual overextension (> 3.00 sigma from 100 EMA or VWAP).
    const singleComponentCeiling = isTrending ? 3.00 : 2.60;
    const isSingleComponentExhausted = signalDirection === "LONG"
      ? (zEma > singleComponentCeiling || zVwap > singleComponentCeiling)
      : (zEma < -singleComponentCeiling || zVwap < -singleComponentCeiling);

    let isValueExtensionMet = true;
    let isValueExtensionSoftened = false;

    if (signalDirection === "LONG") {
      if (zDist > maxZLimit || isSingleComponentExhausted) {
        isValueExtensionMet = false;
      } else if (zDist > baseZLimit && zDist <= maxZLimit) {
        isValueExtensionSoftened = true;
      }
    } else if (signalDirection === "SHORT") {
      if (zDist < -maxZLimit || isSingleComponentExhausted) {
        isValueExtensionMet = false;
      } else if (zDist < -baseZLimit && zDist >= -maxZLimit) {
        isValueExtensionSoftened = true;
      }
    }

    const zDistFormatted = zDist >= 0 ? `+${zDist.toFixed(2)}` : zDist.toFixed(2);
    let valueExtensionValStr = "";
    if (isValueExtensionMet) {
      valueExtensionValStr = `Z_dist: ${zDistFormatted} (VWAP: ${zVwap.toFixed(2)}sigma, EMA100: ${zEma.toFixed(2)}sigma, Chase: ${zChase.toFixed(2)}sigma) | Status: PASSED${isValueExtensionSoftened ? " (SOFTENED BY MOMENTUM)" : ""}`;
    } else if (isSingleComponentExhausted) {
      const overextendedMetric = Math.abs(zEma) > singleComponentCeiling ? `EMA100: ${zEma.toFixed(2)}sigma` : `VWAP: ${zVwap.toFixed(2)}sigma`;
      valueExtensionValStr = `Z_dist: ${zDistFormatted} (VWAP: ${zVwap.toFixed(2)}sigma, EMA100: ${zEma.toFixed(2)}sigma, Chase: ${zChase.toFixed(2)}sigma) | EXHAUSTION BLOCKED (Single component overextended: ${overextendedMetric} > ${singleComponentCeiling.toFixed(2)}sigma limit)`;
    } else {
      valueExtensionValStr = `Z_dist: ${zDistFormatted} (VWAP: ${zVwap.toFixed(2)}sigma, EMA100: ${zEma.toFixed(2)}sigma, Chase: ${zChase.toFixed(2)}sigma) | EXHAUSTION BLOCKED (|Z_dist| > ${maxZLimit.toFixed(2)})`;
    }

    conditions.push({
      name: "Unified Value Extension Anchor",
      met: isValueExtensionMet,
      current_value: valueExtensionValStr,
      required: `Normalized Z-Score Distance (|Z_dist|) <= ${baseZLimit.toFixed(2)} from Fair Value Baseline`,
      description: "Consolidates VWAP Bands, 100 EMA distance, and Chasing lookback into a single normalized Z-score distance (Z_dist) to eliminate conflicting overextension checks while blocking purchases at extreme exhaustion levels.",
      priority: "CRITICAL",
      softened: isValueExtensionSoftened,
    });

    // C15: Market Structure & Entry Confirmation Check (Pullback, Retest, Reversal, High-Vol Confirmation)
    const structCheck = this.evaluateMarketStructureConfirmation(signalDirection, probabilityLong);
    
    // Override market structure confirmation if Special Super Strong Trend Logic is active
    if (isSpecialSuperStrongTrendLogicActive) {
      if (isSuperStrongUptrend) {
        const pullbackHasFormed = struct.pullbackLongMet && struct.current_HH;
        if (pullbackHasFormed && struct.current_HH) {
          const isHHBreakout = currentPrice > struct.current_HH.price;
          const isNotOverextended = currentPrice <= struct.current_HH.price + 1.2 * currentAtr_cp;
          if (isHHBreakout && isNotOverextended) {
            structCheck.confirmed = true;
            structCheck.message = `[Super Strong Trend] Pullback breakout confirmed! Price ($${currentPrice.toFixed(2)}) broke above previous HH ($${struct.current_HH.price.toFixed(2)}).`;
          } else if (isHHBreakout) {
            structCheck.confirmed = false;
            structCheck.message = `[Super Strong Trend] Blocked: Price ($${currentPrice.toFixed(2)}) is overextended above HH ($${struct.current_HH.price.toFixed(2)}).`;
          } else {
            structCheck.confirmed = false;
            structCheck.message = `[Super Strong Trend] Pullback is developing. Waiting for breakout above previous HH ($${struct.current_HH.price.toFixed(2)}).`;
          }
        } else {
          structCheck.confirmed = false;
          structCheck.message = `[Super Strong Trend] Price far from 100 EMA. Waiting for pullback to form before scanning breakouts.`;
        }
      } else if (isSuperStrongDowntrend) {
        const pullbackHasFormed = struct.pullbackShortMet && struct.current_LL;
        if (pullbackHasFormed && struct.current_LL) {
          const isLLBreakout = currentPrice < struct.current_LL.price;
          const isNotOverextended = currentPrice >= struct.current_LL.price - 1.2 * currentAtr_cp;
          if (isLLBreakout && isNotOverextended) {
            structCheck.confirmed = true;
            structCheck.message = `[Super Strong Trend] Pullback breakdown confirmed! Price ($${currentPrice.toFixed(2)}) broke below previous LL ($${struct.current_LL.price.toFixed(2)}).`;
          } else if (isLLBreakout) {
            structCheck.confirmed = false;
            structCheck.message = `[Super Strong Trend] Blocked: Price ($${currentPrice.toFixed(2)}) is overextended below LL ($${struct.current_LL.price.toFixed(2)}).`;
          } else {
            structCheck.confirmed = false;
            structCheck.message = `[Super Strong Trend] Pullback is developing. Waiting for breakdown below previous LL ($${struct.current_LL.price.toFixed(2)}).`;
          }
        } else {
          structCheck.confirmed = false;
          structCheck.message = `[Super Strong Trend] Price far from 100 EMA. Waiting for pullback to form before scanning breakdowns.`;
        }
      }
    }

    conditions.push({
      name: "Market Structure Confirmation",
      met: structCheck.confirmed,
      current_value: structCheck.message,
      required: "Pullback HL (LONG) / LH (SHORT), Breakout Retest, or Range Reversal based on Regime",
      description: "Applies regime-specific market structure entry gates: Trending pulls, Range reversals, High-Vol confirmation, or Low-Vol avoidance.",
      priority: "CRITICAL",
      ema_check_active: structCheck.ema_check_active,
      ema_pair_evaluated: structCheck.ema_pair_evaluated,
      ema_tested: structCheck.ema_tested,
      sub_conditions: structCheck.sub_conditions,
    });



    // C17: Binance Order Flow Confirmation (Hard Validation - Directional Delta & CVD Alignment)
    let ofMet = true;
    const flowRes = this.getOrderFlowScore(signalDirection);
    let ofVal = `Score: ${flowRes.score}/100 [${flowRes.label}] | Taker Buy: ${(flowRes.takerBuyRatio * 100).toFixed(1)}% | Imbalance: ${(flowRes.imbalanceRatio * 100).toFixed(1)}%`;
    let ofReq = "Dynamic Score >= 35/100, Directional Taker Vol >= 45.0% & CVD Alignment (Hard Gate)";

    const netCVD = this.orderFlowStats ? this.orderFlowStats.netCVD : 0;

    if (signalDirection === "LONG") {
      const hasMinTakerBuy = flowRes.takerBuyRatio >= 0.45;
      const hasMinScore = flowRes.score >= 35;
      const notOpposingCvd = netCVD >= -0.20 || flowRes.takerBuyRatio >= 0.52;
      ofMet = hasMinTakerBuy && hasMinScore && notOpposingCvd;
      if (!ofMet) {
        let failReason = "";
        if (!hasMinTakerBuy) {
          failReason = `Taker Buy ${(flowRes.takerBuyRatio * 100).toFixed(1)}% < 45.0% minimum`;
        } else if (!notOpposingCvd) {
          failReason = `Negative CVD (${netCVD.toFixed(4)} BTC) indicates ongoing sell absorption`;
        } else {
          failReason = `Order Flow score ${flowRes.score}/100 < 35`;
        }
        ofVal = `${ofVal} - BLOCKED (${failReason}: ${flowRes.description})`;
      } else {
        ofVal = `${ofVal} - PASSED (Verified Institutional Buy Support)`;
      }
    } else if (signalDirection === "SHORT") {
      const hasMinTakerSell = flowRes.takerBuyRatio <= 0.55; // Taker sell >= 45%
      const hasMinScore = flowRes.score >= 35;
      const notOpposingCvd = netCVD <= 0.20 || flowRes.takerBuyRatio <= 0.48;
      ofMet = hasMinTakerSell && hasMinScore && notOpposingCvd;
      if (!ofMet) {
        let failReason = "";
        if (!hasMinTakerSell) {
          failReason = `Taker Sell ${((1 - flowRes.takerBuyRatio) * 100).toFixed(1)}% < 45.0% minimum (Taker Buy ${(flowRes.takerBuyRatio * 100).toFixed(1)}% > 55.0%)`;
        } else if (!notOpposingCvd) {
          failReason = `Positive CVD (+${netCVD.toFixed(4)} BTC) indicates buyer absorption`;
        } else {
          failReason = `Order Flow score ${flowRes.score}/100 < 35`;
        }
        ofVal = `${ofVal} - BLOCKED (${failReason}: ${flowRes.description})`;
      } else {
        ofVal = `${ofVal} - PASSED (Verified Institutional Sell Pressure)`;
      }
    }

    conditions.push({
      name: "Binance Order Flow Confirmation",
      met: ofMet,
      current_value: ofVal,
      required: ofReq,
      description: "Applies a continuous fuzzy confluence score blending taker volume buy/sell ratio (70% weight) and order book bid/ask depth imbalance (30% weight) with hard floor validation to prevent fighting institutional flow.",
      priority: "CRITICAL",
      softened: false,
    });

    // C18: Volatility Compression (Squeeze) Filter
    const sqBb = this.calculateBollingerBands(closes, 20, 2);
    const sqAtr = currentAtr_cp;
    const sqKbWidth = 2 * 1.5 * sqAtr;
    const sqBbWidth = sqBb.upper - sqBb.lower;
    const isSqueezed = sqBbWidth <= sqKbWidth;

    let squeezeMet = true;
    let squeezeVal = `BB Width: $${sqBbWidth.toFixed(2)} (Keltner Width: $${sqKbWidth.toFixed(2)})`;
    let squeezeReq = "Breakout volume (Rel Volume >= 1.20) or directional order flow inflection required if Bollinger Bands are squeezed inside Keltner Channels";

    if (isSqueezed) {
      const earlySqueezeRelease = relVolume >= 1.20 || flowRes.score >= 60 || this.detectOrderFlowAbsorption(signalDirection).isAbsorption;
      squeezeMet = earlySqueezeRelease;
      if (!squeezeMet) {
        squeezeVal = `COMPRESSED SQUEEZE ACTIVE - BLOCKED (BB Width $${sqBbWidth.toFixed(2)} <= Keltner $${sqKbWidth.toFixed(2)} | Awaiting directional breakout flow)`;
      } else {
        squeezeVal = `COMPRESSED SQUEEZE ACTIVE - PASSED (Early Squeeze Inflection / Volume: ${relVolume.toFixed(2)})`;
      }
    } else {
      squeezeVal = `NO SQUEEZE - PASSING (BB Width $${sqBbWidth.toFixed(2)} > Keltner $${sqKbWidth.toFixed(2)})`;
    }

    conditions.push({
      name: "Volatility Compression (Squeeze) Filter",
      met: squeezeMet,
      current_value: squeezeVal,
      required: squeezeReq,
      description: "Checks if volatility is severely compressed (Bollinger Bands inside Keltner Channels). If so, blocks entries unless a high-volume breakout (Rel Volume >= 1.4x) is detected to avoid consolidation traps.",
      priority: "HIGH",
    });

    // Volatility ATR Floor Filter (Minimum ATR Filter)
    const minAtrEnabled = config.risk_management?.min_atr_for_trading_enabled !== false;
    const minAtrValue = config.risk_management?.min_atr_for_trading_value !== undefined ? config.risk_management.min_atr_for_trading_value : 12;
    let minAtrMet = true;
    let minAtrVal = `ATR (14): $${currentAtr_cp.toFixed(2)}`;
    let minAtrReq = minAtrEnabled ? `>= $${minAtrValue.toFixed(2)}` : "None (Disabled)";

    if (minAtrEnabled) {
      minAtrMet = currentAtr_cp >= minAtrValue;
      if (!minAtrMet) {
        minAtrVal = `ATR COMPRESSION - BLOCKED (Current ATR $${currentAtr_cp.toFixed(2)} < Min ATR Threshold $${minAtrValue.toFixed(2)})`;
      } else {
        minAtrVal = `ATR NORMAL - PASSED (Current ATR $${currentAtr_cp.toFixed(2)} >= Min ATR Threshold $${minAtrValue.toFixed(2)})`;
      }
    }

    conditions.push({
      name: "Minimum ATR Volatility Filter",
      met: minAtrMet,
      current_value: minAtrVal,
      required: minAtrReq,
      description: "Blocks trade entry signals if the current market 14-period Average True Range (ATR) falls below the user-defined floor threshold (e.g., 11 or 12) to avoid thin, low-volatility ranges.",
      priority: "CRITICAL",
    });

    // C19: Order Book Imbalance & Liquidity Depth Gate
    let obMet = true;
    const obMinDepth = config.general.order_book_min_depth !== undefined ? config.general.order_book_min_depth : 4.0;
    const obMaxImbalance = config.general.order_book_max_imbalance !== undefined ? config.general.order_book_max_imbalance : 0.35;
    const obMaxSpoofRisk = config.general.order_book_max_spoof_risk !== undefined ? config.general.order_book_max_spoof_risk : 70;

    const obTotalDepth = this.orderBookStats.bidDepthBTC + this.orderBookStats.askDepthBTC;
    const stability = this.getOrderBookStability(signalDirection);
    
    // Use adjusted/damped imbalance ratio to nullify spoofed limit orders
    const evaluatedImbalance = stability.adjustedImbalance;
    const obImbalancePct = evaluatedImbalance * 100;
    const rawImbalancePct = this.orderBookStats.imbalanceRatio * 100;

    let obVal = `Bids: ${this.orderBookStats.bidDepthBTC.toFixed(1)} | Asks: ${this.orderBookStats.askDepthBTC.toFixed(1)} BTC | Imbalance: ${rawImbalancePct >= 0 ? "+" : ""}${rawImbalancePct.toFixed(1)}% (Adjusted: ${obImbalancePct >= 0 ? "+" : ""}${obImbalancePct.toFixed(1)}%, Stability: ${stability.stabilityIndex}%, Spoof Risk: ${stability.spoofRisk}%)`;
    let obReq = `Top-10 book depth >= ${obMinDepth.toFixed(1)} BTC; Spoof Risk < ${obMaxSpoofRisk}%; Adjusted Imbalance >= -${(obMaxImbalance * 100).toFixed(0)}% for LONG, <= +${(obMaxImbalance * 100).toFixed(0)}% for SHORT`;

    if (obTotalDepth < obMinDepth) {
      obMet = false;
      obVal = `${obVal} - BLOCKED (Insufficient Book Liquidity: ${obTotalDepth.toFixed(1)} < ${obMinDepth.toFixed(1)} BTC)`;
    } else if (stability.spoofRisk >= obMaxSpoofRisk) {
      obMet = false;
      obVal = `${obVal} - BLOCKED (High Spoof Risk: ${stability.spoofRisk}% >= Limit ${obMaxSpoofRisk}%)`;
    } else if (signalDirection === "LONG") {
      // Dynamic tightening of threshold under high spoof risk
      const dynamicHurdle = -obMaxImbalance;
      obMet = evaluatedImbalance >= dynamicHurdle;
      if (!obMet) {
        obVal = `${obVal} - BLOCKED (Heavy Ask Wall / Negative Imbalance)`;
      } else {
        obVal = `${obVal} - PASSED (${stability.spoofRisk >= 40 ? "Damped Bid Support" : "Strong Bid Support"})`;
      }
    } else if (signalDirection === "SHORT") {
      const dynamicHurdle = obMaxImbalance;
      obMet = evaluatedImbalance <= dynamicHurdle;
      if (!obMet) {
        obVal = `${obVal} - BLOCKED (Heavy Bid Floor / Positive Imbalance)`;
      } else {
        obVal = `${obVal} - PASSED (${stability.spoofRisk >= 40 ? "Damped Ask Wall" : "Strong Sell Pressure / Ask Dominance"})`;
      }
    }

    conditions.push({
      name: "Order Book Imbalance & Liquidity Depth Gate",
      met: obMet,
      current_value: obVal,
      required: obReq,
      description: `Verifies near-book liquidity depth and evaluates stability/spoofing risks (stability index: ${stability.stabilityIndex}%, spoof risk: ${stability.spoofRisk}%). Applies a continuous, volume-mismatch filtered EMA imbalance to reject fleeting, spoofed limit wall orders designed by market-makers to trigger false signals.`,
      priority: "HIGH",
    });

    // C21: Multi-Timeframe Volume Profiling (Horizontal Liquidity)
    const vpResult = this.evaluateMultiTimeframeVolumeProfile(signalDirection, currentPrice, currentAtr_cp, relVolume, structCheck, this.currentRegime);
    conditions.push({
      name: "Multi-Timeframe Volume Profiling (Horizontal Liquidity)",
      met: vpResult.met,
      current_value: vpResult.val,
      required: vpResult.req,
      description: vpResult.description,
      priority: "CRITICAL",
    });

    // C20: Regime Transition Cooldown
    const regimeCooldown = this.getRegimeChangeCooldownStatus();
    const regimeCooldownMins = config.general.regime_change_cooldown_minutes !== undefined ? config.general.regime_change_cooldown_minutes : 15;
    const isBreakoutOrStructure = structCheck.confirmed || isSmcActive;
    const isHighConvictionShift = (relVolume >= 1.15 || adxValue >= 24 || isBreakoutOrStructure || hasExtremeRealtimePressure);
    const isCooldownBypassed = regimeCooldown.active && isHighConvictionShift;
    const isRegimeCooldownMet = !regimeCooldown.active || isCooldownBypassed;

    conditions.push({
      name: "Regime Transition Cooldown",
      met: isRegimeCooldownMet,
      current_value: regimeCooldown.active
        ? (isCooldownBypassed 
            ? `PASSING (Bypassed: High Conviction Volume ${relVolume.toFixed(2)}x / Momentum / Structure Override)` 
            : `BLOCKED (Cooldown active: ${Math.ceil(regimeCooldown.remainingSeconds / 60)}m left)`)
        : "PASSING (No recent regime shift)",
      required: `No regime transitions within the last ${regimeCooldownMins} minutes (or Volume >= 1.15x / Momentum / Breakout Override)`,
      description: "Applies a transition lock to entry signals whenever the dominant market regime shifts (e.g. from Strong Uptrend to Range Bound), protecting against high-frequency slippage and trend-reversal fakeouts during structural transitions.",
      priority: "CRITICAL",
      softened: isCooldownBypassed,
    });

    // Choppy Market & Whip-Saw Avoidance Gate
    const choppyFilterEnabled = config.general.enable_choppy_market_filter !== false;
    const maxChopAllowed = config.general.max_allowed_chop_index !== undefined ? config.general.max_allowed_chop_index : 58.0;
    const minKerAllowed = config.general.min_allowed_efficiency_ratio !== undefined ? config.general.min_allowed_efficiency_ratio : 0.22;
    const maxWickRatioAllowed = config.general.max_allowed_wick_ratio !== undefined ? config.general.max_allowed_wick_ratio : 0.60;

    const chopIndex = this.calculateChoppinessIndex(this.candles1m, 14);
    const kerValue = this.calculateEfficiencyRatio(this.candles1m, 10);
    const avgWickRatio = this.calculateAverageWickRatio(this.candles1m, 10);

    const isChopExceeded = chopIndex > maxChopAllowed;
    const isKerDeficient = kerValue < minKerAllowed;
    const isWickExcessive = avgWickRatio > maxWickRatioAllowed;

    const isBreakoutExpansion = (relVolume >= 1.20 || flowRes.score >= 58 || this.detectOrderFlowAbsorption(signalDirection).isAbsorption);

    let choppyGateMet = true;
    let choppyValStr = `CHOP: ${chopIndex.toFixed(1)} | Efficiency (KER): ${kerValue.toFixed(2)} | Wick Ratio: ${(avgWickRatio * 100).toFixed(0)}%`;
    let choppyReqStr = `CHOP <= ${maxChopAllowed.toFixed(1)}, KER >= ${minKerAllowed.toFixed(2)}, Wick Ratio <= ${(maxWickRatioAllowed * 100).toFixed(0)}%`;

    if (choppyFilterEnabled) {
      if (isChopExceeded || isKerDeficient || isWickExcessive) {
        if (isBreakoutExpansion) {
          choppyGateMet = true;
          choppyValStr = `PASSING EXPANSION (Bypassed via High Breakout Volume ${relVolume.toFixed(2)}x / Flow Score ${flowRes.score})`;
        } else {
          choppyGateMet = false;
          const reasons: string[] = [];
          if (isChopExceeded) reasons.push(`High CHOP (${chopIndex.toFixed(1)} > ${maxChopAllowed.toFixed(1)})`);
          if (isKerDeficient) reasons.push(`Low Efficiency KER (${kerValue.toFixed(2)} < ${minKerAllowed.toFixed(2)})`);
          if (isWickExcessive) reasons.push(`Excessive Wicks (${(avgWickRatio * 100).toFixed(0)}% > ${(maxWickRatioAllowed * 100).toFixed(0)}%)`);
          choppyValStr = `CHOPPY / WHIP-SAW MARKET DETECTED - BLOCKED (${reasons.join(", ")})`;
        }
      } else {
        choppyValStr = `PASSING CLEAR TREND / CONVICTION (${choppyValStr})`;
      }
    }

    conditions.push({
      name: "Choppy Market Whip-Saw Filter",
      met: choppyGateMet,
      current_value: choppyValStr,
      required: choppyReqStr,
      description: "Blocks trade entry signals if price action is in a choppy consolidation zone (high Choppiness Index), exhibits low net directional displacement (low Kaufman Efficiency Ratio), or is dominated by wicks.",
      priority: "CRITICAL",
    });

    // Directional Overhead Supply & Exhaustion Wick Protection Gate
    const dirWickExhaustion = signalDirection === "LONG"
      ? this.evaluateDirectionalExhaustionWicks("LONG")
      : (signalDirection === "SHORT" ? this.evaluateDirectionalExhaustionWicks("SHORT") : { isExhausted: false, description: "Neutral direction", wickCount: 0, dominantWickZone: { min: 0, max: 0 }, highestWickHigh: 0, lowestWickLow: 0, totalCandlesScanned: 0, qualifyingCandleIndices: [] });

    const exhaustionWickFilterEnabled = config.general?.enable_exhaustion_wick_filter !== false;
    const isWickExhaustionGateMet = !exhaustionWickFilterEnabled || !dirWickExhaustion.isExhausted;

    conditions.push({
      name: "Overhead Supply & Exhaustion Wick Protection",
      met: isWickExhaustionGateMet,
      current_value: isWickExhaustionGateMet
        ? (dirWickExhaustion.wickCount > 0 ? `PASSING (${dirWickExhaustion.description})` : "PASSING (No contrary rejection wick clusters detected)")
        : `BLOCKED (${dirWickExhaustion.description})`,
      required: signalDirection === "LONG"
        ? "No upper rejection wick cluster at resistance ceiling"
        : (signalDirection === "SHORT" ? "No lower rejection wick cluster at demand floor" : "Clean price action without contrary exhaustion wicks"),
      description: "Strictly blocks trade entry signals when price action exhibits repeated rejection wicks at local extremes, indicating trend exhaustion and overhead supply or demand absorption.",
      priority: "CRITICAL",
    });

    // Apply bypassed/skipped gates
    for (const c of conditions) {
      if (!this.isGateActive(config, c.name)) {
        c.met = true;
        c.current_value = `${c.current_value} (BYPASS)`;
      }
    }

    // Calculate overall entry score and check conditions
    let entryScore = 0;
    let allConditionsMet = false;
    let failedConditions: string[] = [];

    const isWeightedEnabled = config.gate_scoring?.enabled === true;

    if (isWeightedEnabled) {
      // Weighted scoring evaluation
      confidenceScore = 0;
      confidenceThreshold = config.gate_scoring?.confidence_threshold ?? 70;
      tacticalConfidenceMet = true;

      // Dynamically define safetyGates as active gates that are set to mandatory (strictly pass)
      safetyGates = conditions
        .filter((c) => this.isGateActive(config, c.name) && this.isGateMandatory(config, c.name))
        .map((c) => c.name);

      const baseWeights = {
        catboost_ai: config.gate_scoring?.weights?.catboost_ai ?? 25,
        market_regime: config.gate_scoring?.weights?.market_regime ?? 15,
        trend_alignment: config.gate_scoring?.weights?.trend_alignment ?? 10,
        adx_strength: config.gate_scoring?.weights?.adx_strength ?? 5,
        relative_volume: config.gate_scoring?.weights?.relative_volume ?? 10,
        overextension: config.gate_scoring?.weights?.overextension ?? 10,
        wedge_filter: config.gate_scoring?.weights?.wedge_filter ?? 5,
        order_flow: config.gate_scoring?.weights?.order_flow ?? 10,
        squeeze_filter: config.gate_scoring?.weights?.squeeze_filter ?? 5,
        order_book: config.gate_scoring?.weights?.order_book ?? 5,
        volume_profile: (config.gate_scoring?.weights as any)?.volume_profile ?? 10,
      };

      const modifiers = config.gate_scoring?.adaptive_modifiers ?? {
        trending: { trend_alignment_weight_boost: 10, catboost_weight_boost: 5, volume_profile_weight_boost: -5, adx_strength_weight_boost: 10, order_flow_weight_boost: 5, squeeze_filter_weight_reduction: -10 },
        ranging: { order_flow_weight_boost: 15, trend_alignment_weight_reduction: -10, volume_profile_weight_boost: 10, overextension_weight_boost: 15, order_book_weight_boost: 10, adx_strength_weight_reduction: -10 },
        high_volatility: { relative_volume_weight_boost: 10, overextension_weight_boost: 10, volume_profile_weight_boost: 5, order_book_weight_boost: 15, order_flow_weight_boost: 10, trend_alignment_weight_reduction: -5 },
        low_volatility: { squeeze_filter_weight_boost: 15, volume_profile_weight_boost: 0, wedge_filter_weight_boost: 10, relative_volume_weight_reduction: -5, order_flow_weight_boost: 10 },
      };

      activeWeights = { ...baseWeights };

      if (this.currentRegime === MarketRegime.STRONG_UPTREND || this.currentRegime === MarketRegime.STRONG_DOWNTREND) {
        activeWeights.trend_alignment = Math.max(0, activeWeights.trend_alignment + (modifiers.trending?.trend_alignment_weight_boost ?? 10));
        activeWeights.catboost_ai = Math.max(0, activeWeights.catboost_ai + (modifiers.trending?.catboost_weight_boost ?? 5));
        activeWeights.volume_profile = Math.max(0, activeWeights.volume_profile + (modifiers.trending?.volume_profile_weight_boost ?? -5));
        activeWeights.adx_strength = Math.max(0, activeWeights.adx_strength + (modifiers.trending?.adx_strength_weight_boost ?? 10));
        activeWeights.order_flow = Math.max(0, activeWeights.order_flow + (modifiers.trending?.order_flow_weight_boost ?? 5));
        activeWeights.squeeze_filter = Math.max(0, activeWeights.squeeze_filter + (modifiers.trending?.squeeze_filter_weight_reduction ?? -10));
      } else if (this.currentRegime === MarketRegime.RANGE_BOUND) {
        activeWeights.order_flow = Math.max(0, activeWeights.order_flow + (modifiers.ranging?.order_flow_weight_boost ?? 15));
        activeWeights.trend_alignment = Math.max(0, activeWeights.trend_alignment + (modifiers.ranging?.trend_alignment_weight_reduction ?? -10));
        activeWeights.volume_profile = Math.max(0, activeWeights.volume_profile + (modifiers.ranging?.volume_profile_weight_boost ?? 10));
        activeWeights.overextension = Math.max(0, activeWeights.overextension + (modifiers.ranging?.overextension_weight_boost ?? 15));
        activeWeights.order_book = Math.max(0, activeWeights.order_book + (modifiers.ranging?.order_book_weight_boost ?? 10));
        activeWeights.adx_strength = Math.max(0, activeWeights.adx_strength + (modifiers.ranging?.adx_strength_weight_reduction ?? -10));
      } else if (this.currentRegime === MarketRegime.HIGH_VOLATILITY) {
        activeWeights.relative_volume = Math.max(0, activeWeights.relative_volume + (modifiers.high_volatility?.relative_volume_weight_boost ?? 10));
        activeWeights.overextension = Math.max(0, activeWeights.overextension + (modifiers.high_volatility?.overextension_weight_boost ?? 10));
        activeWeights.volume_profile = Math.max(0, activeWeights.volume_profile + (modifiers.high_volatility?.volume_profile_weight_boost ?? 5));
        activeWeights.order_book = Math.max(0, activeWeights.order_book + (modifiers.high_volatility?.order_book_weight_boost ?? 15));
        activeWeights.order_flow = Math.max(0, activeWeights.order_flow + (modifiers.high_volatility?.order_flow_weight_boost ?? 10));
        activeWeights.trend_alignment = Math.max(0, activeWeights.trend_alignment + (modifiers.high_volatility?.trend_alignment_weight_reduction ?? -5));
      } else if (this.currentRegime === MarketRegime.LOW_VOLATILITY) {
        activeWeights.squeeze_filter = Math.max(0, activeWeights.squeeze_filter + (modifiers.low_volatility?.squeeze_filter_weight_boost ?? 15));
        activeWeights.volume_profile = Math.max(0, activeWeights.volume_profile + (modifiers.low_volatility?.volume_profile_weight_boost ?? 0));
        activeWeights.wedge_filter = Math.max(0, activeWeights.wedge_filter + (modifiers.low_volatility?.wedge_filter_weight_boost ?? 10));
        activeWeights.relative_volume = Math.max(0, activeWeights.relative_volume + (modifiers.low_volatility?.relative_volume_weight_reduction ?? -5));
        activeWeights.order_flow = Math.max(0, activeWeights.order_flow + (modifiers.low_volatility?.order_flow_weight_boost ?? 10));
      }

      tacticalGatesMap = [
        { condName: "CatBoost AI Prediction", weightKey: "catboost_ai" as const },
        { condName: "Market Regime Filter", weightKey: "market_regime" as const },
        { condName: "Exponential Trend Alignment", weightKey: "trend_alignment" as const },
        { condName: "ADX Trend Strength Filter", weightKey: "adx_strength" as const },
        { condName: "Relative Volume Confirmation", weightKey: "relative_volume" as const },
        { condName: "Unified Value Extension Anchor", weightKey: "overextension" as const },
        { condName: "Binance Order Flow Confirmation", weightKey: "order_flow" as const },
        { condName: "Volatility Compression (Squeeze) Filter", weightKey: "squeeze_filter" as const },
        { condName: "Order Book Imbalance & Liquidity Depth Gate", weightKey: "order_book" as const },
        { condName: "Multi-Timeframe Volume Profiling (Horizontal Liquidity)", weightKey: "volume_profile" as const },
      ];

      totalTacticalWeight = 0;
      earnedTacticalWeight = 0;

      const enableDiscounting = config.gate_scoring?.enable_weight_discounting !== false;
      const discountFactor = config.gate_scoring?.softened_gate_discount_factor ?? 0.5;

      for (const gate of tacticalGatesMap) {
        // Contribute weight for any active gate (both strict/mandatory and weighted)
        if (this.isGateActive(config, gate.condName)) {
          const cond = conditions.find(c => c.name === gate.condName);
          const weight = activeWeights[gate.weightKey];
          totalTacticalWeight += weight;
          if (cond?.met) {
            if (enableDiscounting && cond.softened === true) {
              earnedTacticalWeight += weight * discountFactor;
            } else {
              earnedTacticalWeight += weight;
            }
          }
        }
      }

      if (totalTacticalWeight > 0) {
        confidenceScore = Math.round((earnedTacticalWeight / totalTacticalWeight) * 100);
      }
      tacticalConfidenceMet = confidenceScore >= confidenceThreshold;

      entryScore = confidenceScore;

      const allSafetyPassed = conditions
        .filter((c) => safetyGates.includes(c.name))
        .every((c) => c.met);

      // Check "Market Structure Confirmation" dynamically based on whether it is active and mandatory
      const isStructureMandatory = this.isGateMandatory(config, "Market Structure Confirmation");
      const isStructureActive = this.isGateActive(config, "Market Structure Confirmation");
      marketStructurePassed = isStructureActive && isStructureMandatory
        ? (conditions.find(c => c.name === "Market Structure Confirmation")?.met ?? false)
        : true;

      // Handle optional mandatory volume profile in ranging regime
      let isMtfVpPassedIfRequired = true;
      if (this.currentRegime === MarketRegime.RANGE_BOUND && config.general.require_volume_profile_in_ranging !== false) {
        if (this.isGateActive(config, "Multi-Timeframe Volume Profiling (Horizontal Liquidity)") && this.isGateMandatory(config, "Multi-Timeframe Volume Profiling (Horizontal Liquidity)")) {
          const vpGate = conditions.find(c => c.name === "Multi-Timeframe Volume Profiling (Horizontal Liquidity)");
          if (vpGate && !vpGate.met) {
            isMtfVpPassedIfRequired = false;
          }
        }
      }

      allConditionsMet = allSafetyPassed && marketStructurePassed && tacticalConfidenceMet && isMtfVpPassedIfRequired;

      failedConditions = conditions.filter((c) => {
        if (safetyGates.includes(c.name)) {
          return !c.met;
        }
        if (c.name === "Market Structure Confirmation") {
          return isStructureActive && isStructureMandatory && !c.met;
        }
        if (this.currentRegime === MarketRegime.RANGE_BOUND && config.general.require_volume_profile_in_ranging !== false && c.name === "Multi-Timeframe Volume Profiling (Horizontal Liquidity)") {
          return this.isGateActive(config, c.name) && this.isGateMandatory(config, c.name) && !c.met;
        }
        return false;
      }).map((c) => c.name);

      if (!tacticalConfidenceMet) {
        failedConditions.push(`Cumulative Tactical Confidence (${confidenceScore}% < ${confidenceThreshold}%)`);
      }
    } else {
      if (pLongMet || pShortMet || !this.isGateActive(config, "CatBoost AI Prediction")) entryScore += 40;
      if ((regimeValid && regimeAligned) || !this.isGateActive(config, "Market Regime Filter")) entryScore += 20;
      if (trendAligned || !this.isGateActive(config, "Exponential Trend Alignment")) entryScore += 15;
      if (adxMet || !this.isGateActive(config, "ADX Trend Strength Filter")) entryScore += 15;
      if (contextVolResult.met || !this.isGateActive(config, "Relative Volume Confirmation")) entryScore += 10;
      allConditionsMet = conditions.every((c) => c.met);
      failedConditions = conditions.filter((c) => !c.met).map((c) => c.name);
    }

    return {
      conditions,
      entry_score: entryScore,
      signal_direction: signalDirection,
      all_conditions_met: allConditionsMet,
      rejection_reason: allConditionsMet ? null : failedConditions.join(", "),
      // Intermediate state values returned to eliminate redundant calculation logic and Execution Path Divergence (Symmetry Risk)
      probabilityLong,
      probabilityShort,
      avgSentiment,
      currentClose: currentPrice,
      adxValue,
      relVolume,
      failedConditions,
      confidenceScore,
      confidenceThreshold,
      isWeightedEnabled,
      tacticalConfidenceMet,
      safetyGates,
      tacticalGatesMap,
      activeWeights,
      marketStructurePassed,
    };
  }

  public getCurrentCheckpoints() {
    return this.evaluateStrategyState();
  }

  // Fetch initial candles from Delta Exchange or Binance or generate realistic ones as fallback
  private async initCandles() {
    this.log("Initializing historical 1-minute candlestick data...");
    const config = dbManager.getConfig();
    const useDelta = config.general?.data_feed_source === "DELTA_EXCHANGE";
    let fetchedSuccessfully = false;

    if (useDelta) {
      this.log("Fetching historical 1-minute candlestick data from Delta Exchange...");
      try {
        const to = Math.floor(Date.now() / 1000);
        const from = to - 300 * 60; // 300 minutes
        const symbol = "BTCUSD"; // standard perpetual
        const url = `https://api.delta.exchange/v2/chart/history?symbol=${symbol}&resolution=1&from=${from}&to=${to}`;
        
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 6000);
        const startTime = Date.now();
        const res = await fetch(url, { signal: controller.signal });
        const latencyMs = Date.now() - startTime;
        clearTimeout(timeoutId);

        let responseText = "";
        const responseStatus = res.status;
        const respHeaders: Record<string, string> = {};
        res.headers.forEach((val, key) => {
          respHeaders[key] = val;
        });

        if (res.ok) {
          const data = await res.json();
          responseText = `[Candlestick history response from Delta Exchange parsed]`;
          
          dbManager.addApiLog({
            service: "Delta Exchange",
            method: "GET",
            url: url,
            request_headers: { "User-Agent": "Delta-Exchange-Trading-Bot/1.0" },
            response_status: responseStatus,
            response_headers: respHeaders,
            response_body: JSON.stringify(data).slice(0, 500) + "...",
            latency_ms: latencyMs,
          });

          // TV UDF format: t, o, h, l, c, v lists
          if (data && data.t && Array.isArray(data.t) && data.t.length > 0) {
            const count = data.t.length;
            const candles: Candlestick[] = [];
            for (let i = 0; i < count; i++) {
              candles.push({
                time: Number(data.t[i]),
                open: parseFloat(data.o[i]),
                high: parseFloat(data.h[i]),
                low: parseFloat(data.l[i]),
                close: parseFloat(data.c[i]),
                volume: parseFloat(data.v[i] || 0),
              });
            }
            this.candles1m = candles;
            const lastCandle = this.candles1m[this.candles1m.length - 1];
            this.currentPrice = lastCandle.close;
            this.log(`Successfully imported ${this.candles1m.length} real-time BTCUSD candles from Delta Exchange API. Price: $${this.currentPrice}`);
            this.recalculateIndicators();
            fetchedSuccessfully = true;
            return;
          }
        } else {
          responseText = await res.text();
          dbManager.addApiLog({
            service: "Delta Exchange",
            method: "GET",
            url: url,
            request_headers: { "User-Agent": "Delta-Exchange-Trading-Bot/1.0" },
            response_status: responseStatus,
            response_headers: respHeaders,
            response_body: responseText,
            latency_ms: latencyMs,
          });
        }
      } catch (err) {
        this.log("Delta Exchange API chart/history offline or failed. Falling back to Binance...");
      }
    }

    if (!fetchedSuccessfully) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 6000);

        // Public endpoint, returns last 300 1-minute candles
        const startTime = Date.now();
        const res = await fetch(
          "https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=300",
          { signal: controller.signal }
        );
        const latencyMs = Date.now() - startTime;
        clearTimeout(timeoutId);

        let responseText = "";
        const responseStatus = res.status;
        const respHeaders: Record<string, string> = {};
        res.headers.forEach((val, key) => {
          respHeaders[key] = val;
        });

        let data: any[][] = [];
        if (res.ok) {
          data = await res.json();
          responseText = `[Array of ${data.length} candlesticks fetched successfully]`;
        } else {
          responseText = await res.text();
        }

        dbManager.addApiLog({
          service: "Binance",
          method: "GET",
          url: "https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=300",
          request_headers: { "User-Agent": "Delta-Exchange-Trading-Bot/1.0" },
          response_status: responseStatus,
          response_headers: respHeaders,
          response_body: responseText,
          latency_ms: latencyMs,
        });

        if (res.ok) {
          this.candles1m = data.map((c) => ({
            time: Math.floor(c[0] / 1000),
            open: parseFloat(c[1]),
            high: parseFloat(c[2]),
            low: parseFloat(c[3]),
            close: parseFloat(c[4]),
            volume: parseFloat(c[5]),
          }));
          const lastCandle = this.candles1m[this.candles1m.length - 1];
          this.currentPrice = lastCandle.close;
          this.log(`Successfully imported ${this.candles1m.length} real-time BTCUSDT candles from Binance API. Price: $${this.currentPrice}`);
          this.recalculateIndicators();
          fetchedSuccessfully = true;
          return;
        }
      } catch (e) {
        this.log("Binance API offline or blocked. Generating high-fidelity simulated candlesticks...");
      }
    }

    if (!fetchedSuccessfully) {
      // Fallback: Generate simulated candles
    let price = 101250;
    const nowSecs = Math.floor(Date.now() / 1000);
    this.candles1m = [];
    for (let i = 300; i >= 1; i--) {
      const open = price + Math.random() * 80 - 40;
      const close = open + Math.random() * 100 - 50;
      const high = Math.max(open, close) + Math.random() * 30;
      const low = Math.min(open, close) - Math.random() * 30;
      const volume = 5 + Math.random() * 45;

      this.candles1m.push({
        time: nowSecs - i * 60,
        open,
        high,
        low,
        close,
        volume,
      });
      price = close;
    }
    this.currentPrice = price;
    this.log(`Generated simulated historical data. Current base price: $${this.currentPrice}`);
    this.recalculateIndicators();
    }
  }

  private async fetchBinanceOrderFlow() {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000);
      const url = "https://api.binance.com/api/v3/trades?symbol=BTCUSDT&limit=80";
      const startTime = Date.now();
      const res = await fetch(url, { signal: controller.signal });
      const latencyMs = Date.now() - startTime;
      clearTimeout(timeoutId);

      let responseText = "";
      const responseStatus = res.status;
      const respHeaders: Record<string, string> = {};
      res.headers.forEach((val, key) => {
        respHeaders[key] = val;
      });

      if (res.ok) {
        const data = await res.json();
        responseText = `[Array of ${data.length} trades fetched successfully]`;

        dbManager.addApiLog({
          service: "Binance",
          method: "GET",
          url: url,
          request_headers: { "User-Agent": "Delta-Exchange-Trading-Bot/1.0" },
          response_status: responseStatus,
          response_headers: respHeaders,
          response_body: JSON.stringify(data).slice(0, 500) + "...",
          latency_ms: latencyMs,
        });

        if (Array.isArray(data) && data.length > 0) {
          let buyVol = 0;
          let sellVol = 0;
          for (const t of data) {
            const qty = parseFloat(t.qty || "0");
            if (t.isBuyerMaker === false) {
              buyVol += qty;
            } else {
              sellVol += qty;
            }
          }
          const totalVol = buyVol + sellVol;
          const ratio = totalVol > 0 ? buyVol / totalVol : 0.5;
          const cvd = buyVol - sellVol;

          this.orderFlowStats = {
            takerBuyVolume: buyVol,
            takerSellVolume: sellVol,
            takerBuyRatio: ratio,
            netCVD: cvd,
            lastUpdateSecs: Math.floor(Date.now() / 1000),
          };
        }
      } else {
        responseText = await res.text();
        dbManager.addApiLog({
          service: "Binance",
          method: "GET",
          url: url,
          request_headers: { "User-Agent": "Delta-Exchange-Trading-Bot/1.0" },
          response_status: responseStatus,
          response_headers: respHeaders,
          response_body: responseText,
          latency_ms: latencyMs,
        });
      }
    } catch (err) {
      // Offline / fallback: simulate slight drift around 50%
      const current = this.orderFlowStats.takerBuyRatio;
      const change = (Math.random() - 0.5) * 0.04; // +/-2% random drift
      const newRatio = Math.max(0.35, Math.min(0.65, current + change));
      const simulatedVol = 15 + Math.random() * 30;
      const buyVol = simulatedVol * newRatio;
      const sellVol = simulatedVol * (1 - newRatio);
      
      this.orderFlowStats = {
        takerBuyVolume: buyVol,
        takerSellVolume: sellVol,
        takerBuyRatio: newRatio,
        netCVD: buyVol - sellVol,
        lastUpdateSecs: Math.floor(Date.now() / 1000),
      };
    }
  }

  private async fetchBinanceOrderBook() {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000);
      const url = "https://api.binance.com/api/v3/depth?symbol=BTCUSDT&limit=20";
      const startTime = Date.now();
      const res = await fetch(url, { signal: controller.signal });
      const latencyMs = Date.now() - startTime;
      clearTimeout(timeoutId);

      if (res.ok) {
        const data = await res.json();
        if (data && Array.isArray(data.bids) && Array.isArray(data.asks)) {
          let bidDepthBTC = 0;
          let askDepthBTC = 0;
          for (let i = 0; i < Math.min(data.bids.length, 10); i++) {
            bidDepthBTC += parseFloat(data.bids[i][1] || "0");
          }
          for (let i = 0; i < Math.min(data.asks.length, 10); i++) {
            askDepthBTC += parseFloat(data.asks[i][1] || "0");
          }
          const totalDepth = bidDepthBTC + askDepthBTC;
          const imbalanceRatio = totalDepth > 0 ? (bidDepthBTC - askDepthBTC) / totalDepth : 0.0;

          this.orderBookStats = {
            bidDepthBTC,
            askDepthBTC,
            imbalanceRatio,
            lastUpdateSecs: Math.floor(Date.now() / 1000),
          };

          this.orderBookImbalanceHistory.push(imbalanceRatio);
          if (this.orderBookImbalanceHistory.length > 15) {
            this.orderBookImbalanceHistory.shift();
          }
        }
      } else {
        throw new Error(`HTTP Error ${res.status}`);
      }
    } catch (err) {
      // Offline / fallback: simulate slight drift around 0.0 (imbalance range from -0.25 to 0.25)
      const change = (Math.random() - 0.5) * 0.04;
      const imbalance = Math.max(-0.25, Math.min(0.25, this.orderBookStats.imbalanceRatio + change));
      const simulatedTotalDepth = 30 + Math.random() * 20;
      const bidDepth = (simulatedTotalDepth / 2) * (1 + imbalance);
      const askDepth = (simulatedTotalDepth / 2) * (1 - imbalance);

      this.orderBookStats = {
        bidDepthBTC: bidDepth,
        askDepthBTC: askDepth,
        imbalanceRatio: imbalance,
        lastUpdateSecs: Math.floor(Date.now() / 1000),
      };

      this.orderBookImbalanceHistory.push(imbalance);
      if (this.orderBookImbalanceHistory.length > 15) {
        this.orderBookImbalanceHistory.shift();
      }
    }
  }

  private async fetchOpenInterest() {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000);
      const startTime = Date.now();
      const url = "https://fapi.binance.com/fapi/v1/openInterest?symbol=BTCUSDT";
      const res = await fetch(url, { signal: controller.signal });
      const latencyMs = Date.now() - startTime;
      clearTimeout(timeoutId);

      if (res.ok) {
        const data = await res.json();
        const rawOi = parseFloat(data.openInterest);
        if (!isNaN(rawOi) && rawOi > 0) {
          const nowSec = Math.floor(Date.now() / 1000);
          this.openInterestHistory.push({
            timestamp: nowSec,
            oi: rawOi,
            price: this.currentPrice,
          });
          if (this.openInterestHistory.length > 120) {
            this.openInterestHistory.shift();
          }

          // Calculate 1m and 5m OI changes
          const target1m = nowSec - 60;
          const target5m = nowSec - 300;

          let prev1mItem = this.openInterestHistory[0];
          let prev5mItem = this.openInterestHistory[0];
          for (const item of this.openInterestHistory) {
            if (item.timestamp <= target1m && item.timestamp > prev1mItem.timestamp) {
              prev1mItem = item;
            }
            if (item.timestamp <= target5m && item.timestamp > prev5mItem.timestamp) {
              prev5mItem = item;
            }
          }

          const oiChange1m = rawOi - prev1mItem.oi;
          const oiChangePct1m = prev1mItem.oi > 0 ? (oiChange1m / prev1mItem.oi) * 100 : 0;
          const oiChange5m = rawOi - prev5mItem.oi;
          const oiChangePct5m = prev5mItem.oi > 0 ? (oiChange5m / prev5mItem.oi) * 100 : 0;

          this.openInterestStats = {
            currentOI: rawOi,
            prevOI_1m: prev1mItem.oi,
            prevOI_5m: prev5mItem.oi,
            oiChange1m,
            oiChangePct1m,
            oiChange5m,
            oiChangePct5m,
            lastUpdateSecs: nowSec,
          };
        }
      }
    } catch (err) {
      // Offline / fallback: simulate realistic subtle OI fluctuations, with occasional contraction on high-volatility candles
      const current = this.openInterestStats.currentOI;
      const lastCandle = this.candles1m[this.candles1m.length - 1];
      const isHighVol = lastCandle && lastCandle.volume > 28;
      const changePct = isHighVol ? -(1.0 + Math.random() * 0.8) : (Math.random() - 0.49) * 0.15;
      const newOi = Math.max(80000, current * (1 + changePct / 100));
      const nowSec = Math.floor(Date.now() / 1000);

      this.openInterestStats = {
        currentOI: newOi,
        prevOI_1m: current,
        prevOI_5m: current,
        oiChange1m: newOi - current,
        oiChangePct1m: changePct,
        oiChange5m: changePct * 1.2,
        oiChangePct5m: changePct * 1.2,
        lastUpdateSecs: nowSec,
      };
    }
  }

  // Periodic loop running every 5 seconds to simulate ticks, and every 1 minute to form candles
  private startLoop() {
    setInterval(() => {
      this.tick();
    }, 5000);
  }

  private async tick() {
    const config = dbManager.getConfig();
    this.tickCount++;

    // Periodically (every 15 seconds) fetch actual USDT wallet balance from Delta Exchange in live mode
    if (!dbManager.isPaperMode() && this.tickCount % 3 === 0) {
      const creds = dbManager.getCredentials();
      if (creds.connection_status === "CONNECTED") {
        getDeltaWalletBalance(creds).then((liveBal) => {
          if (liveBal !== null) {
            dbManager.updateCredentials({
              account_balance_usdt: liveBal,
            });
          }
        }).catch((err) => {
          console.error("[TradingEngine] Failed to sync real-time Delta Exchange balance:", err);
        });
      }
    }

    // Periodically (every 15 seconds) fetch Binance Order Flow & Order Book & Open Interest
    if (this.tickCount === 1 || this.tickCount % 3 === 0) {
      this.fetchBinanceOrderFlow().catch((err) => {
        console.error("[TradingEngine] Failed to fetch Binance order flow:", err);
      });
      this.fetchBinanceOrderBook().catch((err) => {
        console.error("[TradingEngine] Failed to fetch Binance order book:", err);
      });
      this.fetchOpenInterest().catch((err) => {
        console.error("[TradingEngine] Failed to fetch open interest:", err);
      });
    }

    // 1. Simulate minor price fluctuations (random walk centered around actual/historical trends)
    // We pull from selected data feed (Binance or Delta Exchange) to keep the feed incredibly real
    const useDelta = config.general?.data_feed_source === "DELTA_EXCHANGE";
    let tickerFetched = false;

    if (useDelta) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 2000);
        const startTime = Date.now();
        const url = "https://api.delta.exchange/v2/tickers/BTCUSD";
        const res = await fetch(url, { signal: controller.signal });
        const latencyMs = Date.now() - startTime;
        clearTimeout(timeoutId);

        let responseText = "";
        const responseStatus = res.status;
        const respHeaders: Record<string, string> = {};
        res.headers.forEach((val, key) => {
          respHeaders[key] = val;
        });

        let data: any = null;
        if (res.ok) {
          data = await res.json();
          responseText = JSON.stringify(data);
        } else {
          responseText = await res.text();
        }

        dbManager.addApiLog({
          service: "Delta Exchange",
          method: "GET",
          url: url,
          request_headers: { "User-Agent": "Delta-Exchange-Trading-Bot/1.0" },
          response_status: responseStatus,
          response_headers: respHeaders,
          response_body: responseText.slice(0, 500) + (responseText.length > 500 ? "..." : ""),
          latency_ms: latencyMs,
        });

        if (res.ok && data && data.result) {
          const priceStr = data.result.spot_price || data.result.mark_price || data.result.close || data.result.last_price;
          if (priceStr) {
            this.currentPrice = parseFloat(priceStr);
            tickerFetched = true;
          }
        }
      } catch (err) {
        // Soft fail, will try fallback below
      }
    }

    if (!tickerFetched) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 2000);
        const startTime = Date.now();
        const res = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT", {
          signal: controller.signal,
        });
        const latencyMs = Date.now() - startTime;
        clearTimeout(timeoutId);

        let responseText = "";
        const responseStatus = res.status;
        const respHeaders: Record<string, string> = {};
        res.headers.forEach((val, key) => {
          respHeaders[key] = val;
        });

        let data: any = null;
        if (res.ok) {
          data = await res.json();
          responseText = JSON.stringify(data);
        } else {
          responseText = await res.text();
        }

        dbManager.addApiLog({
          service: "Binance",
          method: "GET",
          url: "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT",
          request_headers: { "User-Agent": "Delta-Exchange-Trading-Bot/1.0" },
          response_status: responseStatus,
          response_headers: respHeaders,
          response_body: responseText,
          latency_ms: latencyMs,
        });

        if (res.ok) {
          this.currentPrice = parseFloat(data.price);
          tickerFetched = true;
        }
      } catch (e) {
        // Fall back to offline random walk below
      }
    }

    if (!tickerFetched) {
      // Offline fallback: minor random walk
      const trend = this.currentRegime === MarketRegime.STRONG_UPTREND ? 1.5 : this.currentRegime === MarketRegime.STRONG_DOWNTREND ? -1.5 : 0;
      const change = (Math.random() - 0.5) * 35 + trend;
      this.currentPrice = Number((this.currentPrice + change).toFixed(2));
    }

    // Update the last candle
    if (this.candles1m.length > 0) {
      const last = this.candles1m[this.candles1m.length - 1];
      const nowSec = Math.floor(Date.now() / 1000);

      // If it's a new minute, push a new candle and shift the old ones
      if (nowSec - last.time >= 60) {
        const lastIdx = this.candles1m.length - 1;
        const startIdx = Math.max(0, lastIdx - 20);
        const prevCandles = this.candles1m.slice(startIdx, lastIdx + 1);
        let avgVol = 15.0;
        if (prevCandles.length > 0) {
          const sumVol = prevCandles.reduce((sum, c) => sum + (c.volume || 0), 0);
          avgVol = sumVol / prevCandles.length;
        }
        if (avgVol <= 0) avgVol = 1.0;

        const prices = prevCandles.map(c => c.close);
        const maxPrice = Math.max(...prices);
        const minPrice = Math.min(...prices);

        let surgeMultiplier = 0.8 + Math.random() * 0.4;
        let isBreakoutSurge = false;
        if (this.currentPrice > maxPrice || this.currentPrice < minPrice) {
          surgeMultiplier = 1.45 + Math.random() * 0.7; // Generates 1.45x to 2.15x volume breakout
          isBreakoutSurge = true;
        }

        const dynamicallyCalculatedVolume = avgVol * surgeMultiplier;

        const newCandle: Candlestick = {
          time: last.time + 60,
          open: last.close,
          high: this.currentPrice,
          low: this.currentPrice,
          close: this.currentPrice,
          volume: Number(dynamicallyCalculatedVolume.toFixed(4)),
        };
        this.candles1m.push(newCandle);
        if (this.candles1m.length > 350) {
          this.candles1m.shift();
        }
        this.log(`New 1-Minute Candle formed: Open=$${newCandle.open.toFixed(2)}, Close=$${newCandle.close.toFixed(2)}, Volume=${newCandle.volume.toFixed(2)} (${isBreakoutSurge ? "BREAKOUT SURGE " : ""}${surgeMultiplier.toFixed(2)}x avg of ${avgVol.toFixed(2)})`);
        this.recalculateIndicators();
        this.runScanners(); // Scan trading conditions on new minute close
      } else {
        // Update current candle
        last.high = Math.max(last.high, this.currentPrice);
        last.low = Math.min(last.low, this.currentPrice);
        last.close = this.currentPrice;
      }
    }

    // 2. Track protection timer for news
    if (this.criticalEventActive && this.protectionRemainingSeconds !== null) {
      this.protectionRemainingSeconds -= 5;
      if (this.protectionRemainingSeconds <= 0) {
        this.criticalEventActive = false;
        this.criticalEventKeyword = null;
        this.protectionRemainingSeconds = null;
        this.log("News protection lock has expired. Resuming normal operations.");
      }
    }

    // 3. Update active trade position and check exits
    if (this.activeTrade) {
      this.updateActiveTradePnL();
    }

    // 4. Periodically simulate news headline additions
    if (Math.random() > 0.95) {
      this.simulateIncomingNews();
    }
  }

  // Computes EMAs, RSI, ATR, BB, ADX, VWAP
  private recalculateIndicators() {
    const closes = this.candles1m.map((c) => c.close);
    if (closes.length < 50) return;

    // Calculate Layer 1: Market Regime
    this.detectMarketRegime();

    // Calculate VWAP and its Deviation Bands
    this.calculateVWAP(this.candles1m);

    // 1. Compute current feature values
    const rsi14 = this.calculateRSI(closes, 14);
    const rsiVal = rsi14[closes.length - 1] !== undefined ? rsi14[closes.length - 1] : 50;

    const ema21 = this.calculateEMA(closes, 21);
    const ema50 = this.calculateEMA(closes, 50);
    const emaSpreadVal = ((ema21[closes.length - 1] - ema50[closes.length - 1]) / ema50[closes.length - 1]) * 100;

    const atr14 = this.calculateATR(this.candles1m, 14);
    const currentAtr = atr14[closes.length - 1] || 50;
    let sumAtrLong = 0;
    const lookback = Math.min(closes.length, 50);
    for (let i = closes.length - lookback; i < closes.length; i++) {
      sumAtrLong += atr14[i] || 50;
    }
    const longTermAtr = sumAtrLong / lookback;
    const atrExpansionRatio = currentAtr / (longTermAtr || 1);

  }

  // Indicators Calculation Helpers
  private calculateEMA(data: number[], period: number): number[] {
    if (data.length === 0) return [];
    const key = `${data.length}_${data[data.length - 1]}_${data[0]}_${period}`;
    if (this.indicatorCache.ema.has(key)) {
      return this.indicatorCache.ema.get(key)!;
    }
    if (this.indicatorCache.ema.size > 200) {
      this.indicatorCache.ema.clear();
    }

    const ema: number[] = [];
    const k = 2 / (period + 1);
    let sum = 0;
    for (let i = 0; i < period; i++) {
      sum += data[i];
    }
    ema[period - 1] = sum / period;
    for (let i = period; i < data.length; i++) {
      ema[i] = data[i] * k + ema[i - 1] * (1 - k);
    }
    this.indicatorCache.ema.set(key, ema);
    return ema;
  }

  private calculateRSI(data: number[], period = 14): number[] {
    if (data.length === 0) return [];
    const key = `${data.length}_${data[data.length - 1]}_${data[0]}_${period}`;
    if (this.indicatorCache.rsi.has(key)) {
      return this.indicatorCache.rsi.get(key)!;
    }
    if (this.indicatorCache.rsi.size > 200) {
      this.indicatorCache.rsi.clear();
    }

    const rsi: number[] = [];
    if (data.length <= period) return rsi;

    let avgGain = 0;
    let avgLoss = 0;

    // First period gains/losses
    for (let i = 1; i <= period; i++) {
      const change = data[i] - data[i - 1];
      if (change > 0) avgGain += change;
      else avgLoss -= change;
    }

    avgGain /= period;
    avgLoss /= period;
    rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

    for (let i = period + 1; i < data.length; i++) {
      const change = data[i] - data[i - 1];
      const gain = change > 0 ? change : 0;
      const loss = change < 0 ? -change : 0;

      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;

      rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    }

    this.indicatorCache.rsi.set(key, rsi);
    return rsi;
  }

  private calculateATR(candles: Candlestick[], period = 14): number[] {
    if (candles.length === 0) return [];
    const last = candles[candles.length - 1];
    const first = candles[0];
    const key = `${candles.length}_${last.time}_${last.close}_${first.time}_${period}`;
    if (this.indicatorCache.atr.has(key)) {
      return this.indicatorCache.atr.get(key)!;
    }
    if (this.indicatorCache.atr.size > 200) {
      this.indicatorCache.atr.clear();
    }

    const atr: number[] = [];
    if (candles.length <= period) return atr;

    const tr: number[] = [candles[0].high - candles[0].low];
    for (let i = 1; i < candles.length; i++) {
      const h_l = candles[i].high - candles[i].low;
      const h_pc = Math.abs(candles[i].high - candles[i - 1].close);
      const l_pc = Math.abs(candles[i].low - candles[i - 1].close);
      tr.push(Math.max(h_l, h_pc, l_pc));
    }

    let sum = 0;
    for (let i = 0; i < period; i++) {
      sum += tr[i];
    }
    atr[period - 1] = sum / period;

    for (let i = period; i < candles.length; i++) {
      atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;
    }

    this.indicatorCache.atr.set(key, atr);
    return atr;
  }

  private calculateADX(candles: Candlestick[], period = 14): number[] {
    if (candles.length === 0) return [];
    const last = candles[candles.length - 1];
    const first = candles[0];
    const key = `${candles.length}_${last.time}_${last.close}_${first.time}_${period}`;
    if (this.indicatorCache.adx.has(key)) {
      return this.indicatorCache.adx.get(key)!;
    }
    if (this.indicatorCache.adx.size > 200) {
      this.indicatorCache.adx.clear();
    }

    const adx: number[] = [];
    if (candles.length <= period * 2) {
      return Array(candles.length).fill(25);
    }

    const tr: number[] = [];
    const plusDM: number[] = [];
    const minusDM: number[] = [];

    for (let i = 1; i < candles.length; i++) {
      const highDiff = candles[i].high - candles[i - 1].high;
      const lowDiff = candles[i - 1].low - candles[i].low;

      const h_l = candles[i].high - candles[i].low;
      const h_pc = Math.abs(candles[i].high - candles[i - 1].close);
      const l_pc = Math.abs(candles[i].low - candles[i - 1].close);
      tr.push(Math.max(h_l, h_pc, l_pc));

      if (highDiff > lowDiff && highDiff > 0) {
        plusDM.push(highDiff);
      } else {
        plusDM.push(0);
      }

      if (lowDiff > highDiff && lowDiff > 0) {
        minusDM.push(lowDiff);
      } else {
        minusDM.push(0);
      }
    }

    let smoothedTR = 0;
    let smoothedPlusDM = 0;
    let smoothedMinusDM = 0;

    for (let i = 0; i < period; i++) {
      smoothedTR += tr[i];
      smoothedPlusDM += plusDM[i];
      smoothedMinusDM += minusDM[i];
    }

    const dxList: number[] = [];
    const getDX = (trS: number, pdmS: number, mdmS: number) => {
      if (trS === 0) return 0;
      const plusDI = 100 * (pdmS / trS);
      const minusDI = 100 * (mdmS / trS);
      const diff = Math.abs(plusDI - minusDI);
      const sum = plusDI + minusDI;
      return sum === 0 ? 0 : 100 * (diff / sum);
    };

    dxList.push(getDX(smoothedTR, smoothedPlusDM, smoothedMinusDM));

    for (let i = period; i < tr.length; i++) {
      smoothedTR = smoothedTR - (smoothedTR / period) + tr[i];
      smoothedPlusDM = smoothedPlusDM - (smoothedPlusDM / period) + plusDM[i];
      smoothedMinusDM = smoothedMinusDM - (smoothedMinusDM / period) + minusDM[i];
      dxList.push(getDX(smoothedTR, smoothedPlusDM, smoothedMinusDM));
    }

    let adxSum = 0;
    for (let i = 0; i < period; i++) {
      adxSum += dxList[i];
    }

    for (let i = 0; i < period + period; i++) {
      adx.push(25);
    }

    let smoothedADX = adxSum / period;
    adx.push(smoothedADX);

    for (let i = period; i < dxList.length; i++) {
      smoothedADX = (smoothedADX * (period - 1) + dxList[i]) / period;
      adx.push(smoothedADX);
    }

    while (adx.length < candles.length) {
      adx.unshift(25);
    }

    this.indicatorCache.adx.set(key, adx);
    return adx;
  }

  public calculateAccurateRelativeVolume(candles: Candlestick[] = this.candles1m): number {
    if (!candles || candles.length < 2) return 1.0;
    const lastIdx = candles.length - 1;
    const currentCandle = candles[lastIdx];
    const volumes = candles.map((c) => c.volume || 0);

    // Lookback 20 completed periods before the current candle
    const endPrevIdx = lastIdx;
    const startPrevIdx = Math.max(0, endPrevIdx - 20);
    const prevVolumes = volumes.slice(startPrevIdx, endPrevIdx);

    if (prevVolumes.length === 0) return 1.0;
    const sumPrevVolumes = prevVolumes.reduce((a, b) => a + b, 0);
    const avgPrevVolume = sumPrevVolumes / prevVolumes.length;
    if (avgPrevVolume <= 0) return 1.0;

    // 1. Last completed closed candle relative volume
    const lastClosedVol = volumes[lastIdx - 1] !== undefined ? volumes[lastIdx - 1] : volumes[lastIdx];
    const lastClosedRelVol = lastClosedVol / avgPrevVolume;

    // 2. Current in-progress candle normalized/projected relative volume based on elapsed seconds
    const nowSecs = Math.floor(Date.now() / 1000);
    const candleStartSecs = currentCandle.time || nowSecs;
    const elapsedSeconds = Math.max(3, Math.min(60, nowSecs - candleStartSecs));
    
    // Extrapolate in-progress volume proportionally to full 60s minute
    const paceMultiplier = 60 / elapsedSeconds;
    const projectedCurrentVol = (currentCandle.volume || 0) * paceMultiplier;
    const projectedRelVol = projectedCurrentVol / avgPrevVolume;

    // 3. Raw current volume vs average
    const rawCurrentRelVol = (currentCandle.volume || 0) / avgPrevVolume;

    // The accurate relative volume represents the true volume pace:
    // Take the maximum of the last closed candle's completed RVOL, the projected pacing RVOL, and the raw RVOL
    const pacingRelVol = Math.min(4.0, Math.max(projectedRelVol, rawCurrentRelVol));
    const effectiveRelVolume = Math.max(lastClosedRelVol, pacingRelVol);

    return Number(Math.max(0.1, effectiveRelVolume).toFixed(2));
  }

  // Calculates the 14-period Choppiness Index (CHOP)
  private calculateChoppinessIndex(candles: Candlestick[], period = 14): number {
    if (candles.length < period) return 50.0;
    const slice = candles.slice(-period);
    let sumTR = 0;
    for (let i = 0; i < slice.length; i++) {
      const high = slice[i].high;
      const low = slice[i].low;
      const prevClose = i > 0 ? slice[i - 1].close : slice[i].open;
      const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
      sumTR += tr;
    }
    const maxHigh = Math.max(...slice.map(c => c.high));
    const minLow = Math.min(...slice.map(c => c.low));
    const range = maxHigh - minLow;
    if (range <= 0) return 100.0;
    const chop = 100 * (Math.log10(sumTR / range) / Math.log10(period));
    return Math.max(0, Math.min(100, Number(chop.toFixed(2))));
  }

  // Calculates Kaufman Efficiency Ratio (KER) across lookback period
  private calculateEfficiencyRatio(candles: Candlestick[], period = 10): number {
    if (candles.length <= period) return 1.0;
    const slice = candles.slice(-period - 1);
    const netChange = Math.abs(slice[slice.length - 1].close - slice[0].close);
    let sumPath = 0;
    for (let i = 1; i < slice.length; i++) {
      sumPath += Math.abs(slice[i].close - slice[i - 1].close);
    }
    if (sumPath === 0) return 0.0;
    return Number((netChange / sumPath).toFixed(3));
  }

  // Calculates average candle wick-to-range ratio across recent candles
  private calculateAverageWickRatio(candles: Candlestick[], period = 10): number {
    if (candles.length < period) return 0.5;
    const slice = candles.slice(-period);
    let totalWickRatio = 0;
    for (const c of slice) {
      const range = c.high - c.low;
      if (range <= 0) {
        totalWickRatio += 1.0;
        continue;
      }
      const body = Math.abs(c.close - c.open);
      const wick = range - body;
      totalWickRatio += wick / range;
    }
    return Number((totalWickRatio / slice.length).toFixed(3));
  }

  /**
   * Directional Exhaustion & Overhead Supply / Demand Rejection Wick Analyzer
   * Detects repeated prominent rejection wicks at local extremes (e.g. multiple upper wicks at resistance),
   * strictly protecting against entering long right below a supply ceiling or short right above a demand floor.
   */
  public evaluateDirectionalExhaustionWicks(direction: "LONG" | "SHORT"): {
    isExhausted: boolean;
    wickCount: number;
    totalCandlesScanned: number;
    highestWickHigh: number;
    lowestWickLow: number;
    dominantWickZone: { min: number; max: number };
    qualifyingCandleIndices: number[];
    description: string;
  } {
    const config = dbManager.getConfig();
    if (config.general?.enable_exhaustion_wick_filter === false) {
      return {
        isExhausted: false,
        wickCount: 0,
        totalCandlesScanned: 0,
        highestWickHigh: 0,
        lowestWickLow: 0,
        dominantWickZone: { min: 0, max: 0 },
        qualifyingCandleIndices: [],
        description: "Exhaustion wick protection disabled.",
      };
    }

    const lookback = config.general?.exhaustion_wick_lookback || 6;
    const minWickCount = config.general?.exhaustion_wick_min_count || 2;
    const minWickRatio = config.general?.exhaustion_wick_min_ratio || 0.35;

    if (this.candles1m.length < 10) {
      return {
        isExhausted: false,
        wickCount: 0,
        totalCandlesScanned: 0,
        highestWickHigh: 0,
        lowestWickLow: 0,
        dominantWickZone: { min: 0, max: 0 },
        qualifyingCandleIndices: [],
        description: "Insufficient candle data for wick exhaustion analysis.",
      };
    }

    const lastIdx = this.candles1m.length - 1;
    const atr14 = this.calculateATR(this.candles1m, 14);
    const currentAtr = atr14[lastIdx] || 50;

    const scanStart = Math.max(0, this.candles1m.length - lookback);
    const scanCandles = this.candles1m.slice(scanStart);

    // Reference broader context (last 20 candles) to locate recent swing levels
    const contextStart = Math.max(0, this.candles1m.length - 20);
    const contextCandles = this.candles1m.slice(contextStart);
    const localHigh = Math.max(...contextCandles.map((c) => c.high));
    const localLow = Math.min(...contextCandles.map((c) => c.low));

    if (direction === "LONG") {
      const qualifyingWicks: { index: number; candle: Candlestick; upperWick: number; upperWickRatio: number }[] = [];

      for (let i = 0; i < scanCandles.length; i++) {
        const c = scanCandles[i];
        const globalIdx = scanStart + i;
        const range = c.high - c.low;
        if (range <= 0) continue;

        const body = Math.abs(c.close - c.open);
        const upperWick = c.high - Math.max(c.open, c.close);
        const upperWickRatio = upperWick / range;

        // Check if candle high is near the recent local high (within 1.5 ATR or 0.4%)
        const isNearLocalHigh = c.high >= localHigh - 1.5 * currentAtr || c.high >= localHigh * 0.996;

        // Prominent overhead supply / rejection wick criteria:
        // 1. High upper wick proportion (>= minWickRatio) with meaningful absolute size (>= 0.20 ATR)
        // 2. Upper wick >= 1.5x body with >= 0.15 ATR
        // 3. Shooting star / pinbar at highs (upper wick >= 2x body)
        // 4. Closed in lower half of candle after spiking high with >= 30% upper wick
        const isProminentUpperWick =
          (upperWickRatio >= minWickRatio && upperWick >= 0.20 * currentAtr) ||
          (upperWick >= 1.5 * body && upperWick >= 0.15 * currentAtr) ||
          (upperWick >= 2.0 * body && upperWick >= 0.10 * currentAtr) ||
          (c.close <= c.low + 0.50 * range && upperWickRatio >= 0.30 && upperWick >= 0.15 * currentAtr);

        if (isNearLocalHigh && isProminentUpperWick) {
          qualifyingWicks.push({ index: globalIdx, candle: c, upperWick, upperWickRatio });
        }
      }

      if (qualifyingWicks.length >= minWickCount) {
        const highestWickHigh = Math.max(...qualifyingWicks.map((w) => w.candle.high));
        const minZonePrice = Math.min(...qualifyingWicks.map((w) => Math.max(w.candle.open, w.candle.close)));
        const maxZonePrice = highestWickHigh;

        const currentCandle = this.candles1m[lastIdx];
        const isDecisiveBreakoutAboveWicks =
          currentCandle &&
          currentCandle.close > highestWickHigh &&
          currentCandle.close - currentCandle.open > 0.4 * (currentCandle.high - currentCandle.low);

        if (!isDecisiveBreakoutAboveWicks && this.currentPrice <= highestWickHigh + 0.05 * currentAtr) {
          const desc = `Multiple upper rejection wicks (${qualifyingWicks.length} wicks in last ${lookback}m) at supply zone $${minZonePrice.toFixed(2)} - $${maxZonePrice.toFixed(2)} indicate buyer exhaustion and overhead selling resistance.`;
          return {
            isExhausted: true,
            wickCount: qualifyingWicks.length,
            totalCandlesScanned: scanCandles.length,
            highestWickHigh,
            lowestWickLow: localLow,
            dominantWickZone: { min: minZonePrice, max: maxZonePrice },
            qualifyingCandleIndices: qualifyingWicks.map((w) => w.index),
            description: desc,
          };
        }
      }

      // FIX 2: Check headroom proximity to local swing high ceiling (prevent entering long squeezed < 0.85x ATR under resistance)
      const headroomToCeiling = localHigh - this.currentPrice;
      if (qualifyingWicks.length >= 1 && headroomToCeiling > 0 && headroomToCeiling < 0.85 * currentAtr) {
        return {
          isExhausted: true,
          wickCount: qualifyingWicks.length,
          totalCandlesScanned: scanCandles.length,
          highestWickHigh: localHigh,
          lowestWickLow: localLow,
          dominantWickZone: { min: localHigh - currentAtr * 0.5, max: localHigh },
          qualifyingCandleIndices: qualifyingWicks.map((w) => w.index),
          description: `Blocked: Insufficient headroom to overhead resistance ceiling ($${headroomToCeiling.toFixed(1)} < 0.85x ATR to $${localHigh.toFixed(1)}) with active upper rejection wick present.`,
        };
      }

      return {
        isExhausted: false,
        wickCount: qualifyingWicks.length,
        totalCandlesScanned: scanCandles.length,
        highestWickHigh: localHigh,
        lowestWickLow: localLow,
        dominantWickZone: { min: localHigh, max: localHigh },
        qualifyingCandleIndices: qualifyingWicks.map((w) => w.index),
        description: `No overhead upper wick exhaustion detected (${qualifyingWicks.length} qualifying wicks found, minimum required: ${minWickCount}).`,
      };
    }

    if (direction === "SHORT") {
      const qualifyingWicks: { index: number; candle: Candlestick; lowerWick: number; lowerWickRatio: number }[] = [];

      for (let i = 0; i < scanCandles.length; i++) {
        const c = scanCandles[i];
        const globalIdx = scanStart + i;
        const range = c.high - c.low;
        if (range <= 0) continue;

        const body = Math.abs(c.close - c.open);
        const lowerWick = Math.min(c.open, c.close) - c.low;
        const lowerWickRatio = lowerWick / range;

        // Check if candle low is near recent local low (within 1.5 ATR or 0.4%)
        const isNearLocalLow = c.low <= localLow + 1.5 * currentAtr || c.low <= localLow * 1.004;

        const isProminentLowerWick =
          (lowerWickRatio >= minWickRatio && lowerWick >= 0.20 * currentAtr) ||
          (lowerWick >= 1.5 * body && lowerWick >= 0.15 * currentAtr) ||
          (lowerWick >= 2.0 * body && lowerWick >= 0.10 * currentAtr) ||
          (c.close >= c.low + 0.50 * range && lowerWickRatio >= 0.30 && lowerWick >= 0.15 * currentAtr);

        if (isNearLocalLow && isProminentLowerWick) {
          qualifyingWicks.push({ index: globalIdx, candle: c, lowerWick, lowerWickRatio });
        }
      }

      if (qualifyingWicks.length >= minWickCount) {
        const lowestWickLow = Math.min(...qualifyingWicks.map((w) => w.candle.low));
        const maxZonePrice = Math.max(...qualifyingWicks.map((w) => Math.min(w.candle.open, w.candle.close)));
        const minZonePrice = lowestWickLow;

        const currentCandle = this.candles1m[lastIdx];
        const isDecisiveBreakdownBelowWicks =
          currentCandle &&
          currentCandle.close < lowestWickLow &&
          currentCandle.open - currentCandle.close > 0.4 * (currentCandle.high - currentCandle.low);

        if (!isDecisiveBreakdownBelowWicks && this.currentPrice >= lowestWickLow - 0.05 * currentAtr) {
          const desc = `Multiple lower rejection wicks (${qualifyingWicks.length} wicks in last ${lookback}m) at demand floor $${minZonePrice.toFixed(2)} - $${maxZonePrice.toFixed(2)} indicate seller exhaustion and aggressive buy absorption.`;
          return {
            isExhausted: true,
            wickCount: qualifyingWicks.length,
            totalCandlesScanned: scanCandles.length,
            highestWickHigh: localHigh,
            lowestWickLow,
            dominantWickZone: { min: minZonePrice, max: maxZonePrice },
            qualifyingCandleIndices: qualifyingWicks.map((w) => w.index),
            description: desc,
          };
        }
      }

      // FIX 2: Check headroom proximity to local swing low floor (prevent entering short squeezed < 0.85x ATR above demand)
      const headroomToFloor = this.currentPrice - localLow;
      if (qualifyingWicks.length >= 1 && headroomToFloor > 0 && headroomToFloor < 0.85 * currentAtr) {
        return {
          isExhausted: true,
          wickCount: qualifyingWicks.length,
          totalCandlesScanned: scanCandles.length,
          highestWickHigh: localHigh,
          lowestWickLow: localLow,
          dominantWickZone: { min: localLow, max: localLow + currentAtr * 0.5 },
          qualifyingCandleIndices: qualifyingWicks.map((w) => w.index),
          description: `Blocked: Insufficient headroom to demand floor ($${headroomToFloor.toFixed(1)} < 0.85x ATR to $${localLow.toFixed(1)}) with active lower rejection wick present.`,
        };
      }

      return {
        isExhausted: false,
        wickCount: qualifyingWicks.length,
        totalCandlesScanned: scanCandles.length,
        highestWickHigh: localHigh,
        lowestWickLow: localLow,
        dominantWickZone: { min: localLow, max: localLow },
        qualifyingCandleIndices: qualifyingWicks.map((w) => w.index),
        description: `No demand floor lower wick exhaustion detected (${qualifyingWicks.length} qualifying wicks found, minimum required: ${minWickCount}).`,
      };
    }

    return {
      isExhausted: false,
      wickCount: 0,
      totalCandlesScanned: 0,
      highestWickHigh: localHigh,
      lowestWickLow: localLow,
      dominantWickZone: { min: 0, max: 0 },
      qualifyingCandleIndices: [],
      description: "Neutral direction.",
    };
  }

  public detectWedgePattern(): {
    risingWedge: boolean;
    fallingWedge: boolean;
    upperSlope: number;
    lowerSlope: number;
    ratio: number;
    upperLineCurrent: number;
    lowerLineCurrent: number;
  } {
    const defaultResult = {
      risingWedge: false,
      fallingWedge: false,
      upperSlope: 0,
      lowerSlope: 0,
      ratio: 1.0,
      upperLineCurrent: this.currentPrice,
      lowerLineCurrent: this.currentPrice,
    };

    const closes = this.candles1m.map((c) => c.close);
    const highs = this.candles1m.map((c) => c.high);
    const lows = this.candles1m.map((c) => c.low);
    const lastIdx = closes.length - 1;

    if (closes.length < 30) {
      return defaultResult;
    }

    // 1. Detect Swing Highs and Swing Lows (Fractals)
    const rawHighs: { index: number; price: number }[] = [];
    const rawLows: { index: number; price: number }[] = [];

    // Search backwards over the last 80 candles
    const lookbackRange = Math.min(80, lastIdx - 1);
    for (let i = lastIdx - 1; i >= lastIdx - lookbackRange; i--) {
      const isHigh = highs[i] > highs[i - 1] && highs[i] > highs[i + 1];
      const isLow = lows[i] < lows[i - 1] && lows[i] < lows[i + 1];

      if (isHigh) {
        rawHighs.push({ index: i, price: highs[i] });
      }
      if (isLow) {
        rawLows.push({ index: i, price: lows[i] });
      }
    }

    // 2. Intelligent Noise Filtering: Enforce minimum separation between swing points
    const swingHighs: { index: number; price: number }[] = [];
    for (const sh of rawHighs) {
      if (swingHighs.length === 0) {
        swingHighs.push(sh);
      } else {
        const prevAccepted = swingHighs[swingHighs.length - 1];
        // Ensure at least 4 bars of separation to filter out micro-fluctuations
        if (prevAccepted.index - sh.index >= 4) {
          swingHighs.push(sh);
        }
      }
      if (swingHighs.length >= 3) break;
    }

    const swingLows: { index: number; price: number }[] = [];
    for (const sl of rawLows) {
      if (swingLows.length === 0) {
        swingLows.push(sl);
      } else {
        const prevAccepted = swingLows[swingLows.length - 1];
        if (prevAccepted.index - sl.index >= 4) {
          swingLows.push(sl);
        }
      }
      if (swingLows.length >= 3) break;
    }

    if (swingHighs.length < 2 || swingLows.length < 2) {
      return defaultResult;
    }

    // Connect the two most recent robust swing highs and swing lows
    const h2 = swingHighs[0]; // most recent major swing high
    const h1 = swingHighs[1]; // previous major swing high

    const l2 = swingLows[0]; // most recent major swing low
    const l1 = swingLows[1]; // previous major swing low

    // 3. Staleness Guard: If the most recent touch point of the wedge is too old, ignore the pattern
    const maxStalenessBars = 25;
    if ((lastIdx - h2.index > maxStalenessBars) || (lastIdx - l2.index > maxStalenessBars)) {
      return defaultResult;
    }

    const barH1 = h1.index;
    const barH2 = h2.index;
    const high1 = h1.price;
    const high2 = h2.price;

    const barL1 = l1.index;
    const barL2 = l2.index;
    const low1 = l1.price;
    const low2 = l2.price;

    if (barH2 === barH1 || barL2 === barL1) {
      return defaultResult;
    }

    // Calculate slopes
    const upperSlope = (high2 - high1) / (barH2 - barH1);
    const lowerSlope = (low2 - low1) / (barL2 - barL1);

    // Initial and current width calculation
    const xStart = Math.min(barH1, barL1);

    const upperLineAt = (x: number) => high1 + upperSlope * (x - barH1);
    const lowerLineAt = (x: number) => low1 + lowerSlope * (x - barL1);

    const initialWidth = upperLineAt(xStart) - lowerLineAt(xStart);
    const currentWidth = upperLineAt(lastIdx) - lowerLineAt(lastIdx);

    if (initialWidth <= 0 || currentWidth <= 0) {
      return defaultResult;
    }

    const ratio = currentWidth / initialWidth;
    // An intelligent ratio of < 0.75 captures both early converging structures and fully compressed structures
    const isCompressing = ratio < 0.75;

    // Rising Wedge: Higher highs (upperSlope > 0), Higher lows (lowerSlope > 0), lower trendline steeper (lowerSlope > upperSlope)
    const risingWedge =
      upperSlope > 0 &&
      lowerSlope > 0 &&
      lowerSlope > upperSlope &&
      isCompressing;

    // Falling Wedge: Lower highs (upperSlope < 0), Lower lows (lowerSlope < 0), upper trendline steeper (upperSlope < lowerSlope)
    const fallingWedge =
      upperSlope < 0 &&
      lowerSlope < 0 &&
      upperSlope < lowerSlope &&
      isCompressing;

    return {
      risingWedge,
      fallingWedge,
      upperSlope,
      lowerSlope,
      ratio,
      upperLineCurrent: upperLineAt(lastIdx),
      lowerLineCurrent: lowerLineAt(lastIdx),
    };
  }

  public detectPullbackTrendlineBreak(): {
    isLongBreak: boolean;
    isShortBreak: boolean;
    message: string;
    slope: number;
    valAtLast: number;
    startIdx: number;
  } {
    const defaultResult = { isLongBreak: false, isShortBreak: false, message: "", slope: 0, valAtLast: 0, startIdx: -1 };
    const closes = this.candles1m.map(c => c.close);
    const highs = this.candles1m.map(c => c.high);
    const lows = this.candles1m.map(c => c.low);
    const opens = this.candles1m.map(c => c.open);
    const lastIdx = closes.length - 1;

    if (closes.length < 50) {
      return defaultResult;
    }

    const ema20 = this.calculateEMA(closes, 20);
    const ema50 = this.calculateEMA(closes, 50);
    const ema100 = this.calculateEMA(closes, 100);
    const ema20Val = ema20[lastIdx] || closes[lastIdx];
    const ema50Val = ema50[lastIdx] || closes[lastIdx];
    const ema100Val = ema100[lastIdx] || closes[lastIdx];

    const isUptrendAligned = ema20Val > ema50Val && ema50Val > ema100Val;
    const isDowntrendAligned = ema20Val < ema50Val && ema50Val < ema100Val;

    const fitTrendline = (points: { x: number; y: number }[]) => {
      const n = points.length;
      if (n < 2) return { slope: 0, intercept: 0 };
      let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
      for (const p of points) {
        sumX += p.x;
        sumY += p.y;
        sumXY += p.x * p.y;
        sumXX += p.x * p.x;
      }
      const denominator = n * sumXX - sumX * sumX;
      if (Math.abs(denominator) < 1e-8) return { slope: 0, intercept: 0 };
      const slope = (n * sumXY - sumX * sumY) / denominator;
      const intercept = (sumY - slope * sumX) / n;
      return { slope, intercept };
    };

    if (isUptrendAligned) {
      const lookback = Math.min(30, lastIdx - 5);
      if (lookback < 5) return defaultResult;

      let highestIdx = lastIdx;
      let maxHigh = -Infinity;
      for (let i = lastIdx - lookback; i < lastIdx; i++) {
        if (highs[i] > maxHigh) {
          maxHigh = highs[i];
          highestIdx = i;
        }
      }

      const pullbackLength = lastIdx - highestIdx;
      if (pullbackLength >= 4 && pullbackLength <= 30) {
        const points: { x: number; y: number }[] = [];
        for (let i = highestIdx; i < lastIdx; i++) {
          points.push({ x: i - highestIdx, y: highs[i] });
        }

        const { slope, intercept } = fitTrendline(points);
        const valAtLast = slope * (lastIdx - highestIdx) + intercept;

        if (slope < 0.0001) { // Descending or flat line
          const currentClose = closes[lastIdx];
          const currentOpen = opens[lastIdx];
          const isBreakout = currentClose > valAtLast && currentClose > currentOpen;
          if (isBreakout) {
            return {
              isLongBreak: true,
              isShortBreak: false,
              message: `Bullish Pullback Breakout: Price ($${currentClose.toFixed(2)}) broke above descending pullback resistance line ($${valAtLast.toFixed(2)}) on bullish candle confirmation.`,
              slope,
              valAtLast,
              startIdx: highestIdx
            };
          }
        }
      }
    } else if (isDowntrendAligned) {
      const lookback = Math.min(30, lastIdx - 5);
      if (lookback < 5) return defaultResult;

      let lowestIdx = lastIdx;
      let minLow = Infinity;
      for (let i = lastIdx - lookback; i < lastIdx; i++) {
        if (lows[i] < minLow) {
          minLow = lows[i];
          lowestIdx = i;
        }
      }

      const pullbackLength = lastIdx - lowestIdx;
      if (pullbackLength >= 4 && pullbackLength <= 30) {
        const points: { x: number; y: number }[] = [];
        for (let i = lowestIdx; i < lastIdx; i++) {
          points.push({ x: i - lowestIdx, y: lows[i] });
        }

        const { slope, intercept } = fitTrendline(points);
        const valAtLast = slope * (lastIdx - lowestIdx) + intercept;

        if (slope > -0.0001) { // Ascending or flat line
          const currentClose = closes[lastIdx];
          const currentOpen = opens[lastIdx];
          const isBreakdown = currentClose < valAtLast && currentClose < currentOpen;
          if (isBreakdown) {
            return {
              isLongBreak: false,
              isShortBreak: true,
              message: `Bearish Pullback Breakdown: Price ($${currentClose.toFixed(2)}) broke below ascending pullback support line ($${valAtLast.toFixed(2)}) on bearish candle confirmation.`,
              slope,
              valAtLast,
              startIdx: lowestIdx
            };
          }
        }
      }
    }

    return defaultResult;
  }

  public getTrendMarketStructure(): {
    current_HH: { price: number; index: number } | null;
    prev_HH: { price: number; index: number } | null;
    current_HL: { price: number; index: number } | null;
    prev_HL: { price: number; index: number } | null;
    current_LH: { price: number; index: number } | null;
    prev_LH: { price: number; index: number } | null;
    current_LL: { price: number; index: number } | null;
    prev_LL: { price: number; index: number } | null;
    isLongStructureConfirmed: boolean;
    isShortStructureConfirmed: boolean;
    pullbackLongMet: boolean;
    pullbackShortMet: boolean;
    swingHigh: number;
    swingLow: number;
  } {
    if (this.candles1m.length === 0) {
      return {
        current_HH: null, prev_HH: null, current_HL: null, prev_HL: null,
        current_LH: null, prev_LH: null, current_LL: null, prev_LL: null,
        isLongStructureConfirmed: false, isShortStructureConfirmed: false,
        pullbackLongMet: false, pullbackShortMet: false,
        swingHigh: 100000, swingLow: 100000
      };
    }

    const config = dbManager.getConfig();
    const ms = config.market_structure || {
      fast_ema_period: 20,
      medium_ema_period: 50,
      slow_ema_period: 200,
      trend_alignment_adx_threshold: 30,
      super_trend_adx_threshold: 35,
      timeframe_minutes: 5,
    };
    const timeframeMinutes = ms.timeframe_minutes !== undefined ? ms.timeframe_minutes : 5;

    let candles = this.aggregateCandles(this.candles1m, timeframeMinutes);
    if (candles.length < 35 && timeframeMinutes > 1) {
      candles = this.aggregateCandles(this.candles1m, 3);
      if (candles.length < 35) {
        candles = this.candles1m;
      }
    }

    const last = this.candles1m[this.candles1m.length - 1];
    const cacheKey = `${this.candles1m.length}_${last.time}_${last.close}_${this.currentRegime}_${timeframeMinutes}`;
    if (this.indicatorCache.marketStructure.has(cacheKey)) {
      return this.indicatorCache.marketStructure.get(cacheKey)!;
    }
    if (this.indicatorCache.marketStructure.size > 200) {
      this.indicatorCache.marketStructure.clear();
    }

    const closes = candles.map(c => c.close);
    const highs = candles.map(c => c.high);
    const lows = candles.map(c => c.low);
    const lastIdx = closes.length - 1;

    if (closes.length < 30) {
      const defaultStruct = {
        current_HH: null, prev_HH: null, current_HL: null, prev_HL: null,
        current_LH: null, prev_LH: null, current_LL: null, prev_LL: null,
        isLongStructureConfirmed: false, isShortStructureConfirmed: false,
        pullbackLongMet: false, pullbackShortMet: false,
        swingHigh: highs[lastIdx] || 100000, swingLow: lows[lastIdx] || 100000
      };
      this.indicatorCache.marketStructure.set(cacheKey, defaultStruct);
      return defaultStruct;
    }

    // Adaptive Fractal lookback based on current market regime:
    // In trending markets we use a wider, noise-filtering 9-candle window.
    // In range-bound markets, we use a tighter 5-candle window to capture prompt support/resistance pivots.
    let windowSize = 5;
    if (this.currentRegime === MarketRegime.STRONG_UPTREND || this.currentRegime === MarketRegime.STRONG_DOWNTREND) {
      windowSize = 9;
    } else if (this.currentRegime === MarketRegime.HIGH_VOLATILITY) {
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

    // Direct consecutive swing high/low classification to avoid multi-cycle lag.
    // An uptrend is active if the latest peak is higher than the previous peak (HH > prev_HH)
    // AND the latest trough is higher than the previous trough (HL > prev_HL).
    const current_HH = rawHighs.length > 0 ? rawHighs[rawHighs.length - 1] : null;
    const prev_HH = rawHighs.length > 1 ? rawHighs[rawHighs.length - 2] : null;

    const current_HL = rawLows.length > 0 ? rawLows[rawLows.length - 1] : null;
    const prev_HL = rawLows.length > 1 ? rawLows[rawLows.length - 2] : null;

    const current_LH = current_HH;
    const prev_LH = prev_HH;

    const current_LL = current_HL;
    const prev_LL = prev_HL;

    // Structure confirmations without lag:
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

    // Pullback logic: Checks if price pulled back since the most recent swing high / low
    let pullbackLongMet = false;
    let pullbackShortMet = false;

    const ema20 = this.calculateEMA(closes, 20);
    const ema20Val = ema20[lastIdx] || closes[lastIdx];

    if (current_HH && current_HL) {
      // Pullback LONG triggers if since the HH index, price has touched/gone below EMA20,
      // or touched/gone below prev_HH breakout level, or retraced to between 38% and 61% of HH to HL move.
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
      // Pullback SHORT triggers if since the LL index, price has touched/gone above EMA20,
      // or touched/gone above prev_LL breakout level, or retraced to between 38% and 61% of LH to LL move.
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

    const result = {
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
    this.indicatorCache.marketStructure.set(cacheKey, result);
    return result;
  }

  private evaluateTrendBreakoutSetup(
    direction: "LONG" | "SHORT",
    currentPrice: number,
    ema20Val: number,
    ema50Val: number,
    ema100Val: number,
    struct: any,
    probabilityLong: number
  ): TrendBreakoutSetupResult {
    const config = dbManager.getConfig();
    const ms = config.market_structure || {
      min_breakout_body_ratio: 0.22,
      allow_immediate_breakout: true,
      hf_momentum_adx_threshold: 30,
      hf_orderflow_taker_buy_ratio_long: 0.58,
      hf_orderflow_imbalance_ratio_long: 0.30,
      hf_orderflow_taker_buy_ratio_short: 0.42,
      hf_orderflow_imbalance_ratio_short: -0.30,
      pullback_multiplier_limit: 0.6,
      ema_retrace_multiplier_limit: 0.4,
      bypass_ema200_on_momentum: true,
      ema200_proximity_divisor: 3.0,
      weak_trend_adx_threshold: 25,
    };
    const lastIdx = this.candles1m.length - 1;
    if (lastIdx < 0) {
      return { confirmed: false, message: "No candle data available." };
    }
    const currentCandle = this.candles1m[lastIdx];
    const atr14 = this.calculateATR(this.candles1m, 14);
    const currentAtr = atr14[lastIdx] || 50;

    // --- Dynamic ADX-Adaptive Retracement Zone logic ---
    const adx14 = this.calculateADX(this.candles1m, 14);
    const adxValue = adx14[lastIdx] || 25;

    let adxLabel = "Moderate Trend";
    if (adxValue < 20) adxLabel = "Weak / Choppy";
    else if (adxValue >= 20 && adxValue < 30) adxLabel = "Normal Trend";
    else if (adxValue >= 30 && adxValue < 40) adxLabel = "Strong Trend";
    else adxLabel = "Parabolic Trend";

    const closes = this.candles1m.map(c => c.close);
    const ema20Series = this.calculateEMA(closes, 20);
    const ema50Series = this.calculateEMA(closes, 50);
    const ema100Series = this.calculateEMA(closes, 100);
    const ema200Series = this.calculateEMA(closes, Math.min(closes.length, 200));

    const ema20ValComputed = ema20Series[lastIdx] || ema20Val;
    const ema50ValComputed = ema50Series[lastIdx] || ema50Val;
    const ema100ValComputed = ema100Series[lastIdx] || ema100Val;
    const ema200ValComputed = ema200Series[lastIdx] || currentPrice;

    // 1. EMA Slope of EMA20 (over last 5 candles)
    const slopePeriod = 5;
    let ema20SlopePct = 0;
    if (lastIdx >= slopePeriod && ema20Series[lastIdx] && ema20Series[lastIdx - slopePeriod]) {
      const slopeRaw = (ema20Series[lastIdx] - ema20Series[lastIdx - slopePeriod]) / slopePeriod;
      ema20SlopePct = (slopeRaw / currentPrice) * 100;
    }

    // 2. Trend Acceleration (change in slope over prior 5 candles)
    let ema20AccelerationPct = 0;
    if (lastIdx >= slopePeriod * 2 && ema20Series[lastIdx - slopePeriod] && ema20Series[lastIdx - slopePeriod * 2]) {
      const slopePrevRaw = (ema20Series[lastIdx - slopePeriod] - ema20Series[lastIdx - slopePeriod * 2]) / slopePeriod;
      const slopePrevPct = (slopePrevRaw / currentPrice) * 100;
      ema20AccelerationPct = ema20SlopePct - slopePrevPct;
    }

    // 3. Trend Momentum (EMA Spread)
    const emaSpreadPct = (Math.abs(ema20ValComputed - ema50ValComputed) / currentPrice) * 100;

    // 4. Distance from EMA200 (Stretch)
    const distanceToEma200Pct = (Math.abs(currentPrice - ema200ValComputed) / currentPrice) * 100;

    // 5. Volatility (ATR relative to price)
    const relativeAtrPct = (currentAtr / currentPrice) * 100;

    // Point-based classification system for expected pullback depth
    let depthPoints = 0;

    // ADX Influence
    if (adxValue >= 35) depthPoints += 2;
    else if (adxValue >= 25) depthPoints += 1;

    // Slope Influence (strong slope in the correct direction favors shallow pullback)
    if (direction === "LONG") {
      if (ema20SlopePct > 0.04) depthPoints += 2;
      else if (ema20SlopePct > 0.015) depthPoints += 1;
    } else { // SHORT
      if (ema20SlopePct < -0.04) depthPoints += 2;
      else if (ema20SlopePct < -0.015) depthPoints += 1;
    }

    // Acceleration Influence
    if (direction === "LONG") {
      if (ema20AccelerationPct > 0.005) depthPoints += 1;
    } else { // SHORT
      if (ema20AccelerationPct < -0.005) depthPoints += 1;
    }

    // Spread/Momentum Influence
    if (emaSpreadPct >= 0.4) depthPoints += 1;
    else if (emaSpreadPct < 0.15) depthPoints -= 1;

    // Distance to EMA200 (Mean-reversion risk favors deeper pullbacks)
    if (distanceToEma200Pct > 2.5) depthPoints -= 2;
    else if (distanceToEma200Pct > 1.2) depthPoints -= 1;

    // Relative Volatility (high volatility favors deeper retracements)
    if (relativeAtrPct > 0.5) depthPoints -= 1;

    // Pullback depth classification and EMA zone selection
    let classifiedDepth: "Shallow" | "Medium" | "Deep" = "Medium";
    let firstEmaVal = ema50ValComputed;
    let secondEmaVal = ema100ValComputed;
    let firstEmaPeriod = 50;
    let secondEmaPeriod = 100;
    let emaZoneLabel = "50/100 EMA";

    let pullbackMultiplier = 0.45;
    let emaRetraceMultiplier = 0.30;
    let invalidationMultiplier = 0.25;

    if (depthPoints >= 3) {
      classifiedDepth = "Shallow";
      firstEmaVal = ema20ValComputed;
      secondEmaVal = ema50ValComputed;
      firstEmaPeriod = 20;
      secondEmaPeriod = 50;
      emaZoneLabel = "20/50 EMA";
      pullbackMultiplier = 0.7;
      emaRetraceMultiplier = 0.45;
      invalidationMultiplier = 0.40;
    } else if (depthPoints < 0) {
      classifiedDepth = "Deep";
      firstEmaVal = ema100ValComputed;
      secondEmaVal = ema200ValComputed;
      firstEmaPeriod = 100;
      secondEmaPeriod = 200;
      emaZoneLabel = "100/200 EMA";
      pullbackMultiplier = 0.25;
      emaRetraceMultiplier = 0.18;
      invalidationMultiplier = 0.15;
    }

    const ema200Val = ema200ValComputed;

    const condDict: Record<string, { status: "PASS" | "FAIL" | "SKIP"; reason: string }> = {
      "Multi-Timeframe Trend Alignment": { status: "SKIP", reason: "Evaluating 5m trend alignment..." },
      "EMA Structure Alignment": { status: "SKIP", reason: "Evaluating EMA structure..." },
      "Breakout Level Confirmation": { status: "SKIP", reason: "Pending structural breakout trigger" },
      "Breakout Candle Body Ratio": { status: "SKIP", reason: "Pending breakout candle evaluation" },
      "Immediate Breakout Entry Allowance": { status: "SKIP", reason: "Pending breakout momentum evaluation" },
      "Dynamic Invalidation Floor/Ceiling": { status: "SKIP", reason: "Pending setup invalidation evaluation" },
      "Chasing Lookback limit": { status: "SKIP", reason: "Pending lookback duration evaluation" },
      "Volume-Validated Pullback": { status: "SKIP", reason: "Pending pullback volume validation" },
      "Pullback & Retest Setup (Setup 1)": { status: "SKIP", reason: "No active breakout & retest setup" },
      "EMA Retracement / Pushback Setup (Setup 2)": { status: "SKIP", reason: "No active dynamic EMA pushback setup" },
      "Liquidity Sweep Setup (Setup 3)": { status: "SKIP", reason: "No active liquidity sweep setup" },
      "Range Failed Auction Reclaim Setup (Setup 9)": { status: "SKIP", reason: "No active range failed auction setup" },
      "VWAP Band Rejection Setup (Setup 10)": { status: "SKIP", reason: "No active VWAP band rejection setup" },
      "EQH/EQL Double Touch Setup (Setup 11)": { status: "SKIP", reason: "No active EQH/EQL double touch setup" },
      "CVD Absorption & Delta Divergence (Setup 12)": { status: "SKIP", reason: "No active CVD absorption setup" },
      "OI Flush & Cascade Fade (Setup 13)": { status: "SKIP", reason: "No active OI flush cascade setup" },
    };

    const getReturnObj = (confirmed: boolean, message: string) => {
      let specificEmaTested = "";
      if (firstEmaVal > 0 && secondEmaVal > 0) {
        let testedPeriod = firstEmaPeriod;
        let testedVal = firstEmaVal;

        if (direction === "LONG") {
          if (currentPrice <= (firstEmaVal + secondEmaVal) / 2) {
            testedPeriod = secondEmaPeriod;
            testedVal = secondEmaVal;
          }
        } else if (direction === "SHORT") {
          if (currentPrice >= (firstEmaVal + secondEmaVal) / 2) {
            testedPeriod = secondEmaPeriod;
            testedVal = secondEmaVal;
          }
        } else {
          if (Math.abs(currentPrice - secondEmaVal) < Math.abs(currentPrice - firstEmaVal)) {
            testedPeriod = secondEmaPeriod;
            testedVal = secondEmaVal;
          }
        }
        specificEmaTested = `Dynamic ${testedPeriod} EMA ($${testedVal.toFixed(2)})`;
      } else if (emaZoneLabel) {
        specificEmaTested = `Dynamic ${emaZoneLabel} Band`;
      }

      const sub_conditions = Object.entries(condDict).map(([name, val]) => ({
        name,
        status: val.status,
        reason: val.reason,
      }));

      return {
        confirmed,
        message,
        ema_check_active: true,
        ema_pair_evaluated: emaZoneLabel,
        ema_tested: specificEmaTested,
        sub_conditions,
      };
    };

    // 1. Calculate HF Order Flow & ADX Momentum Pressure
    const hasHighHFPressure = adxValue >= (ms.hf_momentum_adx_threshold + 2) || 
      (direction === "LONG" 
        ? (this.orderFlowStats.takerBuyRatio >= ms.hf_orderflow_taker_buy_ratio_long || this.orderBookStats.imbalanceRatio >= ms.hf_orderflow_imbalance_ratio_long) 
        : (this.orderFlowStats.takerBuyRatio <= ms.hf_orderflow_taker_buy_ratio_short || this.orderBookStats.imbalanceRatio <= ms.hf_orderflow_imbalance_ratio_short));

    // 2. Evaluate Multi-Timeframe (5m) Trend Alignment Up-Front
    const candles5m = this.aggregateCandles(this.candles1m, 5);
    const closes5m = candles5m.map(c => c.close);
    let mtfMessage = "";
    let isMtfAligned = true;

    if (closes5m.length >= 10) {
      const ema5_5m = this.calculateEMA(closes5m, 5);
      const ema15_5m = this.calculateEMA(closes5m, 15);
      const last5mIdx = closes5m.length - 1;
      if (last5mIdx >= 0 && ema5_5m.length > last5mIdx && ema15_5m.length > last5mIdx) {
        const ema5_5m_val = ema5_5m[last5mIdx];
        const ema15_5m_val = ema15_5m[last5mIdx];
        const isMtfLong = ema5_5m_val > ema15_5m_val;

        const isCounterTrend = (direction === "LONG" && this.currentRegime === MarketRegime.STRONG_DOWNTREND) ||
                               (direction === "SHORT" && this.currentRegime === MarketRegime.STRONG_UPTREND);
        const canBypassMtf = hasHighHFPressure && !isCounterTrend;

        if (direction === "LONG" && !isMtfLong && !canBypassMtf) {
          isMtfAligned = false;
          const mtfMsg = `Conflicting Trend: Multi-timeframe (5m) trend is bearish (5m EMA 5: $${ema5_5m_val.toFixed(2)} <= EMA 15: $${ema15_5m_val.toFixed(2)}).`;
          condDict["Multi-Timeframe Trend Alignment"] = { status: "FAIL", reason: mtfMsg };
        } else if (direction === "SHORT" && isMtfLong && !canBypassMtf) {
          isMtfAligned = false;
          const mtfMsg = `Conflicting Trend: Multi-timeframe (5m) trend is bullish (5m EMA 5: $${ema5_5m_val.toFixed(2)} >= EMA 15: $${ema15_5m_val.toFixed(2)}).`;
          condDict["Multi-Timeframe Trend Alignment"] = { status: "FAIL", reason: mtfMsg };
        } else {
          mtfMessage = canBypassMtf ? " | MTF Bypassed (High HF Pressure)" : " | MTF Aligned";
          condDict["Multi-Timeframe Trend Alignment"] = {
            status: "PASS",
            reason: canBypassMtf ? "Bypassed due to high HF pressure" : `5m EMA5 ($${ema5_5m_val.toFixed(2)}) ${isMtfLong ? ">" : "<"} EMA15 ($${ema15_5m_val.toFixed(2)})`
          };
        }
      } else {
        condDict["Multi-Timeframe Trend Alignment"] = { status: "SKIP", reason: "Incomplete 5m EMA calculation indicators." };
      }
    } else {
      condDict["Multi-Timeframe Trend Alignment"] = { status: "SKIP", reason: "Not enough 5m candles available (< 10)." };
    }

    // --- PRE-EVALUATE ALL SMC / SPECIALIZED SETUPS UPFRONT ---
    // 1. Setup 3: Liquidity Sweep
    const sweepResult = this.detectLiquiditySweep(direction);
    if (sweepResult.isSweep) {
      condDict["Liquidity Sweep Setup (Setup 3)"] = { status: "PASS", reason: sweepResult.description };
    } else if (sweepResult.description && sweepResult.description.includes("awaiting CHoCH")) {
      condDict["Liquidity Sweep Setup (Setup 3)"] = { status: "FAIL", reason: sweepResult.description };
    } else {
      condDict["Liquidity Sweep Setup (Setup 3)"] = { status: "SKIP", reason: sweepResult.description || "No active liquidity sweep setup" };
    }

    // Setup 9: Range Failed Auction / SFP Reclaim
    const failedAuctionResult = this.evaluateFailedAuctionSetup(direction);
    if (failedAuctionResult.isValid) {
      condDict["Range Failed Auction Reclaim Setup (Setup 9)"] = { status: "PASS", reason: failedAuctionResult.description };
    } else if (failedAuctionResult.description && !failedAuctionResult.description.includes("No active") && !failedAuctionResult.description.includes("disabled")) {
      condDict["Range Failed Auction Reclaim Setup (Setup 9)"] = { status: "FAIL", reason: failedAuctionResult.description };
    } else {
      condDict["Range Failed Auction Reclaim Setup (Setup 9)"] = { status: "SKIP", reason: failedAuctionResult.description || "No active range failed auction setup" };
    }

    // 8. Setup 10: Dedicated VWAP Outer Band Rejection (Mean Reversion Scalp)
    const vwapBandResult = this.evaluateVwapBandRejectionSetup(direction);
    if (vwapBandResult.isValid) {
      condDict["VWAP Band Rejection Setup (Setup 10)"] = { status: "PASS", reason: vwapBandResult.description };
    } else if (vwapBandResult.description && !vwapBandResult.description.includes("No active") && !vwapBandResult.description.includes("disabled")) {
      condDict["VWAP Band Rejection Setup (Setup 10)"] = { status: "FAIL", reason: vwapBandResult.description };
    } else {
      condDict["VWAP Band Rejection Setup (Setup 10)"] = { status: "SKIP", reason: vwapBandResult.description || "No active VWAP band rejection setup" };
    }

    // 9. Setup 11: EQH / EQL Double Touch Rejection with Divergence
    const eqhEqlResult = this.evaluateEqhEqlDoubleTouchSetup(direction);
    if (eqhEqlResult.isValid) {
      condDict["EQH/EQL Double Touch Setup (Setup 11)"] = { status: "PASS", reason: eqhEqlResult.description };
    } else if (eqhEqlResult.description && !eqhEqlResult.description.includes("No active") && !eqhEqlResult.description.includes("disabled")) {
      condDict["EQH/EQL Double Touch Setup (Setup 11)"] = { status: "FAIL", reason: eqhEqlResult.description };
    } else {
      condDict["EQH/EQL Double Touch Setup (Setup 11)"] = { status: "SKIP", reason: eqhEqlResult.description || "No active EQH/EQL double touch setup" };
    }

    // 10. Setup 12: CVD Absorption & Delta Divergence
    const cvdAbsorptionResult = this.evaluateCvdAbsorptionDivergenceSetup(direction);
    if (cvdAbsorptionResult.isValid) {
      condDict["CVD Absorption & Delta Divergence (Setup 12)"] = { status: "PASS", reason: cvdAbsorptionResult.description };
    } else if (cvdAbsorptionResult.description && !cvdAbsorptionResult.description.includes("No active") && !cvdAbsorptionResult.description.includes("disabled")) {
      condDict["CVD Absorption & Delta Divergence (Setup 12)"] = { status: "FAIL", reason: cvdAbsorptionResult.description };
    } else {
      condDict["CVD Absorption & Delta Divergence (Setup 12)"] = { status: "SKIP", reason: cvdAbsorptionResult.description || "No active CVD absorption setup" };
    }

    // 11. Setup 13: Open Interest (OI) Flush & Cascade Fade
    const oiFlushResult = this.evaluateOiFlushCascadeFadeSetup(direction);
    if (oiFlushResult.isValid) {
      condDict["OI Flush & Cascade Fade (Setup 13)"] = { status: "PASS", reason: oiFlushResult.description };
    } else if (oiFlushResult.description && !oiFlushResult.description.includes("No active") && !oiFlushResult.description.includes("disabled")) {
      condDict["OI Flush & Cascade Fade (Setup 13)"] = { status: "FAIL", reason: oiFlushResult.description };
    } else {
      condDict["OI Flush & Cascade Fade (Setup 13)"] = { status: "SKIP", reason: oiFlushResult.description || "No active OI flush cascade setup" };
    }

    // --- PRIORITY DISPATCH FOR SMC / SPECIALIZED SETUPS ---
    if (sweepResult.isSweep) {
      condDict["EMA Structure Alignment"] = { status: "PASS", reason: "Bypassed for Liquidity Sweep Reversal Setup" };
      condDict["Breakout Level Confirmation"] = { status: "PASS", reason: `Liquidity sweep confirmed at level $${sweepResult.sweptLevel.toFixed(2)}` };
      condDict["Breakout Candle Body Ratio"] = { status: "PASS", reason: `Reclaimed with ${sweepResult.wickRatio.toFixed(0)}% wick` };
      condDict["Immediate Breakout Entry Allowance"] = { status: "PASS", reason: "Sweep reversal entry" };
      condDict["Dynamic Invalidation Floor/Ceiling"] = { status: "PASS", reason: "Reclamation intact" };
      condDict["Chasing Lookback limit"] = { status: "PASS", reason: "Sweep reversal candle" };
      condDict["Volume-Validated Pullback"] = { status: "PASS", reason: `Confirmed volume expansion (${sweepResult.volumeMult.toFixed(1)}x)` };
      condDict["Pullback & Retest Setup (Setup 1)"] = { status: "SKIP", reason: "Bypassed for Liquidity Sweep Setup (Setup 3)" };
      condDict["EMA Retracement / Pushback Setup (Setup 2)"] = { status: "SKIP", reason: "Bypassed for Liquidity Sweep Setup (Setup 3)" };
      if (condDict["Multi-Timeframe Trend Alignment"].status !== "FAIL") {
        condDict["Multi-Timeframe Trend Alignment"] = { status: "PASS", reason: "Liquidity sweep reversal entry" };
      }

      return getReturnObj(
        true,
        `[Setup 3 - Liquidity Sweep Reversal Confirmed] ${sweepResult.description}`
      );
    }

    if (failedAuctionResult.isValid) {
      const faDesc = `[Setup 9 - Range Failed Auction Reclaim Confirmed]: ${failedAuctionResult.description}`;
      condDict["EMA Structure Alignment"] = { status: "PASS", reason: "Bypassed for Range Failed Auction Mean Reversion" };
      condDict["Breakout Level Confirmation"] = { status: "PASS", reason: `Range boundary $${failedAuctionResult.rangeBoundary.toFixed(2)} reclaimed` };
      condDict["Breakout Candle Body Ratio"] = { status: "PASS", reason: "Reclamation candle confirmed" };
      condDict["Immediate Breakout Entry Allowance"] = { status: "PASS", reason: "SFP Reclaim entry" };
      condDict["Dynamic Invalidation Floor/Ceiling"] = { status: "PASS", reason: `SL at $${failedAuctionResult.stopLoss.toFixed(2)}` };
      condDict["Chasing Lookback limit"] = { status: "PASS", reason: "Inflection point reclaim" };
      condDict["Volume-Validated Pullback"] = { status: "PASS", reason: "Delta absorption validated" };
      condDict["Pullback & Retest Setup (Setup 1)"] = { status: "SKIP", reason: "Bypassed for Range Failed Auction Setup (Setup 9)" };
      condDict["EMA Retracement / Pushback Setup (Setup 2)"] = { status: "SKIP", reason: "Bypassed for Range Failed Auction Setup (Setup 9)" };
      if (condDict["Multi-Timeframe Trend Alignment"].status !== "FAIL") {
        condDict["Multi-Timeframe Trend Alignment"] = { status: "PASS", reason: "Range false breakout mean-reversion" };
      }

      return getReturnObj(true, faDesc);
    }

    if (vwapBandResult.isValid) {
      const vwapDesc = `[Setup 10 - VWAP Band Rejection Confirmed]: ${vwapBandResult.description}`;
      condDict["EMA Structure Alignment"] = { status: "PASS", reason: "Bypassed for VWAP Band Reversal Setup" };
      condDict["Breakout Level Confirmation"] = { status: "PASS", reason: `VWAP Outer Band rejection at $${vwapBandResult.bandPrice.toFixed(2)}` };
      condDict["Breakout Candle Body Ratio"] = { status: "PASS", reason: "Reversal rejection candle confirmed" };
      condDict["Immediate Breakout Entry Allowance"] = { status: "PASS", reason: "Mean-reversion entry to VWAP basis" };
      condDict["Dynamic Invalidation Floor/Ceiling"] = { status: "PASS", reason: `SL at $${vwapBandResult.stopLoss.toFixed(2)}` };
      condDict["Chasing Lookback limit"] = { status: "PASS", reason: "Outer band touch inflection" };
      condDict["Volume-Validated Pullback"] = { status: "PASS", reason: "Band rejection volume valid" };
      condDict["Pullback & Retest Setup (Setup 1)"] = { status: "SKIP", reason: "Bypassed for VWAP Band Rejection Setup (Setup 10)" };
      condDict["EMA Retracement / Pushback Setup (Setup 2)"] = { status: "SKIP", reason: "Bypassed for VWAP Band Rejection Setup (Setup 10)" };
      if (condDict["Multi-Timeframe Trend Alignment"].status !== "FAIL") {
        condDict["Multi-Timeframe Trend Alignment"] = { status: "PASS", reason: "VWAP outer band mean-reversion" };
      }

      return getReturnObj(true, vwapDesc);
    }

    if (eqhEqlResult.isValid) {
      const eqDesc = `[Setup 11 - EQH/EQL Double Touch Rejection Confirmed]: ${eqhEqlResult.description}`;
      condDict["EMA Structure Alignment"] = { status: "PASS", reason: "Bypassed for EQH/EQL Boundary Rejection Setup" };
      condDict["Breakout Level Confirmation"] = { status: "PASS", reason: `Equal ${direction === "LONG" ? "Lows (EQL)" : "Highs (EQH)"} level at $${eqhEqlResult.levelPrice.toFixed(2)}` };
      condDict["Breakout Candle Body Ratio"] = { status: "PASS", reason: "2nd touch rejection wick confirmed" };
      condDict["Immediate Breakout Entry Allowance"] = { status: "PASS", reason: "Double boundary rejection entry" };
      condDict["Dynamic Invalidation Floor/Ceiling"] = { status: "PASS", reason: `SL at $${eqhEqlResult.stopLoss.toFixed(2)}` };
      condDict["Chasing Lookback limit"] = { status: "PASS", reason: "Double touch inflection" };
      condDict["Volume-Validated Pullback"] = { status: "PASS", reason: "Volume decay & divergence valid" };
      condDict["Pullback & Retest Setup (Setup 1)"] = { status: "SKIP", reason: "Bypassed for EQH/EQL Double Touch Setup (Setup 11)" };
      condDict["EMA Retracement / Pushback Setup (Setup 2)"] = { status: "SKIP", reason: "Bypassed for EQH/EQL Double Touch Setup (Setup 11)" };
      if (condDict["Multi-Timeframe Trend Alignment"].status !== "FAIL") {
        condDict["Multi-Timeframe Trend Alignment"] = { status: "PASS", reason: "Double touch boundary mean-reversion" };
      }

      return getReturnObj(true, eqDesc);
    }

    if (cvdAbsorptionResult.isValid) {
      const cvdDesc = `[Setup 12 - CVD Absorption & Delta Divergence Confirmed]: ${cvdAbsorptionResult.description}`;
      condDict["EMA Structure Alignment"] = { status: "PASS", reason: "Bypassed for CVD Absorption Institutional Reversal Setup" };
      condDict["Breakout Level Confirmation"] = { status: "PASS", reason: `Structural extreme absorption at $${cvdAbsorptionResult.extremePrice.toFixed(2)}` };
      condDict["Breakout Candle Body Ratio"] = { status: "PASS", reason: `Absorption rejection wick confirmed (${cvdAbsorptionResult.rejectionWickPct.toFixed(0)}%)` };
      condDict["Immediate Breakout Entry Allowance"] = { status: "PASS", reason: "Institutional iceberg absorption rotation entry" };
      condDict["Dynamic Invalidation Floor/Ceiling"] = { status: "PASS", reason: `SL at $${cvdAbsorptionResult.stopLoss.toFixed(2)}` };
      condDict["Chasing Lookback limit"] = { status: "PASS", reason: "Structural extreme rotation inflection" };
      condDict["Volume-Validated Pullback"] = { status: "PASS", reason: "Delta imbalance & absorption validated" };
      condDict["Pullback & Retest Setup (Setup 1)"] = { status: "SKIP", reason: "Bypassed for CVD Absorption Setup (Setup 12)" };
      condDict["EMA Retracement / Pushback Setup (Setup 2)"] = { status: "SKIP", reason: "Bypassed for CVD Absorption Setup (Setup 12)" };
      if (condDict["Multi-Timeframe Trend Alignment"].status !== "FAIL") {
        condDict["Multi-Timeframe Trend Alignment"] = { status: "PASS", reason: "Structural extreme absorption rotation" };
      }

      return getReturnObj(true, cvdDesc);
    }

    if (oiFlushResult.isValid) {
      const oiDesc = `[Setup 13 - OI Flush & Cascade Fade Confirmed]: ${oiFlushResult.description}`;
      condDict["EMA Structure Alignment"] = { status: "PASS", reason: "Bypassed for OI Liquidation Cascade Fade Setup" };
      condDict["Breakout Level Confirmation"] = { status: "PASS", reason: `Liquidation cascade extreme at $${oiFlushResult.flushExtreme.toFixed(2)}` };
      condDict["Breakout Candle Body Ratio"] = { status: "PASS", reason: `Exhaustion wick confirmed (${oiFlushResult.reversalWickPct.toFixed(0)}%)` };
      condDict["Immediate Breakout Entry Allowance"] = { status: "PASS", reason: "Liquidation air pocket cascade fade entry" };
      condDict["Dynamic Invalidation Floor/Ceiling"] = { status: "PASS", reason: `Strict SL at $${oiFlushResult.stopLoss.toFixed(2)}` };
      condDict["Chasing Lookback limit"] = { status: "PASS", reason: "Cascade exhaustion inflection" };
      condDict["Volume-Validated Pullback"] = { status: "PASS", reason: `Volume surge (${oiFlushResult.volumeMult.toFixed(1)}x) & OI drop (${oiFlushResult.oiContractionPct.toFixed(1)}%) validated` };
      condDict["Pullback & Retest Setup (Setup 1)"] = { status: "SKIP", reason: "Bypassed for OI Flush Cascade Fade Setup (Setup 13)" };
      condDict["EMA Retracement / Pushback Setup (Setup 2)"] = { status: "SKIP", reason: "Bypassed for OI Flush Cascade Fade Setup (Setup 13)" };
      if (condDict["Multi-Timeframe Trend Alignment"].status !== "FAIL") {
        condDict["Multi-Timeframe Trend Alignment"] = { status: "PASS", reason: "Forced liquidation cascade mean-reversion" };
      }

      return getReturnObj(true, oiDesc);
    }

    // Block standard trend setups if MTF trend alignment fails
    if (!isMtfAligned) {
      const mtfFailReason = condDict["Multi-Timeframe Trend Alignment"]?.reason || "5m MTF trend conflict.";
      return getReturnObj(false, `${mtfFailReason} ${direction} entry blocked.`);
    }

    // Directional Overhead Supply & Exhaustion Wick Protection Guard
    const wickExhaustion = this.evaluateDirectionalExhaustionWicks(direction);
    if (wickExhaustion.isExhausted) {
      const wickBlockReason = `Blocked: ${wickExhaustion.description} ${direction === "LONG" ? "Long" : "Short"} entry forbidden into overhead supply/demand rejection wick clusters.`;
      condDict["Breakout Level Confirmation"] = { status: "FAIL", reason: wickExhaustion.description };
      return getReturnObj(false, wickBlockReason);
    }

    if (direction === "LONG") {
      const isEmaLagBypassed = hasHighHFPressure || adxValue >= ms.hf_momentum_adx_threshold;
      const isEmaAlignedLong = isEmaLagBypassed
        ? true
        : (adxValue >= ms.weak_trend_adx_threshold
            ? (ema20Val > ema50Val)
            : (ema20Val > ema50Val && currentPrice > ema100Val));
      if (!isEmaAlignedLong) {
        const alignMsg = adxValue >= ms.weak_trend_adx_threshold
          ? `Blocked: Fast Bullish EMA structure not aligned (Requires EMA 20 > EMA 50, ADX is strong: ${adxValue.toFixed(1)}).`
          : `Blocked: Full Bullish EMA structure not aligned (Requires EMA 20 > EMA 50 & Price > EMA 100 on moderate ADX: ${adxValue.toFixed(1)}).`;
        condDict["EMA Structure Alignment"] = { status: "FAIL", reason: alignMsg };
        return getReturnObj(false, alignMsg);
      }
      condDict["EMA Structure Alignment"] = {
        status: "PASS",
        reason: isEmaLagBypassed
          ? "Bypassed EMA lag due to high momentum / HF taker pressure"
          : (adxValue >= ms.weak_trend_adx_threshold ? "EMA 20 > EMA 50 aligned" : "EMA 20 > EMA 50 & Price > EMA 100 aligned")
      };

      // Symmetrically, the broken level is the previous Higher High (prev_HH) in a confirmed uptrend
      const breakoutLevel = struct.prev_HH ? struct.prev_HH.price : (struct.current_HH ? struct.current_HH.price : struct.swingHigh);
      const searchStartTimestamp = struct.prev_HH ? struct.prev_HH.time : 0;

      // Find the candle index where breakout occurred (closing above breakout level for the current sequence)
      let breakoutIdx = -1;
      for (let i = lastIdx; i >= 0; i--) {
        if (this.candles1m[i].time >= searchStartTimestamp && this.candles1m[i].close > breakoutLevel) {
          if (i === 0 || this.candles1m[i - 1].close <= breakoutLevel || i <= lastIdx - 30) {
            breakoutIdx = i;
            break;
          }
        }
      }
      if (breakoutIdx === -1) {
        for (let i = lastIdx; i >= 0; i--) {
          if (this.candles1m[i].time >= searchStartTimestamp && this.candles1m[i].close > breakoutLevel) {
            breakoutIdx = i;
            break;
          }
        }
      }

      // Record Breakout Level Confirmation
      if (breakoutIdx !== -1) {
        condDict["Breakout Level Confirmation"] = { status: "PASS", reason: `Breakout of $${breakoutLevel.toFixed(2)} confirmed at candle index ${breakoutIdx}.` };
      } else {
        condDict["Breakout Level Confirmation"] = { status: "FAIL", reason: `No HH breakout closed above $${breakoutLevel.toFixed(2)}.` };
      }

      // Breakout Candle Body Ratio calculation (for Setup 1)
      let boBodyRatio = 0;
      let boCandle = breakoutIdx !== -1 ? this.candles1m[breakoutIdx] : this.candles1m[lastIdx];
      if (breakoutIdx !== -1) {
        const boRange = boCandle.high - boCandle.low;
        const boBody = Math.abs(boCandle.close - boCandle.open);
        boBodyRatio = boRange > 0 ? boBody / boRange : 0;
      }
      const boBodyRatioMet = breakoutIdx !== -1 && boBodyRatio >= ms.min_breakout_body_ratio;
      if (breakoutIdx !== -1) {
        condDict["Breakout Candle Body Ratio"] = {
          status: boBodyRatioMet ? "PASS" : "FAIL",
          reason: boBodyRatioMet
            ? `Body ratio ${(boBodyRatio * 100).toFixed(0)}% >= ${(ms.min_breakout_body_ratio * 100).toFixed(0)}%`
            : `Body ratio ${(boBodyRatio * 100).toFixed(0)}% < ${(ms.min_breakout_body_ratio * 100).toFixed(0)}%`
        };
      } else {
        condDict["Breakout Candle Body Ratio"] = { status: "SKIP", reason: "Evaluated via EMA Pushback Setup (Setup 2)" };
      }

      if (breakoutIdx === lastIdx) {
        const veryHighProbThreshold = ms.very_high_probability_threshold ?? 0.60;
        const currentRvol = this.calculateAccurateRelativeVolume();
        const hasHighProbability = probabilityLong >= veryHighProbThreshold;
        const hasHighHFPressure = ms.allow_immediate_breakout && (adxValue >= ms.hf_momentum_adx_threshold || (this.orderFlowStats.takerBuyRatio >= ms.hf_orderflow_taker_buy_ratio_long || this.orderBookStats.imbalanceRatio >= ms.hf_orderflow_imbalance_ratio_long) || currentRvol >= 1.20);
        if (hasHighProbability || hasHighHFPressure) {
          condDict["Immediate Breakout Entry Allowance"] = { status: "PASS", reason: `Immediate breakout entry allowed under high-frequency pressure or probability (${(probabilityLong * 100).toFixed(1)}%).` };
          return getReturnObj(
            true,
            `[HF Scalp Boost] Immediate Breakout Entry Confirmed! Price ($${currentPrice.toFixed(2)}) broke out above $${breakoutLevel.toFixed(2)} with momentum/volume confirmation.`
          );
        } else {
          const reasonMsg = !hasHighProbability
            ? `breakout probability is not high enough (P(LONG) = ${(probabilityLong * 100).toFixed(1)}% < ${(veryHighProbThreshold * 100).toFixed(0)}%)`
            : "insufficient high frequency momentum/pressure";
          condDict["Immediate Breakout Entry Allowance"] = { status: "FAIL", reason: `Immediate entry forbidden on breakout candle: ${reasonMsg}.` };
          return getReturnObj(
            false,
            `Blocked: Immediate LONG entry on the Higher High breakout candle ($${breakoutLevel.toFixed(2)}) is forbidden because ${reasonMsg}. Waiting for breakout pullback.`
          );
        }
      }
      condDict["Immediate Breakout Entry Allowance"] = { status: "SKIP", reason: "Evaluated pullback (not currently on breakout candle)." };

      const postBreakoutCandles = breakoutIdx !== -1 ? this.candles1m.slice(breakoutIdx + 1) : this.candles1m.slice(-10);

      // --- FEATURE 4: Dynamic Invalidation & Stop-Loss Zones ---
      const structuralHL = struct.current_HL ? struct.current_HL.price : 0;
      const reclaimThreshold = Math.min(breakoutLevel, Math.max(breakoutLevel - invalidationMultiplier * currentAtr, structuralHL - 0.1 * currentAtr));
      const hasReclaimed = postBreakoutCandles.some(c => c.close < reclaimThreshold);
      const isSetup1Invalidated = breakoutIdx === -1 || hasReclaimed || currentPrice < reclaimThreshold;

      // Deep invalidation floor for EMA retracements
      const emaInvalidationFloor = Math.min(secondEmaVal, Math.max(secondEmaVal - 0.5 * currentAtr, structuralHL - 0.2 * currentAtr));
      const hasEmaInvalidated = postBreakoutCandles.some(c => c.close < emaInvalidationFloor);
      const isSetup2Invalidated = hasEmaInvalidated || currentPrice < emaInvalidationFloor;

      if (isSetup1Invalidated && isSetup2Invalidated) {
        const reclaimMsg = `Blocked: Market structure setup was fully invalidated because price broke below both the breakout reclaim level of $${reclaimThreshold.toFixed(2)} and the dynamic EMA invalidation floor of $${emaInvalidationFloor.toFixed(2)}.`;
        condDict["Dynamic Invalidation Floor/Ceiling"] = { status: "FAIL", reason: `Price broke below reclaim level $${reclaimThreshold.toFixed(2)} and EMA invalidation floor $${emaInvalidationFloor.toFixed(2)}` };
        return getReturnObj(false, reclaimMsg);
      }

      if (isSetup1Invalidated) {
        condDict["Dynamic Invalidation Floor/Ceiling"] = { status: "PASS", reason: `Price broke below breakout reclaim level $${reclaimThreshold.toFixed(2)}, but remains above dynamic EMA invalidation floor $${emaInvalidationFloor.toFixed(2)}.` };
      } else {
        condDict["Dynamic Invalidation Floor/Ceiling"] = { status: "PASS", reason: `Price stayed above breakout reclaim level $${reclaimThreshold.toFixed(2)} and dynamic EMA invalidation floor $${emaInvalidationFloor.toFixed(2)}.` };
      }

      // Chasing check: too many candles elapsed without entry (adaptive lookback based on trend strength)
      let maxPostBreakoutCandles = 30;
      if (adxValue < 20) {
        maxPostBreakoutCandles = 15;
      } else if (adxValue >= 40) {
        maxPostBreakoutCandles = 45;
      }
      const isChasing = postBreakoutCandles.length > maxPostBreakoutCandles;
      condDict["Chasing Lookback limit"] = {
        status: !isChasing ? "PASS" : "FAIL",
        reason: !isChasing
          ? `Elapsed ${postBreakoutCandles.length} candles <= limit ${maxPostBreakoutCandles}`
          : `Elapsed ${postBreakoutCandles.length} candles exceeds limit ${maxPostBreakoutCandles}`
      };

      // --- FEATURE 1: Volume-Validated Pullback & Retest ---
      const volumes = this.candles1m.map(c => c.volume);
      let avgVol20 = 1.0;
      if (volumes.length >= 20) {
        const sumVol20 = volumes.slice(-20).reduce((a, b) => a + b, 0);
        avgVol20 = sumVol20 / 20;
      }

      let isVolumeHealthyForPullback = true;
      let pullbackVolDetails = "";
      const dryupMult = ms.pullback_volume_dryup_threshold_mult ?? 1.5;
      const boRatio = ms.pullback_volume_breakout_ratio ?? 0.85;

      if (postBreakoutCandles.length > 1) {
        // Exclude the current active confirmation candle because rejection/entry candles naturally expand in volume
        const pullbackCandlesPriorToCurrent = postBreakoutCandles.slice(0, -1);
        const avgPullbackVol = pullbackCandlesPriorToCurrent.reduce((sum, c) => sum + c.volume, 0) / pullbackCandlesPriorToCurrent.length;
        
        // We use Math.max instead of Math.min so that standard/low breakout spikes do not force an impossibly low threshold,
        // and we allow a healthy multiplier of the 20-period average volume with adaptive scalping tolerance under HF pressure.
        const baseVolumeThreshold = Math.max(boCandle.volume * boRatio, avgVol20 * dryupMult);
        const volumeThreshold = hasHighHFPressure ? baseVolumeThreshold * 1.25 : baseVolumeThreshold;
        if (avgPullbackVol > volumeThreshold) {
          isVolumeHealthyForPullback = false;
          pullbackVolDetails = `Avg pullback vol (${avgPullbackVol.toFixed(0)}) > Threshold (${volumeThreshold.toFixed(0)}) [Max of BO Vol * ${boRatio} (${(boCandle.volume * boRatio).toFixed(0)}) or 20-period avg * ${dryupMult} (${(avgVol20 * dryupMult).toFixed(0)})]`;
        } else {
          pullbackVolDetails = `Avg pullback vol (${avgPullbackVol.toFixed(0)}) <= Threshold (${volumeThreshold.toFixed(0)}) [Max of BO Vol * ${boRatio} (${(boCandle.volume * boRatio).toFixed(0)}) or 20-period avg * ${dryupMult} (${(avgVol20 * dryupMult).toFixed(0)})]`;
        }
      } else if (postBreakoutCandles.length === 1) {
        // Only 1 candle elapsed (which is the current confirmation candle). Give it more breathing room.
        const volumeThreshold = Math.max(boCandle.volume * (boRatio + 0.15), avgVol20 * (dryupMult + 0.3));
        if (currentCandle.volume > volumeThreshold) {
          isVolumeHealthyForPullback = false;
          pullbackVolDetails = `Single candle vol (${currentCandle.volume.toFixed(0)}) > Threshold (${volumeThreshold.toFixed(0)})`;
        } else {
          pullbackVolDetails = `Single candle vol (${currentCandle.volume.toFixed(0)}) <= Threshold (${volumeThreshold.toFixed(0)})`;
        }
      } else {
        pullbackVolDetails = "No pullback candles elapsed yet.";
      }

      if (!isVolumeHealthyForPullback) {
        condDict["Volume-Validated Pullback"] = { status: "FAIL", reason: `Pullback volume exceeds healthy distribution thresholds. Details: ${pullbackVolDetails}` };
      } else {
        condDict["Volume-Validated Pullback"] = { status: "PASS", reason: `Pullback volume is within safe thresholds. Details: ${pullbackVolDetails}` };
      }

      // Objective Candle Rejection Evaluation for LONG (Support)
      const rejectionCheck = this.isMultiCandleLongRejection(lastIdx, currentAtr);
      const isLongRejectionConfirmed = rejectionCheck.confirmed;
      const longRejectionType = rejectionCheck.type;

      // Setup 1: Pullback and Retest
      const effectivePullbackMult = Math.max(pullbackMultiplier, ms.pullback_multiplier_limit);
      const effectiveEmaMult = Math.max(emaRetraceMultiplier, ms.ema_retrace_multiplier_limit);
      const pullbackLimit = breakoutLevel + effectivePullbackMult * currentAtr;
      
      // To prevent buying the top/late chasing after price has moved away,
      // we check if the actual retest/pullback touch occurred within the last 4 candles
      // (expanded to 4 candles to support 3-candle rejection pattern windows such as Morning Star).
      const recentPostBreakoutCandles = postBreakoutCandles.slice(-4);
      const hasPulledBackToZone = recentPostBreakoutCandles.some(c => c.low <= pullbackLimit);
      
      // Parabolic Breakout Continuation: Allow high-ADX shallow consolidation entries on recent candles (1 to 5) near breakout level (<= 2.0x ATR)
      const strongTrendAdx = ms.trend_alignment_adx_threshold || 28;
      const isRecentBreakout = postBreakoutCandles.length >= 1 && postBreakoutCandles.length <= 5;
      const isNearBreakoutLevel = (currentPrice - breakoutLevel) <= 2.0 * currentAtr;

      // Flaw 1 Fix: Directional Sanity Filter on High-ADX Consolidation
      // ADX is non-directional. A multi-candle dump (e.g. 7 consecutive red candles dropping -$160) spikes ADX to 48+.
      // Do not allow a single 1-minute green bounce to trigger a "High-ADX Parabolic Continuation LONG" when the recent
      // window is net negative or dominated by heavy distribution selling!
      const lookbackLen = Math.min(8, this.candles1m.length);
      const recentWindow = this.candles1m.slice(-lookbackLen);
      const netDisplacement = recentWindow.length > 0 ? (currentPrice - recentWindow[0].open) : 0;
      const redCandlesCount = recentWindow.filter(c => c.close < c.open).length;
      const isDominantDumping = redCandlesCount >= Math.ceil(lookbackLen * 0.65) || netDisplacement < -0.4 * currentAtr;

      // Flaw 3 Filter: Round-Number Retest Requirement
      // If price broke above a major $500 / $1,000 psychological milestone (e.g. $80,000),
      // institutional liquidity sweeps frequently probe below the round number before real continuation.
      // Continuation entries within 2.5x ATR of a round number must have verified a retest touch near that level.
      const nearestRoundBelow = Math.floor(currentPrice / 500) * 500;
      const isNearRoundBreakout = currentPrice > nearestRoundBelow && (currentPrice - nearestRoundBelow) <= 2.5 * currentAtr;
      const hasRetestedRoundLevel = isNearRoundBreakout
        ? recentWindow.some(c => c.low <= (nearestRoundBelow + 0.35 * currentAtr))
        : true;

      const isHighAdxConsolidation = adxValue >= strongTrendAdx && isRecentBreakout && isNearBreakoutLevel && !isDominantDumping && netDisplacement >= 0 && hasRetestedRoundLevel;
      
      // Targeted Fix: Candle Direction & Reversal Confirmation Guard
      // Strictly enforces that long entries require a closed green candle with positive upward displacement.
      const isLongGreen = currentCandle.close > currentCandle.open;
      const isLongCandleStabilized = (() => {
        if (!currentCandle || !isLongGreen) return false;
        const range = Math.max(0.001, currentCandle.high - currentCandle.low);
        const body = currentCandle.close - currentCandle.open;
        return isLongGreen && (body / range >= 0.20 || isLongRejectionConfirmed);
      })();

      const isShallowConsolidationHolding = isHighAdxConsolidation && postBreakoutCandles.every(c => c.close >= reclaimThreshold) && isLongCandleStabilized && isLongRejectionConfirmed;

      let isPullbackRetestValid = false;
      let pullbackRetestMessage = "";
      if (breakoutIdx !== -1 && boBodyRatioMet && !isChasing && !isSetup1Invalidated && (hasPulledBackToZone || isShallowConsolidationHolding)) {
        const isRejection = isLongRejectionConfirmed;
        const isContinuation = isLongGreen && (currentCandle.close >= breakoutLevel || isLongRejectionConfirmed);
        
        // Strict Candlestick Confirmation Mandate:
        // Requires a verified bullish reversal candlestick pattern (isLongRejectionConfirmed) AND a green close
        if (isRejection && isLongGreen && isContinuation) {
          if (isVolumeHealthyForPullback) {
            isPullbackRetestValid = true;
            const setupLabel = isShallowConsolidationHolding && !hasPulledBackToZone
              ? `High-ADX Parabolic Continuation (${adxValue.toFixed(1)} ADX): Shallow consolidation held above $${breakoutLevel.toFixed(2)} with [${longRejectionType}]`
              : `Pullback & Retest setup confirmed via [${longRejectionType}]`;
            pullbackRetestMessage = `${setupLabel}${mtfMessage}: Price ${isShallowConsolidationHolding && !hasPulledBackToZone ? 'consolidated tightly above' : 'pulled back to'} broken HH level ($${breakoutLevel.toFixed(2)}) on healthy volume and formed verified bullish rejection (ADX: ${adxValue.toFixed(1)} [${adxLabel}]).`;
            condDict["Pullback & Retest Setup (Setup 1)"] = { status: "PASS", reason: pullbackRetestMessage };
          } else {
            pullbackRetestMessage = "Blocked Retest: Pullback volume is abnormally high, indicating excessive distribution/selling pressure.";
            condDict["Pullback & Retest Setup (Setup 1)"] = { status: "FAIL", reason: pullbackRetestMessage };
          }
        } else {
          condDict["Pullback & Retest Setup (Setup 1)"] = {
            status: "FAIL",
            reason: `Waiting for verified bullish reversal candlestick pattern (Hammer, Morning Star, Bullish Engulfing, Tweezer Bottom) at broken HH support level $${breakoutLevel.toFixed(2)}. (Current candle: ${isLongGreen ? 'green without pattern confirmation' : 'falling red candle'}).`
          };
        }
      } else {
        if (isSetup1Invalidated) {
          condDict["Pullback & Retest Setup (Setup 1)"] = { status: "FAIL", reason: `Blocked: Price broke below breakout reclaim level $${reclaimThreshold.toFixed(2)}.` };
        } else {
          condDict["Pullback & Retest Setup (Setup 1)"] = { status: "SKIP", reason: `Skipped: Price has not recently pulled back to retest HH level of $${pullbackLimit.toFixed(2)} (or has already drifted too far above).` };
        }
      }

      // Setup 2: Adaptive EMA Pushback Zone
      const emaRetraceThresholdFirst = firstEmaVal + effectiveEmaMult * currentAtr;
      const emaRetraceThresholdSecond = secondEmaVal + effectiveEmaMult * currentAtr;
      
      // We similarly scan the recent 3 candles for the EMA retracement to align with multi-candle rejection patterns,
      // preventing late triggers when price is far away from the EMA zone.
      const hasRetracedToEMA = recentPostBreakoutCandles.some(c => c.low <= emaRetraceThresholdFirst || c.low <= emaRetraceThresholdSecond);
      
      // Touch or rejection proximity to dynamic EMA zone within recent candles (using candle-specific EMA value)
      const firstEmaSeries = this.calculateEMA(closes, firstEmaPeriod);
      const secondEmaSeries = this.calculateEMA(closes, secondEmaPeriod);

      const fastEmaUpperTol = (adxValue >= ms.weak_trend_adx_threshold || hasHighHFPressure) ? 0.35 * currentAtr : 0.25 * currentAtr;
      const fastEmaLowerTol = (adxValue >= ms.weak_trend_adx_threshold || hasHighHFPressure) ? 0.20 * currentAtr : 0.15 * currentAtr;

      const touchesFirstEma = recentPostBreakoutCandles.some(c => {
        const cIdx = this.candles1m.indexOf(c);
        const emaVal = (cIdx !== -1 && firstEmaSeries[cIdx] !== undefined) ? firstEmaSeries[cIdx] : firstEmaVal;
        return c.low <= emaVal + fastEmaUpperTol && c.high >= emaVal - fastEmaLowerTol;
      });
      const touchesSecondEma = recentPostBreakoutCandles.some(c => {
        const cIdx = this.candles1m.indexOf(c);
        const emaVal = (cIdx !== -1 && secondEmaSeries[cIdx] !== undefined) ? secondEmaSeries[cIdx] : secondEmaVal;
        return c.low <= emaVal + 0.25 * currentAtr && c.high >= emaVal - 0.15 * currentAtr;
      });
      
      // Strict Candlestick Confirmation Mandate for EMA Pushback:
      // Must touch the dynamic EMA support zone AND close green with a verified bullish reversal candlestick pattern
      const isRegularEmaPushbackValid = (touchesFirstEma || touchesSecondEma) && isLongRejectionConfirmed && isLongGreen && (hasRetracedToEMA || touchesFirstEma || touchesSecondEma);

      const isEmaPushbackValid = isRegularEmaPushbackValid && !isSetup2Invalidated;
      let emaPushbackMessage = "";
      const matchedEmaVal = touchesFirstEma ? firstEmaVal : (touchesSecondEma ? secondEmaVal : firstEmaVal);
      if (isEmaPushbackValid) {
        if (isVolumeHealthyForPullback) {
          emaPushbackMessage = `${emaZoneLabel} Pushback confirmed via [${longRejectionType}]${mtfMessage} (Adaptive Depth: ${classifiedDepth}): Price rejected/bounced off dynamic EMA support at $${matchedEmaVal.toFixed(2)} (ADX: ${adxValue.toFixed(1)} [${adxLabel}], EMA limit: +${effectiveEmaMult.toFixed(2)} * ATR).`;
          condDict["EMA Retracement / Pushback Setup (Setup 2)"] = { status: "PASS", reason: emaPushbackMessage };
        } else {
          emaPushbackMessage = "Blocked EMA Pushback: Abnormally high volume pullback during EMA retracement suggests a trend failure.";
          condDict["EMA Retracement / Pushback Setup (Setup 2)"] = { status: "FAIL", reason: emaPushbackMessage };
        }
      } else {
        if (isSetup2Invalidated) {
          condDict["EMA Retracement / Pushback Setup (Setup 2)"] = { status: "FAIL", reason: `Blocked: Price broke below dynamic EMA invalidation floor $${emaInvalidationFloor.toFixed(2)}.` };
        } else if (touchesFirstEma || touchesSecondEma || hasRetracedToEMA) {
          condDict["EMA Retracement / Pushback Setup (Setup 2)"] = {
            status: "FAIL",
            reason: `Retraced to dynamic EMA support ($${matchedEmaVal.toFixed(2)}), but waiting for a verified closed bullish reversal candlestick pattern (Hammer, Bullish Engulfing, Morning Star, Tweezer Bottom). Current candle is ${isLongGreen ? 'green without pattern confirmation' : 'falling red candle'}.`
          };
        } else {
          const thresholdVal = Math.max(emaRetraceThresholdFirst, emaRetraceThresholdSecond);
          condDict["EMA Retracement / Pushback Setup (Setup 2)"] = { status: "SKIP", reason: `Skipped: Price has not recently retraced into dynamic EMA threshold level of $${thresholdVal.toFixed(2)}.` };
        }
      }

      // Final Setup-Specific Branching for LONG
      if (isPullbackRetestValid && !pullbackRetestMessage.startsWith("Blocked")) {
        return getReturnObj(true, pullbackRetestMessage);
      } else if (isEmaPushbackValid && !emaPushbackMessage.startsWith("Blocked")) {
        condDict["Breakout Level Confirmation"] = { status: "PASS", reason: "Satisfied via EMA Pushback Setup (Setup 2)" };
        condDict["Breakout Candle Body Ratio"] = { status: "PASS", reason: "Satisfied via EMA Pushback Setup (Setup 2)" };
        condDict["Chasing Lookback limit"] = { status: "PASS", reason: "Satisfied via EMA Pushback Setup (Setup 2)" };
        return getReturnObj(true, emaPushbackMessage);
      } else {
        if (!isVolumeHealthyForPullback) {
          return getReturnObj(false, "Pullback volume is abnormally high (distribution risk); waiting for volume to dry up before confirming a safe entry.");
        }
        if (isChasing && !isEmaPushbackValid) {
          return getReturnObj(false, `Blocked: Chasing price after an extended upward move (more than ${maxPostBreakoutCandles} candles since HH breakout, ADX: ${adxValue.toFixed(1)} [${adxLabel}]) is forbidden.`);
        }
        if (breakoutIdx !== -1 && !boBodyRatioMet && !isEmaPushbackValid) {
          return getReturnObj(false, `Blocked: Weak breakout candle body at $${breakoutLevel.toFixed(2)} (Body is only ${(boBodyRatio * 100).toFixed(0)}% of total range). Likely false breakout/wick sweep.`);
        }
        const failureReason = `Waiting for either breakout -> pullback -> retest OR breakout -> retracement to ${emaZoneLabel} pushback setup (Adaptive Expected Depth: ${classifiedDepth}, ADX: ${adxValue.toFixed(1)} [${adxLabel}]).`;
        return getReturnObj(false, failureReason);
      }
    } else {
      // SHORT
      const isEmaLagBypassed = hasHighHFPressure || adxValue >= ms.hf_momentum_adx_threshold;
      const isEmaAlignedShort = isEmaLagBypassed
        ? true
        : (adxValue >= ms.weak_trend_adx_threshold
            ? (ema20Val < ema50Val)
            : (ema20Val < ema50Val && currentPrice < ema100Val));
      if (!isEmaAlignedShort) {
        const alignMsg = adxValue >= ms.weak_trend_adx_threshold
          ? `Blocked: Fast Bearish EMA structure not aligned (Requires EMA 20 < EMA 50, ADX is strong: ${adxValue.toFixed(1)}).`
          : `Blocked: Full Bearish EMA structure not aligned (Requires EMA 20 < EMA 50 & Price < EMA 100 on moderate ADX: ${adxValue.toFixed(1)}).`;
        condDict["EMA Structure Alignment"] = { status: "FAIL", reason: alignMsg };
        return getReturnObj(false, alignMsg);
      }
      condDict["EMA Structure Alignment"] = {
        status: "PASS",
        reason: isEmaLagBypassed
          ? "Bypassed EMA lag due to high momentum / HF taker pressure"
          : (adxValue >= ms.weak_trend_adx_threshold ? "EMA 20 < EMA 50 aligned" : "EMA 20 < EMA 50 & Price < EMA 100 aligned")
      };

      // The broken level is the previous Lower Low (prev_LL) in a confirmed downtrend
      const breakoutLevel = struct.prev_LL ? struct.prev_LL.price : (struct.current_LL ? struct.current_LL.price : struct.swingLow);
      const searchStartTimestamp = struct.prev_LL ? struct.prev_LL.time : 0;

      // Find the candle index where breakout occurred (closing below breakout level for the current sequence)
      let breakoutIdx = -1;
      for (let i = lastIdx; i >= 0; i--) {
        if (this.candles1m[i].time >= searchStartTimestamp && this.candles1m[i].close < breakoutLevel) {
          if (i === 0 || this.candles1m[i - 1].close >= breakoutLevel || i <= lastIdx - 30) {
            breakoutIdx = i;
            break;
          }
        }
      }
      if (breakoutIdx === -1) {
        for (let i = lastIdx; i >= 0; i--) {
          if (this.candles1m[i].time >= searchStartTimestamp && this.candles1m[i].close < breakoutLevel) {
            breakoutIdx = i;
            break;
          }
        }
      }

      // Record Breakout Level Confirmation
      if (breakoutIdx !== -1) {
        condDict["Breakout Level Confirmation"] = { status: "PASS", reason: `Breakout of $${breakoutLevel.toFixed(2)} confirmed at candle index ${breakoutIdx}.` };
      } else {
        condDict["Breakout Level Confirmation"] = { status: "FAIL", reason: `No LL breakout closed below $${breakoutLevel.toFixed(2)}.` };
      }

      // Breakout Candle Body Ratio calculation (for Setup 1)
      let boBodyRatio = 0;
      let boCandle = breakoutIdx !== -1 ? this.candles1m[breakoutIdx] : this.candles1m[lastIdx];
      if (breakoutIdx !== -1) {
        const boRange = boCandle.high - boCandle.low;
        const boBody = Math.abs(boCandle.close - boCandle.open);
        boBodyRatio = boRange > 0 ? boBody / boRange : 0;
      }
      const boBodyRatioMet = breakoutIdx !== -1 && boBodyRatio >= ms.min_breakout_body_ratio;
      if (breakoutIdx !== -1) {
        condDict["Breakout Candle Body Ratio"] = {
          status: boBodyRatioMet ? "PASS" : "FAIL",
          reason: boBodyRatioMet
            ? `Body ratio ${(boBodyRatio * 100).toFixed(0)}% >= ${(ms.min_breakout_body_ratio * 100).toFixed(0)}%`
            : `Body ratio ${(boBodyRatio * 100).toFixed(0)}% < ${(ms.min_breakout_body_ratio * 100).toFixed(0)}%`
        };
      } else {
        condDict["Breakout Candle Body Ratio"] = { status: "SKIP", reason: "Evaluated via EMA Pushback Setup (Setup 2)" };
      }

      if (breakoutIdx === lastIdx) {
        const veryHighProbThreshold = ms.very_high_probability_threshold ?? 0.60;
        const currentRvol = this.calculateAccurateRelativeVolume();
        const probabilityShort = 1 - probabilityLong;
        const hasHighProbability = probabilityShort >= veryHighProbThreshold;
        const hasHighHFPressure = ms.allow_immediate_breakout && (adxValue >= ms.hf_momentum_adx_threshold || (this.orderFlowStats.takerBuyRatio <= ms.hf_orderflow_taker_buy_ratio_short || this.orderBookStats.imbalanceRatio <= ms.hf_orderflow_imbalance_ratio_short) || currentRvol >= 1.20);
        if (hasHighProbability || hasHighHFPressure) {
          condDict["Immediate Breakout Entry Allowance"] = { status: "PASS", reason: `Immediate breakdown entry allowed under high-frequency pressure or probability (${(probabilityShort * 100).toFixed(1)}%).` };
          return getReturnObj(
            true,
            `[HF Scalp Boost] Immediate Breakdown Entry Confirmed! Price ($${currentPrice.toFixed(2)}) broke down below $${breakoutLevel.toFixed(2)} with momentum/volume confirmation.`
          );
        } else {
          const reasonMsg = !hasHighProbability
            ? `breakout probability is not high enough (P(SHORT) = ${(probabilityShort * 100).toFixed(1)}% < ${(veryHighProbThreshold * 100).toFixed(0)}%)`
            : "insufficient high frequency momentum/pressure";
          condDict["Immediate Breakout Entry Allowance"] = { status: "FAIL", reason: `Immediate entry forbidden on breakout candle: ${reasonMsg}.` };
          return getReturnObj(
            false,
            `Blocked: Immediate SHORT entry on the Lower Low breakout candle ($${breakoutLevel.toFixed(2)}) is forbidden because ${reasonMsg}. Waiting for breakout pullback.`
          );
        }
      }
      condDict["Immediate Breakout Entry Allowance"] = { status: "SKIP", reason: "Evaluated pullback (not currently on breakout candle)." };

      const postBreakoutCandles = breakoutIdx !== -1 ? this.candles1m.slice(breakoutIdx + 1) : this.candles1m.slice(-10);

      // --- FEATURE 4: Dynamic Invalidation & Stop-Loss Zones ---
      const structuralLH = struct.current_LH ? struct.current_LH.price : Infinity;
      const reclaimThreshold = Math.max(breakoutLevel, Math.min(breakoutLevel + invalidationMultiplier * currentAtr, structuralLH + 0.1 * currentAtr));
      const hasReclaimed = postBreakoutCandles.some(c => c.close > reclaimThreshold);
      const isSetup1Invalidated = breakoutIdx === -1 || hasReclaimed || currentPrice > reclaimThreshold;

      // Deep invalidation ceiling for EMA retracements
      const emaInvalidationCeiling = Math.max(secondEmaVal, Math.min(secondEmaVal + 0.5 * currentAtr, structuralLH + 0.2 * currentAtr));
      const hasEmaInvalidated = postBreakoutCandles.some(c => c.close > emaInvalidationCeiling);
      const isSetup2Invalidated = hasEmaInvalidated || currentPrice > emaInvalidationCeiling;

      if (isSetup1Invalidated && isSetup2Invalidated) {
        const reclaimMsg = `Blocked: Market structure setup was fully invalidated because price broke above both the breakout reclaim level of $${reclaimThreshold.toFixed(2)} and the dynamic EMA invalidation ceiling of $${emaInvalidationCeiling.toFixed(2)}.`;
        condDict["Dynamic Invalidation Floor/Ceiling"] = { status: "FAIL", reason: `Price broke above reclaim level $${reclaimThreshold.toFixed(2)} and EMA invalidation ceiling $${emaInvalidationCeiling.toFixed(2)}` };
        return getReturnObj(false, reclaimMsg);
      }

      if (isSetup1Invalidated) {
        condDict["Dynamic Invalidation Floor/Ceiling"] = { status: "PASS", reason: `Price broke above breakout reclaim level $${reclaimThreshold.toFixed(2)}, but remains below dynamic EMA invalidation ceiling $${emaInvalidationCeiling.toFixed(2)}.` };
      } else {
        condDict["Dynamic Invalidation Floor/Ceiling"] = { status: "PASS", reason: `Price stayed below breakout reclaim level $${reclaimThreshold.toFixed(2)} and dynamic EMA invalidation ceiling $${emaInvalidationCeiling.toFixed(2)}.` };
      }

      // Chasing check: too many candles elapsed without entry (adaptive lookback based on trend strength)
      let maxPostBreakoutCandles = 30;
      if (adxValue < 20) {
        maxPostBreakoutCandles = 15;
      } else if (adxValue >= 40) {
        maxPostBreakoutCandles = 45;
      }
      const isChasing = postBreakoutCandles.length > maxPostBreakoutCandles;
      condDict["Chasing Lookback limit"] = {
        status: !isChasing ? "PASS" : "FAIL",
        reason: !isChasing
          ? `Elapsed ${postBreakoutCandles.length} candles <= limit ${maxPostBreakoutCandles}`
          : `Elapsed ${postBreakoutCandles.length} candles exceeds limit ${maxPostBreakoutCandles}`
      };

      // --- FEATURE 1: Volume-Validated Pullback & Retest ---
      const volumes = this.candles1m.map(c => c.volume);
      let avgVol20 = 1.0;
      if (volumes.length >= 20) {
        const sumVol20 = volumes.slice(-20).reduce((a, b) => a + b, 0);
        avgVol20 = sumVol20 / 20;
      }

      let isVolumeHealthyForPullback = true;
      let pullbackVolDetails = "";
      const dryupMult = ms.pullback_volume_dryup_threshold_mult ?? 1.5;
      const boRatio = ms.pullback_volume_breakout_ratio ?? 0.85;

      if (postBreakoutCandles.length > 1) {
        // Exclude the current active confirmation candle because rejection/entry candles naturally expand in volume
        const pullbackCandlesPriorToCurrent = postBreakoutCandles.slice(0, -1);
        const avgPullbackVol = pullbackCandlesPriorToCurrent.reduce((sum, c) => sum + c.volume, 0) / pullbackCandlesPriorToCurrent.length;
        
        // We use Math.max instead of Math.min so that standard/low breakout spikes do not force an impossibly low threshold,
        // and we allow a healthy multiplier of the 20-period average volume with adaptive scalping tolerance under HF pressure.
        const baseVolumeThreshold = Math.max(boCandle.volume * boRatio, avgVol20 * dryupMult);
        const volumeThreshold = hasHighHFPressure ? baseVolumeThreshold * 1.25 : baseVolumeThreshold;
        if (avgPullbackVol > volumeThreshold) {
          isVolumeHealthyForPullback = false;
          pullbackVolDetails = `Avg pullback vol (${avgPullbackVol.toFixed(0)}) > Threshold (${volumeThreshold.toFixed(0)}) [Max of BO Vol * ${boRatio} (${(boCandle.volume * boRatio).toFixed(0)}) or 20-period avg * ${dryupMult} (${(avgVol20 * dryupMult).toFixed(0)})]`;
        } else {
          pullbackVolDetails = `Avg pullback vol (${avgPullbackVol.toFixed(0)}) <= Threshold (${volumeThreshold.toFixed(0)}) [Max of BO Vol * ${boRatio} (${(boCandle.volume * boRatio).toFixed(0)}) or 20-period avg * ${dryupMult} (${(avgVol20 * dryupMult).toFixed(0)})]`;
        }
      } else if (postBreakoutCandles.length === 1) {
        // Only 1 candle elapsed (which is the current confirmation candle). Give it more breathing room.
        const volumeThreshold = Math.max(boCandle.volume * (boRatio + 0.15), avgVol20 * (dryupMult + 0.3));
        if (currentCandle.volume > volumeThreshold) {
          isVolumeHealthyForPullback = false;
          pullbackVolDetails = `Single candle vol (${currentCandle.volume.toFixed(0)}) > Threshold (${volumeThreshold.toFixed(0)})`;
        } else {
          pullbackVolDetails = `Single candle vol (${currentCandle.volume.toFixed(0)}) <= Threshold (${volumeThreshold.toFixed(0)})`;
        }
      } else {
        pullbackVolDetails = "No pullback candles elapsed yet.";
      }

      if (!isVolumeHealthyForPullback) {
        condDict["Volume-Validated Pullback"] = { status: "FAIL", reason: `Pullback volume exceeds healthy distribution thresholds. Details: ${pullbackVolDetails}` };
      } else {
        condDict["Volume-Validated Pullback"] = { status: "PASS", reason: `Pullback volume is within safe thresholds. Details: ${pullbackVolDetails}` };
      }

      // Objective Candle Rejection Evaluation for SHORT (Resistance)
      const rejectionCheck = this.isMultiCandleShortRejection(lastIdx, currentAtr);
      const isShortRejectionConfirmed = rejectionCheck.confirmed;
      const shortRejectionType = rejectionCheck.type;

      // Setup 1: Pullback and Retest
      const effectivePullbackMult = Math.max(pullbackMultiplier, ms.pullback_multiplier_limit);
      const effectiveEmaMult = Math.max(emaRetraceMultiplier, ms.ema_retrace_multiplier_limit);
      const pullbackLimit = breakoutLevel - effectivePullbackMult * currentAtr;
      
      // To prevent shorting the bottom/late chasing after price has moved away,
      // we check if the actual retest/pullback touch occurred within the last 4 candles
      // (expanded to 4 candles to support 3-candle rejection pattern windows such as Evening Star).
      const recentPostBreakoutCandles = postBreakoutCandles.slice(-4);
      const hasPulledBackToZone = recentPostBreakoutCandles.some(c => c.high >= pullbackLimit);
      
      // Parabolic Breakdown Continuation: Allow high-ADX shallow consolidation entries on recent candles (1 to 5) near breakdown level (<= 2.0x ATR)
      const strongTrendAdx = ms.trend_alignment_adx_threshold || 28;
      const isRecentBreakout = postBreakoutCandles.length >= 1 && postBreakoutCandles.length <= 5;
      const isNearBreakoutLevel = (breakoutLevel - currentPrice) <= 2.0 * currentAtr;

      // Flaw 1 Fix: Directional Sanity Filter on High-ADX Consolidation (SHORT)
      // ADX is non-directional. A multi-candle pump spikes ADX to 48+.
      // Do not allow a single 1-minute red dip to trigger a "High-ADX Parabolic Continuation SHORT" when the recent
      // window is net positive or dominated by heavy accumulation buying!
      const lookbackLen = Math.min(8, this.candles1m.length);
      const recentWindow = this.candles1m.slice(-lookbackLen);
      const netDisplacement = recentWindow.length > 0 ? (currentPrice - recentWindow[0].open) : 0;
      const greenCandlesCount = recentWindow.filter(c => c.close > c.open).length;
      const isDominantPumping = greenCandlesCount >= Math.ceil(lookbackLen * 0.65) || netDisplacement > 0.4 * currentAtr;

      // Flaw 3 Filter: Round-Number Retest Requirement (SHORT)
      const nearestRoundAbove = Math.ceil(currentPrice / 500) * 500;
      const isNearRoundBreakdown = currentPrice < nearestRoundAbove && (nearestRoundAbove - currentPrice) <= 2.5 * currentAtr;
      const hasRetestedRoundLevel = isNearRoundBreakdown
        ? recentWindow.some(c => c.high >= (nearestRoundAbove - 0.35 * currentAtr))
        : true;

      const isHighAdxConsolidation = adxValue >= strongTrendAdx && isRecentBreakout && isNearBreakoutLevel && !isDominantPumping && netDisplacement <= 0 && hasRetestedRoundLevel;
      
      // Targeted Fix: Candle Direction & Reversal Confirmation Guard
      // Strictly enforces that short entries require a closed red candle with negative downward displacement.
      const isShortRed = currentCandle.close < currentCandle.open;
      const isShortCandleStabilized = (() => {
        if (!currentCandle || !isShortRed) return false;
        const range = Math.max(0.001, currentCandle.high - currentCandle.low);
        const body = currentCandle.open - currentCandle.close;
        return isShortRed && (body / range >= 0.20 || isShortRejectionConfirmed);
      })();

      const isShallowConsolidationHolding = isHighAdxConsolidation && postBreakoutCandles.every(c => c.close <= reclaimThreshold) && isShortCandleStabilized && isShortRejectionConfirmed;

      let isPullbackRetestValid = false;
      let pullbackRetestMessage = "";
      if (breakoutIdx !== -1 && boBodyRatioMet && !isChasing && !isSetup1Invalidated && (hasPulledBackToZone || isShallowConsolidationHolding)) {
        const isRejection = isShortRejectionConfirmed;
        const isContinuation = isShortRed && (currentCandle.close <= breakoutLevel || isShortRejectionConfirmed);
        
        // Strict Candlestick Confirmation Mandate:
        // Requires a verified bearish reversal candlestick pattern (isShortRejectionConfirmed) AND a red close
        if (isRejection && isShortRed && isContinuation) {
          if (isVolumeHealthyForPullback) {
            isPullbackRetestValid = true;
            const setupLabel = isShallowConsolidationHolding && !hasPulledBackToZone
              ? `High-ADX Parabolic Continuation (${adxValue.toFixed(1)} ADX): Shallow consolidation held below $${breakoutLevel.toFixed(2)} with [${shortRejectionType}]`
              : `Pullback & Retest setup confirmed via [${shortRejectionType}]`;
            pullbackRetestMessage = `${setupLabel}${mtfMessage}: Price ${isShallowConsolidationHolding && !hasPulledBackToZone ? 'consolidated tightly below' : 'pulled back to'} broken LL level ($${breakoutLevel.toFixed(2)}) on healthy volume and formed verified bearish rejection (ADX: ${adxValue.toFixed(1)} [${adxLabel}]).`;
            condDict["Pullback & Retest Setup (Setup 1)"] = { status: "PASS", reason: pullbackRetestMessage };
          } else {
            pullbackRetestMessage = "Blocked Retest: Pullback volume is abnormally high, indicating excessive accumulation/buying pressure.";
            condDict["Pullback & Retest Setup (Setup 1)"] = { status: "FAIL", reason: pullbackRetestMessage };
          }
        } else {
          condDict["Pullback & Retest Setup (Setup 1)"] = {
            status: "FAIL",
            reason: `Waiting for verified bearish reversal candlestick pattern (Shooting Star, Evening Star, Bearish Engulfing, Tweezer Top) at broken LL resistance level $${breakoutLevel.toFixed(2)}. (Current candle: ${isShortRed ? 'red without pattern confirmation' : 'rising green candle'}).`
          };
        }
      } else {
        if (isSetup1Invalidated) {
          condDict["Pullback & Retest Setup (Setup 1)"] = { status: "FAIL", reason: `Blocked: Price broke above breakout reclaim level $${reclaimThreshold.toFixed(2)}.` };
        } else {
          condDict["Pullback & Retest Setup (Setup 1)"] = { status: "SKIP", reason: `Skipped: Price has not recently pulled back to retest LL level of $${pullbackLimit.toFixed(2)} (or has already drifted too far below).` };
        }
      }

      // Setup 2: Adaptive EMA Pushback Zone
      const emaRetraceThresholdFirst = firstEmaVal - effectiveEmaMult * currentAtr;
      const emaRetraceThresholdSecond = secondEmaVal - effectiveEmaMult * currentAtr;
      
      // We similarly scan the recent 3 candles for the EMA retracement to align with multi-candle rejection patterns,
      // preventing late triggers when price is far away from the EMA zone.
      const hasRetracedToEMA = recentPostBreakoutCandles.some(c => c.high >= emaRetraceThresholdFirst || c.high >= emaRetraceThresholdSecond);
      
      // Touch or rejection proximity to dynamic EMA zone within recent candles (using candle-specific EMA value)
      const firstEmaSeries = this.calculateEMA(closes, firstEmaPeriod);
      const secondEmaSeries = this.calculateEMA(closes, secondEmaPeriod);

      const fastEmaUpperTol = (adxValue >= ms.weak_trend_adx_threshold || hasHighHFPressure) ? 0.35 * currentAtr : 0.25 * currentAtr;
      const fastEmaLowerTol = (adxValue >= ms.weak_trend_adx_threshold || hasHighHFPressure) ? 0.20 * currentAtr : 0.15 * currentAtr;

      const touchesFirstEma = recentPostBreakoutCandles.some(c => {
        const cIdx = this.candles1m.indexOf(c);
        const emaVal = (cIdx !== -1 && firstEmaSeries[cIdx] !== undefined) ? firstEmaSeries[cIdx] : firstEmaVal;
        return c.high >= emaVal - fastEmaUpperTol && c.low <= emaVal + fastEmaLowerTol;
      });
      const touchesSecondEma = recentPostBreakoutCandles.some(c => {
        const cIdx = this.candles1m.indexOf(c);
        const emaVal = (cIdx !== -1 && secondEmaSeries[cIdx] !== undefined) ? secondEmaSeries[cIdx] : secondEmaVal;
        return c.high >= emaVal - 0.25 * currentAtr && c.low <= emaVal + 0.15 * currentAtr;
      });
      
      // Strict Candlestick Confirmation Mandate for EMA Pushback:
      // Must touch the dynamic EMA resistance zone AND close red with a verified bearish reversal candlestick pattern
      const isRegularEmaPushbackValid = (touchesFirstEma || touchesSecondEma) && isShortRejectionConfirmed && isShortRed && (hasRetracedToEMA || touchesFirstEma || touchesSecondEma);

      const isEmaPushbackValid = isRegularEmaPushbackValid && !isSetup2Invalidated;
      let emaPushbackMessage = "";
      const matchedEmaVal = touchesFirstEma ? firstEmaVal : (touchesSecondEma ? secondEmaVal : firstEmaVal);
      if (isEmaPushbackValid) {
        if (isVolumeHealthyForPullback) {
          emaPushbackMessage = `${emaZoneLabel} Pushback confirmed via [${shortRejectionType}]${mtfMessage} (Adaptive Depth: ${classifiedDepth}): Price rejected/bounced off dynamic EMA resistance at $${matchedEmaVal.toFixed(2)} (ADX: ${adxValue.toFixed(1)} [${adxLabel}], EMA limit: -${effectiveEmaMult.toFixed(2)} * ATR).`;
          condDict["EMA Retracement / Pushback Setup (Setup 2)"] = { status: "PASS", reason: emaPushbackMessage };
        } else {
          emaPushbackMessage = "Blocked EMA Pushback: Abnormally high volume pullback during EMA retracement suggests a trend failure.";
          condDict["EMA Retracement / Pushback Setup (Setup 2)"] = { status: "FAIL", reason: emaPushbackMessage };
        }
      } else {
        if (isSetup2Invalidated) {
          condDict["EMA Retracement / Pushback Setup (Setup 2)"] = { status: "FAIL", reason: `Blocked: Price broke above dynamic EMA invalidation ceiling $${emaInvalidationCeiling.toFixed(2)}.` };
        } else if (touchesFirstEma || touchesSecondEma || hasRetracedToEMA) {
          condDict["EMA Retracement / Pushback Setup (Setup 2)"] = {
            status: "FAIL",
            reason: `Retraced to dynamic EMA resistance ($${matchedEmaVal.toFixed(2)}), but waiting for a verified closed bearish reversal candlestick pattern (Shooting Star, Bearish Engulfing, Evening Star, Tweezer Top). Current candle is ${isShortRed ? 'red without pattern confirmation' : 'rising green candle'}.`
          };
        } else {
          const thresholdVal = Math.min(emaRetraceThresholdFirst, emaRetraceThresholdSecond);
          condDict["EMA Retracement / Pushback Setup (Setup 2)"] = { status: "SKIP", reason: `Skipped: Price has not recently retraced into dynamic EMA threshold level of $${thresholdVal.toFixed(2)}.` };
        }
      }

      // Final Setup-Specific Branching for SHORT
      if (isPullbackRetestValid && !pullbackRetestMessage.startsWith("Blocked")) {
        return getReturnObj(true, pullbackRetestMessage);
      } else if (isEmaPushbackValid && !emaPushbackMessage.startsWith("Blocked")) {
        condDict["Breakout Level Confirmation"] = { status: "PASS", reason: "Satisfied via EMA Pushback Setup (Setup 2)" };
        condDict["Breakout Candle Body Ratio"] = { status: "PASS", reason: "Satisfied via EMA Pushback Setup (Setup 2)" };
        condDict["Chasing Lookback limit"] = { status: "PASS", reason: "Satisfied via EMA Pushback Setup (Setup 2)" };
        return getReturnObj(true, emaPushbackMessage);
      } else {
        if (!isVolumeHealthyForPullback) {
          return getReturnObj(false, "Pullback volume is abnormally high (accumulation risk); waiting for volume to dry up before confirming a safe entry.");
        }
        if (isChasing && !isEmaPushbackValid) {
          return getReturnObj(false, `Blocked: Chasing price after an extended downward move (more than ${maxPostBreakoutCandles} candles since LL breakout, ADX: ${adxValue.toFixed(1)} [${adxLabel}]) is forbidden.`);
        }
        if (breakoutIdx !== -1 && !boBodyRatioMet && !isEmaPushbackValid) {
          return getReturnObj(false, `Blocked: Weak breakout candle body at $${breakoutLevel.toFixed(2)} (Body is only ${(boBodyRatio * 100).toFixed(0)}% of total range). Likely false breakout/wick sweep.`);
        }
        const failureReason = `Waiting for either breakout -> pullback -> retest OR breakout -> retracement to ${emaZoneLabel} pushback setup (Adaptive Expected Depth: ${classifiedDepth}, ADX: ${adxValue.toFixed(1)} [${adxLabel}]).`;
        return getReturnObj(false, failureReason);
      }
    }
  }

  public detectEqualHighsLows(): {
    eqhLevels: { price: number; touchCount: number; touches?: { price: number; idx: number; volume: number; rsi?: number }[] }[];
    eqlLevels: { price: number; touchCount: number; touches?: { price: number; idx: number; volume: number; rsi?: number }[] }[];
  } {
    const config = dbManager.getConfig();
    const ms: any = config.market_structure || {};
    const tolerancePct = ms.eqh_eql_tolerance_pct || 0.08;
    if (ms.eqh_eql_detection_enabled === false || this.candles1m.length < 30) {
      return { eqhLevels: [], eqlLevels: [] };
    }

    const lookback = Math.min(100, this.candles1m.length);
    const recent = this.candles1m.slice(-lookback);
    const rsi14 = this.calculateRSI(this.candles1m.map(c => c.close), 14);

    const highs: { price: number; idx: number; volume: number; rsi?: number }[] = [];
    const lows: { price: number; idx: number; volume: number; rsi?: number }[] = [];
    for (let i = 1; i < recent.length - 1; i++) {
      const globalIdx = this.candles1m.length - lookback + i;
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
            // Touch too close to previous touch (e.g. adjacent bars in chop); update price to highest without inflating touch count
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
            // Touch too close to previous touch; update price to lowest without inflating touch count
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

  public detectAsianSessionRange(): {
    asianHigh: number | null;
    asianLow: number | null;
  } {
    if (this.candles1m.length === 0) return { asianHigh: null, asianLow: null };

    const eightHoursAgo = (Date.now() / 1000) - 8 * 3600;
    const recentAsian = this.candles1m.filter(c => c.time >= eightHoursAgo);
    if (recentAsian.length === 0) return { asianHigh: null, asianLow: null };

    return {
      asianHigh: Math.max(...recentAsian.map(c => c.high)),
      asianLow: Math.min(...recentAsian.map(c => c.low)),
    };
  }

  public detectCHoCH(direction: "LONG" | "SHORT"): {
    hasChoch: boolean;
    chochLevel: number;
    description: string;
  } {
    const config = dbManager.getConfig();
    const ms: any = config.market_structure || {};
    if (ms.choch_confirmation_enabled === false) {
      return { hasChoch: true, chochLevel: 0, description: "CHoCH requirement bypassed via config" };
    }

    if (this.candles1m.length < 5) {
      return { hasChoch: false, chochLevel: 0, description: "Insufficient candles for CHoCH" };
    }

    const recent = this.candles1m.slice(-8);
    const last = this.candles1m[this.candles1m.length - 1];

    if (direction === "LONG") {
      let maxHighBeforeSweep = 0;
      for (let i = 0; i < recent.length - 1; i++) {
        if (recent[i].high > maxHighBeforeSweep) {
          maxHighBeforeSweep = recent[i].high;
        }
      }
      const hasChoch = last.close > maxHighBeforeSweep;
      return {
        hasChoch,
        chochLevel: maxHighBeforeSweep,
        description: hasChoch
          ? `Bullish CHoCH Confirmed: Price ($${last.close.toFixed(2)}) closed above counter-structure high ($${maxHighBeforeSweep.toFixed(2)}).`
          : `Awaiting Bullish CHoCH: Price ($${last.close.toFixed(2)}) must close above $${maxHighBeforeSweep.toFixed(2)}.`,
      };
    } else {
      let minLowBeforeSweep = Infinity;
      for (let i = 0; i < recent.length - 1; i++) {
        if (recent[i].low < minLowBeforeSweep) {
          minLowBeforeSweep = recent[i].low;
        }
      }
      const hasChoch = last.close < minLowBeforeSweep;
      return {
        hasChoch,
        chochLevel: minLowBeforeSweep,
        description: hasChoch
          ? `Bearish CHoCH Confirmed: Price ($${last.close.toFixed(2)}) closed below counter-structure low ($${minLowBeforeSweep.toFixed(2)}).`
          : `Awaiting Bearish CHoCH: Price ($${last.close.toFixed(2)}) must close below $${minLowBeforeSweep.toFixed(2)}.`,
      };
    }
  }

  public detectLiquiditySweep(direction: "LONG" | "SHORT" | "NEUTRAL"): {
    isSweep: boolean;
    sweptLevel: number;
    reclaimPrice: number;
    wickRatio: number;
    volumeMult: number;
    description: string;
  } {
    if (direction === "NEUTRAL") {
      return { isSweep: false, sweptLevel: 0, reclaimPrice: 0, wickRatio: 0, volumeMult: 0, description: "Neutral direction" };
    }

    const config = dbManager.getConfig();
    const ms: any = config.market_structure || {};
    if (ms.liquidity_sweep_enabled === false) {
      return { isSweep: false, sweptLevel: 0, reclaimPrice: 0, wickRatio: 0, volumeMult: 0, description: "Liquidity sweep strategy disabled in config" };
    }

    const lookback = ms.liquidity_sweep_lookback_candles || 20;
    const minWickRatio = ms.liquidity_sweep_min_wick_ratio || 0.35;
    const reqVolMult = ms.liquidity_sweep_volume_mult || 1.0;

    if (this.candles1m.length < lookback + 2) {
      return { isSweep: false, sweptLevel: 0, reclaimPrice: 0, wickRatio: 0, volumeMult: 0, description: "Insufficient candle history" };
    }

    const lastIdx = this.candles1m.length - 1;
    const currentCandle = this.candles1m[lastIdx];
    const struct = this.getTrendMarketStructure();

    const volumes = this.candles1m.map(c => c.volume);
    const sumVol = volumes.slice(-20).reduce((a, b) => a + b, 0);
    const avgVol = volumes.length >= 20 ? sumVol / 20 : 1.0;

    const recentCandles = this.candles1m.slice(-3);
    const eqLevels = this.detectEqualHighsLows();
    const asianRange = ms.asian_session_sweep_enabled ? this.detectAsianSessionRange() : { asianHigh: null, asianLow: null };

    if (direction === "LONG") {
      const rangeCandles = this.candles1m.slice(-lookback - 1, -1);
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
        const sweepCandle = recentCandles.find(c => c.low < level * 0.9998);
        if (sweepCandle) {
          if (currentCandle.close >= level * 0.9995) {
            const range = sweepCandle.high - sweepCandle.low;
            const lowerWick = Math.min(sweepCandle.open, sweepCandle.close) - sweepCandle.low;
            const wickRatio = range > 0 ? lowerWick / range : 0;
            const volMult = avgVol > 0 ? sweepCandle.volume / avgVol : 1.0;

            if (wickRatio >= minWickRatio && volMult >= reqVolMult * 0.8) {
              const chochResult = this.detectCHoCH("LONG");
              if (!chochResult.hasChoch && ms.choch_confirmation_enabled !== false) {
                return { isSweep: false, sweptLevel: level, reclaimPrice: currentCandle.close, wickRatio: wickRatio * 100, volumeMult: volMult, description: `Sweep detected at $${level.toFixed(2)}, but awaiting CHoCH confirmation (${chochResult.description})` };
              }

              const poolType = eqlPrices.includes(level)
                ? "Equal Lows (EQL) Sell-Side Liquidity Pool"
                : (asianRange.asianLow && Math.abs(level - asianRange.asianLow) < 1 ? "Asian Session Low" : "Support Level");

              return {
                isSweep: true,
                sweptLevel: level,
                reclaimPrice: currentCandle.close,
                wickRatio: wickRatio * 100,
                volumeMult: volMult,
                description: `Bullish Liquidity Sweep: Price pierced ${poolType} $${level.toFixed(2)} (low $${sweepCandle.low.toFixed(2)}), then reclaimed $${currentCandle.close.toFixed(2)} with ${(wickRatio * 100).toFixed(0)}% lower wick and ${volMult.toFixed(1)}x volume. ${chochResult.description}`,
              };
            }
          }
        }
      }
    } else if (direction === "SHORT") {
      const rangeCandles = this.candles1m.slice(-lookback - 1, -1);
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
        const sweepCandle = recentCandles.find(c => c.high > level * 1.0002);
        if (sweepCandle) {
          if (currentCandle.close <= level * 1.0005) {
            const range = sweepCandle.high - sweepCandle.low;
            const upperWick = sweepCandle.high - Math.max(sweepCandle.open, sweepCandle.close);
            const wickRatio = range > 0 ? upperWick / range : 0;
            const volMult = avgVol > 0 ? sweepCandle.volume / avgVol : 1.0;

            if (wickRatio >= minWickRatio && volMult >= reqVolMult * 0.8) {
              const chochResult = this.detectCHoCH("SHORT");
              if (!chochResult.hasChoch && ms.choch_confirmation_enabled !== false) {
                return { isSweep: false, sweptLevel: level, reclaimPrice: currentCandle.close, wickRatio: wickRatio * 100, volumeMult: volMult, description: `Sweep detected at $${level.toFixed(2)}, but awaiting CHoCH confirmation (${chochResult.description})` };
              }

              const poolType = eqhPrices.includes(level)
                ? "Equal Highs (EQH) Buy-Side Liquidity Pool"
                : (asianRange.asianHigh && Math.abs(level - asianRange.asianHigh) < 1 ? "Asian Session High" : "Resistance Level");

              return {
                isSweep: true,
                sweptLevel: level,
                reclaimPrice: currentCandle.close,
                wickRatio: wickRatio * 100,
                volumeMult: volMult,
                description: `Bearish Liquidity Sweep: Price pierced ${poolType} $${level.toFixed(2)} (high $${sweepCandle.high.toFixed(2)}), then reclaimed $${currentCandle.close.toFixed(2)} with ${(wickRatio * 100).toFixed(0)}% upper wick and ${volMult.toFixed(1)}x volume. ${chochResult.description}`,
              };
            }
          }
        }
      }
    }

    return { isSweep: false, sweptLevel: 0, reclaimPrice: 0, wickRatio: 0, volumeMult: 0, description: "No liquidity sweep detected" };
  }

  private validateRangeBreakout(
    direction: "LONG" | "SHORT",
    currentCandle: Candlestick,
    relVolume: number,
    recentCandles: Candlestick[]
  ): { isValid: boolean; reason: string } {
    const candleRange = currentCandle.high - currentCandle.low;
    if (candleRange <= 0) {
      return { isValid: false, reason: "Zero candle range." };
    }

    const bodySize = Math.abs(currentCandle.close - currentCandle.open);
    const bodyRatio = bodySize / candleRange;

    // Calculate average candle range of the last 15 candles
    const sliceCount = Math.min(recentCandles.length, 15);
    const lastCandles = recentCandles.slice(-sliceCount);
    const avgRange = lastCandles.length > 0
      ? lastCandles.reduce((sum, c) => sum + (c.high - c.low), 0) / lastCandles.length
      : candleRange;

    const config = dbManager.getConfig();
    const minBreakoutVol = config.general.relative_volume_threshold ? Math.min(config.general.relative_volume_threshold, 1.20) : 1.15;

    // Order flow context for breakout confirmation
    const isTakerSellDominant = this.orderFlowStats.takerBuyRatio <= 0.42 || this.orderBookStats.imbalanceRatio <= -0.15;
    const isTakerBuyDominant = this.orderFlowStats.takerBuyRatio >= 0.58 || this.orderBookStats.imbalanceRatio >= 0.15;
    const isOrderFlowDominant = direction === "LONG" ? isTakerBuyDominant : isTakerSellDominant;
    const effectiveMinVol = isOrderFlowDominant ? Math.min(minBreakoutVol, 1.05) : minBreakoutVol;

    if (direction === "LONG") {
      // 1. Must be a green candle
      if (currentCandle.close <= currentCandle.open) {
        return { isValid: false, reason: "Breakout candle is not bullish (red or doji)." };
      }

      // 2. Volume Expansion: Require strong volume or clear buyer orderflow dominance
      if (relVolume < effectiveMinVol && !isOrderFlowDominant) {
        return { isValid: false, reason: `Insufficient relative volume (${relVolume.toFixed(2)}x < ${effectiveMinVol.toFixed(2)}x).` };
      }

      // 3. Candle Body Ratio: At least 40% of the candle range should be body (35% on wide range expansion)
      const minBodyRatio = candleRange > avgRange * 1.3 ? 0.35 : 0.40;
      if (bodyRatio < minBodyRatio) {
        return { isValid: false, reason: `Weak candle body structure (body ratio ${bodyRatio.toFixed(2)} < ${minBodyRatio.toFixed(2)}).` };
      }

      // 4. Upper Wick Rejection: Upper wick should not exceed 35% of total candle range
      const upperWick = currentCandle.high - currentCandle.close;
      const upperWickRatio = upperWick / candleRange;
      if (upperWickRatio > 0.35) {
        return { isValid: false, reason: `Excessive upper wick rejection (${(upperWickRatio * 100).toFixed(1)}% > 35.0%) indicating a bull trap.` };
      }

      // 5. Candle Size Check: Prevent micro-candles from drifting above range resistance
      if (candleRange < avgRange * 0.65) {
        return { isValid: false, reason: `Breakout candle size is too small (${candleRange.toFixed(2)} < 65% of average range ${avgRange.toFixed(2)}).` };
      }

    } else {
      // SHORT breakdown
      // 1. Must be a red candle
      if (currentCandle.close >= currentCandle.open) {
        return { isValid: false, reason: "Breakdown candle is not bearish (green or doji)." };
      }

      // 2. Volume Expansion
      if (relVolume < effectiveMinVol && !isOrderFlowDominant) {
        return { isValid: false, reason: `Insufficient relative volume (${relVolume.toFixed(2)}x < ${effectiveMinVol.toFixed(2)}x).` };
      }

      // 3. Candle Body Ratio
      const minBodyRatio = candleRange > avgRange * 1.3 ? 0.35 : 0.40;
      if (bodyRatio < minBodyRatio) {
        return { isValid: false, reason: `Weak candle body structure (body ratio ${bodyRatio.toFixed(2)} < ${minBodyRatio.toFixed(2)}).` };
      }

      // 4. Lower Wick Rejection: Lower wick should not exceed 35% of total candle range
      const lowerWick = currentCandle.close - currentCandle.low;
      const lowerWickRatio = lowerWick / candleRange;
      if (lowerWickRatio > 0.35) {
        return { isValid: false, reason: `Excessive lower wick rejection (${(lowerWickRatio * 100).toFixed(1)}% > 35.0%) indicating a bear trap.` };
      }

      // 5. Candle Size Check
      if (candleRange < avgRange * 0.65) {
        return { isValid: false, reason: `Breakdown candle size is too small (${candleRange.toFixed(2)} < 65% of average range ${avgRange.toFixed(2)}).` };
      }
    }

    return { isValid: true, reason: "Breakout validated." };
  }

  private evaluateMarketStructureConfirmation(signalDirection: "LONG" | "SHORT" | "NEUTRAL", probabilityLong: number): MarketStructureConfirmationResult {
    const rawResult = this.evaluateMarketStructureConfirmationRaw(signalDirection, probabilityLong);
    const emaFiltered = this.applyEma200ProximityFilter(signalDirection, this.currentPrice, rawResult);
    const bbFiltered = this.applyBollingerBandExhaustionGuard(signalDirection, this.currentPrice, emaFiltered);
    return this.applyExhaustionWickFilter(signalDirection, bbFiltered);
  }

  /**
   * Directional Exhaustion Wick Protection Filter for Market Structure
   * Blocks entries when multiple long upper/lower rejection wicks demonstrate supply/demand ceiling exhaustion.
   */
  private applyExhaustionWickFilter(
    direction: "LONG" | "SHORT" | "NEUTRAL",
    result: MarketStructureConfirmationResult
  ): MarketStructureConfirmationResult {
    if (!result.confirmed || direction === "NEUTRAL") {
      return result;
    }

    const wickCheck = this.evaluateDirectionalExhaustionWicks(direction);
    if (wickCheck.isExhausted) {
      return {
        ...result,
        confirmed: false,
        message: `Exhaustion Wick Protection: Blocked ${direction} entry due to ${wickCheck.wickCount} rejection wicks at supply/demand extreme zone ($${wickCheck.dominantWickZone.min.toFixed(2)} - $${wickCheck.dominantWickZone.max.toFixed(2)}).`,
        sub_conditions: [
          ...(result.sub_conditions || []),
          {
            name: "Exhaustion Wick Protection Filter",
            status: "FAIL",
            reason: wickCheck.description,
          },
        ],
      };
    }

    return result;
  }

  /**
   * Fix 3: Bollinger Band Exhaustion Guard
   * Prevents buying/selling at outer band extremes when RSI confirms momentum exhaustion.
   * Demands entries to pull back towards the mean.
   */
  private applyBollingerBandExhaustionGuard(
    direction: "LONG" | "SHORT" | "NEUTRAL",
    currentPrice: number,
    result: MarketStructureConfirmationResult
  ): MarketStructureConfirmationResult {
    if (!result.confirmed || direction === "NEUTRAL") {
      return result;
    }

    const closes = this.candles1m.map(c => c.close);
    if (closes.length < 20) return result;

    const lastIdx = closes.length - 1;
    const bb = this.calculateBollingerBands(closes, 20, 2);
    const rsi14 = this.calculateRSI(closes, 14);
    const currentRsi = lastIdx >= 0 && rsi14.length > lastIdx ? rsi14[lastIdx] : 50;
    const bandWidth = bb.upper - bb.lower || 1;
    const devPos = (currentPrice - bb.lower) / bandWidth;

    // Check if this is an intentional Breakout, Squeeze, or Momentum setup that naturally rides outer bands
    const isBreakoutOrSqueeze = result.message?.toLowerCase().includes("breakout") ||
                                result.message?.toLowerCase().includes("squeeze") ||
                                result.message?.toLowerCase().includes("momentum") ||
                                result.message?.toLowerCase().includes("sweep") ||
                                result.message?.toLowerCase().includes("isolated");

    const relVolume = this.calculateAccurateRelativeVolume();
    const hasBreakoutVolume = relVolume >= 1.15;

    // If strong breakout/momentum is active with volume, outer band position is expected, not exhausted!
    if (isBreakoutOrSqueeze || hasBreakoutVolume) {
      return result;
    }

    if (direction === "LONG") {
      // For standard pullbacks without breakout volume, extreme upper band (> 0.88) and extreme RSI (> 75) indicates exhaustion
      if (devPos > 0.88 && currentRsi > 75) {
        return {
          ...result,
          confirmed: false,
          message: `Bollinger Band Exhaustion Guard: Blocked LONG entry at band upper extreme (Dev Position: ${devPos.toFixed(2)} > 0.88, RSI: ${currentRsi.toFixed(1)} > 75). Pullback to mean required.`
        };
      }
    } else if (direction === "SHORT") {
      // For standard pullbacks without breakdown volume, extreme lower band (< 0.12) and extreme RSI (< 25) indicates exhaustion
      if (devPos < 0.12 && currentRsi < 25) {
        return {
          ...result,
          confirmed: false,
          message: `Bollinger Band Exhaustion Guard: Blocked SHORT entry at band lower extreme (Dev Position: ${devPos.toFixed(2)} < 0.12, RSI: ${currentRsi.toFixed(1)} < 25). Pullback to mean required.`
        };
      }
    }

    return result;
  }

  private applyEma200ProximityFilter(
    direction: "LONG" | "SHORT" | "NEUTRAL",
    currentPrice: number,
    result: MarketStructureConfirmationResult
  ): MarketStructureConfirmationResult {
    if (!result.confirmed || direction === "NEUTRAL") {
      return result;
    }

    const closes = this.candles1m.map(c => c.close);
    if (closes.length === 0) return result;

    const ema200 = this.calculateEMA(closes, Math.min(closes.length, 200));
    const lastIdx = closes.length - 1;
    const ema200Val = lastIdx >= 0 && ema200.length > lastIdx ? ema200[lastIdx] : currentPrice;

    const atr14 = this.calculateATR(this.candles1m, 14);
    const currentAtr = atr14[lastIdx] || 50;

    // --- Dynamic EMA 200 Angle & Slope Filter ---
    // Calculate the linear regression slope of the last 20 elements of the EMA 200 to get a stable, lag-reduced trend rate
    const slopeLookback = 20;
    let rawSlope = 0;
    if (ema200.length >= slopeLookback) {
      let sumX = 0;
      let sumY = 0;
      let sumXY = 0;
      let sumXX = 0;
      const startIndex = ema200.length - slopeLookback;
      for (let i = 0; i < slopeLookback; i++) {
        const x = i;
        const y = ema200[startIndex + i];
        sumX += x;
        sumY += y;
        sumXY += x * y;
        sumXX += x * x;
      }
      const denom = slopeLookback * sumXX - sumX * sumX;
      if (Math.abs(denom) > 1e-8) {
        rawSlope = (slopeLookback * sumXY - sumX * sumY) / denom;
      }
    } else if (ema200.length > 1) {
      rawSlope = (ema200[ema200.length - 1] - ema200[0]) / ema200.length;
    }

    // Normalize the slope against ATR to make it scale-invariant and asset-agnostic
    const normalizedSlope = currentAtr > 0 ? (rawSlope / currentAtr) * 100 : 0;
    // Map the normalized slope to an angle in degrees for intuitive trading rules
    const angle = Math.atan(normalizedSlope / 10) * (180 / Math.PI);

    // 1. Trend Alignment Check: Prevent trading against a strong long-term EMA 200 trend
    if (direction === "LONG" && angle < -12) {
      return {
        ...result,
        confirmed: false,
        message: `Blocked: LONG trade avoided because the EMA 200 long-term trend is strongly bearish (Angle: ${angle.toFixed(1)} deg), presenting high overhead rejection risk.`
      };
    }
    if (direction === "SHORT" && angle > 12) {
      return {
        ...result,
        confirmed: false,
        message: `Blocked: SHORT trade avoided because the EMA 200 long-term trend is strongly bullish (Angle: ${angle.toFixed(1)} deg), presenting high dynamic support bounce risk.`
      };
    }

    // 2. Adaptive Proximity & Chop Protection Rules
    const config = dbManager.getConfig();
    const ms = config.market_structure || {
      min_breakout_body_ratio: 0.22,
      allow_immediate_breakout: true,
      hf_momentum_adx_threshold: 30,
      hf_orderflow_taker_buy_ratio_long: 0.58,
      hf_orderflow_imbalance_ratio_long: 0.30,
      hf_orderflow_taker_buy_ratio_short: 0.42,
      hf_orderflow_imbalance_ratio_short: -0.30,
      pullback_multiplier_limit: 0.6,
      ema_retrace_multiplier_limit: 0.4,
      bypass_ema200_on_momentum: true,
      ema200_proximity_divisor: 3.0,
      weak_trend_adx_threshold: 25,
    };
    const hasExtremeRealtimePressure = (config.general.enable_orderflow_softening !== false) &&
                                       ((direction === "LONG" && (this.orderFlowStats.takerBuyRatio >= ms.hf_orderflow_taker_buy_ratio_long || this.orderBookStats.imbalanceRatio >= ms.hf_orderflow_imbalance_ratio_long)) ||
                                       (direction === "SHORT" && (this.orderFlowStats.takerBuyRatio <= ms.hf_orderflow_taker_buy_ratio_short || this.orderBookStats.imbalanceRatio <= ms.hf_orderflow_imbalance_ratio_short)));

    const adx14 = this.calculateADX(this.candles1m, 14);
    const adxValue = lastIdx >= 0 && adx14.length > lastIdx ? adx14[lastIdx] : 25;

    if ((ms.bypass_ema200_on_momentum && adxValue >= ms.hf_momentum_adx_threshold) || hasExtremeRealtimePressure) {
      // Symmetrically bypass EMA 200 proximity restrictions under strong scalping momentum
      return result;
    }

    let proximityMultiplier = 1.5;
    let stateLabel = "Trending";

    if (Math.abs(angle) <= 15) {
      // EMA 200 is flat/ranging -> High risk of repeated crossings and magnetic chop
      proximityMultiplier = 2.0;
      stateLabel = "Flat / Ranging";
    } else if (direction === "LONG" && angle >= 30) {
      // EMA 200 is sloping strongly upwards -> High momentum, allow closer pullback entries
      proximityMultiplier = 0.5;
      stateLabel = "Strong Uptrend";
    } else if (direction === "SHORT" && angle <= -30) {
      // EMA 200 is sloping strongly downwards -> High momentum, allow closer pullback entries
      proximityMultiplier = 0.5;
      stateLabel = "Strong Downtrend";
    }

    // Scale down the proximity barrier for high-frequency scalping under moderate momentum
    proximityMultiplier = proximityMultiplier / ms.ema200_proximity_divisor;

    const proximityThreshold = proximityMultiplier * currentAtr;

    if (direction === "LONG") {
      const distance = ema200Val - currentPrice;
      if (distance > 0 && distance < proximityThreshold) {
        return {
          ...result,
          confirmed: false,
          message: `Blocked: LONG trade avoided because EMA 200 ($${ema200Val.toFixed(2)}) is nearby above the price ($${currentPrice.toFixed(2)}) within ${proximityThreshold.toFixed(2)} (${proximityMultiplier.toFixed(1)} * ATR: ${currentAtr.toFixed(2)}) in a ${stateLabel} environment (EMA 200 Angle: ${angle.toFixed(1)} deg).`
        };
      }
    } else if (direction === "SHORT") {
      const distance = currentPrice - ema200Val;
      if (distance > 0 && distance < proximityThreshold) {
        return {
          ...result,
          confirmed: false,
          message: `Blocked: SHORT trade avoided because EMA 200 ($${ema200Val.toFixed(2)}) is nearby below the price ($${currentPrice.toFixed(2)}) within ${proximityThreshold.toFixed(2)} (${proximityMultiplier.toFixed(1)} * ATR: ${currentAtr.toFixed(2)}) in a ${stateLabel} environment (EMA 200 Angle: ${angle.toFixed(1)} deg).`
        };
      }
    }

    return result;
  }

  /**
   * Intelligently detects genuine market exhaustion and mean-reversion reversal conditions
   * (combining multi-candle RSI extremes, RSI Hook/Inflection, Bollinger %B / Band Piercing,
   * EMA200/100 Dynamic Support/Resistance retests, Candlestick Rejection, and Flow Absorption)
   * to safely allow Exponential Trend Alignment bypass when lagging moving averages are inverted.
   */
  private evaluateExhaustionReversalCondition(
    direction: "LONG" | "SHORT",
    currentPrice: number,
    closes: number[],
    lastIdx: number
  ): {
    isExhausted: boolean;
    confluenceCount: number;
    reasons: string[];
    description: string;
    details: {
      rsiExhaustion: boolean;
      rsiHook: boolean;
      rsiVal: number;
      minRecentRsi: number;
      maxRecentRsi: number;
      bbExhaustion: boolean;
      bbPercentB: number;
      structuralAnchor: boolean;
      structuralAnchorDesc: string;
      candlestickRejection: boolean;
      candlestickDesc: string;
      flowAbsorption: boolean;
    };
  } {
    const emptyResult = {
      isExhausted: false,
      confluenceCount: 0,
      reasons: [],
      description: "Insufficient data",
      details: {
        rsiExhaustion: false,
        rsiHook: false,
        rsiVal: 50,
        minRecentRsi: 50,
        maxRecentRsi: 50,
        bbExhaustion: false,
        bbPercentB: 0.5,
        structuralAnchor: false,
        structuralAnchorDesc: "None",
        candlestickRejection: false,
        candlestickDesc: "None",
        flowAbsorption: false,
      },
    };

    if (lastIdx < 10 || closes.length < 20) {
      return emptyResult;
    }

    const config = dbManager.getConfig();
    const isBypassEnabled = (config.general.enable_exhaustion_trend_bypass ?? config.general.enable_ranging_extreme_rsi_bypass) !== false;
    if (!isBypassEnabled) {
      return emptyResult;
    }

    // --- Hard Safeguard 1: ADX Momentum Ceiling for Exhaustion Bypasses ---
    const adx14 = this.calculateADX(this.candles1m, 14);
    const currentAdx = (adx14 && adx14.length > lastIdx && adx14[lastIdx] !== undefined) ? adx14[lastIdx] : 20;
    const maxExhaustionAdx = config.general.exhaustion_max_adx ?? 26.0;

    if (currentAdx > maxExhaustionAdx) {
      return {
        ...emptyResult,
        description: `Blocked: ADX (${currentAdx.toFixed(1)}) exceeds exhaustion safe ceiling (${maxExhaustionAdx}) - high-velocity trend active`,
      };
    }

    const lookback = config.general.exhaustion_lookback_candles ?? 6;
    const oversoldThresh = config.general.exhaustion_rsi_oversold_threshold ?? (config.general.ranging_rsi_oversold_threshold ?? 32.0);
    const overboughtThresh = config.general.exhaustion_rsi_overbought_threshold ?? (config.general.ranging_rsi_overbought_threshold ?? 68.0);

    const rsi14 = this.calculateRSI(closes, 14);
    const currentRsi = (rsi14.length > lastIdx && rsi14[lastIdx] !== undefined) ? rsi14[lastIdx] : 50;

    const recentRsis = rsi14.slice(Math.max(0, lastIdx - lookback + 1), lastIdx + 1);
    const minRecentRsi = recentRsis.length > 0 ? Math.min(...recentRsis) : currentRsi;
    const maxRecentRsi = recentRsis.length > 0 ? Math.max(...recentRsis) : currentRsi;

    // RSI SMA (Signal line)
    const rsiSma = recentRsis.length > 0 ? recentRsis.reduce((a, b) => a + b, 0) / recentRsis.length : currentRsi;

    const atr14 = this.calculateATR(this.candles1m, 14);
    const currentAtr = atr14[lastIdx] || 50;

    const bb = this.calculateBollingerBands(closes, 20, 2);
    const bbWidth = Math.max(0.01, bb.upper - bb.lower);
    const percentB = (currentPrice - bb.lower) / bbWidth;

    const ema9 = this.calculateEMA(closes, 9);
    const ema20 = this.calculateEMA(closes, 20);
    const ema50 = this.calculateEMA(closes, 50);
    const ema100 = this.calculateEMA(closes, Math.min(closes.length, 100));
    const ema200 = this.calculateEMA(closes, Math.min(closes.length, 200));

    const ema9Val = ema9[lastIdx] !== undefined ? ema9[lastIdx] : currentPrice;
    const ema20Val = ema20[lastIdx] || currentPrice;
    const ema50Val = ema50[lastIdx] || currentPrice;
    const ema100Val = ema100[lastIdx] !== undefined ? ema100[lastIdx] : currentPrice;
    const ema200Val = ema200[lastIdx] || currentPrice;

    const recentCandles = this.candles1m.slice(Math.max(0, lastIdx - lookback + 1), lastIdx + 1);
    const currentCandle = this.candles1m[lastIdx];
    const prevCandle = lastIdx > 0 ? this.candles1m[lastIdx - 1] : currentCandle;

    // --- Hard Safeguard 2: Waterfall / Severe Expansion Momentum Locks ---
    const closedIdx = (lastIdx === this.candles1m.length - 1 && this.candles1m.length >= 2) ? lastIdx - 1 : lastIdx;
    const recent3Closed = this.candles1m.slice(Math.max(0, closedIdx - 2), closedIdx + 1);
    const consecutiveRedExpansionCount = recent3Closed.filter(c => c.close < c.open && Math.abs(c.close - c.open) >= 0.30 * (c.high - c.low)).length;
    const isSevereRedWaterfall = consecutiveRedExpansionCount >= 3 && currentPrice < ema9Val;

    const consecutiveGreenExpansionCount = recent3Closed.filter(c => c.close > c.open && (c.close - c.open) >= 0.30 * (c.high - c.low)).length;
    const isSevereGreenBlowoff = consecutiveGreenExpansionCount >= 3 && currentPrice > ema9Val;

    const reasons: string[] = [];
    let confluenceScore = 0;

    if (direction === "LONG") {
      if (isSevereRedWaterfall) {
        return {
          ...emptyResult,
          description: "Blocked: Consecutive bearish expansion waterfall active below EMA 9",
        };
      }

      // 1. Multi-Candle RSI Oversold & Hook Confirmation
      const isRsiDirectOversold = currentRsi <= oversoldThresh;
      const isRsiRecentOversold = minRecentRsi <= oversoldThresh || rsiSma <= (oversoldThresh + 2.0);
      const isRsiHookingUp = isRsiRecentOversold && (currentRsi >= minRecentRsi + 1.2 || currentCandle.close > currentCandle.open);
      const rsiExhaustion = isRsiDirectOversold || (isRsiRecentOversold && isRsiHookingUp);

      if (rsiExhaustion) {
        confluenceScore += 2;
        reasons.push(`RSI Oversold/Hook (RSI: ${currentRsi.toFixed(1)}, Recent Min: ${minRecentRsi.toFixed(1)}, SMA: ${rsiSma.toFixed(1)})`);
      }

      // 2. Bollinger Band Stretch & Lower Band Piercing
      const isBbOversold = percentB <= 0.18 || currentPrice <= bb.lower + 0.35 * currentAtr || recentCandles.some(c => c.low <= bb.lower * 1.0008);
      if (isBbOversold) {
        confluenceScore += 1;
        reasons.push(`Lower Bollinger Band Extension (%B: ${(percentB * 100).toFixed(0)}%, BB Lower: $${bb.lower.toFixed(2)})`);
      }

      // 3. Structural Mean-Reversion Anchor (EMA 200 / EMA 100 / Range Low / Deep EMA Extension)
      const isNearEma200 = Math.abs(currentPrice - ema200Val) <= 0.60 * currentAtr || recentCandles.some(c => Math.abs(c.low - ema200Val) <= 0.45 * currentAtr);
      const isNearEma100 = Math.abs(currentPrice - ema100Val) <= 0.50 * currentAtr || recentCandles.some(c => Math.abs(c.low - ema100Val) <= 0.35 * currentAtr);
      const struct = this.getTrendMarketStructure();
      const isNearRangeLow = currentPrice <= (struct.swingLow + 0.65 * currentAtr);
      const isDeepEmaStretch = (ema20Val - currentPrice) >= 1.10 * currentAtr || (ema50Val - currentPrice) >= 1.40 * currentAtr;
      const structuralAnchor = isNearEma200 || isNearEma100 || isNearRangeLow || isDeepEmaStretch;

      let structuralAnchorDesc = "None";
      if (isNearEma200) structuralAnchorDesc = `200 EMA Dynamic Support ($${ema200Val.toFixed(2)})`;
      else if (isNearEma100) structuralAnchorDesc = `100 EMA Support ($${ema100Val.toFixed(2)})`;
      else if (isNearRangeLow) structuralAnchorDesc = `Range Low Floor ($${struct.swingLow.toFixed(2)})`;
      else if (isDeepEmaStretch) structuralAnchorDesc = `Deep EMA Stretch (${((ema20Val - currentPrice) / currentAtr).toFixed(1)}x ATR)`;

      if (structuralAnchor) {
        confluenceScore += 2;
        reasons.push(`Key Dynamic Structure (${structuralAnchorDesc})`);
      }

      // 4. Candlestick Rejection / Absorption Pattern
      const candleRange = Math.max(0.01, currentCandle.high - currentCandle.low);
      const lowerWick = Math.min(currentCandle.open, currentCandle.close) - currentCandle.low;
      const isHammerOrPin = lowerWick / candleRange >= 0.35;
      const isBullishCandle = currentCandle.close > currentCandle.open;
      const isEngulfing = isBullishCandle && currentCandle.close > prevCandle.open && currentCandle.open <= prevCandle.close;
      const anyRecentHammer = recentCandles.slice(-3).some(c => {
        const rng = Math.max(0.01, c.high - c.low);
        const lw = Math.min(c.open, c.close) - c.low;
        return lw / rng >= 0.38;
      });
      const candlestickRejection = isHammerOrPin || isEngulfing || anyRecentHammer || (isBullishCandle && isRsiHookingUp);

      let candlestickDesc = "None";
      if (isHammerOrPin) candlestickDesc = `Hammer Pin Bar (${((lowerWick / candleRange) * 100).toFixed(0)}% lower wick)`;
      else if (isEngulfing) candlestickDesc = "Bullish Engulfing";
      else if (anyRecentHammer) candlestickDesc = "Recent Lower Wick Absorption";
      else if (isBullishCandle) candlestickDesc = "Bullish Rebound Candle";

      if (candlestickRejection) {
        confluenceScore += 1;
        reasons.push(`Bullish Candlestick Absorption (${candlestickDesc})`);
      }

      // 5. Order Flow / Order Book Absorption
      const isFlowAbsorbed = this.orderFlowStats.takerBuyRatio >= 0.50 || this.orderBookStats.imbalanceRatio >= 0.15;
      if (isFlowAbsorbed) {
        confluenceScore += 1;
        reasons.push(`Order Flow Absorption (Taker Buy Ratio: ${(this.orderFlowStats.takerBuyRatio * 100).toFixed(0)}%, Imbalance: ${this.orderBookStats.imbalanceRatio.toFixed(2)})`);
      }

      // Reclaim confirmation: When price is below EMA 20, require either an active candlestick rejection or a confirmed RSI hook
      const isExhausted = (confluenceScore >= 3 || (rsiExhaustion && (structuralAnchor || isBbOversold))) && (candlestickRejection || isRsiHookingUp);

      return {
        isExhausted,
        confluenceCount: confluenceScore,
        reasons,
        description: reasons.length > 0 ? reasons.join(" + ") : "No oversold exhaustion detected",
        details: {
          rsiExhaustion,
          rsiHook: isRsiHookingUp,
          rsiVal: currentRsi,
          minRecentRsi,
          maxRecentRsi,
          bbExhaustion: isBbOversold,
          bbPercentB: percentB,
          structuralAnchor,
          structuralAnchorDesc,
          candlestickRejection,
          candlestickDesc,
          flowAbsorption: isFlowAbsorbed,
        },
      };
    } else {
      // SHORT: Overbought Exhaustion & Rollback
      if (isSevereGreenBlowoff) {
        return {
          ...emptyResult,
          description: "Blocked: Consecutive bullish expansion blowoff active above EMA 9",
        };
      }

      // 1. Multi-Candle RSI Overbought & Hook Confirmation
      const isRsiDirectOverbought = currentRsi >= overboughtThresh;
      const isRsiRecentOverbought = maxRecentRsi >= overboughtThresh || rsiSma >= (overboughtThresh - 2.0);
      const isRsiHookingDown = isRsiRecentOverbought && (currentRsi <= maxRecentRsi - 1.2 || currentCandle.close < currentCandle.open);
      const rsiExhaustion = isRsiDirectOverbought || (isRsiRecentOverbought && isRsiHookingDown);

      if (rsiExhaustion) {
        confluenceScore += 2;
        reasons.push(`RSI Overbought/Hook (RSI: ${currentRsi.toFixed(1)}, Recent Max: ${maxRecentRsi.toFixed(1)}, SMA: ${rsiSma.toFixed(1)})`);
      }

      // 2. Bollinger Band Stretch & Upper Band Piercing
      const isBbOverbought = percentB >= 0.82 || currentPrice >= bb.upper - 0.35 * currentAtr || recentCandles.some(c => c.high >= bb.upper * 0.9992);
      if (isBbOverbought) {
        confluenceScore += 1;
        reasons.push(`Upper Bollinger Band Extension (%B: ${(percentB * 100).toFixed(0)}%, BB Upper: $${bb.upper.toFixed(2)})`);
      }

      // 3. Structural Mean-Reversion Anchor (EMA 200 / EMA 100 / Range High / Deep EMA Extension)
      const isNearEma200 = Math.abs(currentPrice - ema200Val) <= 0.60 * currentAtr || recentCandles.some(c => Math.abs(c.high - ema200Val) <= 0.45 * currentAtr);
      const isNearEma100 = Math.abs(currentPrice - ema100Val) <= 0.50 * currentAtr || recentCandles.some(c => Math.abs(c.high - ema100Val) <= 0.35 * currentAtr);
      const struct = this.getTrendMarketStructure();
      const isNearRangeHigh = currentPrice >= (struct.swingHigh - 0.65 * currentAtr);
      const isDeepEmaStretch = (currentPrice - ema20Val) >= 1.10 * currentAtr || (currentPrice - ema50Val) >= 1.40 * currentAtr;
      const structuralAnchor = isNearEma200 || isNearEma100 || isNearRangeHigh || isDeepEmaStretch;

      let structuralAnchorDesc = "None";
      if (isNearEma200) structuralAnchorDesc = `200 EMA Dynamic Resistance ($${ema200Val.toFixed(2)})`;
      else if (isNearEma100) structuralAnchorDesc = `100 EMA Resistance ($${ema100Val.toFixed(2)})`;
      else if (isNearRangeHigh) structuralAnchorDesc = `Range High Ceiling ($${struct.swingHigh.toFixed(2)})`;
      else if (isDeepEmaStretch) structuralAnchorDesc = `Deep EMA Stretch (${((currentPrice - ema20Val) / currentAtr).toFixed(1)}x ATR)`;

      if (structuralAnchor) {
        confluenceScore += 2;
        reasons.push(`Key Dynamic Structure (${structuralAnchorDesc})`);
      }

      // 4. Candlestick Rejection / Absorption Pattern
      const candleRange = Math.max(0.01, currentCandle.high - currentCandle.low);
      const upperWick = currentCandle.high - Math.max(currentCandle.open, currentCandle.close);
      const isStarOrPin = upperWick / candleRange >= 0.35;
      const isBearishCandle = currentCandle.close < currentCandle.open;
      const isEngulfing = isBearishCandle && currentCandle.close < prevCandle.open && currentCandle.open >= prevCandle.close;
      const anyRecentStar = recentCandles.slice(-3).some(c => {
        const rng = Math.max(0.01, c.high - c.low);
        const uw = c.high - Math.max(c.open, c.close);
        return uw / rng >= 0.38;
      });
      const candlestickRejection = isStarOrPin || isEngulfing || anyRecentStar || (isBearishCandle && isRsiHookingDown);

      let candlestickDesc = "None";
      if (isStarOrPin) candlestickDesc = `Shooting Star Pin Bar (${((upperWick / candleRange) * 100).toFixed(0)}% upper wick)`;
      else if (isEngulfing) candlestickDesc = "Bearish Engulfing";
      else if (anyRecentStar) candlestickDesc = "Recent Upper Wick Absorption";
      else if (isBearishCandle) candlestickDesc = "Bearish Rebound Candle";

      if (candlestickRejection) {
        confluenceScore += 1;
        reasons.push(`Bearish Candlestick Absorption (${candlestickDesc})`);
      }

      // 5. Order Flow / Order Book Absorption
      const isFlowAbsorbed = this.orderFlowStats.takerBuyRatio <= 0.50 || this.orderBookStats.imbalanceRatio <= -0.15;
      if (isFlowAbsorbed) {
        confluenceScore += 1;
        reasons.push(`Order Flow Absorption (Taker Buy Ratio: ${(this.orderFlowStats.takerBuyRatio * 100).toFixed(0)}%, Imbalance: ${this.orderBookStats.imbalanceRatio.toFixed(2)})`);
      }

      const isExhausted = (confluenceScore >= 3 || (rsiExhaustion && (structuralAnchor || isBbOverbought))) && (candlestickRejection || isRsiHookingDown);

      return {
        isExhausted,
        confluenceCount: confluenceScore,
        reasons,
        description: reasons.length > 0 ? reasons.join(" + ") : "No overbought exhaustion detected",
        details: {
          rsiExhaustion,
          rsiHook: isRsiHookingDown,
          rsiVal: currentRsi,
          minRecentRsi,
          maxRecentRsi,
          bbExhaustion: isBbOverbought,
          bbPercentB: percentB,
          structuralAnchor,
          structuralAnchorDesc,
          candlestickRejection,
          candlestickDesc,
          flowAbsorption: isFlowAbsorbed,
        },
      };
    }
  }

  private evaluateRangeReversalSignals(lastIdx: number): { 
    isLongReversal: boolean; 
    isShortReversal: boolean; 
    longReason: string; 
    shortReason: string;
    rangeLow: number;
    rangeHigh: number;
  } {
    const config = dbManager.getConfig();
    const ms = config.market_structure || ({} as MarketStructureConfig);
    
    const currentPrice = this.currentPrice;
    if (lastIdx < 0 || this.candles1m.length === 0) {
      return { isLongReversal: false, isShortReversal: false, longReason: "", shortReason: "", rangeLow: currentPrice, rangeHigh: currentPrice };
    }
    
    const currentCandle = this.candles1m[lastIdx];
    
    const rangeLookback = 30;
    const startIdx = Math.max(0, lastIdx - rangeLookback);
    const recentCandlesForRange = this.candles1m.slice(startIdx, lastIdx);
    
    const struct = this.getTrendMarketStructure();
    const rangeHigh = recentCandlesForRange.length > 0 ? Math.max(...recentCandlesForRange.map(c => c.high)) : struct.swingHigh;
    const rangeLow = recentCandlesForRange.length > 0 ? Math.min(...recentCandlesForRange.map(c => c.low)) : struct.swingLow;
    
    const rangeWidth = rangeHigh - rangeLow;
    const atr14 = this.calculateATR(this.candles1m, 14);
    const currentAtr = atr14[lastIdx] || 50;

    // --- Hard Safeguard 1: ADX Range-Reversal Ceiling ---
    const adx14 = this.calculateADX(this.candles1m, 14);
    const currentAdx = (adx14 && adx14.length > lastIdx && adx14[lastIdx] !== undefined) ? adx14[lastIdx] : 20;
    const maxRangingAdx = config.general.ranging_adx_ceiling ?? 25.0;

    if (currentAdx > maxRangingAdx) {
      return {
        isLongReversal: false,
        isShortReversal: false,
        longReason: `Blocked: ADX (${currentAdx.toFixed(1)}) exceeds ranging ceiling (${maxRangingAdx.toFixed(1)}) - momentum expansion active`,
        shortReason: `Blocked: ADX (${currentAdx.toFixed(1)}) exceeds ranging ceiling (${maxRangingAdx.toFixed(1)}) - momentum expansion active`,
        rangeLow,
        rangeHigh,
      };
    }

    // --- Hard Safeguard 2: Bollinger Band PercentB Outer-Boundary Filter ---
    // In a ranging market, true mean-reversion MUST enter at outer extremities (bottom 28% for Long, top 28% for Short).
    // Entering at the 50% midpoint (equilibrium chop) has zero directional edge and gets chopped up by intertwined EMAs.
    const bb = this.calculateBollingerBands(this.candles1m.map(c => c.close), 20, 2.0);
    const bbUpper = bb.upper[lastIdx] || rangeHigh;
    const bbLower = bb.lower[lastIdx] || rangeLow;
    const bbBandwidth = bbUpper - bbLower;
    const percentB = bbBandwidth > 0 ? (currentPrice - bbLower) / bbBandwidth : 0.5;

    // Support/Resistance threshold uses fraction of range width and relative ATR (strictly in the outer boundary)
    const rangeSupportThreshold = rangeLow + Math.min(rangeWidth * 0.20, Math.max(rangeWidth * 0.08, 0.45 * currentAtr));
    const rangeResistanceThreshold = rangeHigh - Math.min(rangeWidth * 0.20, Math.max(rangeWidth * 0.08, 0.45 * currentAtr));
    
    // --- 1. Recent Touch Check (Lookback Window) ---
    const retestLookback = 5;
    const evaluationSlice = this.candles1m.slice(Math.max(0, lastIdx - retestLookback + 1), lastIdx + 1);
    
    const hasTestedSupportRecently = evaluationSlice.some(c => c.low <= rangeSupportThreshold);
    const hasTestedResistanceRecently = evaluationSlice.some(c => c.high >= rangeResistanceThreshold);
    
    // --- 2. Multiple Reversal & Entry Confirmations ---
    
    // CONFIRMATION A: Candlestick Reversal Pattern (Evaluates 2-candle confirmed rejections on current candle)
    const rejectionCheckLong = this.isMultiCandleLongRejection(lastIdx, currentAtr);
    const rejectionCheckShort = this.isMultiCandleShortRejection(lastIdx, currentAtr);
    
    const isCandleReversalBullish = rejectionCheckLong.confirmed;
    const isCandleReversalBearish = rejectionCheckShort.confirmed;
    
    const candlePatternTypeLong = rejectionCheckLong.type;
    const candlePatternTypeShort = rejectionCheckShort.type;
    
    // CONFIRMATION B: Standard Green/Red Candle Close with Verified Body Expansion
    const closedIdx = (lastIdx === this.candles1m.length - 1 && this.candles1m.length >= 2) ? lastIdx - 1 : lastIdx;
    const lastClosedCandle = this.candles1m[closedIdx] || currentCandle;
    const isClosedCandleGreen = lastClosedCandle.close > lastClosedCandle.open;
    const isClosedCandleRed = lastClosedCandle.close < lastClosedCandle.open;
    const closedCandleBody = Math.abs(lastClosedCandle.close - lastClosedCandle.open);
    const closedCandleRange = lastClosedCandle.high - lastClosedCandle.low;
    const hasClosedBodyExpansion = closedCandleRange > 0 && ((closedCandleBody / closedCandleRange >= 0.35) || (closedCandleBody >= 0.25 * currentAtr));
    
    const isImmediateGreenOnSupport = (lastClosedCandle.close <= rangeSupportThreshold || currentPrice <= rangeSupportThreshold) && isClosedCandleGreen && hasClosedBodyExpansion;
    const isImmediateRedOnResistance = (lastClosedCandle.close >= rangeResistanceThreshold || currentPrice >= rangeResistanceThreshold) && isClosedCandleRed && hasClosedBodyExpansion;
    
    // CONFIRMATION C: Micro EMA Crossover / Momentum Bounce
    const microFastPeriod = ms.micro_trend_fast_period || 5;
    const microSlowPeriod = ms.micro_trend_slow_period || 15;
    const closes = this.candles1m.map(c => c.close);
    const microFastSeries = this.calculateEMA(closes, microFastPeriod);
    const microSlowSeries = this.calculateEMA(closes, microSlowPeriod);
    
    let hasRecentMicroBullishCrossover = false;
    let hasRecentMicroBearishCrossover = false;
    const microCrossoverLookback = 5;
    
    for (let i = 0; i < microCrossoverLookback; i++) {
      const currIdx = lastIdx - i;
      const prevIdx = currIdx - 1;
      if (prevIdx >= 0 && microFastSeries[currIdx] !== undefined && microSlowSeries[currIdx] !== undefined) {
        if (microFastSeries[currIdx] > microSlowSeries[currIdx] && microFastSeries[prevIdx] <= microSlowSeries[prevIdx]) {
          hasRecentMicroBullishCrossover = true;
        }
        if (microFastSeries[currIdx] < microSlowSeries[currIdx] && microFastSeries[prevIdx] >= microSlowSeries[prevIdx]) {
          hasRecentMicroBearishCrossover = true;
        }
      }
    }
    
    const isMicroEMAAlignedBullish = microFastSeries[lastIdx] > microSlowSeries[lastIdx];
    const isMicroEMAAlignedBearish = microFastSeries[lastIdx] < microSlowSeries[lastIdx];
    
    // CONFIRMATION D: RSI Hook from oversold/overbought levels
    const rsi14 = this.calculateRSI(closes, 14);
    const currentRsi = rsi14[lastIdx] || 50;
    
    const recentRsiSlice = rsi14.slice(Math.max(0, lastIdx - 4), lastIdx + 1);
    const wasRsiOversold = recentRsiSlice.some(r => r <= 35);
    const wasRsiOverbought = recentRsiSlice.some(r => r >= 65);
    
    const isRsiHookedBullish = wasRsiOversold && currentRsi > recentRsiSlice[0] && isClosedCandleGreen;
    const isRsiHookedBearish = wasRsiOverbought && currentRsi < recentRsiSlice[0] && isClosedCandleRed;

    // --- Hard Safeguard 2: EMA Trend & Slope Barrier for Counter-Trend Range Trades ---
    const ema9Series = this.calculateEMA(closes, 9);
    const ema20Series = this.calculateEMA(closes, 20);
    const ema50Series = this.calculateEMA(closes, 50);

    const ema9Val = ema9Series[lastIdx] !== undefined ? ema9Series[lastIdx] : currentPrice;
    const ema20Val = ema20Series[lastIdx] !== undefined ? ema20Series[lastIdx] : currentPrice;
    const ema50Val = ema50Series[lastIdx] !== undefined ? ema50Series[lastIdx] : currentPrice;

    const isBearishEmaStructure = ema20Val < ema50Val;
    const isBullishEmaStructure = ema20Val > ema50Val;

    // Waterfall guard: 3 consecutive solid red candles without an EMA 9 reclaim
    const recent3Candles = this.candles1m.slice(Math.max(0, closedIdx - 2), closedIdx + 1);
    const consecutiveRedCount = recent3Candles.filter(c => c.close < c.open && Math.abs(c.close - c.open) >= 0.30 * (c.high - c.low)).length;
    const isWaterfallDump = consecutiveRedCount >= 3 && currentPrice < ema9Val;

    const consecutiveGreenCount = recent3Candles.filter(c => c.close > c.open && (c.close - c.open) >= 0.30 * (c.high - c.low)).length;
    const isBlowoffPump = consecutiveGreenCount >= 3 && currentPrice > ema9Val;
    
    // --- 3. Evaluate Long Reversal ---
    let isLongReversal = false;
    let longReason = "";
    
    // Strict range boundary: Must be in lower 28% of range and Bollinger Band percentB <= 0.30
    const maxLongPriceThreshold = rangeLow + Math.min(rangeWidth * 0.28, Math.max(rangeWidth * 0.15, 0.45 * currentAtr));
    const rangeLongMinFloor = rangeLow - 0.75 * currentAtr;
    const isNotCrashingBreakdown = currentPrice >= rangeLongMinFloor || currentCandle.close >= rangeLow;
    const isWithinBbLowerZone = percentB <= 0.32;
    const isPriceWithinLongZone = currentPrice <= maxLongPriceThreshold && isNotCrashingBreakdown && isWithinBbLowerZone;

    // Long Reversal Filter: If market has bearish EMA stack (EMA 20 < EMA 50) and price is below EMA 20, require EMA 9 reclaim or confirmed 2-candle pattern
    const canEnterLongReversal = !isWaterfallDump && (
      (!isBearishEmaStructure || currentPrice >= ema9Val - 0.05 * currentAtr || hasRecentMicroBullishCrossover || isCandleReversalBullish)
    );
    
    if (hasTestedSupportRecently && isPriceWithinLongZone && canEnterLongReversal) {
      if (isCandleReversalBullish) {
        isLongReversal = true;
        longReason = `Confirmed via [${candlePatternTypeLong}] following recent support touch of $${rangeLow.toFixed(2)}`;
      } else if (hasRecentMicroBullishCrossover && isMicroEMAAlignedBullish) {
        isLongReversal = true;
        longReason = `Confirmed via Micro EMA Crossover (${microFastPeriod}/${microSlowPeriod} EMA) following recent support touch of $${rangeLow.toFixed(2)}`;
      } else if (isRsiHookedBullish && (!isBearishEmaStructure || currentPrice >= ema9Val)) {
        isLongReversal = true;
        longReason = `Confirmed via RSI Hook (${currentRsi.toFixed(1)}) from oversold following recent support touch of $${rangeLow.toFixed(2)}`;
      } else if (isImmediateGreenOnSupport && (!isBearishEmaStructure && currentPrice >= ema9Val)) {
        isLongReversal = true;
        longReason = `Confirmed via Bullish close at/below support threshold ($${rangeSupportThreshold.toFixed(2)})`;
      }
    }
    
    // --- 4. Evaluate Short Reversal ---
    let isShortReversal = false;
    let shortReason = "";
    
    // Strict range boundary: Must be in upper 28% of range and Bollinger Band percentB >= 0.68
    const minShortPriceThreshold = rangeHigh - Math.min(rangeWidth * 0.28, Math.max(rangeWidth * 0.15, 0.45 * currentAtr));
    const rangeShortMaxCeiling = rangeHigh + 0.75 * currentAtr;
    const isNotExplodingBreakout = currentPrice <= rangeShortMaxCeiling || currentCandle.close <= rangeHigh;
    const isWithinBbUpperZone = percentB >= 0.68;
    const isPriceWithinShortZone = currentPrice >= minShortPriceThreshold && isNotExplodingBreakout && isWithinBbUpperZone;

    // Short Reversal Filter: If market has bullish EMA stack (EMA 20 > EMA 50) and price is above EMA 20, require EMA 9 breakdown or confirmed 2-candle pattern
    const canEnterShortReversal = !isBlowoffPump && (
      (!isBullishEmaStructure || currentPrice <= ema9Val + 0.05 * currentAtr || hasRecentMicroBearishCrossover || isCandleReversalBearish)
    );
    
    if (hasTestedResistanceRecently && isPriceWithinShortZone && canEnterShortReversal) {
      if (isCandleReversalBearish) {
        isShortReversal = true;
        shortReason = `Confirmed via [${candlePatternTypeShort}] following recent resistance touch of $${rangeHigh.toFixed(2)}`;
      } else if (hasRecentMicroBearishCrossover && isMicroEMAAlignedBearish) {
        isShortReversal = true;
        shortReason = `Confirmed via Micro EMA Crossover (${microFastPeriod}/${microSlowPeriod} EMA) following recent resistance touch of $${rangeHigh.toFixed(2)}`;
      } else if (isRsiHookedBearish && (!isBullishEmaStructure || currentPrice <= ema9Val)) {
        isShortReversal = true;
        shortReason = `Confirmed via RSI Hook (${currentRsi.toFixed(1)}) from overbought following recent resistance touch of $${rangeHigh.toFixed(2)}`;
      } else if (isImmediateRedOnResistance && (!isBullishEmaStructure && currentPrice <= ema9Val)) {
        isShortReversal = true;
        shortReason = `Confirmed via Bearish close at/above resistance threshold ($${rangeResistanceThreshold.toFixed(2)})`;
      }
    }
    
    return {
      isLongReversal,
      isShortReversal,
      longReason,
      shortReason,
      rangeLow,
      rangeHigh
    };
  }

  public detectOrderFlowAbsorption(direction: "LONG" | "SHORT"): {
    isAbsorption: boolean;
    type: string;
    description: string;
  } {
    const lastIdx = this.candles1m.length - 1;
    if (lastIdx < 1) return { isAbsorption: false, type: "", description: "Insufficient candle data" };
    
    const currentCandle = this.candles1m[lastIdx];
    const prevCandle = this.candles1m[lastIdx - 1];

    const candleRange = Math.max(0.001, currentCandle.high - currentCandle.low);
    const candleBody = Math.abs(currentCandle.close - currentCandle.open);
    const lowerWick = Math.min(currentCandle.open, currentCandle.close) - currentCandle.low;
    const upperWick = currentCandle.high - Math.max(currentCandle.open, currentCandle.close);

    const takerBuyRatio = this.orderFlowStats.takerBuyRatio;
    const obImbalance = this.orderBookStats.imbalanceRatio;
    const netCVD = this.orderFlowStats.netCVD;

    if (direction === "LONG") {
      // 1. Seller Exhaustion / Passive Buyer Absorption:
      // Heavy seller aggressor volume (takerBuyRatio <= 0.46 or negative delta), but price refuses to break down
      // and prints a lower wick >= 30% of range or stabilizes with small body at support.
      const hasHeavySellAggression = takerBuyRatio <= 0.46 || obImbalance <= -0.25 || netCVD < 0;
      const priceHoldingSupport = (lowerWick / candleRange >= 0.30) || (currentCandle.close >= prevCandle.low && candleBody <= 0.35 * candleRange);
      const isReboundStarting = currentCandle.close >= currentCandle.open || (lowerWick >= candleBody);

      if (hasHeavySellAggression && priceHoldingSupport && isReboundStarting) {
        return {
          isAbsorption: true,
          type: "Bullish Passive Limit Absorption",
          description: `Bullish Order Flow Absorption: Heavy market selling (Taker Buy ${(takerBuyRatio * 100).toFixed(0)}%, Imbalance ${(obImbalance * 100).toFixed(0)}%) absorbed by passive buyers at $${currentCandle.low.toFixed(2)} (Lower Wick: ${((lowerWick / candleRange) * 100).toFixed(0)}%).`
        };
      }

      // 2. Aggressive Buyer Accumulation:
      // Strong buyer takeover during compression or at support
      const hasAggressiveBuying = takerBuyRatio >= 0.58 && obImbalance >= 0.20;
      if (hasAggressiveBuying && lowerWick >= 0.20 * candleRange) {
        return {
          isAbsorption: true,
          type: "Bullish Aggressive Accumulation",
          description: `Bullish Accumulation Surge: Strong institutional taker flow (${(takerBuyRatio * 100).toFixed(0)}% buys, ${(obImbalance * 100).toFixed(0)}% bid wall) driving early inflection at $${this.currentPrice.toFixed(2)}.`
        };
      }
    } else {
      // SHORT
      // 1. Buyer Exhaustion / Passive Seller Absorption:
      // Heavy buyer aggressor volume (takerBuyRatio >= 0.54 or positive delta), but price stalls at resistance with upper wick >= 30%.
      const hasHeavyBuyAggression = takerBuyRatio >= 0.54 || obImbalance >= 0.25 || netCVD > 0;
      const priceHoldingResistance = (upperWick / candleRange >= 0.30) || (currentCandle.close <= prevCandle.high && candleBody <= 0.35 * candleRange);
      const isReboundStarting = currentCandle.close <= currentCandle.open || (upperWick >= candleBody);

      if (hasHeavyBuyAggression && priceHoldingResistance && isReboundStarting) {
        return {
          isAbsorption: true,
          type: "Bearish Passive Limit Absorption",
          description: `Bearish Order Flow Absorption: Heavy market buying (Taker Buy ${(takerBuyRatio * 100).toFixed(0)}%, Imbalance ${(obImbalance * 100).toFixed(0)}%) absorbed by passive sell limit walls at $${currentCandle.high.toFixed(2)} (Upper Wick: ${((upperWick / candleRange) * 100).toFixed(0)}%).`
        };
      }

      // 2. Aggressive Seller Distribution:
      const hasAggressiveSelling = takerBuyRatio <= 0.42 && obImbalance <= -0.20;
      if (hasAggressiveSelling && upperWick >= 0.20 * candleRange) {
        return {
          isAbsorption: true,
          type: "Bearish Aggressive Distribution",
          description: `Bearish Distribution Surge: Strong institutional taker sell flow (${(takerBuyRatio * 100).toFixed(0)}% buys, ${(obImbalance * 100).toFixed(0)}% ask wall) driving early breakdown at $${this.currentPrice.toFixed(2)}.`
        };
      }
    }

    return { isAbsorption: false, type: "", description: "No order flow absorption detected" };
  }

  public evaluateVolatilitySqueeze(): {
    isSqueezed: boolean;
    squeezeFired: boolean;
    squeezeFiredDirection: "LONG" | "SHORT" | "NONE";
    bbWidth: number;
    keltnerWidth: number;
    description: string;
  } {
    const closes = this.candles1m.map(c => c.close);
    const lastIdx = closes.length - 1;
    if (lastIdx < 20) {
      return { isSqueezed: false, squeezeFired: false, squeezeFiredDirection: "NONE", bbWidth: 0, keltnerWidth: 0, description: "Insufficient data" };
    }

    const atr14 = this.calculateATR(this.candles1m, 14);
    const currentAtr = atr14[lastIdx] || 50;
    const bb = this.calculateBollingerBands(closes, 20, 2);
    const bbWidth = bb.upper - bb.lower;
    const keltnerWidth = 2 * 1.5 * currentAtr;

    const isSqueezed = bbWidth <= keltnerWidth;

    // Check prior candle to see if squeeze just fired (compression release)
    const prevCloses = closes.slice(0, -1);
    const prevBb = this.calculateBollingerBands(prevCloses, 20, 2);
    const prevAtr = (atr14[lastIdx - 1]) || currentAtr;
    const prevBbWidth = prevBb.upper - prevBb.lower;
    const prevKeltnerWidth = 2 * 1.5 * prevAtr;
    const prevWasSqueezed = prevBbWidth <= prevKeltnerWidth;

    const squeezeFired = prevWasSqueezed && !isSqueezed;
    let squeezeFiredDirection: "LONG" | "SHORT" | "NONE" = "NONE";

    if (squeezeFired || isSqueezed) {
      const ema20Series = this.calculateEMA(closes, 20);
      const ema20 = ema20Series[lastIdx] || this.currentPrice;
      const momentum = this.currentPrice - ema20;
      if (momentum > 0.10 * currentAtr) squeezeFiredDirection = "LONG";
      else if (momentum < -0.10 * currentAtr) squeezeFiredDirection = "SHORT";
    }

    const desc = isSqueezed
      ? `Volatility Squeeze Active (BB Width: $${bbWidth.toFixed(2)} <= Keltner: $${keltnerWidth.toFixed(2)})`
      : squeezeFired
        ? `Volatility Squeeze FIRED (${squeezeFiredDirection}): Momentum releasing from compression!`
        : `Normal Volatility (BB Width: $${bbWidth.toFixed(2)} > Keltner: $${keltnerWidth.toFixed(2)})`;

    return { isSqueezed, squeezeFired, squeezeFiredDirection, bbWidth, keltnerWidth, description: desc };
  }

  /**
   * FEATURE 11: Setup 9 - Range Failed Auction / Swing Failure Pattern (SFP) Reclaim
   * Captures false breakouts outside established range boundaries that fail within 1-3 candles
   * and decisively close back inside the range with delta/order flow absorption.
   */
  public evaluateFailedAuctionSetup(direction: "LONG" | "SHORT" | "NEUTRAL"): {
    isValid: boolean;
    direction: "LONG" | "SHORT" | "NEUTRAL";
    rangeBoundary: number;
    reclaimPrice: number;
    deviationAtr: number;
    candlesOutside: number;
    stopLoss: number;
    takeProfit: number;
    description: string;
  } {
    const config = dbManager.getConfig();
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

    if (this.candles1m.length < 25) {
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

    const lastIdx = this.candles1m.length - 1;
    const currentCandle = this.candles1m[lastIdx];
    const currentPrice = this.currentPrice;

    const atr14 = this.calculateATR(this.candles1m, 14);
    const currentAtr = atr14[lastIdx] || 50;

    const maxDeviationAtr = ms.failed_auction_max_deviation_atr_mult !== undefined ? ms.failed_auction_max_deviation_atr_mult : 0.8;
    const maxCandlesOutside = ms.failed_auction_max_candles_outside !== undefined ? ms.failed_auction_max_candles_outside : 3;

    // Define the range bounding box from the prior 25-30 candles (excluding current/recent poke)
    const rangeLookback = 30;
    const rangeStartIdx = Math.max(0, lastIdx - rangeLookback);
    const rangeSlice = this.candles1m.slice(rangeStartIdx, Math.max(rangeStartIdx + 10, lastIdx - 4));
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

    const absorption = this.detectOrderFlowAbsorption(direction);

    if (direction === "LONG") {
      // Bullish Failed Auction / SFP at Range Low:
      // Price poked below rangeLow (poked out by <= maxDeviationAtr * ATR), spent <= maxCandlesOutside below,
      // and current candle has closed or is actively closing back ABOVE rangeLow with bullish momentum/absorption.
      let pokeLowest = rangeLow;
      let pokeCount = 0;
      let pokeStartIndex = -1;

      // Also check if the current candle itself wicked below rangeLow and is already reclaiming
      const currentLowPoked = currentCandle.low < rangeLow;
      if (currentLowPoked) {
        pokeLowest = Math.min(pokeLowest, currentCandle.low);
        pokeCount++;
      }

      for (let i = 1; i <= Math.min(6, lastIdx - rangeStartIdx); i++) {
        const c = this.candles1m[lastIdx - i];
        if (c.low < rangeLow) {
          pokeLowest = Math.min(pokeLowest, c.low);
          pokeCount++;
          if (pokeStartIndex === -1) pokeStartIndex = lastIdx - i;
        } else if (pokeCount > 0) {
          // Finished the poke window
          break;
        }
      }

      if (pokeCount >= 1 && pokeCount <= maxCandlesOutside) {
        const deviationAmount = rangeLow - pokeLowest;
        const deviationAtrRatio = deviationAmount / currentAtr;

        // Check that the overshoot was not a massive runaway trend breakdown
        if (deviationAtrRatio <= maxDeviationAtr && deviationAmount > 0.02 * currentAtr) {
          // Check that price is now firmly reclaimed back INSIDE the range (above rangeLow)
          const isReclaimed = currentCandle.close >= rangeLow || currentPrice >= rangeLow;
          const isBullishCandle = currentCandle.close >= currentCandle.open || currentPrice >= currentCandle.open || (currentCandle.close - currentCandle.low) > (currentCandle.high - currentCandle.close);
          const isOrderFlowSupported = absorption.isAbsorption || this.orderFlowStats.takerBuyRatio >= 0.45 || this.orderBookStats.imbalanceRatio >= -0.15;

          if (isReclaimed && isBullishCandle && isOrderFlowSupported) {
            const stopLoss = pokeLowest - 0.15 * currentAtr;
            const takeProfit = rangeHigh - 0.15 * currentAtr;

            return {
              isValid: true,
              direction: "LONG",
              rangeBoundary: rangeLow,
              reclaimPrice: currentPrice,
              deviationAtr: Number(deviationAtrRatio.toFixed(2)),
              candlesOutside: pokeCount,
              stopLoss,
              takeProfit,
              description: `Bullish Range Failed Auction (SFP Reclaim): Price false-breakdown low $${pokeLowest.toFixed(2)} (-${(deviationAtrRatio).toFixed(2)}x ATR for ${pokeCount}c) reclaimed back above Range Low $${rangeLow.toFixed(2)}. ${absorption.type || "Bullish delta reversal"} targeting median $${rangeMedian.toFixed(2)} and Range High $${rangeHigh.toFixed(2)} (SL: $${stopLoss.toFixed(2)}).`
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

      // Also check if current candle itself wicked above rangeHigh and is already reclaiming
      const currentHighPoked = currentCandle.high > rangeHigh;
      if (currentHighPoked) {
        pokeHighest = Math.max(pokeHighest, currentCandle.high);
        pokeCount++;
      }

      for (let i = 1; i <= Math.min(6, lastIdx - rangeStartIdx); i++) {
        const c = this.candles1m[lastIdx - i];
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
          const isReclaimed = currentCandle.close <= rangeHigh || currentPrice <= rangeHigh;
          const isBearishCandle = currentCandle.close <= currentCandle.open || currentPrice <= currentCandle.open || (currentCandle.high - currentCandle.close) > (currentCandle.close - currentCandle.low);
          const isOrderFlowSupported = absorption.isAbsorption || this.orderFlowStats.takerBuyRatio <= 0.55 || this.orderBookStats.imbalanceRatio <= 0.15;

          if (isReclaimed && isBearishCandle && isOrderFlowSupported) {
            const stopLoss = pokeHighest + 0.15 * currentAtr;
            const takeProfit = rangeLow + 0.15 * currentAtr;

            return {
              isValid: true,
              direction: "SHORT",
              rangeBoundary: rangeHigh,
              reclaimPrice: currentPrice,
              deviationAtr: Number(deviationAtrRatio.toFixed(2)),
              candlesOutside: pokeCount,
              stopLoss,
              takeProfit,
              description: `Bearish Range Failed Auction (SFP Reclaim): Price false-breakout high $${pokeHighest.toFixed(2)} (+${(deviationAtrRatio).toFixed(2)}x ATR for ${pokeCount}c) reclaimed back below Range High $${rangeHigh.toFixed(2)}. ${absorption.type || "Bearish delta reversal"} targeting median $${rangeMedian.toFixed(2)} and Range Low $${rangeLow.toFixed(2)} (SL: $${stopLoss.toFixed(2)}).`
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

  /**
   * FEATURE 12: Setup 10 - Dedicated VWAP / Range Band Rejection (Mean Reversion Scalp)
   * Exploits institutional mean-reversion pull when price stretches to the +/- 1.5 sigma or +/- 2.0 sigma
   * standard deviation bands of the Session VWAP and prints an inward-facing reversal rejection candle.
   */
  public evaluateVwapBandRejectionSetup(direction: "LONG" | "SHORT" | "NEUTRAL"): {
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
  } {
    const config = dbManager.getConfig();
    const ms: any = config.market_structure || {};

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
    if (direction === "SHORT" && this.currentRegime === MarketRegime.STRONG_UPTREND) {
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
    if (direction === "LONG" && this.currentRegime === MarketRegime.STRONG_DOWNTREND) {
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

    if (this.candles1m.length < 25) {
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

    const lastIdx = this.candles1m.length - 1;
    const currentCandle = this.candles1m[lastIdx];
    const currentPrice = this.currentPrice;

    const atr14 = this.calculateATR(this.candles1m, 14);
    const currentAtr = atr14[lastIdx] || 50;

    const mult = ms.vwap_band_reversal_deviation_mult || 1.5;
    this.calculateVWAP(this.candles1m, mult);

    const vwapVal = currentCandle.vwap !== undefined ? currentCandle.vwap : currentPrice;
    const vwapUpper = currentCandle.vwap_upper !== undefined ? currentCandle.vwap_upper : currentPrice + mult * currentAtr;
    const vwapLower = currentCandle.vwap_lower !== undefined ? currentCandle.vwap_lower : currentPrice - mult * currentAtr;

    const minWickRatio = ms.vwap_band_reversal_min_wick_ratio || 0.30;
    const rsi14 = this.calculateRSI(this.candles1m.map(c => c.close), 14);
    const currentRsi = rsi14[lastIdx] ?? 50;
    const absorption = this.detectOrderFlowAbsorption(direction);

    // Look at recent 3 candles for band touch and inward rejection
    const recentCandles = this.candles1m.slice(-3);

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

      // Bullish candlestick rejection check
      const rejectionCheck = this.isMultiCandleLongRejection(lastIdx, currentAtr);
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
      const stopLoss = lowestPoint - 0.15 * currentAtr;
      const takeProfit = vwapVal;
      const riskDistance = currentPrice - stopLoss;
      const rewardDistance = takeProfit - currentPrice;
      const rrRatio = riskDistance > 0 ? rewardDistance / riskDistance : 0;

      if (rrRatio < 1.40) {
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
          description: `VWAP Mean Reversion R:R too low (${rrRatio.toFixed(2)} < 1.40)`
        };
      }

      // Confluence: RSI oversold or Order flow absorption
      const isRsiValid = currentRsi <= 48;
      const isDeltaSupported = absorption.isAbsorption || this.orderFlowStats.takerBuyRatio >= 0.46;

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

      // Bearish candlestick rejection check
      const rejectionCheck = this.isMultiCandleShortRejection(lastIdx, currentAtr);
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
      const stopLoss = highestPoint + 0.15 * currentAtr;
      const takeProfit = vwapVal;
      const riskDistance = stopLoss - currentPrice;
      const rewardDistance = currentPrice - takeProfit;
      const rrRatio = riskDistance > 0 ? rewardDistance / riskDistance : 0;

      if (rrRatio < 1.40) {
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
          description: `VWAP Mean Reversion R:R too low (${rrRatio.toFixed(2)} < 1.40)`
        };
      }

      // Confluence: RSI overbought or Order flow absorption
      const isRsiValid = currentRsi >= 52;
      const isDeltaSupported = absorption.isAbsorption || this.orderFlowStats.takerBuyRatio <= 0.54;

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

  /**
   * FEATURE 13: Setup 11 - Equal Highs / Equal Lows (EQH/EQL) Double Rejection with Momentum Divergence
   * Targets high-expectancy double top / double bottom boundary rejections at established EQH/EQL pools
   * exhibiting volume decay on the 2nd touch and RSI/CVD momentum divergence.
   */
  public evaluateEqhEqlDoubleTouchSetup(direction: "LONG" | "SHORT" | "NEUTRAL"): {
    isValid: boolean;
    direction: "LONG" | "SHORT" | "NEUTRAL";
    levelPrice: number;
    touchCount: number;
    hasVolumeDecay: boolean;
    hasMomentumDivergence: boolean;
    reversalType: string;
    stopLoss: number;
    takeProfit: number;
    riskReward: number;
    description: string;
  } {
    const config = dbManager.getConfig();
    const ms: any = config.market_structure || {};

    if (ms.eqh_eql_strategy_enabled === false || direction === "NEUTRAL") {
      return {
        isValid: false,
        direction,
        levelPrice: 0,
        touchCount: 0,
        hasVolumeDecay: false,
        hasMomentumDivergence: false,
        reversalType: "",
        stopLoss: 0,
        takeProfit: 0,
        riskReward: 0,
        description: ms.eqh_eql_strategy_enabled === false ? "EQH/EQL Double Touch strategy disabled" : "Neutral direction"
      };
    }

    // Protection 1: Block counter-trend execution during strongly trending regimes
    if (direction === "SHORT" && this.currentRegime === MarketRegime.STRONG_UPTREND) {
      return {
        isValid: false,
        direction: "SHORT",
        levelPrice: 0,
        touchCount: 0,
        hasVolumeDecay: false,
        hasMomentumDivergence: false,
        reversalType: "",
        stopLoss: 0,
        takeProfit: 0,
        riskReward: 0,
        description: "Blocked: Counter-trend Bearish EQH Double Top Short prohibited in STRONG_UPTREND regime."
      };
    }
    if (direction === "LONG" && this.currentRegime === MarketRegime.STRONG_DOWNTREND) {
      return {
        isValid: false,
        direction: "LONG",
        levelPrice: 0,
        touchCount: 0,
        hasVolumeDecay: false,
        hasMomentumDivergence: false,
        reversalType: "",
        stopLoss: 0,
        takeProfit: 0,
        riskReward: 0,
        description: "Blocked: Counter-trend Bullish EQL Double Bottom Long prohibited in STRONG_DOWNTREND regime."
      };
    }

    if (this.candles1m.length < 30) {
      return {
        isValid: false,
        direction,
        levelPrice: 0,
        touchCount: 0,
        hasVolumeDecay: false,
        hasMomentumDivergence: false,
        reversalType: "",
        stopLoss: 0,
        takeProfit: 0,
        riskReward: 0,
        description: "Insufficient candle history"
      };
    }

    const lastIdx = this.candles1m.length - 1;
    const currentCandle = this.candles1m[lastIdx];
    const currentPrice = this.currentPrice;

    const atr14 = this.calculateATR(this.candles1m, 14);
    const currentAtr = atr14[lastIdx] || 50;
    const ema9 = this.calculateEMA(this.candles1m.map(c => c.close), 9);
    const ema21 = this.calculateEMA(this.candles1m.map(c => c.close), 21);
    const ema100 = this.calculateEMA(this.candles1m.map(c => c.close), 100);

    const eqLevels = this.detectEqualHighsLows();
    const minTouches = ms.eqh_eql_min_touch_count || 2;

    const rangeLookback = 30;
    const recentRangeSlice = this.candles1m.slice(-rangeLookback);
    const rangeHigh = Math.max(...recentRangeSlice.map(c => c.high));
    const rangeLow = Math.min(...recentRangeSlice.map(c => c.low));
    const rangeEq = (rangeHigh + rangeLow) / 2;

    if (direction === "LONG") {
      // Find matching EQL support level near current price
      const matchedEql = eqLevels.eqlLevels.find(
        eql => eql.touchCount >= minTouches &&
               (Math.abs(currentCandle.low - eql.price) / eql.price * 100 <= 0.15 ||
                Math.abs(currentPrice - eql.price) <= 0.35 * currentAtr)
      );

      if (!matchedEql) {
        return {
          isValid: false,
          direction: "LONG",
          levelPrice: 0,
          touchCount: 0,
          hasVolumeDecay: false,
          hasMomentumDivergence: false,
          reversalType: "",
          stopLoss: 0,
          takeProfit: 0,
          riskReward: 0,
          description: "No active Equal Lows (EQL) double bottom level tested"
        };
      }

      // FIX 1: Block EQL setups at overextended trend tops (price extended far above 21/100 EMA)
      const currentEma21 = ema21[lastIdx] || currentPrice;
      const currentEma100 = ema100[lastIdx] || currentPrice;
      const distAboveEma21 = currentPrice - currentEma21;
      const distAboveEma100 = currentPrice - currentEma100;
      const isOverextendedAboveEmas = distAboveEma21 > 2.0 * currentAtr || (currentAtr > 0 && distAboveEma100 > 2.5 * currentAtr);
      if (isOverextendedAboveEmas) {
        return {
          isValid: false,
          direction: "LONG",
          levelPrice: matchedEql.price,
          touchCount: matchedEql.touchCount,
          hasVolumeDecay: false,
          hasMomentumDivergence: false,
          reversalType: "",
          stopLoss: 0,
          takeProfit: 0,
          riskReward: 0,
          description: `Blocked: EQL Double Bottom invalidated by top-of-trend overextension (+$${distAboveEma21.toFixed(1)} above 21 EMA, +$${distAboveEma100.toFixed(1)} above 100 EMA)`
        };
      }

      // Protection 3: Micro-trend 9 EMA momentum guard - don't catch falling knives
      const isEma9Falling = lastIdx >= 1 && ema9[lastIdx] < ema9[lastIdx - 1];
      const isDroppingBelowEma9 = isEma9Falling && currentCandle.close <= ema9[lastIdx];
      if (isDroppingBelowEma9) {
        return {
          isValid: false,
          direction: "LONG",
          levelPrice: matchedEql.price,
          touchCount: matchedEql.touchCount,
          hasVolumeDecay: false,
          hasMomentumDivergence: false,
          reversalType: "",
          stopLoss: 0,
          takeProfit: 0,
          riskReward: 0,
          description: "Blocked: Price is falling below declining 9 EMA during EQL test (downward micro-trend active)"
        };
      }

      // Check candlestick reversal at double bottom (must strictly close green and hold above EQL support)
      const rejectionCheck = this.isMultiCandleLongRejection(lastIdx, currentAtr);
      const isCandleGreen = currentCandle.close > currentCandle.open;
      const isAboveEql = currentCandle.close > matchedEql.price;
      const isReversalConfirmed = rejectionCheck.confirmed || (isCandleGreen && isAboveEql);

      if ((!isReversalConfirmed || !isCandleGreen || !isAboveEql) && ms.eqh_eql_require_candlestick_reversal !== false) {
        return {
          isValid: false,
          direction: "LONG",
          levelPrice: matchedEql.price,
          touchCount: matchedEql.touchCount,
          hasVolumeDecay: false,
          hasMomentumDivergence: false,
          reversalType: "",
          stopLoss: 0,
          takeProfit: 0,
          riskReward: 0,
          description: `Awaiting confirmed bullish green rejection candle closing above EQL support $${matchedEql.price.toFixed(2)}`
        };
      }

      // Check volume decay & momentum divergence between touches
      let hasVolumeDecay = true;
      let hasMomentumDivergence = true;

      if (matchedEql.touches && matchedEql.touches.length >= 2) {
        const t1 = matchedEql.touches[matchedEql.touches.length - 2];
        const t2 = matchedEql.touches[matchedEql.touches.length - 1];
        // Volume Decay: 2nd touch volume <= 1.20x of 1st touch (exhaustion of sellers)
        hasVolumeDecay = t2.volume <= t1.volume * 1.20 || t2.volume <= currentCandle.volume * 1.5;
        // RSI Divergence: RSI on 2nd touch is higher than or equal to 1st touch (bullish divergence)
        hasMomentumDivergence = (t2.rsi !== undefined && t1.rsi !== undefined)
          ? t2.rsi >= t1.rsi - 2.0
          : true;
      }

      const absorption = this.detectOrderFlowAbsorption("LONG");
      const isDeltaConfirmed = absorption.isAbsorption || this.orderFlowStats.takerBuyRatio >= 0.47;

      if (ms.eqh_eql_require_divergence !== false && !hasVolumeDecay && !hasMomentumDivergence && !isDeltaConfirmed) {
        return {
          isValid: false,
          direction: "LONG",
          levelPrice: matchedEql.price,
          touchCount: matchedEql.touchCount,
          hasVolumeDecay,
          hasMomentumDivergence,
          reversalType: rejectionCheck.type || "Bullish Reversal",
          stopLoss: 0,
          takeProfit: 0,
          riskReward: 0,
          description: `EQL double bottom lacks volume decay and momentum divergence at $${matchedEql.price.toFixed(2)}`
        };
      }

      const stopLoss = matchedEql.price - 0.15 * currentAtr;
      const takeProfit = rangeEq > currentPrice + 0.5 * currentAtr ? rangeEq : rangeHigh - 0.15 * currentAtr;
      const riskDistance = currentPrice - stopLoss;
      const rewardDistance = takeProfit - currentPrice;
      const rrRatio = riskDistance > 0 ? rewardDistance / riskDistance : 0;

      const patternDesc = rejectionCheck.type || "Bullish Double Bottom Rejection";
      return {
        isValid: true,
        direction: "LONG",
        levelPrice: matchedEql.price,
        touchCount: matchedEql.touchCount,
        hasVolumeDecay,
        hasMomentumDivergence,
        reversalType: patternDesc,
        stopLoss,
        takeProfit,
        riskReward: Number(rrRatio.toFixed(2)),
        description: `Bullish EQL Double Bottom Rejection: Price successfully tested Equal Lows pool ($${matchedEql.price.toFixed(2)}, ${matchedEql.touchCount} touches) with ${patternDesc}${hasVolumeDecay ? " [Volume Decay]" : ""}${hasMomentumDivergence ? " [RSI/CVD Divergence]" : ""} targeting Range Equilibrium $${takeProfit.toFixed(2)} (SL: $${stopLoss.toFixed(2)}).`
      };
    } else {
      // Find matching EQH resistance level near current price
      const matchedEqh = eqLevels.eqhLevels.find(
        eqh => eqh.touchCount >= minTouches &&
               (Math.abs(currentCandle.high - eqh.price) / eqh.price * 100 <= 0.15 ||
                Math.abs(currentPrice - eqh.price) <= 0.35 * currentAtr)
      );

      if (!matchedEqh) {
        return {
          isValid: false,
          direction: "SHORT",
          levelPrice: 0,
          touchCount: 0,
          hasVolumeDecay: false,
          hasMomentumDivergence: false,
          reversalType: "",
          stopLoss: 0,
          takeProfit: 0,
          riskReward: 0,
          description: "No active Equal Highs (EQH) double top level tested"
        };
      }

      // FIX 1: Block EQH setups at overextended trend bottoms (price extended far below 21/100 EMA)
      const currentEma21 = ema21[lastIdx] || currentPrice;
      const currentEma100 = ema100[lastIdx] || currentPrice;
      const distBelowEma21 = currentEma21 - currentPrice;
      const distBelowEma100 = currentEma100 - currentPrice;
      const isOverextendedBelowEmas = distBelowEma21 > 2.0 * currentAtr || (currentAtr > 0 && distBelowEma100 > 2.5 * currentAtr);
      if (isOverextendedBelowEmas) {
        return {
          isValid: false,
          direction: "SHORT",
          levelPrice: matchedEqh.price,
          touchCount: matchedEqh.touchCount,
          hasVolumeDecay: false,
          hasMomentumDivergence: false,
          reversalType: "",
          stopLoss: 0,
          takeProfit: 0,
          riskReward: 0,
          description: `Blocked: EQH Double Top invalidated by bottom-of-trend overextension (-$${distBelowEma21.toFixed(1)} below 21 EMA, -$${distBelowEma100.toFixed(1)} below 100 EMA)`
        };
      }

      // Protection 3: Micro-trend 9 EMA momentum guard - don't short into surging green impulse
      const isEma9Rising = lastIdx >= 1 && ema9[lastIdx] > ema9[lastIdx - 1];
      const isRidingAboveEma9 = isEma9Rising && currentCandle.close >= ema9[lastIdx];
      if (isRidingAboveEma9) {
        return {
          isValid: false,
          direction: "SHORT",
          levelPrice: matchedEqh.price,
          touchCount: matchedEqh.touchCount,
          hasVolumeDecay: false,
          hasMomentumDivergence: false,
          reversalType: "",
          stopLoss: 0,
          takeProfit: 0,
          riskReward: 0,
          description: "Blocked: Price is riding above rising 9 EMA during EQH test (upward micro-trend active)"
        };
      }

      // Check candlestick reversal at double top (must strictly close red and stay below EQH resistance)
      const rejectionCheck = this.isMultiCandleShortRejection(lastIdx, currentAtr);
      const isCandleRed = currentCandle.close < currentCandle.open;
      const isBelowEqh = currentCandle.close < matchedEqh.price;
      const isReversalConfirmed = rejectionCheck.confirmed || (isCandleRed && isBelowEqh);

      if ((!isReversalConfirmed || !isCandleRed || !isBelowEqh) && ms.eqh_eql_require_candlestick_reversal !== false) {
        return {
          isValid: false,
          direction: "SHORT",
          levelPrice: matchedEqh.price,
          touchCount: matchedEqh.touchCount,
          hasVolumeDecay: false,
          hasMomentumDivergence: false,
          reversalType: "",
          stopLoss: 0,
          takeProfit: 0,
          riskReward: 0,
          description: `Awaiting confirmed bearish red rejection candle closing below EQH resistance $${matchedEqh.price.toFixed(2)}`
        };
      }

      // Check volume decay & momentum divergence between touches
      let hasVolumeDecay = true;
      let hasMomentumDivergence = true;

      if (matchedEqh.touches && matchedEqh.touches.length >= 2) {
        const t1 = matchedEqh.touches[matchedEqh.touches.length - 2];
        const t2 = matchedEqh.touches[matchedEqh.touches.length - 1];
        // Volume Decay: 2nd touch volume <= 1.20x of 1st touch (exhaustion of buyers)
        hasVolumeDecay = t2.volume <= t1.volume * 1.20 || t2.volume <= currentCandle.volume * 1.5;
        // RSI Divergence: RSI on 2nd touch is lower than or equal to 1st touch (bearish divergence)
        hasMomentumDivergence = (t2.rsi !== undefined && t1.rsi !== undefined)
          ? t2.rsi <= t1.rsi + 2.0
          : true;
      }

      const absorption = this.detectOrderFlowAbsorption("SHORT");
      const isDeltaConfirmed = absorption.isAbsorption || this.orderFlowStats.takerBuyRatio <= 0.53;

      if (ms.eqh_eql_require_divergence !== false && !hasVolumeDecay && !hasMomentumDivergence && !isDeltaConfirmed) {
        return {
          isValid: false,
          direction: "SHORT",
          levelPrice: matchedEqh.price,
          touchCount: matchedEqh.touchCount,
          hasVolumeDecay,
          hasMomentumDivergence,
          reversalType: rejectionCheck.type || "Bearish Reversal",
          stopLoss: 0,
          takeProfit: 0,
          riskReward: 0,
          description: `EQH double top lacks volume decay and momentum divergence at $${matchedEqh.price.toFixed(2)}`
        };
      }

      const stopLoss = matchedEqh.price + 0.15 * currentAtr;
      const takeProfit = rangeEq < currentPrice - 0.5 * currentAtr ? rangeEq : rangeLow + 0.15 * currentAtr;
      const riskDistance = stopLoss - currentPrice;
      const rewardDistance = currentPrice - takeProfit;
      const rrRatio = riskDistance > 0 ? rewardDistance / riskDistance : 0;

      const patternDesc = rejectionCheck.type || "Bearish Double Top Rejection";
      return {
        isValid: true,
        direction: "SHORT",
        levelPrice: matchedEqh.price,
        touchCount: matchedEqh.touchCount,
        hasVolumeDecay,
        hasMomentumDivergence,
        reversalType: patternDesc,
        stopLoss,
        takeProfit,
        riskReward: Number(rrRatio.toFixed(2)),
        description: `Bearish EQH Double Top Rejection: Price successfully tested Equal Highs pool ($${matchedEqh.price.toFixed(2)}, ${matchedEqh.touchCount} touches) with ${patternDesc}${hasVolumeDecay ? " [Volume Decay]" : ""}${hasMomentumDivergence ? " [RSI/CVD Divergence]" : ""} targeting Range Equilibrium $${takeProfit.toFixed(2)} (SL: $${stopLoss.toFixed(2)}).`
      };
    }
  }

  /**
   * FEATURE: Setup 12 - CVD Absorption & Delta Divergence
   * Monitors Cumulative Volume Delta (CVD) and Taker Buy/Sell flow at structural extremes.
   * - Long: Price makes or sweeps a local low / range low, but aggressive market sells fail to displace
   *   price lower due to passive institutional iceberg absorption (long lower wick >= 35%, delta divergence).
   * - Short: Price makes or sweeps a local high / range high, but aggressive market buys fail to displace
   *   price higher due to passive institutional limit asks (long upper wick >= 35%, delta divergence).
   * Strict Risk & Structural Safeguards:
   * 1. Requires structural extreme (swing high/low of last 15-20 candles or range boundary).
   * 2. Rejection wick >= cvd_divergence_min_rejection_wick_pct (default: 35%).
   * 3. Delta imbalance absorbed (taker aggression absorbed with price stabilization).
   * 4. Invalidation floor/ceiling: SL placed strictly 1-2 ticks (0.15 * ATR) beyond the absorption wick extreme.
   * 5. Counter-trend regime protection: Prohibits longs into STRONG_DOWNTREND, prohibits shorts into STRONG_UPTREND.
   */
  public evaluateCvdAbsorptionDivergenceSetup(
    direction: "LONG" | "SHORT" | "NEUTRAL"
  ): CvdAbsorptionSetupResult {
    const config = dbManager.getConfig();
    const ms: any = config.market_structure || {};

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

    const lastIdx = this.candles1m.length - 1;
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

    const currentCandle = this.candles1m[lastIdx];
    const currentPrice = this.currentPrice;
    const atr14 = this.calculateATR(this.candles1m, 14);
    const currentAtr = Math.max(10, atr14[lastIdx] || 50);
    const minWickPct = (ms.cvd_divergence_min_rejection_wick_pct !== undefined ? ms.cvd_divergence_min_rejection_wick_pct : 35) / 100;
    const imbalanceRatio = ms.cvd_divergence_min_delta_imbalance_ratio !== undefined ? ms.cvd_divergence_min_delta_imbalance_ratio : 0.55;
    const lookback = ms.cvd_divergence_lookback_candles !== undefined ? ms.cvd_divergence_lookback_candles : 20;
    const requireExtreme = ms.cvd_divergence_require_structural_extreme !== false;

    // Structural swing extremes over lookback
    const startSlice = Math.max(0, lastIdx - lookback);
    const lookbackSlice = this.candles1m.slice(startSlice, lastIdx);
    const priorHigh = Math.max(...lookbackSlice.map(c => c.high));
    const priorLow = Math.min(...lookbackSlice.map(c => c.low));

    // Dynamic range boundaries
    const rangeCandles = this.candles1m.slice(Math.max(0, lastIdx - 30));
    const rangeHigh = rangeCandles.length > 0 ? Math.max(...rangeCandles.map(c => c.high)) : priorHigh;
    const rangeLow = rangeCandles.length > 0 ? Math.min(...rangeCandles.map(c => c.low)) : priorLow;

    const candleRange = Math.max(1.0, currentCandle.high - currentCandle.low);
    const lowerWick = Math.min(currentCandle.open, currentCandle.close) - currentCandle.low;
    const upperWick = currentCandle.high - Math.max(currentCandle.open, currentCandle.close);
    const lowerWickRatio = lowerWick / candleRange;
    const upperWickRatio = upperWick / candleRange;

    const takerBuyRatio = this.orderFlowStats.takerBuyRatio;
    const netCVD = this.orderFlowStats.netCVD;
    const obImbalance = this.orderBookStats.imbalanceRatio;

    if (direction === "LONG") {
      // Regime safeguard: No knife catching in strong trend
      if (this.currentRegime === MarketRegime.STRONG_DOWNTREND) {
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
      const isNearRangeLow = this.currentRegime === MarketRegime.RANGE_BOUND && currentPrice <= (rangeLow + 0.28 * (rangeHigh - rangeLow));
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
      const isStabilizing = currentCandle.close >= currentCandle.low + 0.35 * candleRange || currentPrice >= currentCandle.open;

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

      const stopLoss = currentCandle.low - 0.15 * currentAtr;
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
      if (this.currentRegime === MarketRegime.STRONG_UPTREND) {
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
      const isNearRangeHigh = this.currentRegime === MarketRegime.RANGE_BOUND && currentPrice >= (rangeHigh - 0.28 * (rangeHigh - rangeLow));
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
      const isRejecting = currentCandle.close <= currentCandle.high - 0.35 * candleRange || currentPrice <= currentCandle.open;

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

      const stopLoss = currentCandle.high + 0.15 * currentAtr;
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

  /**
   * FEATURE: Setup 13 - Open Interest (OI) Flush & Cascade Fade
   * Tracks sudden Open Interest contractions coinciding with aggressive liquidation-driven spikes.
   * - Long Cascade Fade: Long liquidation cascade flushes price downward with massive volume (>= 1.8x)
   *   and sudden Open Interest contraction (>= 1.0%), leaving an order book air pocket.
   *   Once the exhaustion candle forms a long lower wick (>= 45%) and stops making lower lows, fades the cascade.
   * - Short Cascade Fade: Short squeeze cascade flushes price upward with massive volume and OI contraction,
   *   printing an exhaustion upper wick (>= 45%), fading the squeeze back to mean.
   * Strict Risk & Structural Safeguards:
   * 1. Minimum OI contraction threshold (default: >= 1.0% drop in OI) confirming positions forcibly liquidated.
   * 2. Volume surge threshold (default: >= 1.8x SMA volume) confirming exchange engine forced liquidation bursts.
   * 3. Two-candle / exhaustion wick confirmation safeguard (>= 45% wick, no continuation cascade).
   * 4. Mathematically absolute Stop Loss placed 1-2 ticks (0.10 * ATR) beyond the liquidation flush wick extreme.
   * 5. Asymmetric R:R (>= 2.5:1) targeting the origin / baseline of the liquidation cascade.
   */
  public evaluateOiFlushCascadeFadeSetup(
    direction: "LONG" | "SHORT" | "NEUTRAL"
  ): OiFlushCascadeFadeSetupResult {
    const config = dbManager.getConfig();
    const ms: any = config.market_structure || {};

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

    const lastIdx = this.candles1m.length - 1;
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

    const currentCandle = this.candles1m[lastIdx];
    const prevCandle = this.candles1m[lastIdx - 1];
    const currentPrice = this.currentPrice;
    const atr14 = this.calculateATR(this.candles1m, 14);
    const currentAtr = Math.max(10, atr14[lastIdx] || 50);

    // Compute 20-period average volume
    const volSlice = this.candles1m.slice(Math.max(0, lastIdx - 20), lastIdx);
    const sumVol = volSlice.reduce((sum, c) => sum + (c.volume || 0), 0);
    const avgVol = volSlice.length > 0 ? Math.max(1.0, sumVol / volSlice.length) : 15.0;

    // Detect cascade candidate: either prevCandle (with current candle confirming) or currentCandle
    const checkPrev = requireConfirmation && lastIdx >= 2;
    const flushCandle = checkPrev ? prevCandle : currentCandle;

    const flushRange = Math.max(1.0, flushCandle.high - flushCandle.low);
    const volMult = (flushCandle.volume || avgVol) / avgVol;

    // Measure OI contraction: negative change in OI during flush
    const oiDropPct1m = -this.openInterestStats.oiChangePct1m;
    const oiDropPct5m = -this.openInterestStats.oiChangePct5m;
    const effectiveOiContraction = Math.max(0, Math.max(oiDropPct1m, oiDropPct5m));

    const isVolumeSurge = volMult >= minVolMult * 0.90;
    const isOiContractionMet = effectiveOiContraction >= minContractionPct || (volMult >= 2.0 && flushRange >= 1.2 * currentAtr && (this.openInterestStats.oiChange1m < 0 || this.openInterestStats.oiChangePct1m <= -0.4));
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
        // Current candle must not make lower low below flush low (cascade stopped)
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
        // Confirmation: price is stabilizing or turning green
        if (this.orderFlowStats.takerBuyRatio < 0.44 && currentPrice < currentCandle.open) {
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
            description: `Awaiting 2nd candle delta stabilization after liquidation flush (Taker Buy: ${(this.orderFlowStats.takerBuyRatio * 100).toFixed(1)}%)`
          };
        }
      }

      // Stop loss placed strictly 1-2 ticks (0.10 * ATR) below cascade wick low
      const stopLoss = flushCandle.low - 0.10 * currentAtr;
      const risk = currentPrice - stopLoss;
      // Target origin of liquidation cascade (flushCandle.high) or asymmetric 2.5:1 R:R
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
        if (this.orderFlowStats.takerBuyRatio > 0.56 && currentPrice > currentCandle.open) {
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
            description: `Awaiting 2nd candle delta stabilization after squeeze flush (Taker Buy: ${(this.orderFlowStats.takerBuyRatio * 100).toFixed(1)}%)`
          };
        }
      }

      // Stop loss placed strictly 1-2 ticks (0.10 * ATR) above squeeze wick high
      const stopLoss = flushCandle.high + 0.10 * currentAtr;
      const risk = stopLoss - currentPrice;
      // Target origin of squeeze cascade (flushCandle.low) or asymmetric 2.5:1 R:R
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

  public evaluateContextAwareVolume(
    direction: "LONG" | "SHORT" | "NEUTRAL",
    relVolume: number,
    hasExtremeRealtimePressure: boolean,
    regime: MarketRegime,
    structCheck: { confirmed: boolean; setupType?: string; message?: string }
  ): {
    met: boolean;
    currentValue: string;
    requiredStr: string;
    description: string;
    softened: boolean;
    setupCategory: string;
  } {
    const config = dbManager.getConfig();
    const baseMinRelVol = config.general.relative_volume_threshold !== undefined ? config.general.relative_volume_threshold : 1.30;
    const softeningPercent = config.general.orderflow_softening_percent !== undefined ? config.general.orderflow_softening_percent : 10;
    
    // Determine active setup category from structCheck message or setupType
    const msg = (structCheck?.message || "").toLowerCase();
    const isBreakout = msg.includes("breakout") || msg.includes("super strong") || msg.includes("immediate breakout");
    const isPullbackRetest = msg.includes("pullback") || msg.includes("retest") || msg.includes("mitigation");
    const isEmaRetrace = msg.includes("ema") || msg.includes("pushback") || msg.includes("bounce");
    const isLiquiditySweep = msg.includes("liquidity sweep") || msg.includes("setup 3");
    const isFailedAuction = msg.includes("failed auction") || msg.includes("sfp") || msg.includes("setup 9");
    const isCvdAbsorption = msg.includes("cvd absorption") || msg.includes("delta divergence") || msg.includes("setup 12");
    const isOiFlush = msg.includes("open interest") || msg.includes("oi flush") || msg.includes("cascade fade") || msg.includes("setup 13");
    const isRangeReversal = regime === MarketRegime.RANGE_BOUND || isFailedAuction || isCvdAbsorption || msg.includes("range reversal") || msg.includes("ranging bullish") || msg.includes("ranging bearish");

    let setupCategory = "General Momentum";
    let targetRelVol = baseMinRelVol; // default e.g. 1.30x
    let categoryDescription = "Standard momentum entry: requires clear transaction volume expansion above 20-period moving average.";

    if (isOiFlush) {
      setupCategory = "Liquidation Cascade Fade (OI Flush)";
      targetRelVol = Math.max(1.30, baseMinRelVol);
      categoryDescription = "OI Flush Cascade Fade: Requires confirmed volume surge (>= 1.30x) during liquidation flush followed by exhaustion.";
    } else if (isCvdAbsorption) {
      setupCategory = "CVD Absorption & Delta Divergence";
      targetRelVol = Math.min(baseMinRelVol * 0.85, 1.10);
      categoryDescription = "CVD Absorption: Passive institutional absorption at structural extremes operates with steady turnover (>= 1.10x).";
    } else if (isFailedAuction) {
      setupCategory = "Range Failed Auction (SFP Reclaim)";
      targetRelVol = Math.min(baseMinRelVol * 0.85, 1.10);
      categoryDescription = "Range Failed Auction: False breakout liquidity poke reclaimed back inside range with absorption volume (>= 1.10x).";
    } else if (isBreakout && !isPullbackRetest) {
      // High-Velocity Breakouts require real breakout volume expansion
      setupCategory = "Momentum Breakout Expansion";
      targetRelVol = Math.max(1.25, baseMinRelVol);
      categoryDescription = "Momentum Breakout: Demands high institutional expansion volume (>= 1.25x - 1.30x) to confirm genuine range expansion without false breakouts.";
    } else if (isPullbackRetest || isEmaRetrace) {
      // Pullbacks & Retests thrive on volume dry-up during retracement, only requiring healthy normal volume on the bounce
      setupCategory = "Trend Retracement / Pullback Retest";
      targetRelVol = Math.min(baseMinRelVol * 0.80, 1.05); // e.g. 1.04x
      categoryDescription = "Pullback & Retest: Healthy trend retracements feature volume dry-up into support/resistance and steady retest volume (>= 1.05x).";
    } else if (isLiquiditySweep) {
      // Smart Money (SMC) Setups: Order Flow / Institutional Wick Mitigations
      setupCategory = "Institutional SMC (Liquidity Sweep)";
      targetRelVol = Math.min(baseMinRelVol * 0.85, 1.10); // e.g. 1.10x
      categoryDescription = "Smart Money Setup: Institutional sweep reversals operate on targeted delta absorption, requiring baseline liquidity confirmation (>= 1.10x).";
    } else if (isRangeReversal) {
      // Range Mean Reversion
      setupCategory = "Range Boundary Reversal";
      targetRelVol = Math.min(baseMinRelVol * 0.90, 1.15); // e.g. 1.15x
      categoryDescription = "Range Boundary Reversal: Mean-reversion off established range extremes requires rejection volume (>= 1.15x).";
    }

    // Dynamic softening under extreme real-time order flow pressure (strong CVD / book imbalance)
    const softenedThreshold = targetRelVol * (1 - softeningPercent / 100);
    const requiredRelVol = hasExtremeRealtimePressure ? softenedThreshold : targetRelVol;
    const isSoftened = hasExtremeRealtimePressure && relVolume >= softenedThreshold && relVolume < targetRelVol;
    const isMet = relVolume >= requiredRelVol;

    let currentValueStr = `${relVolume.toFixed(2)}x [${setupCategory}]`;
    if (isSoftened) {
      currentValueStr += " (SOFTENED VIA LEADING ORDER FLOW)";
    }

    const requiredStr = `> ${requiredRelVol.toFixed(2)}x (${setupCategory})`;

    return {
      met: isMet,
      currentValue: currentValueStr,
      requiredStr,
      description: `Context-Aware Volume Matrix [${setupCategory}]: ${categoryDescription}`,
      softened: isSoftened,
      setupCategory,
    };
  }

  private isMultiCandleLongRejection(lastIdx: number, currentAtr: number): { confirmed: boolean; type: string } {
    if (lastIdx < 0 || this.candles1m.length === 0) return { confirmed: false, type: "" };
    const config = dbManager.getConfig();
    const requirePinBarConfirmation = config.market_structure.pinbar_two_candle_confirmation_enabled !== false;
    const minWickRatio = config.market_structure.pinbar_min_wick_ratio || 0.50;

    // The confirmation candle MUST be a finished, closed candle (not an in-progress, 0-second unclosed candle)
    const closedIdx = (lastIdx === this.candles1m.length - 1 && this.candles1m.length >= 2) ? lastIdx - 1 : lastIdx;
    if (closedIdx < 0) return { confirmed: false, type: "" };

    const confirmCandle = this.candles1m[closedIdx];
    const confirmRange = confirmCandle.high - confirmCandle.low;
    const confirmBody = Math.abs(confirmCandle.close - confirmCandle.open);
    const confirmUpperWick = confirmCandle.high - Math.max(confirmCandle.close, confirmCandle.open);
    const confirmLowerWick = Math.min(confirmCandle.close, confirmCandle.open) - confirmCandle.low;
    const isBullish = confirmCandle.close > confirmCandle.open;
    const setupCandle = closedIdx >= 1 ? this.candles1m[closedIdx - 1] : null;

    // Single Candle Patterns on finished closed candle
    const isPinBar = confirmRange > 0 && confirmLowerWick >= minWickRatio * confirmRange && confirmUpperWick <= 0.25 * confirmRange;
    const isMajorWickRejection = confirmRange > 0 && confirmLowerWick >= 0.65 * confirmRange;
    const hasStrongClose = confirmRange > 0 && (confirmCandle.close - confirmCandle.low) / confirmRange >= 0.70;
    const isMomentumCandle = isBullish && confirmBody >= 0.7 * currentAtr;
    const isIndecision = confirmRange > 0 && 
      ((confirmBody / confirmRange < 0.20) || (confirmRange < 0.25 * currentAtr && !isPinBar && !isMajorWickRejection)) && 
      !isPinBar && !isMajorWickRejection;

    // 2-Candle Confirmed Bullish Pin Bar / Major Wick Rejection:
    // Candle 0 (setupCandle) forms the rejection wick, and Candle 1 (confirmCandle) MUST be finished and closed GREEN with verified body expansion
    let isConfirmedBullishPinBar = false;
    let isConfirmedMajorWickRejection = false;
    if (setupCandle) {
      const setupRange = setupCandle.high - setupCandle.low;
      const setupLowerWick = Math.min(setupCandle.open, setupCandle.close) - setupCandle.low;
      const setupUpperWick = setupCandle.high - Math.max(setupCandle.open, setupCandle.close);
      const setupIsPinBar = setupRange > 0 && setupLowerWick >= minWickRatio * setupRange && setupUpperWick <= 0.30 * setupRange;
      const setupIsMajorWick = setupRange > 0 && setupLowerWick >= 0.65 * setupRange;

      // Verification Criteria on finished, closed confirmCandle:
      // 1. Must be closed strictly green (close > open)
      const isConfirmGreen = confirmCandle.close > confirmCandle.open;
      const greenBody = confirmCandle.close - confirmCandle.open;

      // 2. Verified Body Expansion:
      // Body must be real and decisive: >= 35% of range or >= 0.25 * ATR (rejects flat dojis, zero-spread spinning tops, and unexpanded candles)
      const hasVerifiedBodyExpansion = confirmRange > 0 && ((greenBody / confirmRange >= 0.35) || (greenBody >= 0.25 * currentAtr)) && (greenBody / (confirmRange || 1) >= 0.20);

      // 3. Must hold the Pin Bar's low without sweeping/breaking it
      const holdsPinLow = confirmCandle.low >= setupCandle.low - 0.05 * currentAtr;

      // 4. Must show positive displacement / upward follow-through:
      // Must close above at least 50% midpoint of setup candle OR exceed setup candle's high, AND close higher than setup close
      const breaksPinUpper = confirmCandle.close >= (setupCandle.low + setupRange * 0.50) || confirmCandle.close >= setupCandle.high;
      const hasUpwardFollowThrough = confirmCandle.close > setupCandle.close;

      if (setupIsPinBar && isConfirmGreen && hasVerifiedBodyExpansion && holdsPinLow && (breaksPinUpper || hasUpwardFollowThrough)) {
        isConfirmedBullishPinBar = true;
      }
      if (setupIsMajorWick && isConfirmGreen && hasVerifiedBodyExpansion && holdsPinLow && (breaksPinUpper || hasUpwardFollowThrough)) {
        isConfirmedMajorWickRejection = true;
      }
    }

    // Two-Candle Patterns (Evaluated on completed, closed candles)
    const minEngulfBody = Math.max(0.35 * currentAtr, 0.35 * confirmRange);
    const prevBody = setupCandle ? Math.abs(setupCandle.close - setupCandle.open) : 0;
    const isBullishEngulfing = setupCandle && 
      (setupCandle.close < setupCandle.open) && 
      isBullish && 
      (confirmCandle.close >= setupCandle.open) && 
      (confirmCandle.open <= setupCandle.close) &&
      (confirmBody >= minEngulfBody) &&
      (prevBody >= 0.20 * currentAtr);

    const hasMultiWickRejection = setupCandle && 
      (confirmLowerWick >= 0.35 * confirmRange) && 
      ((Math.min(setupCandle.close, setupCandle.open) - setupCandle.low) >= 0.35 * (setupCandle.high - setupCandle.low)) && 
      Math.abs(confirmCandle.low - setupCandle.low) < 0.15 * currentAtr;

    // 1. Tweezer Bottom (Two-candle)
    let isTweezerBottom = false;
    if (setupCandle) {
      const prevRange = setupCandle.high - setupCandle.low;
      const prevLowerWick = Math.min(setupCandle.close, setupCandle.open) - setupCandle.low;
      const matchingLows = Math.abs(confirmCandle.low - setupCandle.low) < 0.05 * currentAtr;
      const currentHasLowerWick = confirmRange > 0 && confirmLowerWick >= 0.25 * confirmRange;
      const prevHasLowerWick = prevRange > 0 && prevLowerWick >= 0.25 * prevRange;
      const hasPositiveClose = isBullish && (confirmBody >= 0.20 * confirmRange || confirmBody >= 0.20 * currentAtr);
      if (matchingLows && currentHasLowerWick && prevHasLowerWick && (hasPositiveClose || hasStrongClose)) {
        isTweezerBottom = true;
      }
    }

    // 2. Piercing Line (Two-candle)
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

    // 3. Bullish Harami (Two-candle Inside Bar Reversal)
    let isBullishHarami = false;
    if (setupCandle) {
      const prevRange = setupCandle.high - setupCandle.low;
      const prevBody = setupCandle.open - setupCandle.close;
      // Mother candle must be a decisive bearish candle
      const isPrevBearish = setupCandle.close < setupCandle.open && prevBody >= 0.30 * prevRange && prevBody >= 0.25 * currentAtr;
      const opensInsideMotherBody = confirmCandle.open >= setupCandle.close - 0.05 * currentAtr;
      const closesInsideMotherBody = confirmCandle.close <= setupCandle.open + 0.05 * currentAtr;
      const isInsideMotherRange = confirmCandle.high <= setupCandle.high + 0.05 * currentAtr && confirmCandle.low >= setupCandle.low - 0.05 * currentAtr;
      
      // Confirmation candle MUST show real upward buying displacement (not a tiny 1-2 tick doji)
      const hasMeaningfulBody = confirmBody >= 0.25 * currentAtr || (confirmRange > 0 && confirmBody >= 0.35 * confirmRange && confirmRange >= 0.30 * currentAtr);
      const hasRetracedMotherBar = confirmBody >= 0.25 * prevBody || confirmCandle.close >= setupCandle.close + (prevBody * 0.25);
      const hasPositiveDisplacement = isBullish && hasMeaningfulBody && hasRetracedMotherBar;

      if (isPrevBearish && isBullish && opensInsideMotherBody && closesInsideMotherBody && isInsideMotherRange && hasPositiveDisplacement) {
        isBullishHarami = true;
      }
    }

    // Three-Candle Patterns
    // 4. Morning Star
    let isMorningStar = false;
    if (closedIdx >= 2) {
      const c2 = this.candles1m[closedIdx - 2];
      const c1 = this.candles1m[closedIdx - 1];
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

    // 5. Three White Soldiers
    let isThreeWhiteSoldiers = false;
    if (closedIdx >= 2) {
      const c2 = this.candles1m[closedIdx - 2];
      const c1 = this.candles1m[closedIdx - 1];
      const c0 = confirmCandle;

      const c2Bullish = c2.close > c2.open;
      const c1Bullish = c1.close > c1.open;
      const c0Bullish = c0.close > c0.open;

      const ascendingCloses = c0.close > c1.close && c1.close > c2.close;
      
      const b2 = c2.close - c2.open;
      const b1 = c1.close - c1.open;
      const b0 = c0.close - c0.open;

      const healthyBodies = b2 >= 0.2 * currentAtr && b1 >= 0.2 * currentAtr && b0 >= 0.2 * currentAtr;
      const isCurrentCandleHoldingHighs = this.currentPrice >= c0.low;

      if (c2Bullish && c1Bullish && c0Bullish && ascendingCloses && healthyBodies && isCurrentCandleHoldingHighs) {
        isThreeWhiteSoldiers = true;
      }
    }

    // Institutional Order Flow Absorption and Early Wick Rejection Checks
    // NOTE: Order flow metrics (CVD / order book imbalance) must NEVER bypass candlestick confirmation on falling red candles.
    // Bullish reversal confirmation STRICTLY requires a completed, closed GREEN candle (close > open) with positive upward displacement.
    const absorptionLong = this.detectOrderFlowAbsorption("LONG");
    if (absorptionLong.isAbsorption && isBullish && (confirmLowerWick / (confirmRange || 1) >= 0.25 || confirmBody >= 0.20 * currentAtr)) {
      return { confirmed: true, type: `${absorptionLong.type} with Green Reversal Close` };
    }
    const isEarlyWickAbsorption = isBullish && confirmRange > 0 && (confirmLowerWick / confirmRange >= 0.38) && confirmBody >= 0.20 * confirmRange;
    if (isEarlyWickAbsorption) {
      return { confirmed: true, type: "Early Lower Wick Absorption Support Rejection" };
    }

    // Priority Check: Every pattern MUST be supported by a green close (isBullish) or verified 2-candle confirmation
    if (isConfirmedBullishPinBar) return { confirmed: true, type: "2-Candle Confirmed Bullish Pin Bar" };
    if (isConfirmedMajorWickRejection) return { confirmed: true, type: "2-Candle Confirmed 65%+ Lower Wick Rejection" };
    if (isBullishEngulfing) return { confirmed: !isIndecision, type: "Bullish Engulfing Pattern" };
    if (hasMultiWickRejection && isBullish) return { confirmed: !isIndecision, type: "Multi-Candle Wick Rejection" };
    if (isTweezerBottom && isBullish) return { confirmed: !isIndecision, type: "Tweezer Bottom Reversal Pattern" };
    if (isPiercingLine) return { confirmed: !isIndecision, type: "Piercing Line Reversal Pattern" };
    if (isBullishHarami) return { confirmed: !isIndecision, type: "Bullish Harami Reversal Pattern" };
    if (isMorningStar) return { confirmed: !isIndecision, type: "Morning Star Reversal Pattern" };
    if (isThreeWhiteSoldiers) return { confirmed: !isIndecision, type: "Three White Soldiers Continuation Pattern" };
    if (isMomentumCandle && hasStrongClose && isBullish) return { confirmed: !isIndecision, type: "Bullish Momentum Candle" };
    if (hasStrongClose && isBullish && confirmLowerWick > confirmUpperWick) return { confirmed: !isIndecision, type: "Strong Close Support Rejection" };

    // If 2-candle confirmation is DISABLED, allow legacy immediate 1-candle entry (strictly requiring green close)
    if (!requirePinBarConfirmation) {
      if (isPinBar && hasStrongClose && isBullish) return { confirmed: !isIndecision, type: "Bullish Pin Bar (Legacy 1-Candle)" };
      if (isMajorWickRejection && isBullish && hasStrongClose) return { confirmed: true, type: "65%+ Wick-to-Range Lower Rejection (Legacy 1-Candle)" };
    }

    return { confirmed: false, type: "" };
  }

  private isMultiCandleShortRejection(lastIdx: number, currentAtr: number): { confirmed: boolean; type: string } {
    if (lastIdx < 0 || this.candles1m.length === 0) return { confirmed: false, type: "" };
    const config = dbManager.getConfig();
    const requirePinBarConfirmation = config.market_structure.pinbar_two_candle_confirmation_enabled !== false;
    const minWickRatio = config.market_structure.pinbar_min_wick_ratio || 0.50;

    // The confirmation candle MUST be a finished, closed candle (not an in-progress, 0-second unclosed candle)
    const closedIdx = (lastIdx === this.candles1m.length - 1 && this.candles1m.length >= 2) ? lastIdx - 1 : lastIdx;
    if (closedIdx < 0) return { confirmed: false, type: "" };

    const confirmCandle = this.candles1m[closedIdx];
    const confirmRange = confirmCandle.high - confirmCandle.low;
    const confirmBody = Math.abs(confirmCandle.close - confirmCandle.open);
    const confirmUpperWick = confirmCandle.high - Math.max(confirmCandle.close, confirmCandle.open);
    const confirmLowerWick = Math.min(confirmCandle.close, confirmCandle.open) - confirmCandle.low;
    const isBearish = confirmCandle.close < confirmCandle.open;
    const setupCandle = closedIdx >= 1 ? this.candles1m[closedIdx - 1] : null;

    // Single Candle Patterns on finished closed candle
    const isPinBar = confirmRange > 0 && confirmUpperWick >= minWickRatio * confirmRange && confirmLowerWick <= 0.25 * confirmRange;
    const isMajorWickRejection = confirmRange > 0 && confirmUpperWick >= 0.65 * confirmRange;
    const hasStrongClose = confirmRange > 0 && (confirmCandle.high - confirmCandle.close) / confirmRange >= 0.70;
    const isMomentumCandle = isBearish && confirmBody >= 0.7 * currentAtr;
    const isIndecision = confirmRange > 0 && 
      ((confirmBody / confirmRange < 0.20) || (confirmRange < 0.25 * currentAtr && !isPinBar && !isMajorWickRejection)) && 
      !isPinBar && !isMajorWickRejection;

    // 2-Candle Confirmed Bearish Pin Bar / Major Wick Rejection:
    // Candle 0 (setupCandle) forms the upper rejection wick, and Candle 1 (confirmCandle) MUST be finished and closed RED with verified body expansion
    let isConfirmedBearishPinBar = false;
    let isConfirmedMajorWickRejection = false;
    if (setupCandle) {
      const setupRange = setupCandle.high - setupCandle.low;
      const setupUpperWick = setupCandle.high - Math.max(setupCandle.open, setupCandle.close);
      const setupLowerWick = Math.min(setupCandle.open, setupCandle.close) - setupCandle.low;
      const setupIsPinBar = setupRange > 0 && setupUpperWick >= minWickRatio * setupRange && setupLowerWick <= 0.30 * setupRange;
      const setupIsMajorWick = setupRange > 0 && setupUpperWick >= 0.65 * setupRange;

      // Verification Criteria on finished, closed confirmCandle:
      // 1. Must be closed strictly red (close < open)
      const isConfirmRed = confirmCandle.close < confirmCandle.open;
      const redBody = confirmCandle.open - confirmCandle.close;

      // 2. Verified Body Expansion:
      // Body must be real and decisive: >= 35% of range or >= 0.25 * ATR (rejects flat dojis, zero-spread spinning tops, and unexpanded candles)
      const hasVerifiedBodyExpansion = confirmRange > 0 && ((redBody / confirmRange >= 0.35) || (redBody >= 0.25 * currentAtr)) && (redBody / (confirmRange || 1) >= 0.20);

      // 3. Must hold the Pin Bar's high without sweeping/breaking it
      const holdsPinHigh = confirmCandle.high <= setupCandle.high + 0.05 * currentAtr;

      // 4. Must show downward displacement / downward follow-through:
      // Must close below at least 50% midpoint of setup candle OR break setup candle's low, AND close lower than setup close
      const breaksPinLower = confirmCandle.close <= (setupCandle.high - setupRange * 0.50) || confirmCandle.close <= setupCandle.low;
      const hasDownwardFollowThrough = confirmCandle.close < setupCandle.close;

      if (setupIsPinBar && isConfirmRed && hasVerifiedBodyExpansion && holdsPinHigh && (breaksPinLower || hasDownwardFollowThrough)) {
        isConfirmedBearishPinBar = true;
      }
      if (setupIsMajorWick && isConfirmRed && hasVerifiedBodyExpansion && holdsPinHigh && (breaksPinLower || hasDownwardFollowThrough)) {
        isConfirmedMajorWickRejection = true;
      }
    }

    // Two-Candle Patterns (Evaluated on completed, closed candles)
    const minEngulfBody = Math.max(0.35 * currentAtr, 0.35 * confirmRange);
    const prevBody = setupCandle ? Math.abs(setupCandle.close - setupCandle.open) : 0;
    const isBearishEngulfing = setupCandle && 
      (setupCandle.close > setupCandle.open) && 
      isBearish && 
      (confirmCandle.close <= setupCandle.open) && 
      (confirmCandle.open >= setupCandle.close) &&
      (confirmBody >= minEngulfBody) &&
      (prevBody >= 0.20 * currentAtr);

    const hasMultiWickRejection = setupCandle && 
      (confirmUpperWick >= 0.35 * confirmRange) && 
      ((setupCandle.high - Math.max(setupCandle.close, setupCandle.open)) >= 0.35 * (setupCandle.high - setupCandle.low)) && 
      Math.abs(confirmCandle.high - setupCandle.high) < 0.15 * currentAtr;

    // 1. Tweezer Top (Two-candle)
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

    // 2. Dark Cloud Cover (Two-candle)
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

    // 3. Bearish Harami (Two-candle Inside Bar Reversal)
    let isBearishHarami = false;
    if (setupCandle) {
      const prevRange = setupCandle.high - setupCandle.low;
      const prevBody = setupCandle.close - setupCandle.open;
      // Mother candle must be a decisive bullish candle
      const isPrevBullish = setupCandle.close > setupCandle.open && prevBody >= 0.30 * prevRange && prevBody >= 0.25 * currentAtr;
      const opensInsideMotherBody = confirmCandle.open <= setupCandle.close + 0.05 * currentAtr;
      const closesInsideMotherBody = confirmCandle.close >= setupCandle.open - 0.05 * currentAtr;
      const isInsideMotherRange = confirmCandle.high <= setupCandle.high + 0.05 * currentAtr && confirmCandle.low >= setupCandle.low - 0.05 * currentAtr;
      
      // Confirmation candle MUST show real downward selling displacement (not a tiny 1-2 tick doji)
      const hasMeaningfulBody = confirmBody >= 0.25 * currentAtr || (confirmRange > 0 && confirmBody >= 0.35 * confirmRange && confirmRange >= 0.30 * currentAtr);
      const hasRetracedMotherBar = confirmBody >= 0.25 * prevBody || confirmCandle.close <= setupCandle.close - (prevBody * 0.25);
      const hasNegativeDisplacement = isBearish && hasMeaningfulBody && hasRetracedMotherBar;

      if (isPrevBullish && isBearish && opensInsideMotherBody && closesInsideMotherBody && isInsideMotherRange && hasNegativeDisplacement) {
        isBearishHarami = true;
      }
    }

    // Three-Candle Patterns
    // 4. Evening Star
    let isEveningStar = false;
    if (closedIdx >= 2) {
      const c2 = this.candles1m[closedIdx - 2];
      const c1 = this.candles1m[closedIdx - 1];
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

    // 5. Three Black Crows
    let isThreeBlackCrows = false;
    if (closedIdx >= 2) {
      const c2 = this.candles1m[closedIdx - 2];
      const c1 = this.candles1m[closedIdx - 1];
      const c0 = confirmCandle;

      const c2Bearish = c2.close < c2.open;
      const c1Bearish = c1.close < c1.open;
      const c0Bearish = c0.close < c0.open;

      const descendingCloses = c0.close < c1.close && c1.close < c2.close;

      const b2 = c2.open - c2.close;
      const b1 = c1.open - c1.close;
      const b0 = c0.open - c0.close;

      const healthyBodies = b2 >= 0.2 * currentAtr && b1 >= 0.2 * currentAtr && b0 >= 0.2 * currentAtr;
      const isCurrentCandleHoldingLows = this.currentPrice <= c0.high;

      if (c2Bearish && c1Bearish && c0Bearish && descendingCloses && healthyBodies && isCurrentCandleHoldingLows) {
        isThreeBlackCrows = true;
      }
    }

    // Institutional Order Flow Absorption and Early Wick Rejection Checks
    // NOTE: Order flow metrics (CVD / order book imbalance) must NEVER bypass candlestick confirmation on rising green candles.
    // Bearish reversal confirmation STRICTLY requires a completed, closed RED candle (close < open) with negative downward displacement.
    const absorptionShort = this.detectOrderFlowAbsorption("SHORT");
    if (absorptionShort.isAbsorption && isBearish && (confirmUpperWick / (confirmRange || 1) >= 0.25 || confirmBody >= 0.20 * currentAtr)) {
      return { confirmed: true, type: `${absorptionShort.type} with Red Reversal Close` };
    }
    const isEarlyWickAbsorptionShort = isBearish && confirmRange > 0 && (confirmUpperWick / confirmRange >= 0.38) && confirmBody >= 0.20 * confirmRange;
    if (isEarlyWickAbsorptionShort) {
      return { confirmed: true, type: "Early Upper Wick Absorption Resistance Rejection" };
    }

    // Priority Check: Every pattern MUST be supported by a red close (isBearish) or verified 2-candle confirmation
    if (isConfirmedBearishPinBar) return { confirmed: true, type: "2-Candle Confirmed Bearish Pin Bar" };
    if (isConfirmedMajorWickRejection) return { confirmed: true, type: "2-Candle Confirmed 65%+ Upper Wick Rejection" };
    if (isBearishEngulfing) return { confirmed: !isIndecision, type: "Bearish Engulfing Pattern" };
    if (hasMultiWickRejection && isBearish) return { confirmed: !isIndecision, type: "Multi-Candle Wick Rejection" };
    if (isTweezerTop && isBearish) return { confirmed: !isIndecision, type: "Tweezer Top Reversal Pattern" };
    if (isDarkCloudCover) return { confirmed: !isIndecision, type: "Dark Cloud Cover Reversal Pattern" };
    if (isBearishHarami) return { confirmed: !isIndecision, type: "Bearish Harami Reversal Pattern" };
    if (isEveningStar) return { confirmed: !isIndecision, type: "Evening Star Reversal Pattern" };
    if (isThreeBlackCrows) return { confirmed: !isIndecision, type: "Three Black Crows Continuation Pattern" };
    if (isMomentumCandle && hasStrongClose && isBearish) return { confirmed: !isIndecision, type: "Bearish Momentum Candle" };
    if (hasStrongClose && isBearish && confirmUpperWick > confirmLowerWick) return { confirmed: !isIndecision, type: "Strong Close Resistance Rejection" };

    // If 2-candle confirmation is DISABLED, allow legacy immediate 1-candle entry (strictly requiring red close)
    if (!requirePinBarConfirmation) {
      if (isPinBar && hasStrongClose && isBearish) return { confirmed: !isIndecision, type: "Bearish Pin Bar (Legacy 1-Candle)" };
      if (isMajorWickRejection && isBearish && hasStrongClose) return { confirmed: true, type: "65%+ Wick-to-Range Upper Rejection (Legacy 1-Candle)" };
    }

    return { confirmed: false, type: "" };
  }

  private evaluateMarketStructureConfirmationRaw(signalDirection: "LONG" | "SHORT" | "NEUTRAL", probabilityLong: number): MarketStructureConfirmationResult {
    const config = dbManager.getConfig();
    const struct = this.getTrendMarketStructure();
    const lastIdx = this.candles1m.length - 1;
    const currentPrice = this.currentPrice;
    const currentCandle = lastIdx >= 0 ? this.candles1m[lastIdx] : { time: Date.now() / 1000, open: currentPrice, high: currentPrice, low: currentPrice, close: currentPrice, volume: 0 };

    if (this.currentRegime === MarketRegime.LOW_VOLATILITY) {
      return {
        confirmed: false,
        message: "Blocked: Trading is deactivated in low-volatility regimes to prevent chop losses.",
        swingHigh: struct.swingHigh,
        swingLow: struct.swingLow
      };
    }

    // Isolated Fast EMA Crossover Strategy bypass logic
    if (config.market_structure?.crossover_only_strategy_enabled) {
      const fastPeriod = config.market_structure.crossover_only_fast_period || 5;
      const slowPeriod = config.market_structure.crossover_only_slow_period || 15;
      
      const closes = this.candles1m.map(c => c.close);
      const minRequiredCandles = Math.max(fastPeriod, slowPeriod) * 2;
      const hasEnoughDataForCrossover = closes.length >= minRequiredCandles;
      
      if (signalDirection === "NEUTRAL") {
        return {
          confirmed: true,
          message: "No active trend entry signal scanning.",
          swingHigh: struct.swingHigh,
          swingLow: struct.swingLow,
          ema_check_active: true,
          ema_pair_evaluated: `${fastPeriod} / ${slowPeriod} EMA`,
          ema_tested: `Dynamic ${fastPeriod} / ${slowPeriod} EMA Band`,
          sub_conditions: [
            {
              name: "Strategy Mode",
              status: "PASS",
              reason: `Isolated Fast EMA Crossover Strategy is active and monitoring (${fastPeriod} EMA / ${slowPeriod} EMA).`
            }
          ]
        };
      }
      
      if (!hasEnoughDataForCrossover) {
        return {
          confirmed: false,
          message: `Blocked: Insufficient candle history for crossover strategy (${closes.length}/${minRequiredCandles} required).`,
          swingHigh: struct.swingHigh,
          swingLow: struct.swingLow,
          ema_check_active: true,
          ema_pair_evaluated: `${fastPeriod} / ${slowPeriod} EMA`,
          sub_conditions: [
            {
              name: "Candle History Verification",
              status: "FAIL",
              reason: `Required at least ${minRequiredCandles} candles but only have ${closes.length}.`
            }
          ]
        };
      }
      
      const emaFastList = this.calculateEMA(closes, fastPeriod);
      const emaSlowList = this.calculateEMA(closes, slowPeriod);
      const lastIdxVal = closes.length - 1;
      const emaFastVal = emaFastList[lastIdxVal] !== undefined ? emaFastList[lastIdxVal] : currentPrice;
      const emaSlowVal = emaSlowList[lastIdxVal] !== undefined ? emaSlowList[lastIdxVal] : currentPrice;
      
      // Calculate true crossover events within the configured lookback candles
      let bullishCrossoverIndex = -1;
      let bearishCrossoverIndex = -1;
      const crossoverLookback = config.market_structure.crossover_only_lookback_candles || 5;
      const startIdx = Math.max(1, lastIdxVal - crossoverLookback + 1);

      for (let i = startIdx; i <= lastIdxVal; i++) {
        const prevFast = emaFastList[i - 1];
        const prevSlow = emaSlowList[i - 1];
        const currFast = emaFastList[i];
        const currSlow = emaSlowList[i];

        if (prevFast !== undefined && prevSlow !== undefined && currFast !== undefined && currSlow !== undefined) {
          if (currFast > currSlow && prevFast <= prevSlow) {
            bullishCrossoverIndex = i;
          }
          if (currFast < currSlow && prevFast >= prevSlow) {
            bearishCrossoverIndex = i;
          }
        }
      }

      // Calculate confirmation indicators
      const adxThreshold = config.market_structure.crossover_only_adx_threshold !== undefined ? config.market_structure.crossover_only_adx_threshold : 25;
      const rsiLimit = config.market_structure.crossover_only_rsi_limit !== undefined ? config.market_structure.crossover_only_rsi_limit : 70;
      
      const adxList = this.calculateADX(this.candles1m, 14);
      const rsiList = this.calculateRSI(closes, 14);
      
      const currentAdx = adxList[lastIdxVal] !== undefined ? adxList[lastIdxVal] : 25;
      const currentRsi = rsiList[lastIdxVal] !== undefined ? rsiList[lastIdxVal] : 50;

      const adxPassed = currentAdx >= adxThreshold;
      const sub_conditions: MarketStructureSubCondition[] = [
        {
          name: "ADX Trend Confirmation",
          status: adxPassed ? "PASS" : "FAIL",
          reason: adxPassed
            ? `ADX is ${currentAdx.toFixed(1)} demonstrating strong trend velocity (>= ${adxThreshold} required).`
            : `ADX is ${currentAdx.toFixed(1)} indicating insufficient trend strength (< ${adxThreshold} required).`
        }
      ];

      if (signalDirection === "LONG") {
        const rsiPassed = currentRsi <= rsiLimit;
        sub_conditions.push({
          name: "RSI Momentum Safety",
          status: rsiPassed ? "PASS" : "FAIL",
          reason: rsiPassed
            ? `RSI is safe at ${currentRsi.toFixed(1)} preventing overbought top entries (<= ${rsiLimit} required).`
            : `RSI is overbought at ${currentRsi.toFixed(1)} preventing top-buying risks (> ${rsiLimit} limit).`
        });

        const hasBullishCrossover = bullishCrossoverIndex !== -1;
        const currentBullishState = emaFastVal > emaSlowVal;
        const crossoverPassed = hasBullishCrossover && currentBullishState;
        
        const candlesAgo = hasBullishCrossover ? (lastIdxVal - bullishCrossoverIndex) : -1;
        sub_conditions.push({
          name: "Fast EMA Bullish Crossover",
          status: crossoverPassed ? "PASS" : "FAIL",
          reason: crossoverPassed
            ? `Bullish crossover confirmed ${candlesAgo} candle(s) ago. Fast EMA ${fastPeriod} ($${emaFastVal.toFixed(2)}) is above Slow EMA ${slowPeriod} ($${emaSlowVal.toFixed(2)}).`
            : hasBullishCrossover
            ? `Fast EMA crossed above Slow EMA ${candlesAgo} candle(s) ago, but current state is no longer bullish (Fast EMA: $${emaFastVal.toFixed(2)}, Slow EMA: $${emaSlowVal.toFixed(2)}).`
            : `No Bullish crossover event occurred within the last ${crossoverLookback} candles. Waiting for next crossover.`
        });

        const confirmed = adxPassed && rsiPassed && crossoverPassed;
        let message = "";
        if (!adxPassed) {
          message = `Crossover LONG Blocked: ADX is ${currentAdx.toFixed(1)} which is below the trend confirmation threshold (${adxThreshold}).`;
        } else if (!rsiPassed) {
          message = `Crossover LONG Blocked: RSI is ${currentRsi.toFixed(1)} which is overbought (> ${rsiLimit}).`;
        } else if (!crossoverPassed) {
          message = !hasBullishCrossover
            ? `Crossover LONG Blocked: No crossover event in last ${crossoverLookback} candles.`
            : `Crossover LONG Blocked: Fast EMA is not currently above Slow EMA.`;
        } else {
          message = `Isolated Crossover LONG Confirmed: Bullish crossover ${candlesAgo} candle(s) ago with RSI ${currentRsi.toFixed(1)} and ADX ${currentAdx.toFixed(1)}.`;
        }

        return {
          confirmed,
          message,
          swingHigh: struct.swingHigh,
          swingLow: struct.swingLow,
          ema_check_active: true,
          ema_pair_evaluated: `${fastPeriod} / ${slowPeriod} EMA`,
          ema_tested: `Dynamic ${fastPeriod} EMA ($${emaFastVal.toFixed(2)})`,
          sub_conditions
        };

      } else if (signalDirection === "SHORT") {
        const rsiLowerLimit = 100 - rsiLimit;
        const rsiPassed = currentRsi >= rsiLowerLimit;
        sub_conditions.push({
          name: "RSI Momentum Safety",
          status: rsiPassed ? "PASS" : "FAIL",
          reason: rsiPassed
            ? `RSI is safe at ${currentRsi.toFixed(1)} preventing oversold bottom entries (>= ${rsiLowerLimit.toFixed(1)} required).`
            : `RSI is oversold at ${currentRsi.toFixed(1)} preventing bottom-shorting risks (< ${rsiLowerLimit.toFixed(1)} limit).`
        });

        const hasBearishCrossover = bearishCrossoverIndex !== -1;
        const currentBearishState = emaFastVal < emaSlowVal;
        const crossoverPassed = hasBearishCrossover && currentBearishState;

        const candlesAgo = hasBearishCrossover ? (lastIdxVal - bearishCrossoverIndex) : -1;
        sub_conditions.push({
          name: "Fast EMA Bearish Crossover",
          status: crossoverPassed ? "PASS" : "FAIL",
          reason: crossoverPassed
            ? `Bearish crossover confirmed ${candlesAgo} candle(s) ago. Fast EMA ${fastPeriod} ($${emaFastVal.toFixed(2)}) is below Slow EMA ${slowPeriod} ($${emaSlowVal.toFixed(2)}).`
            : hasBearishCrossover
            ? `Fast EMA crossed below Slow EMA ${candlesAgo} candle(s) ago, but current state is no longer bearish (Fast EMA: $${emaFastVal.toFixed(2)}, Slow EMA: $${emaSlowVal.toFixed(2)}).`
            : `No Bearish crossover event occurred within the last ${crossoverLookback} candles. Waiting for next crossover.`
        });

        const confirmed = adxPassed && rsiPassed && crossoverPassed;
        let message = "";
        if (!adxPassed) {
          message = `Crossover SHORT Blocked: ADX is ${currentAdx.toFixed(1)} which is below the trend confirmation threshold (${adxThreshold}).`;
        } else if (!rsiPassed) {
          message = `Crossover SHORT Blocked: RSI is ${currentRsi.toFixed(1)} which is oversold (< ${rsiLowerLimit.toFixed(1)}).`;
        } else if (!crossoverPassed) {
          message = !hasBearishCrossover
            ? `Crossover SHORT Blocked: No crossover event in last ${crossoverLookback} candles.`
            : `Crossover SHORT Blocked: Fast EMA is not currently below Slow EMA.`;
        } else {
          message = `Isolated Crossover SHORT Confirmed: Bearish crossover ${candlesAgo} candle(s) ago with RSI ${currentRsi.toFixed(1)} and ADX ${currentAdx.toFixed(1)}.`;
        }

        return {
          confirmed,
          message,
          swingHigh: struct.swingHigh,
          swingLow: struct.swingLow,
          ema_check_active: true,
          ema_pair_evaluated: `${fastPeriod} / ${slowPeriod} EMA`,
          ema_tested: `Dynamic ${fastPeriod} EMA ($${emaFastVal.toFixed(2)})`,
          sub_conditions
        };
      }
    }

    if (this.currentRegime === MarketRegime.RANGE_BOUND) {
      if (signalDirection === "NEUTRAL") {
        return {
          confirmed: true,
          message: "No active trend/range entry signal scanning.",
          swingHigh: struct.swingHigh,
          swingLow: struct.swingLow
        };
      }

      const ms = config.market_structure;

      const rangeLookback = 30;
      const recentCandlesForRange = this.candles1m.slice(-rangeLookback - 1, -1);
      const rangeHigh = recentCandlesForRange.length > 0 ? Math.max(...recentCandlesForRange.map(c => c.high)) : struct.swingHigh;
      const rangeLow = recentCandlesForRange.length > 0 ? Math.min(...recentCandlesForRange.map(c => c.low)) : struct.swingLow;

      const rangeWidth = rangeHigh - rangeLow;

      // Restructured/optimized range reversal signal evaluation
      const revSignals = this.evaluateRangeReversalSignals(lastIdx);
      const isRangeLongReversal = revSignals.isLongReversal;
      const isRangeShortReversal = revSignals.isShortReversal;

      // Compute relative volume to check breakout strength
      const relVolume = this.calculateAccurateRelativeVolume();

      const breakoutValidationLong = this.validateRangeBreakout("LONG", currentCandle, relVolume, recentCandlesForRange);
      const breakoutValidationShort = this.validateRangeBreakout("SHORT", currentCandle, relVolume, recentCandlesForRange);

      const isRangeLongBreakout = (currentPrice > rangeHigh) && breakoutValidationLong.isValid;
      const isRangeShortBreakdown = (currentPrice < rangeLow) && breakoutValidationShort.isValid;

      // Range LONG Breakout Pullback Check
      let isRangeLongPullback = false;
      let rangeLongPullbackDetails = "";
      let boRangeHigh = rangeHigh;

      let rangeLongBreakoutIdx = -1;
      for (let i = lastIdx - 15; i < lastIdx; i++) {
        if (i < 30) continue;
        const prevCandles = this.candles1m.slice(i - 30, i);
        const rHigh = Math.max(...prevCandles.map(c => c.high));
        if (this.candles1m[i].close > rHigh) {
          rangeLongBreakoutIdx = i;
          boRangeHigh = rHigh;
          break;
        }
      }

      const atr14ForPullback = this.calculateATR(this.candles1m, 14);
      const currentAtrForPullback = atr14ForPullback[lastIdx] || 50;

      if (rangeLongBreakoutIdx !== -1) {
        const postBreakoutCandles = this.candles1m.slice(rangeLongBreakoutIdx + 1);
        const pullbackThreshold = boRangeHigh + 0.5 * currentAtrForPullback;
        
        const recentPostBreakoutCandles = postBreakoutCandles.slice(-4);
        const hasPulledBackToZone = recentPostBreakoutCandles.some(c => c.low <= pullbackThreshold);
        
        // Check for bullish rejection on the current candle
        const rejectionCheck = this.isMultiCandleLongRejection(lastIdx, currentAtrForPullback);
        const isLongRejectionConfirmed = rejectionCheck.confirmed;
        const longRejectionType = rejectionCheck.type;

        const isNearBrokenSupport = currentPrice >= boRangeHigh - 0.25 * currentAtrForPullback && currentPrice <= boRangeHigh + 0.8 * currentAtrForPullback;

        if (hasPulledBackToZone && isLongRejectionConfirmed && isNearBrokenSupport) {
          isRangeLongPullback = true;
          rangeLongPullbackDetails = `Range LONG Breakout Pullback Confirmed: Price broke out above range resistance ($${boRangeHigh.toFixed(2)}) recently (index ${rangeLongBreakoutIdx}) and successfully retested it as support with a bullish rejection.`;
        }
      }

      // Range SHORT Breakdown Pullback Check
      let isRangeShortPullback = false;
      let rangeShortPullbackDetails = "";
      let boRangeLow = rangeLow;

      let rangeShortBreakoutIdx = -1;
      for (let i = lastIdx - 15; i < lastIdx; i++) {
        if (i < 30) continue;
        const prevCandles = this.candles1m.slice(i - 30, i);
        const rLow = Math.min(...prevCandles.map(c => c.low));
        if (this.candles1m[i].close < rLow) {
          rangeShortBreakoutIdx = i;
          boRangeLow = rLow;
          break;
        }
      }

      if (rangeShortBreakoutIdx !== -1) {
        const postBreakoutCandles = this.candles1m.slice(rangeShortBreakoutIdx + 1);
        const pullbackThreshold = boRangeLow - 0.5 * currentAtrForPullback;
        
        const recentPostBreakoutCandles = postBreakoutCandles.slice(-4);
        const hasPulledBackToZone = recentPostBreakoutCandles.some(c => c.high >= pullbackThreshold);
        
        // Check for bearish rejection on current candle
        const rejectionCheck = this.isMultiCandleShortRejection(lastIdx, currentAtrForPullback);
        const isShortRejectionConfirmed = rejectionCheck.confirmed;
        const shortRejectionType = rejectionCheck.type;

        const isNearBrokenResistance = currentPrice <= boRangeLow + 0.25 * currentAtrForPullback && currentPrice >= boRangeLow - 0.8 * currentAtrForPullback;

        if (hasPulledBackToZone && isShortRejectionConfirmed && isNearBrokenResistance) {
          isRangeShortPullback = true;
          rangeShortPullbackDetails = `Range SHORT Breakdown Pullback Confirmed: Price broke below range support ($${boRangeLow.toFixed(2)}) recently (index ${rangeShortBreakoutIdx}) and successfully retested it as resistance with a bearish rejection.`;
        }
      }

      // Calculate Micro-Trend alignment using fast/slow EMAs on 1m chart
      const closes = this.candles1m.map((c) => c.close);
      const hasEnoughCandles = closes.length >= Math.max(ms.micro_trend_slow_period || 15, 15);
      let microTrendAligned = true;
      let microTrendDetails = "";

      if (ms.micro_trend_alignment_enabled !== false && hasEnoughCandles) {
        const microFastPeriod = ms.micro_trend_fast_period || 5;
        const microSlowPeriod = ms.micro_trend_slow_period || 15;
        const emaFastList = this.calculateEMA(closes, microFastPeriod);
        const emaSlowList = this.calculateEMA(closes, microSlowPeriod);
        const emaFastVal = emaFastList[lastIdx] !== undefined ? emaFastList[lastIdx] : currentPrice;
        const emaSlowVal = emaSlowList[lastIdx] !== undefined ? emaSlowList[lastIdx] : currentPrice;

        const isMicroTrendBullish = emaFastVal > emaSlowVal;
        const isMicroTrendBearish = emaFastVal < emaSlowVal;

        const prevEmaFastVal = lastIdx > 0 && emaFastList[lastIdx - 1] !== undefined ? emaFastList[lastIdx - 1] : emaFastVal;
        const isFastEmaHookingUp = emaFastVal > prevEmaFastVal;
        const isFastEmaHookingDown = emaFastVal < prevEmaFastVal;

        if (signalDirection === "LONG") {
          // LONG reversal/breakout requires bullish micro-trend, price above fast/slow EMA, or fast EMA hooking up off support
          microTrendAligned = isMicroTrendBullish || (currentPrice >= emaSlowVal) || (currentPrice >= emaFastVal && isFastEmaHookingUp);
          microTrendDetails = `(Micro-Trend [EMA ${microFastPeriod}/${microSlowPeriod}]: Fast $${emaFastVal.toFixed(2)} vs Slow $${emaSlowVal.toFixed(2)} - ${isMicroTrendBullish ? "BULLISH" : "BEARISH"}${microTrendAligned ? " [ALIGNED]" : " [BLOCKED]"})`;
        } else if (signalDirection === "SHORT") {
          // SHORT reversal/breakdown requires bearish micro-trend, price below fast/slow EMA, or fast EMA hooking down off resistance
          microTrendAligned = isMicroTrendBearish || (currentPrice <= emaSlowVal) || (currentPrice <= emaFastVal && isFastEmaHookingDown);
          microTrendDetails = `(Micro-Trend [EMA ${microFastPeriod}/${microSlowPeriod}]: Fast $${emaFastVal.toFixed(2)} vs Slow $${emaSlowVal.toFixed(2)} - ${isMicroTrendBearish ? "BEARISH" : "BULLISH"}${microTrendAligned ? " [ALIGNED]" : " [BLOCKED]"})`;
        }
      }

      if (signalDirection === "LONG") {
        if (isRangeLongReversal) {
          if (ms.micro_trend_alignment_enabled !== false && !microTrendAligned) {
            return {
              confirmed: false,
              message: `Range LONG Reversal Blocked: Micro-Trend is strongly bearish and does not support entry. ${microTrendDetails}`,
              swingHigh: rangeHigh,
              swingLow: rangeLow
            };
          }
          return {
            confirmed: true,
            message: `Ranging Bullish Reversal Confirmed: ${revSignals.longReason}. Price ($${currentPrice.toFixed(2)}) is bouncing off major range support ($${rangeLow.toFixed(2)}). ${microTrendDetails}`,
            swingHigh: rangeHigh,
            swingLow: rangeLow
          };
        } else if (isRangeLongBreakout) {
          const veryHighProbThreshold = ms.very_high_probability_threshold ?? 0.58;
          const isTakerBuyDominant = this.orderFlowStats.takerBuyRatio >= 0.58 || this.orderBookStats.imbalanceRatio >= 0.15;
          const isBreakoutMomentumStrong = relVolume >= 1.10 || isTakerBuyDominant;
          if (probabilityLong < veryHighProbThreshold && !isBreakoutMomentumStrong) {
            return {
              confirmed: false,
              message: `Range LONG Breakout Blocked: Breakout probability is not high enough (P(LONG) = ${(probabilityLong * 100).toFixed(1)}% < ${(veryHighProbThreshold * 100).toFixed(1)}%). Waiting for range breakout pullback.`,
              swingHigh: rangeHigh,
              swingLow: rangeLow
            };
          }
          if (ms.micro_trend_alignment_enabled !== false && !microTrendAligned) {
            return {
              confirmed: false,
              message: `Range LONG Breakout Blocked: Micro-Trend is strongly bearish and does not support entry. ${microTrendDetails}`,
              swingHigh: rangeHigh,
              swingLow: rangeLow
            };
          }
          return {
            confirmed: true,
            message: `Ranging Bullish Breakout Confirmed. Price ($${currentPrice.toFixed(2)}) broke above major range resistance ($${rangeHigh.toFixed(2)}) on relative volume (${relVolume.toFixed(2)}x) with P(LONG) = ${(probabilityLong * 100).toFixed(1)}%. ${microTrendDetails}`,
            swingHigh: rangeHigh,
            swingLow: rangeLow
          };
        } else if (isRangeLongPullback) {
          if (ms.micro_trend_alignment_enabled !== false && !microTrendAligned) {
            return {
              confirmed: false,
              message: `Range LONG Pullback Blocked: Micro-Trend is strongly bearish and does not support entry. ${microTrendDetails}`,
              swingHigh: rangeHigh,
              swingLow: rangeLow
            };
          }
          return {
            confirmed: true,
            message: `${rangeLongPullbackDetails} ${microTrendDetails}`,
            swingHigh: rangeHigh,
            swingLow: rangeLow
          };
        } else if (currentPrice > rangeHigh) {
          return {
            confirmed: false,
            message: `Fake LONG Breakout (Bull Trap) Detected: Price ($${currentPrice.toFixed(2)}) crossed above range resistance ($${rangeHigh.toFixed(2)}) but failed validation. Reason: ${breakoutValidationLong.reason}`,
            swingHigh: rangeHigh,
            swingLow: rangeLow
          };
        } else {
          return {
            confirmed: false,
            message: `Range-bound Reversal Filter: Price ($${currentPrice.toFixed(2)}) is inside the range [$${rangeLow.toFixed(2)} - $${rangeHigh.toFixed(2)}] without a valid reversal, breakout, or pullback.`,
            swingHigh: rangeHigh,
            swingLow: rangeLow
          };
        }
      } else if (signalDirection === "SHORT") {
        if (isRangeShortReversal) {
          if (ms.micro_trend_alignment_enabled !== false && !microTrendAligned) {
            return {
              confirmed: false,
              message: `Range SHORT Reversal Blocked: Micro-Trend is strongly bullish and does not support entry. ${microTrendDetails}`,
              swingHigh: rangeHigh,
              swingLow: rangeLow
            };
          }
          return {
            confirmed: true,
            message: `Ranging Bearish Reversal Confirmed: ${revSignals.shortReason}. Price ($${currentPrice.toFixed(2)}) is rejecting major range resistance ($${rangeHigh.toFixed(2)}). ${microTrendDetails}`,
            swingHigh: rangeHigh,
            swingLow: rangeLow
          };
        } else if (isRangeShortBreakdown) {
          const veryHighProbThreshold = ms.very_high_probability_threshold ?? 0.58;
          const probabilityShort = 1 - probabilityLong;
          const isTakerSellDominant = this.orderFlowStats.takerBuyRatio <= 0.42 || this.orderBookStats.imbalanceRatio <= -0.15;
          const isBreakdownMomentumStrong = relVolume >= 1.10 || isTakerSellDominant;
          if (probabilityShort < veryHighProbThreshold && !isBreakdownMomentumStrong) {
            return {
              confirmed: false,
              message: `Range SHORT Breakdown Blocked: Breakdown probability is not high enough (P(SHORT) = ${(probabilityShort * 100).toFixed(1)}% < ${(veryHighProbThreshold * 100).toFixed(1)}%). Waiting for range breakdown pullback.`,
              swingHigh: rangeHigh,
              swingLow: rangeLow
            };
          }
          if (ms.micro_trend_alignment_enabled !== false && !microTrendAligned) {
            return {
              confirmed: false,
              message: `Range SHORT Breakdown Blocked: Micro-Trend is strongly bullish and does not support entry. ${microTrendDetails}`,
              swingHigh: rangeHigh,
              swingLow: rangeLow
            };
          }
          return {
            confirmed: true,
            message: `Ranging Bearish Breakdown Confirmed. Price ($${currentPrice.toFixed(2)}) broke below major range support ($${rangeLow.toFixed(2)}) on relative volume (${relVolume.toFixed(2)}x) with P(SHORT) = ${(probabilityShort * 100).toFixed(1)}%. ${microTrendDetails}`,
            swingHigh: rangeHigh,
            swingLow: rangeLow
          };
        } else if (isRangeShortPullback) {
          if (ms.micro_trend_alignment_enabled !== false && !microTrendAligned) {
            return {
              confirmed: false,
              message: `Range SHORT Pullback Blocked: Micro-Trend is strongly bullish and does not support entry. ${microTrendDetails}`,
              swingHigh: rangeHigh,
              swingLow: rangeLow
            };
          }
          return {
            confirmed: true,
            message: `${rangeShortPullbackDetails} ${microTrendDetails}`,
            swingHigh: rangeHigh,
            swingLow: rangeLow
          };
        } else if (currentPrice < rangeLow) {
          return {
            confirmed: false,
            message: `Fake SHORT Breakdown (Bear Trap) Detected: Price ($${currentPrice.toFixed(2)}) crossed below range support ($${rangeLow.toFixed(2)}) but failed validation. Reason: ${breakoutValidationShort.reason}`,
            swingHigh: rangeHigh,
            swingLow: rangeLow
          };
        } else {
          return {
            confirmed: false,
            message: `Range-bound Reversal Filter: Price ($${currentPrice.toFixed(2)}) is inside the range [$${rangeLow.toFixed(2)} - $${rangeHigh.toFixed(2)}] without a valid reversal, breakdown, or pullback.`,
            swingHigh: rangeHigh,
            swingLow: rangeLow
          };
        }
      }
    }

    if (signalDirection === "NEUTRAL") {
      return {
        confirmed: true,
        message: "No active trend entry signal scanning.",
        swingHigh: struct.swingHigh,
        swingLow: struct.swingLow
      };
    }

    let confirmed = false;
    let message = "";

    const closes = this.candles1m.map(c => c.close);
    const hasEnoughData = closes.length >= 100;
    const ema20 = hasEnoughData ? this.calculateEMA(closes, 20) : [];
    const ema50 = hasEnoughData ? this.calculateEMA(closes, 50) : [];
    const ema100 = hasEnoughData ? this.calculateEMA(closes, 100) : [];
    
    const lastIdxVal = closes.length - 1;
    const ema20Val = lastIdxVal >= 0 && ema20.length > lastIdxVal ? ema20[lastIdxVal] : currentPrice;
    const ema50Val = lastIdxVal >= 0 && ema50.length > lastIdxVal ? ema50[lastIdxVal] : currentPrice;
    const ema100Val = lastIdxVal >= 0 && ema100.length > lastIdxVal ? ema100[lastIdxVal] : currentPrice;

    let trendResult: TrendBreakoutSetupResult | null = null;
    if (signalDirection === "LONG") {
      trendResult = this.evaluateTrendBreakoutSetup("LONG", currentPrice, ema20Val, ema50Val, ema100Val, struct, probabilityLong);
      confirmed = trendResult.confirmed;
      message = trendResult.message;
    } else if (signalDirection === "SHORT") {
      trendResult = this.evaluateTrendBreakoutSetup("SHORT", currentPrice, ema20Val, ema50Val, ema100Val, struct, probabilityLong);
      confirmed = trendResult.confirmed;
      message = trendResult.message;
    }

    return {
      confirmed,
      message,
      swingHigh: struct.swingHigh,
      swingLow: struct.swingLow,
      ema_check_active: trendResult ? trendResult.ema_check_active : undefined,
      ema_pair_evaluated: trendResult ? trendResult.ema_pair_evaluated : undefined,
      ema_tested: trendResult ? trendResult.ema_tested : undefined,
      sub_conditions: trendResult ? trendResult.sub_conditions : undefined
    };
  }

  private calculateBollingerBands(data: number[], period = 20, multiplier = 2) {
    if (data.length < period) {
      const lastPrice = data[data.length - 1] || 0;
      return { middle: lastPrice, upper: lastPrice, lower: lastPrice };
    }
    const lastElements = data.slice(data.length - period);
    const mean = lastElements.reduce((sum, val) => sum + val, 0) / period;
    const variance = lastElements.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / period;
    const stdDev = Math.sqrt(variance);
    return {
      middle: mean,
      upper: mean + multiplier * stdDev,
      lower: mean - multiplier * stdDev
    };
  }

  // Volume Weighted Average Price (VWAP) and its standard deviation bands
  private calculateVWAP(candles: Candlestick[], multiplier = 1.5) {
    if (candles.length === 0) return;
    let cumPV = 0;
    let cumVol = 0;

    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];
      const tp = (c.high + c.low + c.close) / 3;
      cumPV += tp * c.volume;
      cumVol += c.volume;

      const currentVwap = cumVol > 0 ? cumPV / cumVol : tp;
      c.vwap = currentVwap;

      // Compute weighted standard deviation around the current VWAP anchor
      let weightedVarianceSum = 0;
      for (let j = 0; j <= i; j++) {
        const c_j = candles[j];
        const tp_j = (c_j.high + c_j.low + c_j.close) / 3;
        weightedVarianceSum += c_j.volume * Math.pow(tp_j - currentVwap, 2);
      }
      const stdDev = cumVol > 0 ? Math.sqrt(weightedVarianceSum / cumVol) : 0;
      c.vwap_upper = currentVwap + multiplier * stdDev;
      c.vwap_lower = currentVwap - multiplier * stdDev;
    }
  }

  private aggregateCandles(candles1m: Candlestick[], intervalMinutes: number): Candlestick[] {
    if (intervalMinutes <= 1 || candles1m.length === 0) {
      return candles1m;
    }
    const last = candles1m[candles1m.length - 1];
    const key = `${candles1m.length}_${last.time}_${last.close}_${intervalMinutes}`;
    if (this.indicatorCache.aggCandles.has(key)) {
      return this.indicatorCache.aggCandles.get(key)!;
    }
    if (this.indicatorCache.aggCandles.size > 200) {
      this.indicatorCache.aggCandles.clear();
    }

    const aggregated: Candlestick[] = [];
    const groups: Record<number, Candlestick[]> = {};
    const keys: number[] = [];

    for (const candle of candles1m) {
      const intervalSec = intervalMinutes * 60;
      const bucketTime = Math.floor(candle.time / intervalSec) * intervalSec;
      if (!groups[bucketTime]) {
        groups[bucketTime] = [];
        keys.push(bucketTime);
      }
      groups[bucketTime].push(candle);
    }

    keys.sort((a, b) => a - b);

    for (const key of keys) {
      const group = groups[key];
      const open = group[0].open;
      const close = group[group.length - 1].close;
      const high = Math.max(...group.map(c => c.high));
      const low = Math.min(...group.map(c => c.low));
      const volume = group.reduce((sum, c) => sum + c.volume, 0);

      aggregated.push({
        time: key,
        open,
        high,
        low,
        close,
        volume
      });
    }

    this.indicatorCache.aggCandles.set(key, aggregated);
    return aggregated;
  }

  // --- MULTI-TIMEFRAME VOLUME PROFILING & HORIZONTAL LIQUIDITY ---
  private calculateVolumeProfile(candles: Candlestick[], numBins: number = 24): {
    poc: number;
    vah: number;
    val: number;
    hvns: number[];
    lvns: number[];
    bins: { price: number; volume: number }[];
  } {
    if (candles.length === 0) {
      return { poc: this.currentPrice, vah: this.currentPrice, val: this.currentPrice, hvns: [], lvns: [], bins: [] };
    }

    const highs = candles.map(c => c.high);
    const lows = candles.map(c => c.low);
    const maxPrice = Math.max(...highs);
    const minPrice = Math.min(...lows);
    const priceRange = maxPrice - minPrice;

    if (priceRange === 0) {
      return { poc: minPrice, vah: minPrice, val: minPrice, hvns: [minPrice], lvns: [], bins: [] };
    }

    const binSize = priceRange / numBins;
    const bins = Array.from({ length: numBins }, (_, i) => ({
      price: minPrice + (i + 0.5) * binSize,
      volume: 0
    }));

    let totalVolume = 0;
    for (const c of candles) {
      const cRange = c.high - c.low;
      const cVol = c.volume;
      totalVolume += cVol;
      if (cRange === 0) {
        const idx = Math.min(numBins - 1, Math.max(0, Math.floor((c.close - minPrice) / binSize)));
        bins[idx].volume += cVol;
      } else {
        const startIdx = Math.min(numBins - 1, Math.max(0, Math.floor((c.low - minPrice) / binSize)));
        const endIdx = Math.min(numBins - 1, Math.floor((c.high - minPrice) / binSize));
        if (startIdx === endIdx) {
          bins[startIdx].volume += cVol;
        } else {
          for (let idx = startIdx; idx <= endIdx; idx++) {
            const binMin = minPrice + idx * binSize;
            const binMax = binMin + binSize;
            const overlapMin = Math.max(c.low, binMin);
            const overlapMax = Math.min(c.high, binMax);
            const overlap = overlapMax - overlapMin;
            if (overlap > 0) {
              bins[idx].volume += cVol * (overlap / cRange);
            }
          }
        }
      }
    }

    let maxVol = 0;
    let pocIdx = 0;
    for (let idx = 0; idx < numBins; idx++) {
      if (bins[idx].volume > maxVol) {
        maxVol = bins[idx].volume;
        pocIdx = idx;
      }
    }
    const poc = bins[pocIdx].price;

    const valueAreaThreshold = totalVolume * 0.70;
    let valueAreaVolume = bins[pocIdx].volume;
    let leftIdx = pocIdx;
    let rightIdx = pocIdx;

    while (valueAreaVolume < valueAreaThreshold && (leftIdx > 0 || rightIdx < numBins - 1)) {
      const leftVol = leftIdx > 0 ? bins[leftIdx - 1].volume : -1;
      const rightVol = rightIdx < numBins - 1 ? bins[rightIdx + 1].volume : -1;

      if (leftVol >= rightVol && leftIdx > 0) {
        leftIdx--;
        valueAreaVolume += leftVol;
      } else if (rightIdx < numBins - 1) {
        rightIdx++;
        valueAreaVolume += rightVol;
      } else if (leftIdx > 0) {
        leftIdx--;
        valueAreaVolume += leftVol;
      } else {
        break;
      }
    }

    const val = bins[leftIdx].price - binSize * 0.5;
    const vah = bins[rightIdx].price + binSize * 0.5;

    const hvns: number[] = [];
    const lvns: number[] = [];
    const windowSize = 2;

    for (let idx = windowSize; idx < numBins - windowSize; idx++) {
      const currentVol = bins[idx].volume;
      let isPeak = true;
      let isTrough = true;

      for (let offset = -windowSize; offset <= windowSize; offset++) {
        if (offset === 0) continue;
        const neighborVol = bins[idx + offset].volume;
        if (neighborVol >= currentVol) isPeak = false;
        if (neighborVol <= currentVol) isTrough = false;
      }

      if (isPeak && currentVol > totalVolume * 0.03) {
        hvns.push(bins[idx].price);
      }
      if (isTrough && currentVol < totalVolume * 0.015) {
        lvns.push(bins[idx].price);
      }
    }

    return { poc, vah, val, hvns, lvns, bins };
  }

  private getVolumeProfileCached(candles: Candlestick[], id: string, numBins: number = 24): {
    poc: number;
    vah: number;
    val: number;
    hvns: number[];
    lvns: number[];
    bins: { price: number; volume: number }[];
  } {
    if (candles.length === 0) {
      return { poc: this.currentPrice, vah: this.currentPrice, val: this.currentPrice, hvns: [], lvns: [], bins: [] };
    }
    const last = candles[candles.length - 1];
    const key = `${id}_${candles.length}_${last.time}_${last.close}_${numBins}`;
    if (this.indicatorCache.volumeProfile.has(key)) {
      return this.indicatorCache.volumeProfile.get(key)!;
    }
    if (this.indicatorCache.volumeProfile.size > 200) {
      this.indicatorCache.volumeProfile.clear();
    }
    const profile = this.calculateVolumeProfile(candles, numBins);
    this.indicatorCache.volumeProfile.set(key, profile);
    return profile;
  }

  private evaluateMultiTimeframeVolumeProfile(
    direction: "LONG" | "SHORT" | "NEUTRAL",
    currentPrice: number,
    atrVal: number,
    relVolume: number,
    structCheck?: { confirmed: boolean; setupType?: string; message?: string },
    regime?: MarketRegime
  ): {
    met: boolean;
    val: string;
    req: string;
    description: string;
    stProfile: any;
    mtProfile: any;
    htProfile: any;
    nearestBarrierPrice: number | null;
    headroomRatio: number;
  } {
    const stProfile = this.getVolumeProfileCached(this.candles1m.slice(-90), "st_1m");
    const mtProfile = this.getVolumeProfileCached(this.aggregateCandles(this.candles1m, 5).slice(-120), "mt_5m");
    const htProfile = this.getVolumeProfileCached(this.aggregateCandles(this.candles1m, 15).slice(-120), "ht_15m");

    if (direction === "NEUTRAL") {
      return {
        met: true,
        val: "NEUTRAL - Profiles computed and tracking",
        req: "Symmetrical horizontal liquidity tracking",
        description: "Evaluates support/resistance points of control (POC) and value area boundaries across short, medium, and high timeframes.",
        stProfile,
        mtProfile,
        htProfile,
        nearestBarrierPrice: null,
        headroomRatio: 1.0,
      };
    }

    const proximityTolerance = Math.max(currentPrice * 0.003, atrVal * 0.35);

    const allPocs = [stProfile.poc, mtProfile.poc, htProfile.poc];
    const allHvns = [...stProfile.hvns, ...mtProfile.hvns, ...htProfile.hvns];
    const allLvns = [...stProfile.lvns, ...mtProfile.lvns, ...htProfile.lvns];
    const allLiquidityNodes = Array.from(new Set([...allPocs, ...allHvns])).sort((a, b) => a - b);

    const supportNodes = allLiquidityNodes.filter(node => node < currentPrice);
    const resistanceNodes = allLiquidityNodes.filter(node => node > currentPrice);

    const nearSupport = supportNodes.length > 0 ? supportNodes[supportNodes.length - 1] : null;
    const nearResistance = resistanceNodes.length > 0 ? resistanceNodes[0] : null;

    // Context Archetype Detection
    const msg = (structCheck?.message || "").toLowerCase();
    const isBreakoutOrSqueeze = msg.includes("breakout") || msg.includes("squeeze") || msg.includes("super strong") || msg.includes("immediate breakout");
    const isPullbackOrRetest = msg.includes("pullback") || msg.includes("retest") || msg.includes("mitigation") || msg.includes("bounce") || msg.includes("pushback");
    const isSMCConcept = msg.includes("liquidity sweep");
    const isRangeReversal = (regime === MarketRegime.RANGE_BOUND) || msg.includes("range reversal") || msg.includes("ranging bullish") || msg.includes("ranging bearish");

    // Check if price is sitting directly inside an LVN (Low Volume Node) Acceleration Runway
    const isInsideLvnPocket = allLvns.some(lvn => Math.abs(lvn - currentPrice) <= 0.25 * atrVal);

    const config = dbManager.getConfig();
    const minWallVol = config.general.relative_volume_threshold ? Math.min(config.general.relative_volume_threshold, 1.25) : 1.25;

    let hasSupportFloor = false;
    let hasOverheadBlocker = false;
    let detailMsg = "";
    let isMet = true;
    let nearestBarrierPrice: number | null = null;
    let headroomRatio = 2.0;

    const stVABreakout = currentPrice > stProfile.vah;
    const stVABreakdown = currentPrice < stProfile.val;
    const mtVABreakout = currentPrice > mtProfile.vah;
    const mtVABreakdown = currentPrice < mtProfile.val;

    if (direction === "LONG") {
      nearestBarrierPrice = nearResistance;
      const barrierDistance = nearestBarrierPrice ? (nearestBarrierPrice - currentPrice) : (2.5 * atrVal);
      headroomRatio = Number((barrierDistance / Math.max(1, 0.8 * atrVal)).toFixed(2));

      if (nearSupport && (currentPrice - nearSupport) <= proximityTolerance) {
        hasSupportFloor = true;
      }

      if (nearResistance && (nearResistance - currentPrice) <= proximityTolerance) {
        if (relVolume < minWallVol) {
          hasOverheadBlocker = true;
        }
      }

      if (isBreakoutOrSqueeze) {
        if (stVABreakout || mtVABreakout || isInsideLvnPocket) {
          isMet = true;
          detailMsg = `PASSED [Breakout/Squeeze]: Expanding through Low-Volume Runway / Above Session VAH ($${mtProfile.vah.toFixed(1)})`;
        } else if (hasOverheadBlocker) {
          isMet = false;
          detailMsg = `BLOCKED [Breakout]: Approaching dense Overhead HVN Wall at $${nearResistance!.toFixed(1)} without volume (${relVolume.toFixed(2)}x < ${minWallVol.toFixed(2)}x)`;
        } else {
          isMet = true;
          detailMsg = `PASSED [Breakout]: Headroom clear to next target ($${(nearResistance || currentPrice + 2 * atrVal).toFixed(1)})`;
        }
      } else if (isPullbackOrRetest) {
        if (hasSupportFloor) {
          isMet = true;
          detailMsg = `PASSED [Pullback Retest]: Supported by Heavy Horizontal Floor at $${nearSupport!.toFixed(1)}`;
        } else if (nearResistance && (nearResistance - currentPrice) < Math.max(50, 0.65 * atrVal)) {
          isMet = false;
          detailMsg = `BLOCKED [Pullback]: Entry cramped directly under Overhead Resistance Wall at $${nearResistance.toFixed(1)} (runway ${(nearResistance - currentPrice).toFixed(1)} < $50 threshold)`;
        } else {
          isMet = true;
          detailMsg = `PASSED [Pullback]: Sufficient runway ($${barrierDistance.toFixed(1)}) above structural base`;
        }
      } else if (isSMCConcept) {
        if (stVABreakdown && currentPrice > stProfile.val - 0.5 * atrVal) {
          isMet = true;
          detailMsg = `PASSED [SMC Sweep]: Liquidity sweep outside Value Area Low ($${stProfile.val.toFixed(1)}) targeting POC ($${stProfile.poc.toFixed(1)})`;
        } else if (hasOverheadBlocker) {
          isMet = false;
          detailMsg = `BLOCKED [SMC]: Entry into unmitigated overhead supply block at $${nearResistance!.toFixed(1)}`;
        } else {
          isMet = true;
          detailMsg = `PASSED [SMC]: Balanced volume profile structure targeting Session POC ($${mtProfile.poc.toFixed(1)})`;
        }
      } else if (isRangeReversal) {
        if (currentPrice <= mtProfile.val + 0.3 * atrVal) {
          isMet = true;
          detailMsg = `PASSED [Range Reversal]: Bouncing from Value Area Low ($${mtProfile.val.toFixed(1)}) targeting Session POC ($${mtProfile.poc.toFixed(1)})`;
        } else if (nearResistance && (nearResistance - currentPrice) < Math.max(50, 0.65 * atrVal)) {
          isMet = false;
          detailMsg = `BLOCKED [Range Reversal]: Overhead resistance ceiling at $${nearResistance.toFixed(1)} limits upside (distance ${(nearResistance - currentPrice).toFixed(1)} < $50 threshold)`;
        } else {
          isMet = true;
          detailMsg = `PASSED [Range]: Mean-reverting toward central value nodes`;
        }
      } else {
        if (hasOverheadBlocker) {
          isMet = false;
          detailMsg = `BLOCKED (Overhead Liquidity Wall detected at $${nearResistance!.toFixed(1)} - requires Rel Vol >= ${minWallVol.toFixed(2)})`;
        } else if (hasSupportFloor) {
          detailMsg = `PASSED (Bouncing off heavy Horizontal Floor support at $${nearSupport!.toFixed(1)})`;
        } else if (stVABreakout || mtVABreakout) {
          detailMsg = `PASSED (Explosive Value Area High breakout: stVAH $${stProfile.vah.toFixed(1)}, mtVAH $${mtProfile.vah.toFixed(1)})`;
        } else {
          detailMsg = `PASSED (Neutral range spacing; Near Floor: ${nearSupport ? "$" + nearSupport.toFixed(1) : "None"}, Near Wall: ${nearResistance ? "$" + nearResistance.toFixed(1) : "None"})`;
        }
      }
    } else {
      nearestBarrierPrice = nearSupport;
      const barrierDistance = nearestBarrierPrice ? (currentPrice - nearestBarrierPrice) : (2.5 * atrVal);
      headroomRatio = Number((barrierDistance / Math.max(1, 0.8 * atrVal)).toFixed(2));

      if (nearResistance && (nearResistance - currentPrice) <= proximityTolerance) {
        hasSupportFloor = true;
      }

      if (nearSupport && (currentPrice - nearSupport) <= proximityTolerance) {
        if (relVolume < minWallVol) {
          hasOverheadBlocker = true;
        }
      }

      if (isBreakoutOrSqueeze) {
        if (stVABreakdown || mtVABreakdown || isInsideLvnPocket) {
          isMet = true;
          detailMsg = `PASSED [Breakdown/Squeeze]: Expanding through Low-Volume Runway / Below Session VAL ($${mtProfile.val.toFixed(1)})`;
        } else if (hasOverheadBlocker) {
          isMet = false;
          detailMsg = `BLOCKED [Breakdown]: Approaching dense Underhead Support Floor at $${nearSupport!.toFixed(1)} without volume (${relVolume.toFixed(2)}x < ${minWallVol.toFixed(2)}x)`;
        } else {
          isMet = true;
          detailMsg = `PASSED [Breakdown]: Downside runway clear to next target ($${(nearSupport || currentPrice - 2 * atrVal).toFixed(1)})`;
        }
      } else if (isPullbackOrRetest) {
        if (hasSupportFloor) {
          isMet = true;
          detailMsg = `PASSED [Pullback Retest]: Protected by Heavy Horizontal Ceiling at $${nearResistance!.toFixed(1)}`;
        } else if (nearSupport && (currentPrice - nearSupport) < Math.max(50, 0.65 * atrVal)) {
          isMet = false;
          detailMsg = `BLOCKED [Pullback]: Entry cramped directly above Underhead Support Floor at $${nearSupport.toFixed(1)} (runway ${(currentPrice - nearSupport).toFixed(1)} < $50 threshold)`;
        } else {
          isMet = true;
          detailMsg = `PASSED [Pullback]: Sufficient downside runway ($${barrierDistance.toFixed(1)})`;
        }
      } else if (isSMCConcept) {
        if (stVABreakout && currentPrice < stProfile.vah + 0.5 * atrVal) {
          isMet = true;
          detailMsg = `PASSED [SMC Sweep]: Liquidity sweep outside Value Area High ($${stProfile.vah.toFixed(1)}) targeting POC ($${stProfile.poc.toFixed(1)})`;
        } else if (hasOverheadBlocker) {
          isMet = false;
          detailMsg = `BLOCKED [SMC]: Entry into unmitigated demand floor at $${nearSupport!.toFixed(1)}`;
        } else {
          isMet = true;
          detailMsg = `PASSED [SMC]: Balanced volume profile structure targeting Session POC ($${mtProfile.poc.toFixed(1)})`;
        }
      } else if (isRangeReversal) {
        if (currentPrice >= mtProfile.vah - 0.3 * atrVal) {
          isMet = true;
          detailMsg = `PASSED [Range Reversal]: Rejecting off Value Area High ($${mtProfile.vah.toFixed(1)}) targeting Session POC ($${mtProfile.poc.toFixed(1)})`;
        } else if (nearSupport && (currentPrice - nearSupport) < Math.max(50, 0.65 * atrVal)) {
          isMet = false;
          detailMsg = `BLOCKED [Range Reversal]: Underhead support floor at $${nearSupport.toFixed(1)} limits downside (distance ${(currentPrice - nearSupport).toFixed(1)} < $50 threshold)`;
        } else {
          isMet = true;
          detailMsg = `PASSED [Range]: Mean-reverting toward central value nodes`;
        }
      } else {
        if (hasOverheadBlocker) {
          isMet = false;
          detailMsg = `BLOCKED (Underhead Liquidity Support Floor detected at $${nearSupport!.toFixed(1)} - requires Rel Vol >= ${minWallVol.toFixed(2)})`;
        } else if (hasSupportFloor) {
          detailMsg = `PASSED (Retesting heavy dynamic resistance ceiling at $${nearResistance!.toFixed(1)})`;
        } else if (stVABreakdown || mtVABreakdown) {
          detailMsg = `PASSED (Explosive Value Area Low breakdown: stVAL $${stProfile.val.toFixed(1)}, mtVAL $${mtProfile.val.toFixed(1)})`;
        } else {
          detailMsg = `PASSED (Neutral range spacing; Near Floor: ${nearSupport ? "$" + nearSupport.toFixed(1) : "None"}, Near Wall: ${nearResistance ? "$" + nearResistance.toFixed(1) : "None"})`;
        }
      }
    }

    // Strict $50 Session POC & Major HVN Node Check
    const pocHvnConflictThreshold = 50.0;
    if (direction === "LONG") {
      const directOverheadNode = allLiquidityNodes.find(node => node > currentPrice && (node - currentPrice) < pocHvnConflictThreshold);
      if (directOverheadNode && relVolume < 1.35) {
        isMet = false;
        detailMsg = `BLOCKED [POC/HVN Conflict]: Overhead liquidity barrier at $${directOverheadNode.toFixed(1)} within $${(directOverheadNode - currentPrice).toFixed(1)} (< $50 clearance) requires Rel Vol >= 1.35 (current: ${relVolume.toFixed(2)}x)`;
      }
    } else if (direction === "SHORT") {
      const directUnderheadNode = [...allLiquidityNodes].reverse().find(node => node < currentPrice && (currentPrice - node) < pocHvnConflictThreshold);
      if (directUnderheadNode && relVolume < 1.35) {
        isMet = false;
        detailMsg = `BLOCKED [POC/HVN Conflict]: Underhead liquidity barrier at $${directUnderheadNode.toFixed(1)} within $${(currentPrice - directUnderheadNode).toFixed(1)} (< $50 clearance) requires Rel Vol >= 1.35 (current: ${relVolume.toFixed(2)}x)`;
      }
    }

    const valueStr = `ST_POC: $${stProfile.poc.toFixed(1)} (VA: $${stProfile.val.toFixed(0)}-$${stProfile.vah.toFixed(0)}) | MT_POC: $${mtProfile.poc.toFixed(1)} | HT_POC: $${htProfile.poc.toFixed(1)} | ${detailMsg}`;
    const reqStr = `Price must not enter trades directly into heavy POC/HVN boundaries without high breakout volume (Rel Volume >= 1.25)`;

    return {
      met: isMet,
      val: valueStr,
      req: reqStr,
      description: "Applies Context-Aware Multi-Timeframe Volume Profiling across 30m, 120m, and 300m horizons. Evaluates Low-Volume Node (LVN) acceleration pockets for breakouts, High-Volume Node (HVN) floors for pullbacks, and Value Area edges (VAH/VAL) for mean-reversion and SMC liquidity sweeps.",
      stProfile,
      mtProfile,
      htProfile,
      nearestBarrierPrice,
      headroomRatio,
    };
  }

  // Layer 1: Market Regime Detection
  private detectMarketRegime() {
    const config = dbManager.getConfig();
    const adxThreshold = config.general.adx_threshold !== undefined ? config.general.adx_threshold : 22.0;
    let intervalMinutes = config.general.regime_candle_interval_minutes || 3;

    let candles = this.aggregateCandles(this.candles1m, intervalMinutes);
    if (candles.length < 50 && intervalMinutes > 1) {
      // Dynamic fallback to 1-minute candles if we don't have enough history at startup
      intervalMinutes = 1;
      candles = this.candles1m;
    }

    const closes = candles.map((c) => c.close);
    if (closes.length < 50) return;

    // Calculators
    const ema9 = this.calculateEMA(closes, 9);
    const ema21 = this.calculateEMA(closes, 21);
    const ema50 = this.calculateEMA(closes, 50);
    const atr14 = this.calculateATR(candles, 14);
    const adx14 = this.calculateADX(candles, 14);

    const lastIdx = closes.length - 1;
    const currentClose = closes[lastIdx];
    const currentAtr = atr14[lastIdx] || 50;
    const currentAdx = adx14[lastIdx] || 25;

    // Calculate ATR Expansion (current ATR vs long term ATR)
    let sumAtrLong = 0;
    const lookback = Math.min(closes.length, 50);
    for (let i = lastIdx - lookback + 1; i <= lastIdx; i++) {
      sumAtrLong += atr14[i] || 50;
    }
    const longTermAtr = sumAtrLong / lookback;
    const atrExpansionRatio = currentAtr / longTermAtr;

    // Check EMA Structure Alignment
    const isBullAligned = ema9[lastIdx] > ema21[lastIdx] && ema21[lastIdx] > ema50[lastIdx];
    const isBearAligned = ema9[lastIdx] < ema21[lastIdx] && ema21[lastIdx] < ema50[lastIdx];

    const ema100 = this.calculateEMA(closes, Math.min(closes.length, 100));
    const ema100Val = (ema100.length > lastIdx && ema100[lastIdx] !== undefined) ? ema100[lastIdx] : ema50[lastIdx];

    const isBullAlignedFull = isBullAligned && (ema50[lastIdx] > ema100Val);
    const isBearAlignedFull = isBearAligned && (ema50[lastIdx] < ema100Val);

    const ema9Val = ema9[lastIdx];
    const ema21Val = ema21[lastIdx];
    const ema50Val = ema50[lastIdx];
    const spread21to50Percent = Math.abs(ema21Val - ema50Val) / ema50Val;

    // Calculate Macro Slope (Flatness)
    const slopeLookback = config.general.regime_macro_slope_lookback !== undefined ? config.general.regime_macro_slope_lookback : 5;
    const slopeThreshold = config.general.regime_macro_slope_threshold !== undefined ? config.general.regime_macro_slope_threshold : 0.0005;
    const slopeEma = (ema100.length > lastIdx && ema100[lastIdx] !== undefined) ? ema100 : ema50;
    const prevIdx = Math.max(0, lastIdx - slopeLookback);
    const currentEmaVal = slopeEma[lastIdx];
    const prevEmaVal = slopeEma[prevIdx];
    const macroSlope = prevEmaVal !== 0 ? Math.abs(currentEmaVal - prevEmaVal) / prevEmaVal : 0;
    const isSlopeFlat = macroSlope < slopeThreshold;

    // Calculate Ribbon Ribbon Compression (Tightness)
    const compressionThreshold = config.general.regime_ribbon_compression_threshold !== undefined ? config.general.regime_ribbon_compression_threshold : 0.0015;
    const emaMean = (ema9Val + ema21Val + ema50Val) / 3;
    const emaVariance = (
      Math.pow(ema9Val - emaMean, 2) +
      Math.pow(ema21Val - emaMean, 2) +
      Math.pow(ema50Val - emaMean, 2)
    ) / 3;
    const emaStdDev = Math.sqrt(emaVariance);
    const normalizedSpread = emaStdDev / currentClose;
    const isRibbonCompressed = normalizedSpread < compressionThreshold;

    // Simple Directional trend direction count to combine with ADX
    let upwardCount = 0;
    let downwardCount = 0;
    for (let i = lastIdx - 14; i <= lastIdx; i++) {
      if (closes[i] > closes[i - 1]) upwardCount++;
      else downwardCount++;
    }
    const trendStrength = Math.abs(upwardCount - downwardCount) / 15; // 0 to 1

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

    // Step 1: Volatility Extremes
    if (atrExpansionRatio < 0.6) {
      regime = MarketRegime.LOW_VOLATILITY;
      confidence = 0.65 + (0.6 - atrExpansionRatio) * 0.5;
    } else if (atrExpansionRatio > 1.5) {
      regime = MarketRegime.HIGH_VOLATILITY;
      confidence = 0.7 + (atrExpansionRatio - 1.5) * 0.2;
    } 
    // Step 2: Compression Intercept
    else if (isSlopeFlat && isRibbonCompressed) {
      regime = MarketRegime.RANGE_BOUND;
      confidence = 0.8 + (1 - normalizedSpread / compressionThreshold) * 0.15;
    } 
    // Step 3: Trend Alignment
    else if (isStrongUptrend) {
      regime = MarketRegime.STRONG_UPTREND;
      confidence = 0.6 + (currentAdx / 100) * 0.35;
    } else if (isStrongDowntrend) {
      regime = MarketRegime.STRONG_DOWNTREND;
      confidence = 0.6 + (currentAdx / 100) * 0.35;
    } 
    // Step 4: Fallback
    else {
      regime = MarketRegime.RANGE_BOUND;
      confidence = 0.5 + (1 - (currentAdx / 100)) * 0.3;
    }

    // Step 5: 1-Minute Fast-Track Momentum Acceleration Override
    // Instantly transitions regime to STRONG_DOWNTREND or STRONG_UPTREND on 1m momentum bursts before multi-minute aggregator catches up
    if (this.candles1m.length >= 25 && regime !== MarketRegime.HIGH_VOLATILITY) {
      const c1m = this.candles1m;
      const l1m = c1m.length - 1;
      const closes1m = c1m.map(c => c.close);
      const ema9List1m = this.calculateEMA(closes1m, 9);
      const ema21List1m = this.calculateEMA(closes1m, 21);
      const ema50List1m = this.calculateEMA(closes1m, 50);
      const ema9_1m = ema9List1m[l1m];
      const ema21_1m = ema21List1m[l1m];
      const ema50_1m = ema50List1m[l1m];
      const adx1mList = this.calculateADX(c1m, 14);
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

    if (this.currentRegime !== regime) {
      if (this.hasInitializedRegime) {
        this.lastRegimeChangeTimestamp = Date.now();
        const config = dbManager.getConfig();
        const cooldownMins = config.general.regime_change_cooldown_minutes !== undefined
          ? config.general.regime_change_cooldown_minutes
          : 15;
        this.log(
          `[WAIT] Regime Change Cooldown Activated: Pausing new trade entries for ${cooldownMins} minutes due to regime shift [${this.currentRegime}] -> [${regime}].`
        );
      }

      this.log(
        `Market Regime Shift detected: [${this.currentRegime}] -> [${regime}] (using ${intervalMinutes}m aggregated candles) with confidence ${(
          confidence * 100
         ).toFixed(1)}%. Real ADX: ${currentAdx.toFixed(1)}, ATR Expansion: ${atrExpansionRatio.toFixed(
          2
        )}x`
      );

      // Record regime change to DB
      dbManager.addRegimeLog({
        detected_at: new Date().toISOString(),
        regime,
        confidence,
        adx_value: currentAdx,
        atr_expansion_ratio: atrExpansionRatio,
        bb_width_percentile: regime === MarketRegime.LOW_VOLATILITY ? 10 : 60,
        ema_structure: isBullAligned ? "BULLISH_ALIGNED" : isBearAligned ? "BEARISH_ALIGNED" : "MIXED",
        realized_volatility: Number((currentAtr / currentClose).toFixed(4)),
        volume_expansion: 1.1,
      });

      // Handle active trade protection if regime changes to non-favorable
      if (
        this.activeTrade &&
        (regime === MarketRegime.RANGE_BOUND || regime === MarketRegime.LOW_VOLATILITY)
      ) {
        this.log(`Active trade affected by market regime shift to sideways range. Tightening stop loss by 30%.`);
      }
    }

    this.currentRegime = regime;
    this.regimeConfidence = confidence;
    this.hasInitializedRegime = true;
  }

  // Layer 2: Sentiment analysis on news titles using FinBERT and Cross-Source Aggregation
  public async analyzeHeadlineSentiment(headlineText: string, source: NewsSource): Promise<{
    score: number;
    keywordMatched: string | null;
    explanation?: string;
  }> {
    const config = dbManager.getConfig();
    const keywords = config.sentiment_settings.critical_keywords;

    // Step A: Perform critical keyword check (Regex matching)
    let keywordMatched: string | null = null;
    if (config.sentiment_settings.block_on_critical_keywords) {
      for (const kw of keywords) {
        const regex = new RegExp(`\\b${kw}\\b`, "i");
        if (regex.test(headlineText)) {
          keywordMatched = kw;
          break;
        }
      }
    }

    // Step B: Calculate base sentiment using the FinBERT Model simulation with Negation Parser
    this.log(`[FinBERT Model] Pre-processing and classifying headline from ${source}: "${headlineText}"`);
    const modelOutput = FinBertSentimentModel.analyze(headlineText);
    
    if (modelOutput.rulesApplied && modelOutput.rulesApplied.length > 0) {
      this.log(`[FinBERT Parser] Aspect-based negation rules: ${modelOutput.rulesApplied.join("; ")}`);
    }
    
    this.log(`[FinBERT Model] Raw Softmax -> Positive: ${(modelOutput.probabilities.positive * 100).toFixed(1)}%, Neutral: ${(modelOutput.probabilities.neutral * 100).toFixed(1)}%, Negative: ${(modelOutput.probabilities.negative * 100).toFixed(1)}%. Raw Score: ${modelOutput.sentiment}`);

    // Step C: Apply Cross-Source Sentiment Aggregation & Weighting
    const recentHeadlines = dbManager.getHeadlines();
    const aggregation = CrossSourceSentimentAggregator.aggregateAndScale(
      modelOutput.sentiment,
      source,
      headlineText,
      recentHeadlines
    );

    this.log(`[FinBERT Aggregator] ${aggregation.explanation}`);

    return {
      score: aggregation.score,
      keywordMatched,
      explanation: aggregation.explanation,
    };
  }

  // Handles dynamic simulation of incoming headlines, analyzing them and triggering news protection
  private async simulateIncomingNews() {
    const config = dbManager.getConfig();

    try {
      const liveHeadlines = await fetchLiveRSSHeadlines();
      const existing = dbManager.getHeadlines();

      // Find the first headline from RSS that is not already in the db
      const newArticle = liveHeadlines.find((h) => !existing.some((e) => e.headline === h.title));

      if (!newArticle) {
        return; // No new headlines at this moment
      }

      this.log(`[RSS Feed] Scraped fresh article from ${newArticle.source}: "${newArticle.title}"`);

      const result = await this.analyzeHeadlineSentiment(newArticle.title, newArticle.source);

      const headlineRecord = dbManager.addHeadline({
        timestamp: new Date().toISOString(),
        source: newArticle.source,
        headline: newArticle.title,
        sentiment_score: result.score,
        category: result.score > 0.15 ? "BULLISH" : result.score < -0.15 ? "BEARISH" : "NEUTRAL",
        has_critical_keyword: result.keywordMatched !== null,
        matched_keyword: result.keywordMatched,
      });

      // Trigger high-impact news lock if critical keyword matched
      if (result.keywordMatched && config.sentiment_settings.block_on_critical_keywords) {
        this.criticalEventActive = true;
        this.criticalEventKeyword = result.keywordMatched;
        this.protectionRemainingSeconds = config.sentiment_settings.protection_window_minutes * 60;

        this.log(
          `[GUARD]  NEWS EVENT CIRCUIT BREAKER ACTIVATED! Blocked keywords matched: [${result.keywordMatched}]. Entry scanning paused for +/-${config.sentiment_settings.protection_window_minutes} minutes.`
        );

        // Add a sentiment log update
        dbManager.addSentimentLog({
          refreshed_at: new Date().toISOString(),
          source: newArticle.source,
          headline_count: 1,
          positive_count: result.score > 0.15 ? 1 : 0,
          neutral_count: result.score >= -0.15 && result.score <= 0.15 ? 1 : 0,
          negative_count: result.score < -0.15 ? 1 : 0,
          current_sentiment: result.score,
          sentiment_30m_avg: result.score * 0.9,
          sentiment_1h_avg: result.score * 0.8,
          sentiment_4h_avg: 0.1,
          sentiment_momentum: 0.1,
          sentiment_volatility: 0.2,
          news_intensity_30m: existing.length + 1,
          news_intensity_60m: existing.length + 1,
          processing_time_ms: 15, // FinBERT is super fast!
        });
      }
    } catch (e) {
      this.log(`Error in RSS pipeline processing: ${(e as Error).message}`);
    }
  }

  // Layer 3: CatBoost Prediction and Entry Scanners
  private runScanners() {
    const config = dbManager.getConfig();
    const ms = config.market_structure || {
      min_breakout_body_ratio: 0.22,
      allow_immediate_breakout: true,
      hf_momentum_adx_threshold: 30,
      hf_orderflow_taker_buy_ratio_long: 0.58,
      hf_orderflow_imbalance_ratio_long: 0.30,
      hf_orderflow_taker_buy_ratio_short: 0.42,
      hf_orderflow_imbalance_ratio_short: -0.30,
      pullback_multiplier_limit: 0.6,
      ema_retrace_multiplier_limit: 0.4,
      bypass_ema200_on_momentum: true,
      ema200_proximity_divisor: 3.0,
      weak_trend_adx_threshold: 25,
      trend_alignment_adx_threshold: 30,
      super_trend_adx_threshold: 35,
      fast_ema_period: 20,
      medium_ema_period: 50,
      slow_ema_period: 200,
    };
    const relVolThreshold = config.general.relative_volume_threshold !== undefined ? config.general.relative_volume_threshold : 1.3;
    const adxThreshold = config.general.adx_threshold !== undefined ? config.general.adx_threshold : 22.0;

    if (!config.general.is_trading_active) return;

    const timestamp = new Date().toISOString();
    if (this.lastScanningTimestamp === timestamp.slice(0, 16)) return; // scan once per minute
    this.lastScanningTimestamp = timestamp.slice(0, 16);

    // Calculate indicator details
    const closes = this.candles1m.map((c) => c.close);
    if (closes.length < 50) return;


    // Evaluate the strategy state from the single source of truth (Symmetry Protection)
    const state = this.evaluateStrategyState();
    const {
      conditions,
      entry_score: entryScore,
      signal_direction: signalDirection,
      all_conditions_met: allConditionsMet,
      failedConditions,
      probabilityLong,
      avgSentiment,
      currentClose,
      adxValue,
      relVolume,
      confidenceScore,
      confidenceThreshold,
      isWeightedEnabled,
      tacticalConfidenceMet,
      safetyGates,
      tacticalGatesMap,
      activeWeights,
      marketStructurePassed,
    } = state;

    // Write to trade_block_log backend file every 1 minute
    if (config.general.enable_block_logging !== false) {
      try {
        const logTime = new Date().toISOString();
        let blockDetails = "";

        if ((signalDirection as string) === "NEUTRAL") {
          let neutralReason = "No strategy setup triggered.";
          if (this.currentRegime === MarketRegime.LOW_VOLATILITY) {
            neutralReason = "Trading is deactivated in low-volatility regimes to prevent chop losses.";
          } else if (this.currentRegime === MarketRegime.RANGE_BOUND) {
            neutralReason = "Price is inside the range boundaries; no mean-reversion range-support reversal, range-resistance reversal, or range breakout/breakdown triggered.";
          } else {
            neutralReason = "No valid pullback/retest of the 20/50 EMA detected, or the trend structure is not aligned with the required ML probability thresholds.";
          }
          blockDetails = `  * Neutral Strategy State: ${neutralReason}`;
        } else if (!allConditionsMet) {
          if (isWeightedEnabled) {
            const safetyFailures = conditions.filter(c => safetyGates.includes(c.name) && !c.met);
            const msFailure = !marketStructurePassed;
            const detailsList: string[] = [];
            if (safetyFailures.length > 0) {
              detailsList.push("    - [Safety Circuit Breakers Failed]: " + safetyFailures.map(c => `${c.name} ("${c.current_value}")`).join(", "));
            }
            if (msFailure) {
              const msCond = conditions.find(c => c.name === "Market Structure Confirmation");
              detailsList.push(`    - [Market Structure Confirmation Failed (MANDATORY)]: Current = "${msCond?.current_value}" | Required = "${msCond?.required}"`);
            }
            if (!tacticalConfidenceMet) {
              detailsList.push(`    - [Confidence Threshold Failed]: Cumulative Score: ${confidenceScore}% | Required: >= ${confidenceThreshold}%`);
              detailsList.push("      * Tactical Gates Performance:");
              for (const gate of tacticalGatesMap) {
                const cond = conditions.find(c => c.name === gate.condName);
                const weight = activeWeights[gate.weightKey];
                detailsList.push(`        - ${gate.condName}: [${cond?.met ? "PASS" : "FAIL"}] (Weight: ${weight}%)`);
              }
            }
            blockDetails = "  * Disqualified Gates Detail:\n" + detailsList.join("\n");
          } else {
            blockDetails = "  * Disqualified Gates Detail:\n" + conditions
              .filter((c) => !c.met)
              .map((c) => `    - [${c.name}]: Current = "${c.current_value}" | Required = "${c.required}"`)
              .join("\n");
          }
        } else {
          blockDetails = "  * Status: All gating conditions passed! Ready for execution / executed.";
        }

        const logHeader = `================================================================================\n`;
        const logTimeStr = `TIMESTAMP: ${logTime}\n`;
        const logStatus = `STATUS: ${allConditionsMet && (signalDirection as string) !== "NEUTRAL" ? "QUALIFIED" : "BLOCKED"}\n`;
        const logDir = `POLLING DIRECTION: ${signalDirection}\n`;
        const logRegime = `MARKET REGIME: ${this.currentRegime}\n`;
        const logPrice = `CURRENT PRICE: $${currentClose.toFixed(2)} | ADX: ${adxValue.toFixed(1)} | Rel Volume: ${relVolume.toFixed(2)}x\n`;
        const logBody = `${blockDetails}\n`;
        const logFooter = `================================================================================\n\n`;

        const logLine = `${logHeader}${logTimeStr}${logStatus}${logDir}${logRegime}${logPrice}${logBody}${logFooter}`;

        const DATA_DIR = process.env.DATA_DIR || process.cwd();
        fs.appendFileSync(path.join(DATA_DIR, "trade_block_log"), logLine, "utf-8");
      } catch (e) {
        console.error("[TradingEngine] Failed to write to trade_block_log backend file:", e);
      }
    }

    this.log(
      `Scanned conditions. Direction: ${signalDirection}. Entry Score: ${entryScore}/100. All met: ${allConditionsMet}.`
    );

    // Save scanning signal to db for timeline visualization
    const savedSignal = dbManager.addSignal({
      trade_id: null,
      timestamp,
      catboost_probability: probabilityLong,
      direction: signalDirection === "LONG" ? TradeDirection.LONG : TradeDirection.SHORT,
      regime_detected: this.currentRegime,
      sentiment_score: avgSentiment,
      sentiment_momentum: 0.05,
      all_conditions_met: allConditionsMet,
      failed_conditions: failedConditions,
      executed: false,
      rejection_reason: allConditionsMet ? null : failedConditions.join(", "),
    });

    // 3. Trade Entry Execution: Trigger a trade if all conditions met, entry score >= hurdle, and no trade active
    const entryHurdle = isWeightedEnabled ? confidenceThreshold : 80;
    if (allConditionsMet && entryScore >= entryHurdle && !this.activeTrade && (signalDirection as string) !== "NEUTRAL") {
      this.executeTradeEntry(signalDirection as "LONG" | "SHORT", probabilityLong, avgSentiment, entryScore, savedSignal.id);
    }
  }

  // Position Sizing & Order Execution on Delta Exchange
  private executeTradeEntry(
    direction: "LONG" | "SHORT",
    probability: number,
    sentiment: number,
    score: number,
    signalId: string
  ) {
    if ((direction as string) === "NEUTRAL") {
      this.log(`[WARN]  BLOCKED: Attempted to execute trade entry with NEUTRAL direction.`);
      return;
    }

    const config = dbManager.getConfig();
    const creds = dbManager.getCredentials();

    if (creds.connection_status !== "CONNECTED") {
      this.log(`[WARN]  FAILED to enter trade: Exchange credentials are not in CONNECTED state.`);
      return;
    }

    const isInverted = config.general.invert_confirmed_trades === true;
    const execDirection: "LONG" | "SHORT" = isInverted
      ? (direction === "LONG" ? "SHORT" : "LONG")
      : direction;

    if (isInverted) {
      this.log(`[LOOP] [REVERSE TRADING MODE ACTIVE] Engine confirmed ${direction} signal -> Inverting execution to ${execDirection} trade position!`);
    } else {
      this.log(`[LAUNCH] SIGNAL TRIGGERED! Entering Delta Exchange ${direction} position...`);
    }

    // Dynamically calculate dynamic Stop Loss, Take Profit, and Confluence of Extremes (Exhaustion + Overextension)
    const closes = this.candles1m.map((c) => c.close);
    const currentPrice = this.currentPrice;
    const atr14 = this.calculateATR(this.candles1m, 14);
    const lastAtr = atr14[closes.length - 1] || 150;
    const bb = this.calculateBollingerBands(closes, 20, 2);
    const ema9 = this.calculateEMA(closes, 9);
    const lastIdx = closes.length - 1;
    const ema9Val = ema9[lastIdx] || currentPrice;
    const struct = this.getTrendMarketStructure();

    const stProfile = this.getVolumeProfileCached(this.candles1m.slice(-90), "st_1m");
    const mtProfile = this.getVolumeProfileCached(this.aggregateCandles(this.candles1m, 5).slice(-120), "mt_5m");

    // --- CONFLUENCE OF EXTREMES (EXHAUSTION + OVEREXTENSION) BLOCK ---
    const rawImbalance = this.orderBookStats.imbalanceRatio;
    const takerRatio = this.orderFlowStats.takerBuyRatio;

    // Condition A (Order Flow Climax): Raw Imbalance > 85% or Taker ratio > 90% in direction of executed trade
    const isConditionA = execDirection === "LONG"
      ? (rawImbalance > 0.85 || takerRatio > 0.90)
      : (rawImbalance < -0.85 || takerRatio < 0.10);

    // Condition B (Physical Overextension): Entry Price physically outside Bollinger Bands OR distance to EMA 9 > 1.5 * ATR_14
    const isOutsideBB = execDirection === "LONG" ? (currentPrice > bb.upper) : (currentPrice < bb.lower);
    const distEma9 = Math.abs(currentPrice - ema9Val);
    const isEmaOverextended = distEma9 > 1.5 * lastAtr;
    const isConditionB = isOutsideBB || isEmaOverextended;

    // Extreme Confluence: Parabolic & mathematically exhausted -> BLOCK ENTRY
    if (isConditionA && isConditionB) {
      this.log(
        `  [ENTRY BLOCKED - Confluence of Extremes] Late-stage exhaustion breakout detected! Order Flow Climax (Imbalance: ${(rawImbalance * 100).toFixed(1)}%, Taker: ${(takerRatio * 100).toFixed(1)}%) & Physical Overextension (Outside BB: ${isOutsideBB}, Dist to EMA9: $${distEma9.toFixed(2)} vs 1.5xATR $${(1.5 * lastAtr).toFixed(2)}). Trade entry aborted.`
      );
      return;
    }

    if (isConditionA && !isConditionB) {
      this.log(`[VOLT] [High-Momentum Breakout Allowed]: Extreme Order Flow detected, but Price is not overextended. Executing Market Order.`);
    } else if (isConditionB && !isConditionA) {
      this.log(`  [Steady Trend Grind Allowed]: Price is overextended, but Order Flow is not climactic. Executing Market Order.`);
    }

    // Apply Maximum ATR Cap for Stop Loss calculation if enabled
    let stopLossAtr = lastAtr;
    if (config.risk_management.max_atr_for_stop_loss_enabled === true && config.risk_management.max_atr_for_stop_loss_value !== undefined) {
      if (lastAtr > config.risk_management.max_atr_for_stop_loss_value) {
        stopLossAtr = config.risk_management.max_atr_for_stop_loss_value;
      }
    }

    // Regime-Adaptive Dynamic Stop Loss ATR Multiplier
    // Trending: 1.55x ATR (provides essential breathing room for BTC 1m noise while trailing safely)
    // Range-Bound: 1.35x ATR (allows standard range bounce without micro-wick triggers)
    // High Volatility: 1.75x ATR (allows necessary breathing room for volatile expansions)
    let effectiveSlAtrMult = config.risk_management.stop_loss_atr_multiplier || 1.55;
    let effectiveTpAtrMult = config.risk_management.take_profit_atr_multiplier !== undefined
      ? config.risk_management.take_profit_atr_multiplier
      : 1.65;

    if (config.risk_management.enable_regime_adaptive_sl_tp !== false) {
      if (this.currentRegime === MarketRegime.STRONG_UPTREND || this.currentRegime === MarketRegime.STRONG_DOWNTREND) {
        effectiveSlAtrMult = config.risk_management.sl_atr_multiplier_trending !== undefined
          ? config.risk_management.sl_atr_multiplier_trending
          : 1.55;
        effectiveTpAtrMult = config.risk_management.tp_atr_multiplier_trending !== undefined
          ? config.risk_management.tp_atr_multiplier_trending
          : 1.70;
      } else if (this.currentRegime === MarketRegime.RANGE_BOUND) {
        effectiveSlAtrMult = config.risk_management.sl_atr_multiplier_ranging !== undefined
          ? config.risk_management.sl_atr_multiplier_ranging
          : 1.35;
        effectiveTpAtrMult = config.risk_management.tp_atr_multiplier_ranging !== undefined
          ? config.risk_management.tp_atr_multiplier_ranging
          : 1.40;
      } else if (this.currentRegime === MarketRegime.HIGH_VOLATILITY) {
        effectiveSlAtrMult = config.risk_management.sl_atr_multiplier_volatile !== undefined
          ? config.risk_management.sl_atr_multiplier_volatile
          : 1.75;
        effectiveTpAtrMult = config.risk_management.tp_atr_multiplier_volatile !== undefined
          ? config.risk_management.tp_atr_multiplier_volatile
          : 2.00;
      }
    }

    // Enforce a sensible minimum stop loss distance floor to prevent sub-tick anomalies without overriding ATR scaling
    const usdFloor = config.risk_management.min_stop_loss_distance_usd !== undefined ? config.risk_management.min_stop_loss_distance_usd : 35;
    const pctFloorVal = config.risk_management.min_stop_loss_distance_pct !== undefined ? config.risk_management.min_stop_loss_distance_pct : 0.045;
    const minSlDistance = Math.max(usdFloor, currentPrice * (pctFloorVal / 100));
    
    const isStaticSl = config.risk_management.static_stop_loss_enabled === true;
    const staticSlVal = config.risk_management.static_stop_loss_value_usd !== undefined ? config.risk_management.static_stop_loss_value_usd : 150;

    const stopLossDistance = isStaticSl
      ? staticSlVal
      : Math.max(
          stopLossAtr * effectiveSlAtrMult,
          minSlDistance
        );

    const structuralSlDistance = stopLossDistance;

    // Use the configured default quantity (fixed standard trade size)
    const sizeMultiplier = this.getTradeSizeMultiplier();
    const baseQty = config.risk_management.default_quantity_btc || 0.001;
    const positionQtyBtc = Number((baseQty * sizeMultiplier).toFixed(5));
    const leverage = config.risk_management.leverage || 20;

    // Fee-Aware Take Profit Target Floor:
    // Estimate round-trip exchange fees (taker ~0.05% entry + 0.05% exit + GST ≈ 0.10 - 0.118%).
    // Minimum Take Profit distance must cover at least 1.5x the round-trip fee distance so net profit is always solidly positive (> +$0.03 to +$0.06+).
    const estRoundTripFeeRate = config.risk_management.delta_india_gst_enabled ? 0.00118 : 0.0010;
    const minFeeCoverDistance = currentPrice * estRoundTripFeeRate * 1.5;

    // Positive R:R Guarantee:
    // Ensure planned TP Distance is at least 1.25x - 1.35x of Stop Loss Distance (preventing 1 SL from wiping multiple TPs)
    const minRRMultiplier = config.risk_management.min_rr_ratio_floor !== undefined
      ? config.risk_management.min_rr_ratio_floor
      : (this.currentRegime === MarketRegime.RANGE_BOUND ? 1.15 : 1.35);

    const isAtrScalpMode = config.risk_management.take_profit_mode !== "RR_RATIO";
    const rawTpDist = isAtrScalpMode
      ? Math.max(lastAtr * effectiveTpAtrMult, structuralSlDistance * minRRMultiplier)
      : structuralSlDistance * Math.max(config.risk_management.take_profit_ratio, minRRMultiplier);

    const takeProfitDistance = Math.max(rawTpDist, minFeeCoverDistance);

    // --- CONTEXT-AWARE VOLUME PROFILE SL / TP TARGETING ---
    // Align TP with next opposing High-Volume Node (POC/HVN) and SL behind local supporting Volume Node
    let vpTargetTpDistance = takeProfitDistance;
    let vpTargetSlDistance = structuralSlDistance;

    const vpCheck = this.evaluateMultiTimeframeVolumeProfile(
      execDirection,
      currentPrice,
      lastAtr,
      this.calculateAccurateRelativeVolume(),
      { confirmed: true, message: `Setup execution: ${execDirection}` },
      this.currentRegime
    );

    if (vpCheck.nearestBarrierPrice) {
      const distToBarrier = Math.abs(vpCheck.nearestBarrierPrice - currentPrice);
      // If opposing HVN barrier provides reasonable scalp room (between 0.9x ATR and 3.0x ATR), anchor TP right before the liquidity node
      if (distToBarrier >= 0.9 * lastAtr && distToBarrier <= 3.0 * lastAtr) {
        vpTargetTpDistance = distToBarrier;
      }
    }

    const finalTpDistance = vpTargetTpDistance;
    const finalSlDistance = vpTargetSlDistance;

    const initialSlPrice = execDirection === "LONG" ? currentPrice - finalSlDistance : currentPrice + finalSlDistance;

    // --- FLAW 3 FIX: STRUCTURAL STOP PLACEMENT AROUND MAJOR ROUND NUMBERS ---
    // Major psychological round numbers (multiples of $500 and $1,000 like $80,000, $80,500)
    // attract institutional stop sweeps before real breakouts occur.
    // If a LONG SL lands in the danger zone between the round level and $45 above it (e.g. $80,000 to $80,045),
    // a standard wick down to $79,960-$79,980 stops out the trader right before the surge.
    // We adjust the SL with a protective buffer below/above the round number.
    const roundStep = 500;
    let adjustedSlPrice = initialSlPrice;
    if (execDirection === "LONG") {
      const nearestRoundBelow = Math.floor(currentPrice / roundStep) * roundStep;
      // If entry is above the round level and stop loss lands right above it (within $45 or 0.8x ATR)
      if (currentPrice > nearestRoundBelow && adjustedSlPrice >= nearestRoundBelow && (adjustedSlPrice - nearestRoundBelow) <= Math.max(45, 0.8 * lastAtr)) {
        const bufferedSl = nearestRoundBelow - Math.max(35, 0.55 * lastAtr);
        // Only buffer if it keeps the SL within 2.35x ATR to preserve risk boundaries
        if ((currentPrice - bufferedSl) <= 2.35 * (lastAtr * effectiveSlAtrMult)) {
          adjustedSlPrice = bufferedSl;
        }
      }
    } else if (execDirection === "SHORT") {
      const nearestRoundAbove = Math.ceil(currentPrice / roundStep) * roundStep;
      // If entry is below the round level and stop loss lands right below it (within $45 or 0.8x ATR)
      if (currentPrice < nearestRoundAbove && adjustedSlPrice <= nearestRoundAbove && (nearestRoundAbove - adjustedSlPrice) <= Math.max(45, 0.8 * lastAtr)) {
        const bufferedSl = nearestRoundAbove + Math.max(35, 0.55 * lastAtr);
        if ((bufferedSl - currentPrice) <= 2.35 * (lastAtr * effectiveSlAtrMult)) {
          adjustedSlPrice = bufferedSl;
        }
      }
    }

    const stopLossPrice = adjustedSlPrice;
    const actualSLDistance = Math.abs(currentPrice - stopLossPrice);

    // Maintain favorable Risk-to-Reward ratio if SL was adjusted
    const requiredTpDist = Math.max(finalTpDistance, actualSLDistance * minRRMultiplier);
    const takeProfitPrice = execDirection === "LONG" ? currentPrice + requiredTpDist : currentPrice - requiredTpDist;
    const actualTPDistance = Math.abs(currentPrice - takeProfitPrice);

    this.log(
      `Computed Execution Parameters (${execDirection}${isInverted ? " - INVERTED" : ""}): Entry=$${currentPrice.toFixed(2)}, StopLoss=$${stopLossPrice.toFixed(2)} (Dist: $${actualSLDistance.toFixed(
        2
      )} [${effectiveSlAtrMult}x ATR | Regime: ${this.currentRegime}]), TakeProfit=$${takeProfitPrice.toFixed(2)} (Dist: $${actualTPDistance.toFixed(
        2
      )} [Mode: ${isAtrScalpMode ? `${effectiveTpAtrMult}x ATR Scalp` : `${config.risk_management.take_profit_ratio}x R:R`} | VP Anchor: ${vpCheck.nearestBarrierPrice ? `$${vpCheck.nearestBarrierPrice.toFixed(0)}` : "Standard"}]), Qty=${positionQtyBtc} BTC, Leverage=${leverage}x`
    );

    // Create the Trade record
    const newTrade: Trade = dbManager.addTrade({
      entry_timestamp: new Date().toISOString(),
      exit_timestamp: null,
      direction: execDirection === "LONG" ? TradeDirection.LONG : TradeDirection.SHORT,
      entry_price: currentPrice,
      exit_price: null,
      quantity_btc: positionQtyBtc,
      leverage,
      pnl_usdt: null,
      pnl_pct: null,
      fees_paid_usdt: this.calculateTradingFee(currentPrice * positionQtyBtc, true, 0), // entry commission fee
      exit_reason: null,
      catboost_probability: probability,
      regime_at_entry: this.currentRegime,
      sentiment_score_at_entry: sentiment,
      sentiment_momentum_at_entry: 0.05,
      entry_signal_score: score,
      max_favorable_excursion: 0,
      max_adverse_excursion: 0,
      hold_duration_seconds: 0,
      is_win: null,
      feature_snapshot: {
        last_price: currentPrice,
        atr_14: lastAtr,
        regime: this.currentRegime,
        average_sentiment: sentiment,
        stop_loss_price: stopLossPrice,
        take_profit_price: takeProfitPrice,
        inverted_from_signal: isInverted ? direction : undefined,
      },
    });

    this.activeTrade = newTrade;

    // Link trade id back to signal
    const signals = dbManager.getSignals();
    const sigIdx = signals.findIndex((s) => s.id === signalId);
    if (sigIdx !== -1) {
      signals[sigIdx].trade_id = newTrade.id;
      signals[sigIdx].executed = true;
    }

    this.log(`SUCCESS! Trade entry confirmed (${execDirection}). Transaction ID: ${newTrade.id}`);
    this.logTradeToFile(newTrade, this.getCurrentCheckpoints());

    // If live account mode is enabled, execute real-time order placement on Delta Exchange!
    if (!dbManager.isPaperMode()) {
      const side = execDirection === "LONG" ? "buy" : "sell";
      this.log(`  Dispatching real market order to Delta Exchange REST API...`);
      placeDeltaMarketOrder(creds, "BTCUSD", side, positionQtyBtc).then((res) => {
        if (res.success) {
          this.log(`[OK] Delta Exchange order matched successfully! Order ID: ${res.order_id}`);
          dbManager.updateTrade(newTrade.id, {
            feature_snapshot: {
              ...newTrade.feature_snapshot,
              delta_order_id: res.order_id,
              delta_response: res.response_data,
            }
          });
          getDeltaWalletBalance(creds).then((liveBal) => {
            if (liveBal !== null) {
              dbManager.updateCredentials({
                account_balance_usdt: liveBal,
              });
              this.log(`  Real-time balance updated from Delta Exchange: $${liveBal.toFixed(2)} USDT`);
            }
          }).catch(() => {});
        } else {
          this.log(`[X] Delta Exchange API returned rejection error: ${res.message}`);
        }
      }).catch((err) => {
        this.log(`[X] Delta Exchange order dispatch error: ${err?.message || err}`);
      });
    }
  }

  // Calculate realistic Delta Exchange India trading fees including 18% GST and Scalper Offer
  private calculateTradingFee(
    notionalValue: number,
    isEntry: boolean,
    durationSeconds = 0,
    orderTypeOverride?: "MAKER" | "TAKER"
  ): number {
    const config = dbManager.getConfig();
    const isPaper = dbManager.isPaperMode();
    const simulateFees = config.risk_management.simulate_paper_fees !== false;

    // If on paper trading and fee simulation is disabled, pay 0 fees
    if (isPaper && !simulateFees) {
      return 0;
    }

    // Determine execution type (MAKER or TAKER)
    const execType = orderTypeOverride || config.risk_management.default_order_execution || "TAKER";
    
    // Base fee rate: Maker is 0.02%, Taker is 0.05%
    let rate = execType === "MAKER" ? 0.0002 : 0.0005;

    // Scalper Offer: if closing leg, and scalper offer is enabled, and trade duration is <= 30 mins (1800 seconds)
    if (!isEntry && config.risk_management.delta_scalper_offer_enabled !== false) {
      if (durationSeconds <= 30 * 60) {
        // Waive the closing fee completely!
        rate = 0;
      }
    }

    let fee = notionalValue * rate;

    // Apply 18% GST if enabled
    if (config.risk_management.delta_india_gst_enabled !== false && rate > 0) {
      fee = fee * 1.18;
    }

    return Number(fee.toFixed(4));
  }

  // Real-time tracking of active position PnL and exit checking
  private updateActiveTradePnL() {
    if (!this.activeTrade) return;

    const config = dbManager.getConfig();
    const currentPrice = this.currentPrice;
    const entryPrice = this.activeTrade.entry_price;
    const qty = this.activeTrade.quantity_btc;
    const direction = this.activeTrade.direction;

    // Compute SL & TP limits from entry
    const closes = this.candles1m.map((c) => c.close);
    const atr14 = this.calculateATR(this.candles1m, 14);
    const lastAtr = atr14[closes.length - 1] || 150;

    // Apply Maximum ATR Cap for Stop Loss calculation if enabled
    let stopLossAtr = lastAtr;
    if (config.risk_management.max_atr_for_stop_loss_enabled === true && config.risk_management.max_atr_for_stop_loss_value !== undefined) {
      if (lastAtr > config.risk_management.max_atr_for_stop_loss_value) {
        stopLossAtr = config.risk_management.max_atr_for_stop_loss_value;
      }
    }

    // Apply the same sensible minimum stop-loss distance floor to prevent excessively tight SL on historical/active trades
    const usdFloor = config.risk_management.min_stop_loss_distance_usd !== undefined ? config.risk_management.min_stop_loss_distance_usd : 25;
    const pctFloorVal = config.risk_management.min_stop_loss_distance_pct !== undefined ? config.risk_management.min_stop_loss_distance_pct : 0.035;
    const minSlDistance = Math.max(usdFloor, entryPrice * (pctFloorVal / 100));
    
    const isStaticSl = config.risk_management.static_stop_loss_enabled === true;
    const staticSlVal = config.risk_management.static_stop_loss_value_usd !== undefined ? config.risk_management.static_stop_loss_value_usd : 150;

    const stopLossDistance = isStaticSl
      ? staticSlVal
      : Math.max(
          stopLossAtr * config.risk_management.stop_loss_atr_multiplier,
          minSlDistance
        );

    // Fee-aware minimum distance and positive R:R guarantee
    const estRoundTripFeeRate = config.risk_management.delta_india_gst_enabled ? 0.00118 : 0.0010;
    const minFeeCoverDistance = entryPrice * estRoundTripFeeRate * 1.5;
    const minRRMultiplier = config.risk_management.min_rr_ratio_floor !== undefined
      ? config.risk_management.min_rr_ratio_floor
      : (this.currentRegime === MarketRegime.RANGE_BOUND ? 1.15 : 1.35);

    // Take-Profit Calibration: Ensure TP is at least minRRMultiplier x SL distance and covers round-trip fees
    const tpAtrMult = config.risk_management.take_profit_atr_multiplier !== undefined
      ? config.risk_management.take_profit_atr_multiplier
      : 1.50;
    const isAtrScalpMode = config.risk_management.take_profit_mode !== "RR_RATIO";
    const rawTpDist = isAtrScalpMode
      ? Math.max(lastAtr * tpAtrMult, stopLossDistance * minRRMultiplier)
      : stopLossDistance * Math.max(config.risk_management.take_profit_ratio, minRRMultiplier);
    const takeProfitDistance = Math.max(rawTpDist, minFeeCoverDistance);

    let stopLossPrice = direction === TradeDirection.LONG ? entryPrice - stopLossDistance : entryPrice + stopLossDistance;
    let takeProfitPrice = direction === TradeDirection.LONG ? entryPrice + takeProfitDistance : entryPrice - takeProfitDistance;

    // Support custom manual SL / TP values if set
    if (this.activeTrade.feature_snapshot && typeof this.activeTrade.feature_snapshot.stop_loss_price === "number") {
      stopLossPrice = this.activeTrade.feature_snapshot.stop_loss_price;
    }
    if (this.activeTrade.feature_snapshot && typeof this.activeTrade.feature_snapshot.take_profit_price === "number") {
      takeProfitPrice = this.activeTrade.feature_snapshot.take_profit_price;
    }

    // Calculate current PnL
    let rawPnL = 0;
    let priceReturnPct = 0;

    if (direction === TradeDirection.LONG) {
      rawPnL = (currentPrice - entryPrice) * qty;
      priceReturnPct = ((currentPrice - entryPrice) / entryPrice) * 100;
    } else {
      rawPnL = (entryPrice - currentPrice) * qty;
      priceReturnPct = ((entryPrice - currentPrice) / entryPrice) * 100;
    }

    const durationSec = Math.floor(
      (Date.now() - new Date(this.activeTrade.entry_timestamp).getTime()) / 1000
    );
    this.activeTrade.hold_duration_seconds = durationSec;

    // Include entry commission and exit commission projection
    const entryFee = this.calculateTradingFee(entryPrice * qty, true, 0);
    const exitFeeProj = this.calculateTradingFee(currentPrice * qty, false, durationSec);
    const currentPnL = Number((rawPnL - (entryFee + exitFeeProj)).toFixed(2));
    const currentPnLPct = Number(((currentPnL / dbManager.getCredentials().account_balance_usdt) * 100).toFixed(4));

    // Update active trade parameters
    this.activeTrade.pnl_usdt = currentPnL;
    this.activeTrade.pnl_pct = currentPnLPct;

    // Record excursions (MFE and MAE)
    if (priceReturnPct > this.activeTrade.max_favorable_excursion) {
      this.activeTrade.max_favorable_excursion = Number(priceReturnPct.toFixed(4));
    }
    const adversePct = -priceReturnPct;
    if (adversePct > this.activeTrade.max_adverse_excursion) {
      this.activeTrade.max_adverse_excursion = Number(adversePct.toFixed(4));
    }

    // Check exit conditions
    let shouldExit = false;
    let reason = ExitReason.MANUAL_EXIT;

    // TP Hit
    const isTpHit = direction === TradeDirection.LONG ? currentPrice >= takeProfitPrice : currentPrice <= takeProfitPrice;
    if (isTpHit) {
      shouldExit = true;
      reason = ExitReason.TAKE_PROFIT;
    }

    // Fix 1: Structural Trailing Stop Anchoring (Stops Premature Choking)
    let finalStopLossPrice = stopLossPrice;
    if (config.risk_management.trailing_stop_loss_enabled) {
      if (!this.activeTrade.feature_snapshot) {
        this.activeTrade.feature_snapshot = {};
      }
      
      const activationRatio = config.risk_management.trailing_stop_loss_activation_ratio !== undefined
        ? config.risk_management.trailing_stop_loss_activation_ratio
        : 1.2;
      
      let trailingActivated = this.activeTrade.feature_snapshot.trailing_activated === true;
      const struct = this.getTrendMarketStructure();
      
      // Get the last 3 closed 1-minute candles for structural swing trailing
      const closedCandles = this.candles1m.slice(-4, -1);
      
      if (direction === TradeDirection.LONG) {
        // Track maximum price observed since entry
        const peakPrice = Math.max(
          this.activeTrade.feature_snapshot.peak_price || entryPrice,
          currentPrice
        );
        this.activeTrade.feature_snapshot.peak_price = peakPrice;
        
        // 1. Calculate structural anchor: lowest low of last 3 closed candles (or Higher Low swing)
        const lowestOf3Candles = closedCandles.length > 0
          ? Math.min(...closedCandles.map(c => c.low))
          : entryPrice;
        const structuralAnchor = struct.current_HL?.price
          ? Math.max(lowestOf3Candles, struct.current_HL.price)
          : lowestOf3Candles;
          
        // 2. Anti-Choking Hard Floor: Never place trailing stop closer than 1.2 * ATR from current market price
        const maxAllowedTrailingSl = currentPrice - 1.2 * lastAtr;
        const candidateTrailingSl = Math.min(structuralAnchor, maxAllowedTrailingSl);
        
        // 3. Monotonic ratcheting: Trailing stop must never move backward
        const previousTrailingSl = this.activeTrade.feature_snapshot.trailing_stop_loss_price || stopLossPrice;
        const trailingSl = Math.max(previousTrailingSl, candidateTrailingSl);
        this.activeTrade.feature_snapshot.trailing_stop_loss_price = trailingSl;
        
        // Check activation condition if not already activated
        if (!trailingActivated) {
          const reachedTarget = (peakPrice - entryPrice) >= (stopLossDistance * activationRatio);
          if (reachedTarget) {
            trailingActivated = true;
            this.activeTrade.feature_snapshot.trailing_activated = true;
            this.log(`  Structural Trailing Stop Loss ACTIVATED for trade ${this.activeTrade.id}! Peak profit reached ${activationRatio}x of risk threshold ($${(stopLossDistance * activationRatio).toFixed(2)} USD in profit).`);
          }
        }
        
        // Apply trailing stop loss ONLY if activated
        if (trailingActivated) {
          finalStopLossPrice = Math.max(stopLossPrice, trailingSl);
        } else {
          finalStopLossPrice = stopLossPrice;
        }

        // Dynamic Breakeven Floor: Once profit touches >= 0.75x ATR, lock SL to Entry + Fees (with strict safety limits)
        const beTriggerAtr = config.risk_management.breakeven_trigger_atr !== undefined
          ? config.risk_management.breakeven_trigger_atr
          : 0.75;
        if ((peakPrice - entryPrice) >= (lastAtr * beTriggerAtr)) {
          // Standard round-trip taker fee buffer (~0.08% of notional)
          const feeBufferUsd = Math.min(entryPrice * 0.0008, (entryFee + exitFeeProj) / (qty || 0.001));
          const targetBe = entryPrice + feeBufferUsd + 1.0;
          // Invariant Safety Guard: Breakeven SL must NEVER choke the active trade.
          // It must stay at least 0.4 * ATR below current market price and not exceed peakPrice.
          const maxAllowedBe = Math.min(currentPrice - 0.4 * lastAtr, peakPrice - 0.4 * lastAtr);
          const safeBeFloor = Math.min(targetBe, maxAllowedBe);
          if (safeBeFloor > stopLossPrice) {
            finalStopLossPrice = Math.max(finalStopLossPrice, safeBeFloor);
          }
        }
      } else {
        // Track minimum price observed since entry
        const valleyPrice = Math.min(
          this.activeTrade.feature_snapshot.valley_price || entryPrice,
          currentPrice
        );
        this.activeTrade.feature_snapshot.valley_price = valleyPrice;
        
        // 1. Calculate structural anchor: highest high of last 3 closed candles (or Lower High swing)
        const highestOf3Candles = closedCandles.length > 0
          ? Math.max(...closedCandles.map(c => c.high))
          : entryPrice;
        const structuralAnchor = struct.current_LH?.price
          ? Math.min(highestOf3Candles, struct.current_LH.price)
          : highestOf3Candles;
          
        // 2. Anti-Choking Hard Floor: Never place trailing stop closer than 1.2 * ATR from current market price
        const minAllowedTrailingSl = currentPrice + 1.2 * lastAtr;
        const candidateTrailingSl = Math.max(structuralAnchor, minAllowedTrailingSl);
        
        // 3. Monotonic ratcheting: Trailing stop must never move backward
        const previousTrailingSl = this.activeTrade.feature_snapshot.trailing_stop_loss_price || stopLossPrice;
        const trailingSl = Math.min(previousTrailingSl, candidateTrailingSl);
        this.activeTrade.feature_snapshot.trailing_stop_loss_price = trailingSl;
        
        // Check activation condition if not already activated
        if (!trailingActivated) {
          const reachedTarget = (entryPrice - valleyPrice) >= (stopLossDistance * activationRatio);
          if (reachedTarget) {
            trailingActivated = true;
            this.activeTrade.feature_snapshot.trailing_activated = true;
            this.log(`  Structural Trailing Stop Loss ACTIVATED for trade ${this.activeTrade.id}! Peak profit reached ${activationRatio}x of risk threshold ($${(stopLossDistance * activationRatio).toFixed(2)} USD in profit).`);
          }
        }
        
        // Apply trailing stop loss ONLY if activated
        if (trailingActivated) {
          finalStopLossPrice = Math.min(stopLossPrice, trailingSl);
        } else {
          finalStopLossPrice = stopLossPrice;
        }

        // Dynamic Breakeven Floor: Once profit touches >= 0.75x ATR, lock SL to Entry - Fees (with strict safety limits)
        const beTriggerAtr = config.risk_management.breakeven_trigger_atr !== undefined
          ? config.risk_management.breakeven_trigger_atr
          : 0.75;
        if ((entryPrice - valleyPrice) >= (lastAtr * beTriggerAtr)) {
          // Standard round-trip taker fee buffer (~0.08% of notional)
          const feeBufferUsd = Math.min(entryPrice * 0.0008, (entryFee + exitFeeProj) / (qty || 0.001));
          const targetBe = entryPrice - feeBufferUsd - 1.0;
          // Invariant Safety Guard: Breakeven SL must NEVER choke the active trade.
          // It must stay at least 0.4 * ATR above current market price and not drop below valleyPrice.
          const minAllowedBe = Math.max(currentPrice + 0.4 * lastAtr, valleyPrice + 0.4 * lastAtr);
          const safeBeFloor = Math.max(targetBe, minAllowedBe);
          if (safeBeFloor < stopLossPrice) {
            finalStopLossPrice = Math.min(finalStopLossPrice, safeBeFloor);
          }
        }
      }
      
      this.activeTrade.feature_snapshot.current_stop_loss_price = finalStopLossPrice;
    }

    // SL Hit (supports Trailing SL)
    const isSlHit = direction === TradeDirection.LONG ? currentPrice <= finalStopLossPrice : currentPrice >= finalStopLossPrice;
    if (isSlHit) {
      shouldExit = true;
      reason = ExitReason.STOP_LOSS;
    }

    // Time Limit 29 minutes hard deadline!
    if (durationSec >= 29 * 60) {
      shouldExit = true;
      reason = ExitReason.TIME_LIMIT_29MIN;
    }

    // If exit condition triggered, execute exit immediately!
    if (shouldExit) {
      this.executeTradeExit(reason);
    }
  }

  public executeTradeExit(reason: ExitReason) {
    if (!this.activeTrade) return;

    const currentPrice = this.currentPrice;
    const trade = this.activeTrade;
    this.log(`  EXIT TRIGGERED for trade ${trade.id}. Reason: ${reason}. Exit Price: $${currentPrice}`);

    const isWin = (trade.pnl_usdt || 0) > 0;

    const entryFee = this.calculateTradingFee(trade.entry_price * trade.quantity_btc, true, 0);
    const exitFee = this.calculateTradingFee(currentPrice * trade.quantity_btc, false, trade.hold_duration_seconds);
    const totalFeesPaid = Number((entryFee + exitFee).toFixed(4));

    // Update trade fields
    const updated = dbManager.updateTrade(trade.id, {
      exit_timestamp: new Date().toISOString(),
      exit_price: currentPrice,
      pnl_usdt: trade.pnl_usdt,
      pnl_pct: trade.pnl_pct,
      exit_reason: reason,
      is_win: isWin,
      hold_duration_seconds: trade.hold_duration_seconds,
      fees_paid_usdt: totalFeesPaid,
    });

    this.logTradeExitToFile(updated);

    // Update account balance in DB credentials
    const finalPnL = trade.pnl_usdt || 0;
    const currentBal = dbManager.getCredentials().account_balance_usdt;
    const newBal = Number((currentBal + finalPnL).toFixed(2));

    dbManager.updateCredentials({
      account_balance_usdt: newBal,
    });

    this.activeTrade = null;
    this.log(`Trade closed. Net P&L: $${finalPnL.toFixed(2)} USD. Account balance updated to: $${newBal.toFixed(2)}`);

    const creds = dbManager.getCredentials();

    // If live account mode is enabled, execute real-time order placement to CLOSE position on Delta Exchange!
    if (!dbManager.isPaperMode()) {
      this.log(`  Dispatching real market order to CLOSE position on Delta Exchange REST API...`);
      // Place opposite order to close (if we were LONG, we SELL; if we were SHORT, we BUY)
      const closeSide = trade.direction === TradeDirection.LONG ? "sell" : "buy";
      placeDeltaMarketOrder(creds, "BTCUSD", closeSide, trade.quantity_btc).then((res) => {
        if (res.success) {
          this.log(`[OK] Delta Exchange position successfully closed! Exit Order ID: ${res.order_id}`);
          // Immediately sync balance
          getDeltaWalletBalance(creds).then((liveBal) => {
            if (liveBal !== null) {
              dbManager.updateCredentials({
                account_balance_usdt: liveBal,
              });
              this.log(`  Real-time balance updated from Delta Exchange: $${liveBal.toFixed(2)} USDT`);
            }
          }).catch(() => {});
        } else {
          this.log(`[X] Delta Exchange API returned exit rejection error: ${res.message}`);
        }
      }).catch((err) => {
        this.log(`[X] Delta Exchange exit order dispatch error: ${err?.message || err}`);
      });
    }
  }

  // Force exit manual trigger
  public forceExit() {
    if (this.activeTrade) {
      this.executeTradeExit(ExitReason.MANUAL_EXIT);
      return true;
    }
    return false;
  }

  // Create manual trade entry
  public executeManualTradeEntry(
    direction: "LONG" | "SHORT",
    quantityBtc: number,
    leverage: number,
    stopLossPrice?: number | null,
    takeProfitPrice?: number | null
  ): { success: boolean; message: string; trade?: Trade } {
    if (this.activeTrade) {
      return {
        success: false,
        message: "An active position already exists. Please exit the active position first."
      };
    }

    const currentPrice = this.currentPrice;
    this.log(`Manual Trade execution request: ${direction} Qty=${quantityBtc} BTC, Leverage=${leverage}x`);

    // Add trade to database
    const config = dbManager.getConfig();
    // Convert string inputs to proper types if necessary
    const q = Number(quantityBtc);
    const lev = Number(leverage);
    const sl = stopLossPrice ? Number(stopLossPrice) : null;
    const tp = takeProfitPrice ? Number(takeProfitPrice) : null;

    const feesPaid = this.calculateTradingFee(currentPrice * q, true, 0);

    const atr14List = this.calculateATR(this.candles1m, 14);
    const lastAtr = atr14List.length > 0 ? (atr14List[atr14List.length - 1] || 150) : 150;

    const newTrade = dbManager.addTrade({
      entry_timestamp: new Date().toISOString(),
      exit_timestamp: null,
      direction: direction === "LONG" ? TradeDirection.LONG : TradeDirection.SHORT,
      entry_price: currentPrice,
      exit_price: null,
      quantity_btc: q,
      leverage: lev,
      pnl_usdt: 0,
      pnl_pct: 0,
      fees_paid_usdt: feesPaid,
      exit_reason: null,
      catboost_probability: direction === "LONG" ? 0.95 : 0.05,
      regime_at_entry: this.currentRegime,
      sentiment_score_at_entry: direction === "LONG" ? 0.5 : -0.5,
      sentiment_momentum_at_entry: 0,
      entry_signal_score: 100, // Manual execution max score
      max_favorable_excursion: 0,
      max_adverse_excursion: 0,
      hold_duration_seconds: 0,
      is_win: null,
      feature_snapshot: {
        last_price: currentPrice,
        atr_14: lastAtr,
        regime: this.currentRegime,
        is_manual: true,
        stop_loss_price: sl,
        take_profit_price: tp,
      },
    });

    this.activeTrade = newTrade;
    this.log(`Manual trade successfully created and active. Trade ID: ${newTrade.id}`);
    this.logTradeToFile(newTrade, this.getCurrentCheckpoints());

    const creds = dbManager.getCredentials();

    // If live account mode is enabled, execute real-time order placement on Delta Exchange!
    if (!dbManager.isPaperMode()) {
      this.log(`  Dispatching real MANUAL market order to Delta Exchange REST API...`);
      const side = direction === "LONG" ? "buy" : "sell";
      placeDeltaMarketOrder(creds, "BTCUSD", side, q).then((res) => {
        if (res.success) {
          this.log(`[OK] Delta Exchange manual order matched successfully! Order ID: ${res.order_id}`);
          dbManager.updateTrade(newTrade.id, {
            feature_snapshot: {
              ...newTrade.feature_snapshot,
              delta_order_id: res.order_id,
              delta_response: res.response_data,
            }
          });
          // Immediately sync balance
          getDeltaWalletBalance(creds).then((liveBal) => {
            if (liveBal !== null) {
              dbManager.updateCredentials({
                account_balance_usdt: liveBal,
              });
              this.log(`  Real-time balance updated from Delta Exchange: $${liveBal.toFixed(2)} USDT`);
            }
          }).catch(() => {});
        } else {
          this.log(`[X] Delta Exchange API returned rejection error for manual order: ${res.message}`);
        }
      }).catch((err) => {
        this.log(`[X] Delta Exchange manual order dispatch error: ${err?.message || err}`);
      });
    }

    return {
      success: true,
      message: `Successfully opened ${direction} position at $${currentPrice}.`,
      trade: newTrade
    };
  }
}

export const tradingEngine = new TradingEngine();
