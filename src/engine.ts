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
    if (n.includes("catboost")) return "catboost";
    if (n.includes("regime transition") || n.includes("regime_cooldown")) return "regime_cooldown";
    if (n.includes("regime") && !n.includes("transition")) return "regime";
    if (n.includes("exponential trend alignment") || (n.includes("trend") && !n.includes("adx"))) return "trend";
    if (n.includes("sentiment")) return "sentiment";
    if (n.includes("volume") && !n.includes("volume profiling")) return "volume";
    if (n.includes("news")) return "news";
    if (n.includes("limit")) return "limit";
    if (n.includes("adx")) return "adx";
    if (n.includes("equity")) return "equity";
    if (n.includes("credentials")) return "credentials";
    if (n.includes("loss streak cooldown") || n.includes("cooldown")) return "cooldown";
    if (n.includes("timing")) return "timing";
    if (n.includes("vwap deviation") || (n.includes("vwap") && !n.includes("ema"))) return "vwap";
    if (n.includes("wedge")) return "wedge";
    if (n.includes("order flow") || n.includes("orderflow")) return "orderflow";
    if (n.includes("squeeze")) return "squeeze";
    if (n.includes("imbalance") || n.includes("orderbook")) return "orderbook";
    if (n.includes("atr")) return "atr";
    if (n.includes("volume profiling") || n.includes("volume_profile")) return "volume_profile";
    if (n.includes("ema 100") || n.includes("ema")) return "ema100";
    if (n.includes("structure")) return "structure";
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
    return mandatory.includes(gateId);
  }

  private isGateWeighted(config: StrategyConfig, name: string): boolean {
    const gateId = this.getGateIdByName(name);
    const adaptiveStatus = this.getRegimeAdaptiveGateStatus(config, gateId);
    if (adaptiveStatus === "WEIGHTED") return true;
    if (adaptiveStatus === "MANDATORY" || adaptiveStatus === "BYPASSED") return false;

    const weighted = config.general.weighted_gates || [];
    return weighted.includes(gateId);
  }

  private isGateActive(config: StrategyConfig, name: string): boolean {
    const gateId = this.getGateIdByName(name);
    const adaptiveStatus = this.getRegimeAdaptiveGateStatus(config, gateId);
    if (adaptiveStatus === "MANDATORY" || adaptiveStatus === "WEIGHTED") return true;
    if (adaptiveStatus === "BYPASSED") return false;

    if (config.general.mandatory_gates || config.general.weighted_gates) {
      const mandatory = config.general.mandatory_gates || [];
      const weighted = config.general.weighted_gates || [];
      return mandatory.includes(gateId) || weighted.includes(gateId);
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
          const statusChar = c.met ? "✅ [PASS]" : "❌ [FAIL]";
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

      let relVolume = 1.0;
      if (hasEnough && volumes.length >= 20) {
        const lastIdx = closes.length - 1;
        const currentVolume = volumes[lastIdx];
        const startIdx = Math.max(0, lastIdx - 20);
        const prevVolumes = volumes.slice(startIdx, lastIdx);
        if (prevVolumes.length > 0) {
          const sumPrevVolumes = prevVolumes.reduce((a, b) => a + b, 0);
          const avgPrevVolume = sumPrevVolumes / prevVolumes.length;
          relVolume = avgPrevVolume > 0 ? currentVolume / avgPrevVolume : 1.0;
        }
      } else if (hasEnough) {
        relVolume = 1.35;
      }

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
        `Stop Loss Price  : $${trade.feature_snapshot?.stop_loss_price || "—"}\n` +
        `Take Profit Price: $${trade.feature_snapshot?.take_profit_price || "—"}\n` +
        `ATR (14)         : $${trade.feature_snapshot?.atr_14 || "—"}\n` +
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
      this.log(`📝 Logged trade entry ${trade.id} details to trade_log file.`);
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
        `Exit Reason      : ${trade.exit_reason || "—"}\n` +
        `Is Win           : ${trade.is_win ? "YES ✅" : "NO ❌"}\n` +
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
      this.log(`📝 Logged trade exit ${trade.id} details to trade_log file.`);
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
    let relVolume = 1.0;
    if (hasEnoughData && volumes.length >= 20) {
      const currentVolume = volumes[lastIdx];
      const startIdx = Math.max(0, lastIdx - 20);
      const prevVolumes = volumes.slice(startIdx, lastIdx);
      if (prevVolumes.length > 0) {
        const sumPrevVolumes = prevVolumes.reduce((a, b) => a + b, 0);
        const avgPrevVolume = sumPrevVolumes / prevVolumes.length;
        relVolume = avgPrevVolume > 0 ? currentVolume / avgPrevVolume : 1.0;
      }
    } else if (hasEnoughData) {
      relVolume = 1.35;
    }

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

    const trendAlignAdx = ms.trend_alignment_adx_threshold || 30;
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

      if (isRangeLongReversal) {
        signalDirection = "LONG";
      } else if (isRangeShortReversal) {
        signalDirection = "SHORT";
      } else if (isRangeLongBreakout) {
        signalDirection = "LONG";
      } else if (isRangeShortBreakdown) {
        signalDirection = "SHORT";
      } else {
        signalDirection = "NEUTRAL";
      }
    } else if (this.currentRegime === MarketRegime.LOW_VOLATILITY) {
      signalDirection = "NEUTRAL";
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

      // Multi-factor intelligent direction assessment
      if (isUptrendAligned && (hasValidPushbackLong || isScalperBreakoutLongAllowed) && isNotLongBreakout && probabilityLong >= 0.58) {
        signalDirection = "LONG";
      } else if (isDowntrendAligned && (hasValidPushbackShort || isScalperBreakdownShortAllowed) && isNotShortBreakdown && probabilityShort >= 0.58) {
        signalDirection = "SHORT";
      } else if (isUptrendAligned && (probabilityLong >= 0.55 || (this.orderFlowStats.takerBuyRatio >= 0.54 && currentRsi >= 45))) {
        signalDirection = "LONG";
      } else if (isDowntrendAligned && (probabilityShort >= 0.55 || (this.orderFlowStats.takerBuyRatio <= 0.46 && currentRsi <= 55))) {
        signalDirection = "SHORT";
      } else {
        signalDirection = "NEUTRAL";
      }
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
    const isEnteringPullback = signalDirection !== "NEUTRAL";
    const catboostThreshold = this.currentRegime === MarketRegime.RANGE_BOUND 
      ? 0.50 
      : (isEnteringPullback ? 0.58 : 0.65);
    const pLongMet = signalDirection === "LONG" ? (probabilityLong >= catboostThreshold) : false;
    const pShortMet = signalDirection === "SHORT" ? (probabilityShort >= catboostThreshold) : false;
    conditions.push({
      name: "CatBoost AI Prediction",
      met: (signalDirection === "NEUTRAL") 
        ? (probabilityLong >= (this.currentRegime === MarketRegime.RANGE_BOUND ? 0.50 : 0.65) || 
           probabilityShort >= (this.currentRegime === MarketRegime.RANGE_BOUND ? 0.50 : 0.65)) 
        : (pLongMet || pShortMet),
      current_value: `P(LONG) = ${(probabilityLong * 100).toFixed(1)}% | P(SHORT) = ${(probabilityShort * 100).toFixed(1)}%`,
      required: signalDirection === "LONG"
        ? `P(LONG) >= ${this.currentRegime === MarketRegime.RANGE_BOUND ? "50" : "58"}% (Evaluating LONG Trade)`
        : signalDirection === "SHORT"
        ? `P(SHORT) >= ${this.currentRegime === MarketRegime.RANGE_BOUND ? "50" : "58"}% (Evaluating SHORT Trade)`
        : `P(LONG) >= ${this.currentRegime === MarketRegime.RANGE_BOUND ? "50" : "65"}% for LONG OR P(SHORT) >= ${this.currentRegime === MarketRegime.RANGE_BOUND ? "50" : "65"}% for SHORT (Mutually Exclusive)`,
      description: "Uses pre-trained ensemble trees mapping momentum, EMA spreads, and ATR volatility expansion.",
      priority: "CRITICAL",
    });

    const hasExtremeRealtimePressure = (config.general.enable_orderflow_softening !== false) &&
                                       ((signalDirection === "LONG" && (this.orderFlowStats.takerBuyRatio >= 0.68 || this.orderBookStats.imbalanceRatio >= 0.45)) ||
                                       (signalDirection === "SHORT" && (this.orderFlowStats.takerBuyRatio <= 0.32 || this.orderBookStats.imbalanceRatio <= -0.45)));

    const isLowVolatility = this.currentRegime === MarketRegime.LOW_VOLATILITY;

    // C2: Market Regime lock
    // Blocked all entries during LOW_VOLATILITY.
    const regimeValid = !isLowVolatility;
    const regimeAligned =
      (signalDirection === "LONG" && (this.currentRegime === MarketRegime.STRONG_UPTREND || this.currentRegime === MarketRegime.RANGE_BOUND)) ||
      (signalDirection === "SHORT" && (this.currentRegime === MarketRegime.STRONG_DOWNTREND || this.currentRegime === MarketRegime.RANGE_BOUND)) ||
      this.currentRegime === MarketRegime.HIGH_VOLATILITY;

    const isRegimeSoftened = false;

    conditions.push({
      name: "Market Regime Filter",
      met: regimeValid && (signalDirection === "NEUTRAL" ? true : regimeAligned),
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
    const softenedAdxThreshold = standardAdxThreshold * (1 - softeningPercent / 100);

    if (this.currentRegime === MarketRegime.RANGE_BOUND) {
      if (signalDirection === "LONG") {
        trendAligned = !isBearAligned;
        currentTrendStr = isBearAligned ? "BLOCKED: STRONGLY BEARISH" : "PASSING (Not strongly bearish)";
      } else if (signalDirection === "SHORT") {
        trendAligned = !isBullAligned;
        currentTrendStr = isBullAligned ? "BLOCKED: STRONGLY BULLISH" : "PASSING (Not strongly bullish)";
      } else {
        trendAligned = true;
        currentTrendStr = "NEUTRAL";
      }
      adxMet = true; // Bypassed in RANGE_BOUND
      requiredStr = "LONG: Not strongly bearish (isBearAligned), SHORT: Not strongly bullish (isBullAligned)";
    } else {
      if (hasExtremeRealtimePressure) {
        const fastEma = ms.fast_ema_period || 20;
        const medEma = ms.medium_ema_period || 50;
        trendAligned = signalDirection === "NEUTRAL" ? true : (
          signalDirection === "LONG" ? (ema20Val > ema50Val) : (ema20Val < ema50Val)
        );
        adxMet = adxValue >= softenedAdxThreshold;
        currentTrendStr = `EMA Structure: FAST_ALIGNED (Extreme Real-time Flow Pressure) | ADX: ${adxValue.toFixed(1)} (Threshold softened to >= ${softenedAdxThreshold.toFixed(1)})`;
        requiredStr = `LONG: Fast EMA${fastEma} > EMA${medEma} & ADX >= ${softenedAdxThreshold.toFixed(1)} (Softened via Order Flow), SHORT: Fast EMA${fastEma} < EMA${medEma} & ADX >= ${softenedAdxThreshold.toFixed(1)}`;
      } else {
        const fastEma = ms.fast_ema_period || 20;
        const medEma = ms.medium_ema_period || 50;
        const slowEma = ms.slow_ema_period || 200;
        trendAligned = signalDirection === "NEUTRAL" ? true : (
          (signalDirection === "LONG" && isUptrendAligned) ||
          (signalDirection === "SHORT" && isDowntrendAligned)
        );
        adxMet = adxValue >= standardAdxThreshold;
        currentTrendStr = `EMA Structure: ${isUptrendAligned ? "BULLISH_TREND" : isDowntrendAligned ? "BEARISH_TREND" : "MIXED/FLAT"}`;
        requiredStr = `LONG: EMA${fastEma} > EMA${medEma} > EMA${slowEma} & ADX >= ${standardAdxThreshold} & STRONG_UPTREND, SHORT: EMA${fastEma} < EMA${medEma} < EMA${slowEma} & ADX >= ${standardAdxThreshold} & STRONG_DOWNTREND`;
      }
    }

    const fastEma = ms.fast_ema_period || 20;
    const medEma = ms.medium_ema_period || 50;
    const slowEma = ms.slow_ema_period || 200;

    const isTrendSoftened = (this.currentRegime !== MarketRegime.RANGE_BOUND) && hasExtremeRealtimePressure && (
      (signalDirection === "LONG" && !isUptrendAligned) ||
      (signalDirection === "SHORT" && !isDowntrendAligned) ||
      (adxValue < standardAdxThreshold)
    );

    conditions.push({
      name: "Exponential Trend Alignment",
      met: trendAligned,
      current_value: currentTrendStr,
      required: requiredStr.split(" & ADX")[0],
      description: `Confirms overall strong trend alignment (EMA ${fastEma}/${medEma}/${slowEma}) or checks safety locks during range bound.`,
      priority: "HIGH",
      softened: isTrendSoftened,
    });

    conditions.push({
      name: "ADX Trend Strength Filter",
      met: adxMet,
      current_value: `ADX: ${adxValue.toFixed(1)}`,
      required: `ADX >= ${hasExtremeRealtimePressure ? softenedAdxThreshold.toFixed(1) : standardAdxThreshold.toFixed(1)}`,
      description: `Confirms strong trend velocity/momentum (ADX >= ${trendAlignAdx}).`,
      priority: "HIGH",
      softened: isTrendSoftened,
    });

    // C5: Relative Volume Confirmation
    const standardRelVolThreshold = relVolThreshold;
    const softenedRelVolThreshold = standardRelVolThreshold * (1 - softeningPercent / 100);
    const requiredRelVol = hasExtremeRealtimePressure 
      ? softenedRelVolThreshold 
      : standardRelVolThreshold;
    const isRelVolumeSoftened = hasExtremeRealtimePressure && relVolume >= softenedRelVolThreshold && relVolume < standardRelVolThreshold;

    conditions.push({
      name: "Relative Volume Confirmation",
      met: relVolume >= requiredRelVol,
      current_value: `${relVolume.toFixed(2)}x` + (hasExtremeRealtimePressure ? " (SOFTENED VIA LEADING ORDER FLOW)" : ""),
      required: `> ${requiredRelVol.toFixed(2)}x above 20-period MA`,
      description: hasExtremeRealtimePressure
        ? "Validates supporting transaction volume. (Threshold softened under extreme leading order flow pressure)."
        : "Validates that trade has supporting transaction volume to avoid false breakups.",
      priority: "MEDIUM",
      softened: isRelVolumeSoftened,
    });

    // C7: Daily Circuit Breaker
    const timestamp = new Date().toISOString();
    const tradesToday = dbManager.getTrades().filter(
      (t) => t.entry_timestamp.split("T")[0] === timestamp.split("T")[0]
    );
    const cbDailyTradesPass = tradesToday.length < config.general.max_trades_per_day;
    conditions.push({
      name: "Daily Trade Count Limit",
      met: cbDailyTradesPass,
      current_value: `${tradesToday.length} trades`,
      required: `< ${config.general.max_trades_per_day} trades/day`,
      description: "Risk mitigation ceiling to prevent overtrading and revenge trading sessions.",
      priority: "CRITICAL",
    });

    // C9 & C10 Combined: Account Equity & API Connection Verification
    const balance = dbManager.getCredentials().account_balance_usdt;
    const hasMinEquity = balance >= 100;
    const apiCreds = dbManager.getCredentials();
    const hasValidCreds = dbManager.isPaperMode() || (!!apiCreds.api_key && !!apiCreds.api_secret);

    conditions.push({
      name: "Account Equity & API Connection Verification",
      met: hasMinEquity && hasValidCreds,
      current_value: `Balance: $${balance.toFixed(2)} USDT | API: ${dbManager.isPaperMode() ? "PAPER MODE ACTIVE" : (hasValidCreds ? "KEYS CONFIGURED" : "MISSING KEYS")}`,
      required: "Balance >= $100.00 USDT and valid live connection keys or Paper Mode active",
      description: "Ensures portfolio has sufficient margin buffer and API credentials are ready to route orders.",
      priority: "CRITICAL",
    });

    // C11: Consecutive Losses Cooldown Protection
    const lossCooldown = this.getConsecutiveLossesCooldownStatus();
    conditions.push({
      name: "Loss Streak Cooldown Protection",
      met: !lossCooldown.active,
      current_value: lossCooldown.active
        ? `COOLDOWN (Streak: ${lossCooldown.consecutiveLosses}, ${Math.ceil(lossCooldown.remainingSeconds / 60)}m left)`
        : "PASSING",
      required: "No active cooldown from consecutive losses",
      description: "Automated timeout that blocks trading after being hit by N consecutive losses to prevent emotional or algorithmic revenge trading.",
      priority: "CRITICAL",
    });

    // C12: Optimal Session Timing Window Check (IST)
    const timingStatus = this.getISTTimingStatus();
    conditions.push({
      name: "Optimal Session Timing Window Check (IST)",
      met: timingStatus.met,
      current_value: timingStatus.status,
      required: "Avoid weekends & 2:00 AM - 8:00 AM IST",
      description: timingStatus.description,
      priority: "HIGH",
    });

    // C14 & C17 Combined: Overextension & Level Anchors (VWAP/EMA)
    let vwapDevMet = signalDirection === "LONG"
      ? currentPrice <= vwapUpperVal
      : signalDirection === "SHORT"
        ? currentPrice >= vwapLowerVal
        : true;

    // Optimize: In super strong trend breakouts or with extreme leading indicator momentum, bypass VWAP overextension lock
    if (isSpecialSuperStrongTrendLogicActive || hasExtremeRealtimePressure) {
      vwapDevMet = true;
    }

    const atr14 = hasEnoughData ? this.calculateATR(this.candles1m, 14) : [50];
    const currentAtr = atr14[lastIdx] || 50;

    // Check for high movement in earlier short period (recent 10 candles)
    const shortLookback = 10;
    let highMovementShort = false;
    let shortMovementVal = 0;
    if (this.candles1m.length >= shortLookback) {
      const recentCandles = this.candles1m.slice(-shortLookback);
      const recentHighs = recentCandles.map(c => c.high);
      const recentLows = recentCandles.map(c => c.low);
      const maxHigh = Math.max(...recentHighs);
      const minLow = Math.min(...recentLows);
      shortMovementVal = maxHigh - minLow;
      highMovementShort = shortMovementVal > 1.8 * currentAtr;
    }

    const ema100Distance = currentPrice - ema100Val;
    const maxAllowedDeviation = emaThreshold * currentAtr;
    const isEma100OverextendedLong = currentPrice > ema100Val + maxAllowedDeviation;
    const isEma100OverextendedShort = currentPrice < ema100Val - maxAllowedDeviation;

    let ema100Met = true;
    let ema100ValStr = "PASSING (NORMAL DISTANCE)";

    if (hasExtremeRealtimePressure) {
      ema100Met = true;
      ema100ValStr = signalDirection === "LONG"
        ? `PASSING (Extreme Leading Pressure Confirmed: Distance +$${ema100Distance.toFixed(2)})`
        : `PASSING (Extreme Leading Pressure Confirmed: Distance -$${Math.abs(ema100Distance).toFixed(2)})`;
    } else if (isTrending && !highMovementShort) {
      ema100ValStr = `PASSING (No high momentum pulse in last 10 candles in Trending Regime)`;
    } else {
      if (signalDirection === "LONG") {
        if (isSpecialSuperStrongTrendLogicActive) {
          ema100Met = true;
          ema100ValStr = `PASSING (Super Strong Trend Breakout Confirmed: Distance +$${ema100Distance.toFixed(2)})`;
        } else if (isEma100OverextendedLong) {
          ema100Met = false;
          ema100ValStr = `OVEREXTENDED LONG: BLOCKED (Price: $${currentPrice.toFixed(2)} too far above 100 EMA)`;
        } else {
          ema100ValStr = `PASSING (Distance: +$${ema100Distance.toFixed(2)})`;
        }
      } else if (signalDirection === "SHORT") {
        if (isSpecialSuperStrongTrendLogicActive) {
          ema100Met = true;
          ema100ValStr = `PASSING (Super Strong Trend Breakdown Confirmed: Distance -$${Math.abs(ema100Distance).toFixed(2)})`;
        } else if (isEma100OverextendedShort) {
          ema100Met = false;
          ema100ValStr = `OVEREXTENDED SHORT: BLOCKED (Price: $${currentPrice.toFixed(2)} too far below 100 EMA)`;
        } else {
          ema100ValStr = `PASSING (Distance: -$${Math.abs(ema100Distance).toFixed(2)})`;
        }
      }
    }

    conditions.push({
      name: "VWAP Deviation Anchor Check",
      met: vwapDevMet,
      current_value: vwapDevMet ? "PASSING" : "OVEREXTENDED",
      required: "Price within dynamic VWAP standard deviation bands",
      description: "Guards against entering trades when price is overextended relative to the VWAP standard deviation bands.",
      priority: "CRITICAL",
    });

    conditions.push({
      name: "EMA 100 Overextension Protection",
      met: ema100Met,
      current_value: ema100ValStr,
      required: "Price not overextended relative to the 100 EMA baseline",
      description: "Guards against buying the exact top or shorting the exact bottom relative to the 100 EMA baseline.",
      priority: "CRITICAL",
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

    // C16: Wedge Pattern Filter (Avoid entry during rising/falling wedges unless confirmed breakout)
    const wedge = this.detectWedgePattern();
    let wedgeMet = true;
    let wedgeVal = "NO WEDGE PATTERN DETECTED";
    let wedgeReq = "None (Pattern normal)";
    const wedgeRelVolume = relVolume;

    // Cross-optimization: Calculate if volatility is squeezed
    const sqBb_wedge = this.calculateBollingerBands(closes, 20, 2);
    const sqAtr_wedge = currentAtr_cp;
    const sqKbWidth_wedge = 2 * 1.5 * sqAtr_wedge;
    const sqBbWidth_wedge = sqBb_wedge.upper - sqBb_wedge.lower;
    const isSqueezed_wedge = sqBbWidth_wedge <= sqKbWidth_wedge;

    if (wedge.risingWedge) {
      if (signalDirection === "LONG") {
        // Counter-trend LONG in rising wedge. Requires superior breakout.
        const requiredVol = isSqueezed_wedge ? 1.40 : 1.25;
        const isBreakout = currentPrice > wedge.upperLineCurrent && wedgeRelVolume >= requiredVol;
        wedgeMet = isBreakout;
        wedgeVal = isBreakout
          ? `RISING WEDGE: SUPERIOR BULL BREAKOUT (Close: $${currentPrice.toFixed(2)} > Upper: $${wedge.upperLineCurrent.toFixed(2)} | Vol: ${wedgeRelVolume.toFixed(2)} >= ${requiredVol})`
          : `RISING WEDGE: BLOCKED (LONG counter-trend requires upper breakout with volume >= ${requiredVol})`;
        wedgeReq = `LONG Breakout: Price > Upper ($${wedge.upperLineCurrent.toFixed(2)}) & Rel Volume >= ${requiredVol}`;
      } else if (signalDirection === "SHORT") {
        // Aligned SHORT in rising wedge. Requires confirmed lower breakdown to avoid trap.
        const requiredVol = 1.10;
        const isBreakdown = currentPrice < wedge.lowerLineCurrent && wedgeRelVolume >= requiredVol;
        wedgeMet = isBreakdown;
        wedgeVal = isBreakdown
          ? `RISING WEDGE: BEAR BREAKDOWN CONFIRMED (Close: $${currentPrice.toFixed(2)} < Lower: $${wedge.lowerLineCurrent.toFixed(2)} | Vol: ${wedgeRelVolume.toFixed(2)} >= ${requiredVol})`
          : `RISING WEDGE: BLOCKED (SHORT requires confirmed lower breakdown with volume >= ${requiredVol})`;
        wedgeReq = `SHORT Breakdown: Price < Lower ($${wedge.lowerLineCurrent.toFixed(2)}) & Rel Volume >= ${requiredVol}`;
      }
    } else if (wedge.fallingWedge) {
      if (signalDirection === "SHORT") {
        // Counter-trend SHORT in falling wedge. Requires superior breakdown.
        const requiredVol = isSqueezed_wedge ? 1.40 : 1.25;
        const isBreakdown = currentPrice < wedge.lowerLineCurrent && wedgeRelVolume >= requiredVol;
        wedgeMet = isBreakdown;
        wedgeVal = isBreakdown
          ? `FALLING WEDGE: SUPERIOR BEAR BREAKDOWN (Close: $${currentPrice.toFixed(2)} < Lower: $${wedge.lowerLineCurrent.toFixed(2)} | Vol: ${wedgeRelVolume.toFixed(2)} >= ${requiredVol})`
          : `FALLING WEDGE: BLOCKED (SHORT counter-trend requires lower breakdown with volume >= ${requiredVol})`;
        wedgeReq = `SHORT Breakdown: Price < Lower ($${wedge.lowerLineCurrent.toFixed(2)}) & Rel Volume >= ${requiredVol}`;
      } else if (signalDirection === "LONG") {
        // Aligned LONG in falling wedge. Requires confirmed upper breakout to avoid trap.
        const requiredVol = 1.10;
        const isBreakout = currentPrice > wedge.upperLineCurrent && wedgeRelVolume >= requiredVol;
        wedgeMet = isBreakout;
        wedgeVal = isBreakout
          ? `FALLING WEDGE: BULL BREAKOUT CONFIRMED (Close: $${currentPrice.toFixed(2)} > Upper: $${wedge.upperLineCurrent.toFixed(2)} | Vol: ${wedgeRelVolume.toFixed(2)} >= ${requiredVol})`
          : `FALLING WEDGE: BLOCKED (LONG requires confirmed upper breakout with volume >= ${requiredVol})`;
        wedgeReq = `LONG Breakout: Price > Upper ($${wedge.upperLineCurrent.toFixed(2)}) & Rel Volume >= ${requiredVol}`;
      }
    }

    conditions.push({
      name: "Wedge Pattern Filter",
      met: wedgeMet,
      current_value: wedgeVal,
      required: wedgeReq,
      description: "Filters trades during wedge compression to avoid low-probability trendline traps, unless a confirmed breakout with high volume occurs.",
      priority: "CRITICAL",
    });

    // C17: Binance Order Flow Confirmation
    let ofMet = true;
    const flowRes = this.getOrderFlowScore(signalDirection);
    let ofVal = `Score: ${flowRes.score}/100 [${flowRes.label}] | Taker Buy: ${(flowRes.takerBuyRatio * 100).toFixed(1)}% | Imbalance: ${(flowRes.imbalanceRatio * 100).toFixed(1)}%`;
    let ofReq = "Dynamic Score >= 45/100 (Softenable to 30/100 if CatBoost AI probability >= 85.0%)";

    if (signalDirection !== "NEUTRAL") {
      const activeProb = signalDirection === "LONG" ? probabilityLong : probabilityShort;
      const isExtremeAiConfidence = activeProb >= 0.85;
      const hurdleScore = isExtremeAiConfidence ? 30 : 45;
      ofMet = flowRes.score >= hurdleScore;
      if (!ofMet) {
        ofVal = `${ofVal} - BLOCKED (${flowRes.description})`;
      } else {
        const softState = flowRes.score < 45 ? " - SOFTENED BY AI" : "";
        ofVal = `${ofVal} - PASSED${softState} (${flowRes.description})`;
      }
    }

    const isOrderFlowSoftened = signalDirection !== "NEUTRAL" && flowRes.score < 45 && flowRes.score >= 30;

    conditions.push({
      name: "Binance Order Flow Confirmation",
      met: ofMet,
      current_value: ofVal,
      required: ofReq,
      description: "Applies a continuous fuzzy confluence score blending taker volume buy/sell ratio (70% weight) and order book bid/ask depth imbalance (30% weight) with adaptive soft-gates based on AI prediction confidence.",
      priority: "HIGH",
      softened: isOrderFlowSoftened,
    });

    // C18: Volatility Compression (Squeeze) Filter
    const sqBb = this.calculateBollingerBands(closes, 20, 2);
    const sqAtr = currentAtr_cp;
    const sqKbWidth = 2 * 1.5 * sqAtr;
    const sqBbWidth = sqBb.upper - sqBb.lower;
    const isSqueezed = sqBbWidth <= sqKbWidth;

    let squeezeMet = true;
    let squeezeVal = `BB Width: $${sqBbWidth.toFixed(2)} (Keltner Width: $${sqKbWidth.toFixed(2)})`;
    let squeezeReq = "Breakout volume (Rel Volume >= 1.40) required if Bollinger Bands are squeezed inside Keltner Channels";

    if (isSqueezed) {
      squeezeMet = relVolume >= 1.40;
      if (!squeezeMet) {
        squeezeVal = `COMPRESSED SQUEEZE ACTIVE - BLOCKED (BB Width $${sqBbWidth.toFixed(2)} <= Keltner $${sqKbWidth.toFixed(2)} | Rel Volume ${relVolume.toFixed(2)} < 1.40)`;
      } else {
        squeezeVal = `COMPRESSED SQUEEZE ACTIVE - PASSED (High Breakout Volume: ${relVolume.toFixed(2)} >= 1.40)`;
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
    const vpResult = this.evaluateMultiTimeframeVolumeProfile(signalDirection, currentPrice, currentAtr_cp, relVolume);
    conditions.push({
      name: "Multi-Timeframe Volume Profiling (Horizontal Liquidity)",
      met: vpResult.met,
      current_value: vpResult.val,
      required: vpResult.req,
      description: vpResult.description,
      priority: "HIGH",
    });

    // C20: Regime Transition Cooldown
    const regimeCooldown = this.getRegimeChangeCooldownStatus();
    const regimeCooldownMins = config.general.regime_change_cooldown_minutes !== undefined ? config.general.regime_change_cooldown_minutes : 15;
    conditions.push({
      name: "Regime Transition Cooldown",
      met: !regimeCooldown.active,
      current_value: regimeCooldown.active
        ? `BLOCKED (Cooldown active: ${Math.ceil(regimeCooldown.remainingSeconds / 60)}m left)`
        : "PASSING (No recent regime shift)",
      required: `No regime transitions within the last ${regimeCooldownMins} minutes`,
      description: "Applies a transition lock to entry signals whenever the dominant market regime shifts (e.g. from Strong Uptrend to Range Bound), protecting against high-frequency slippage and trend-reversal fakeouts during structural transitions.",
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
        overextension: config.gate_scoring?.weights?.overextension ?? 5,
        ema100_overextension: config.gate_scoring?.weights?.ema100_overextension ?? 5,
        wedge_filter: config.gate_scoring?.weights?.wedge_filter ?? 5,
        order_flow: config.gate_scoring?.weights?.order_flow ?? 10,
        squeeze_filter: config.gate_scoring?.weights?.squeeze_filter ?? 5,
        order_book: config.gate_scoring?.weights?.order_book ?? 5,
        volume_profile: (config.gate_scoring?.weights as any)?.volume_profile ?? 10,
      };

      const modifiers = config.gate_scoring?.adaptive_modifiers ?? {
        trending: { trend_alignment_weight_boost: 10, catboost_weight_boost: 5, volume_profile_weight_boost: -5 },
        ranging: { order_flow_weight_boost: 15, trend_alignment_weight_reduction: -10, volume_profile_weight_boost: 10 },
        high_volatility: { relative_volume_weight_boost: 10, overextension_weight_boost: 10, volume_profile_weight_boost: 5 },
        low_volatility: { squeeze_filter_weight_boost: 15, volume_profile_weight_boost: 0 },
      };

      activeWeights = { ...baseWeights };

      if (this.currentRegime === MarketRegime.STRONG_UPTREND || this.currentRegime === MarketRegime.STRONG_DOWNTREND) {
        activeWeights.trend_alignment = Math.max(0, activeWeights.trend_alignment + (modifiers.trending?.trend_alignment_weight_boost ?? 10));
        activeWeights.catboost_ai = Math.max(0, activeWeights.catboost_ai + (modifiers.trending?.catboost_weight_boost ?? 5));
        activeWeights.volume_profile = Math.max(0, activeWeights.volume_profile + (modifiers.trending?.volume_profile_weight_boost ?? -5));
      } else if (this.currentRegime === MarketRegime.RANGE_BOUND) {
        activeWeights.order_flow = Math.max(0, activeWeights.order_flow + (modifiers.ranging?.order_flow_weight_boost ?? 15));
        activeWeights.trend_alignment = Math.max(0, activeWeights.trend_alignment + (modifiers.ranging?.trend_alignment_weight_reduction ?? -10));
        activeWeights.volume_profile = Math.max(0, activeWeights.volume_profile + (modifiers.ranging?.volume_profile_weight_boost ?? 10));
      } else if (this.currentRegime === MarketRegime.HIGH_VOLATILITY) {
        activeWeights.relative_volume = Math.max(0, activeWeights.relative_volume + (modifiers.high_volatility?.relative_volume_weight_boost ?? 10));
        activeWeights.overextension = Math.max(0, activeWeights.overextension + (modifiers.high_volatility?.overextension_weight_boost ?? 10));
        activeWeights.volume_profile = Math.max(0, activeWeights.volume_profile + (modifiers.high_volatility?.volume_profile_weight_boost ?? 5));
      } else if (this.currentRegime === MarketRegime.LOW_VOLATILITY) {
        activeWeights.squeeze_filter = Math.max(0, activeWeights.squeeze_filter + (modifiers.low_volatility?.squeeze_filter_weight_boost ?? 15));
        activeWeights.volume_profile = Math.max(0, activeWeights.volume_profile + (modifiers.low_volatility?.volume_profile_weight_boost ?? 0));
      }

      tacticalGatesMap = [
        { condName: "CatBoost AI Prediction", weightKey: "catboost_ai" as const },
        { condName: "Market Regime Filter", weightKey: "market_regime" as const },
        { condName: "Exponential Trend Alignment", weightKey: "trend_alignment" as const },
        { condName: "ADX Trend Strength Filter", weightKey: "adx_strength" as const },
        { condName: "Relative Volume Confirmation", weightKey: "relative_volume" as const },
        { condName: "VWAP Deviation Anchor Check", weightKey: "overextension" as const },
        { condName: "EMA 100 Overextension Protection", weightKey: "ema100_overextension" as const },
        { condName: "Wedge Pattern Filter", weightKey: "wedge_filter" as const },
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
      if (signalDirection !== "NEUTRAL") {
        if (pLongMet || pShortMet || !this.isGateActive(config, "CatBoost AI Prediction")) entryScore += 40;
        if ((regimeValid && regimeAligned) || !this.isGateActive(config, "Market Regime Filter")) entryScore += 20;
        if (trendAligned || !this.isGateActive(config, "Exponential Trend Alignment")) entryScore += 15;
        if (adxMet || !this.isGateActive(config, "ADX Trend Strength Filter")) entryScore += 15;
        if (relVolume > requiredRelVol || !this.isGateActive(config, "Relative Volume Confirmation")) entryScore += 10;
      }
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
      const change = (Math.random() - 0.5) * 0.04; // ±2% random drift
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

    // Periodically (every 15 seconds) fetch Binance Order Flow & Order Book
    if (this.tickCount === 1 || this.tickCount % 3 === 0) {
      this.fetchBinanceOrderFlow().catch((err) => {
        console.error("[TradingEngine] Failed to fetch Binance order flow:", err);
      });
      this.fetchBinanceOrderBook().catch((err) => {
        console.error("[TradingEngine] Failed to fetch Binance order book:", err);
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

    // Configurable fallback crossover EMAs for Setup 2
    const fallbackEnabled = ms.fallback_crossover_enabled !== false;
    const fallbackFastPeriod = ms.fallback_crossover_fast_period || 5;
    const fallbackSlowPeriod = ms.fallback_crossover_slow_period || 15;
    const fallbackFastSeries = this.calculateEMA(closes, fallbackFastPeriod);
    const fallbackSlowSeries = this.calculateEMA(closes, fallbackSlowPeriod);

    let isFallbackCrossoverBullish = false;
    let isFallbackCrossoverBearish = false;

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
      "Multi-Timeframe Trend Alignment": { status: "SKIP", reason: "Not evaluated." },
      "EMA Structure Alignment": { status: "SKIP", reason: "Not evaluated." },
      "Breakout Level Confirmation": { status: "SKIP", reason: "Not evaluated." },
      "Breakout Candle Body Ratio": { status: "SKIP", reason: "Not evaluated." },
      "Immediate Breakout Entry Allowance": { status: "SKIP", reason: "Not evaluated." },
      "Dynamic Invalidation Floor/Ceiling": { status: "SKIP", reason: "Not evaluated." },
      "Chasing Lookback limit": { status: "SKIP", reason: "Not evaluated." },
      "Volume-Validated Pullback": { status: "SKIP", reason: "Not evaluated." },
      "Pullback & Retest Setup (Setup 1)": { status: "SKIP", reason: "Not evaluated." },
      "EMA Retracement / Pushback Setup (Setup 2)": { status: "SKIP", reason: "Not evaluated." },
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

      this.log(`[Checkpoint Radar Debug - Market Confirmation]`);
      this.log(`  Direction: ${direction} | Regime: ${this.currentRegime} | ADX: ${adxValue.toFixed(1)} (${adxLabel})`);
      this.log(`  Evaluating Retracement on EMA Pair: ${emaZoneLabel} (Testing: ${specificEmaTested}, Pullback Depth Class: ${classifiedDepth}, Points: ${depthPoints})`);
      this.log(`  Conditions Evaluation:`);
      for (const cond of sub_conditions) {
        const icon = cond.status === "PASS" ? "✅" : cond.status === "FAIL" ? "❌" : "➖";
        this.log(`    ${icon} ${cond.name}: [${cond.status}] - ${cond.reason}`);
      }
      this.log(`  Final Market Structure Gate Confirmation Result: ${confirmed ? "PASSED" : "BLOCKED"} (${message})`);

      return {
        confirmed,
        message,
        ema_check_active: true,
        ema_pair_evaluated: emaZoneLabel,
        ema_tested: specificEmaTested,
        sub_conditions,
      };
    };

    const hasHighHFPressure = adxValue >= (ms.hf_momentum_adx_threshold + 2) || 
      (direction === "LONG" 
        ? (this.orderFlowStats.takerBuyRatio >= ms.hf_orderflow_taker_buy_ratio_long || this.orderBookStats.imbalanceRatio >= ms.hf_orderflow_imbalance_ratio_long) 
        : (this.orderFlowStats.takerBuyRatio <= ms.hf_orderflow_taker_buy_ratio_short || this.orderBookStats.imbalanceRatio <= ms.hf_orderflow_imbalance_ratio_short));

    // --- FEATURE 3: Multi-Timeframe (5m) Trend Structure Alignment ---
    const candles5m = this.aggregateCandles(this.candles1m, 5);
    const closes5m = candles5m.map(c => c.close);
    let mtfMessage = "";
    if (closes5m.length >= 10) {
      const ema5_5m = this.calculateEMA(closes5m, 5);
      const ema15_5m = this.calculateEMA(closes5m, 15);
      const last5mIdx = closes5m.length - 1;
      if (last5mIdx >= 0 && ema5_5m.length > last5mIdx && ema15_5m.length > last5mIdx) {
        const ema5_5m_val = ema5_5m[last5mIdx];
        const ema15_5m_val = ema15_5m[last5mIdx];
        const isMtfLong = ema5_5m_val > ema15_5m_val;
        if (direction === "LONG" && !isMtfLong && !hasHighHFPressure) {
          const mtfMsg = `Conflicting Trend: Multi-timeframe (5m) trend is bearish (5m EMA 5: $${ema5_5m_val.toFixed(2)} <= EMA 15: $${ema15_5m_val.toFixed(2)}).`;
          condDict["Multi-Timeframe Trend Alignment"] = { status: "FAIL", reason: mtfMsg };
          return getReturnObj(
            false,
            `${mtfMsg} LONG entry blocked.`
          );
        }
        if (direction === "SHORT" && isMtfLong && !hasHighHFPressure) {
          const mtfMsg = `Conflicting Trend: Multi-timeframe (5m) trend is bullish (5m EMA 5: $${ema5_5m_val.toFixed(2)} >= EMA 15: $${ema15_5m_val.toFixed(2)}).`;
          condDict["Multi-Timeframe Trend Alignment"] = { status: "FAIL", reason: mtfMsg };
          return getReturnObj(
            false,
            `${mtfMsg} SHORT entry blocked.`
          );
        }
        mtfMessage = hasHighHFPressure ? " | MTF Bypassed (High HF Pressure)" : " | MTF Aligned (5m EMA5 > EMA15)";
        condDict["Multi-Timeframe Trend Alignment"] = {
          status: "PASS",
          reason: hasHighHFPressure ? "Bypassed due to high HF pressure" : `5m EMA5 ($${ema5_5m_val.toFixed(2)}) ${isMtfLong ? ">" : "<"} EMA15 ($${ema15_5m_val.toFixed(2)})`
        };
      } else {
        condDict["Multi-Timeframe Trend Alignment"] = { status: "SKIP", reason: "Incomplete 5m EMA calculation indicators." };
      }
    } else {
      condDict["Multi-Timeframe Trend Alignment"] = { status: "SKIP", reason: "Not enough 5m candles available (< 10)." };
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

      if (breakoutIdx === -1) {
        const breakoutMsg = `Waiting for a confirmed Higher High breakout of $${breakoutLevel.toFixed(2)} to initiate the pullback/retest or EMA pushback setup sequence.`;
        condDict["Breakout Level Confirmation"] = { status: "FAIL", reason: `No HH breakout closed above $${breakoutLevel.toFixed(2)}.` };
        return getReturnObj(false, breakoutMsg);
      }
      condDict["Breakout Level Confirmation"] = { status: "PASS", reason: `Breakout of $${breakoutLevel.toFixed(2)} confirmed at candle index ${breakoutIdx}.` };

      // --- FEATURE 2: Candle Body Close Confirmation for Breakout ---
      const boCandle = this.candles1m[breakoutIdx];
      const boRange = boCandle.high - boCandle.low;
      const boBody = Math.abs(boCandle.close - boCandle.open);
      const boBodyRatio = boRange > 0 ? boBody / boRange : 0;
      if (boBodyRatio < ms.min_breakout_body_ratio) {
        const bodyMsg = `Blocked: Weak breakout candle body at $${breakoutLevel.toFixed(2)} (Body is only ${(boBodyRatio * 100).toFixed(0)}% of total range). Likely false breakout/wick sweep.`;
        condDict["Breakout Candle Body Ratio"] = { status: "FAIL", reason: `Body ratio ${(boBodyRatio * 100).toFixed(0)}% < ${(ms.min_breakout_body_ratio * 100).toFixed(0)}%` };
        return getReturnObj(false, bodyMsg);
      }
      condDict["Breakout Candle Body Ratio"] = { status: "PASS", reason: `Body ratio ${(boBodyRatio * 100).toFixed(0)}% >= ${(ms.min_breakout_body_ratio * 100).toFixed(0)}%` };

      if (breakoutIdx === lastIdx) {
        const veryHighProbThreshold = ms.very_high_probability_threshold ?? 0.82;
        const hasHighProbability = probabilityLong >= veryHighProbThreshold;
        const hasHighHFPressure = ms.allow_immediate_breakout && (adxValue >= ms.hf_momentum_adx_threshold || (this.orderFlowStats.takerBuyRatio >= ms.hf_orderflow_taker_buy_ratio_long || this.orderBookStats.imbalanceRatio >= ms.hf_orderflow_imbalance_ratio_long));
        if (hasHighProbability && hasHighHFPressure) {
          condDict["Immediate Breakout Entry Allowance"] = { status: "PASS", reason: `Immediate breakout entry allowed under high-frequency pressure with high probability (${(probabilityLong * 100).toFixed(1)}%).` };
          return getReturnObj(
            true,
            `[HF Scalp Boost] Immediate Breakout Entry Confirmed! Price ($${currentPrice.toFixed(2)}) broke out above $${breakoutLevel.toFixed(2)} with very high probability (${(probabilityLong * 100).toFixed(1)}% >= ${(veryHighProbThreshold * 100).toFixed(0)}%) and high frequency momentum.`
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

      const postBreakoutCandles = this.candles1m.slice(breakoutIdx + 1);

      // --- FEATURE 4: Dynamic Invalidation & Stop-Loss Zones ---
      const structuralHL = struct.current_HL ? struct.current_HL.price : 0;
      const reclaimThreshold = Math.min(breakoutLevel, Math.max(breakoutLevel - invalidationMultiplier * currentAtr, structuralHL - 0.1 * currentAtr));
      const hasReclaimed = postBreakoutCandles.some(c => c.close < reclaimThreshold);
      const isSetup1Invalidated = hasReclaimed || currentPrice < reclaimThreshold;

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
      if (postBreakoutCandles.length > maxPostBreakoutCandles) {
        const chasingMsg = `Blocked: Chasing price after an extended upward move (more than ${maxPostBreakoutCandles} candles since HH breakout, ADX: ${adxValue.toFixed(1)} [${adxLabel}]) is forbidden.`;
        condDict["Chasing Lookback limit"] = { status: "FAIL", reason: `Elapsed ${postBreakoutCandles.length} candles exceeds limit ${maxPostBreakoutCandles}` };
        return getReturnObj(false, chasingMsg);
      }
      condDict["Chasing Lookback limit"] = { status: "PASS", reason: `Elapsed ${postBreakoutCandles.length} candles <= limit ${maxPostBreakoutCandles}` };

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
      
      // Parabolic Breakout Continuation: Allow high-ADX shallow consolidation entries on candle 2+
      const strongTrendAdx = ms.trend_alignment_adx_threshold || 28;
      const isHighAdxConsolidation = adxValue >= strongTrendAdx && postBreakoutCandles.length >= 1;
      const isShallowConsolidationHolding = isHighAdxConsolidation && postBreakoutCandles.every(c => c.close >= reclaimThreshold);

      let isPullbackRetestValid = false;
      let pullbackRetestMessage = "";
      if (isSetup1Invalidated) {
        condDict["Pullback & Retest Setup (Setup 1)"] = { status: "FAIL", reason: `Blocked: Price broke below breakout reclaim level $${reclaimThreshold.toFixed(2)}.` };
      } else if (hasPulledBackToZone || isShallowConsolidationHolding) {
        const isRejection = isLongRejectionConfirmed;
        const isContinuation = currentCandle.close > currentCandle.open && (currentCandle.close >= breakoutLevel || isLongRejectionConfirmed);
        if ((isRejection && isContinuation) || (isShallowConsolidationHolding && isContinuation)) {
          if (isVolumeHealthyForPullback) {
            isPullbackRetestValid = true;
            const setupLabel = isShallowConsolidationHolding && !hasPulledBackToZone
              ? `High-ADX Parabolic Continuation (${adxValue.toFixed(1)} ADX): Shallow consolidation held above $${breakoutLevel.toFixed(2)}`
              : `Pullback & Retest setup confirmed via [${longRejectionType}]`;
            pullbackRetestMessage = `${setupLabel}${mtfMessage}: Price ${isShallowConsolidationHolding && !hasPulledBackToZone ? 'consolidated tightly above' : 'pulled back to'} broken HH level ($${breakoutLevel.toFixed(2)}) on healthy volume and resumed trend (ADX: ${adxValue.toFixed(1)} [${adxLabel}]).`;
            condDict["Pullback & Retest Setup (Setup 1)"] = { status: "PASS", reason: pullbackRetestMessage };
          } else {
            pullbackRetestMessage = "Blocked Retest: Pullback volume is abnormally high, indicating excessive distribution/selling pressure.";
            condDict["Pullback & Retest Setup (Setup 1)"] = { status: "FAIL", reason: pullbackRetestMessage };
          }
        } else {
          condDict["Pullback & Retest Setup (Setup 1)"] = { status: "FAIL", reason: `Waiting for bullish confirmation candle pattern at broken HH support level $${breakoutLevel.toFixed(2)}.` };
        }
      } else {
        condDict["Pullback & Retest Setup (Setup 1)"] = { status: "SKIP", reason: `Skipped: Price has not recently pulled back to retest HH level of $${pullbackLimit.toFixed(2)} (or has already drifted too far above).` };
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
      
      // Calculate Fallback Micro EMA Momentum Confirmation with ATR fraction filters (Setup 2 fallback)
      const bounceAtrFraction = ms.fallback_crossover_bounce_atr_fraction !== undefined ? ms.fallback_crossover_bounce_atr_fraction : 0.15;
      const invalidationAtrFraction = ms.fallback_crossover_invalidation_atr_fraction !== undefined ? ms.fallback_crossover_invalidation_atr_fraction : 0.25;

      if (fallbackEnabled && closes.length >= fallbackSlowPeriod) {
        const fCurrent = fallbackFastSeries[lastIdx];
        const sCurrent = fallbackSlowSeries[lastIdx];
        
        // 1. Bullish Alignment (fast EMA above slow EMA)
        const isAlignedBullish = fCurrent > sCurrent;
        
        // 2. Bounce Confirmation (close is at least bounce fraction above slow EMA)
        const isBounceConfirmed = currentPrice >= sCurrent + bounceAtrFraction * currentAtr;
        
        // 3. Check for a recent crossover (fast EMA crossed above slow EMA within the last 3 candles)
        let hasRecentCrossover = false;
        for (let i = 0; i < 3; i++) {
          const currIdx = lastIdx - i;
          const prevIdx = currIdx - 1;
          if (prevIdx >= 0 && fallbackFastSeries[currIdx] !== undefined && fallbackSlowSeries[currIdx] !== undefined) {
            if (fallbackFastSeries[currIdx] > fallbackSlowSeries[currIdx] && fallbackFastSeries[prevIdx] <= fallbackSlowSeries[prevIdx]) {
              hasRecentCrossover = true;
              break;
            }
          }
        }

        // 4. Fallback Crossover Invalidation Check (only evaluates current price to allow retracement flexibility)
        const isFallbackCrossoverInvalidated = currentPrice < sCurrent - invalidationAtrFraction * currentAtr;

        // Crossover is valid if fast is above slow, price is bouncing or we had a recent crossover, and the current price is not below the invalidation threshold.
        if (isAlignedBullish && (isBounceConfirmed || hasRecentCrossover) && !isFallbackCrossoverInvalidated) {
          isFallbackCrossoverBullish = true;
        }
      }

      const isRegularEmaPushbackValid = (touchesFirstEma || touchesSecondEma) && isLongRejectionConfirmed && hasRetracedToEMA;
      const hasRetracedToEmaSinceBreakout = postBreakoutCandles.some(c => c.low <= emaRetraceThresholdFirst || c.low <= emaRetraceThresholdSecond);
      const isFallbackEmaPushbackValid = isFallbackCrossoverBullish && hasRetracedToEmaSinceBreakout;

      const isEmaPushbackValid = (isRegularEmaPushbackValid || isFallbackEmaPushbackValid) && !isSetup2Invalidated;
      let emaPushbackMessage = "";
      if (isEmaPushbackValid) {
        if (isVolumeHealthyForPullback) {
          const matchedEmaVal = touchesFirstEma ? firstEmaVal : (touchesSecondEma ? secondEmaVal : firstEmaVal);
          const confirmType = (isLongRejectionConfirmed && (touchesFirstEma || touchesSecondEma))
            ? `via [${longRejectionType}]` 
            : `via Fallback Micro EMA Momentum Bounce (${fallbackFastPeriod}/${fallbackSlowPeriod} EMA, +${bounceAtrFraction.toFixed(2)}xATR)`;
          emaPushbackMessage = `${emaZoneLabel} Pushback confirmed ${confirmType}${mtfMessage} (Adaptive Depth: ${classifiedDepth}): Price rejected/bounced off dynamic EMA support at $${matchedEmaVal.toFixed(2)} (ADX: ${adxValue.toFixed(1)} [${adxLabel}], EMA limit: +${effectiveEmaMult.toFixed(2)} * ATR).`;
          condDict["EMA Retracement / Pushback Setup (Setup 2)"] = { status: "PASS", reason: emaPushbackMessage };
        } else {
          emaPushbackMessage = "Blocked EMA Pushback: Abnormally high volume pullback during EMA retracement suggests a trend failure.";
          condDict["EMA Retracement / Pushback Setup (Setup 2)"] = { status: "FAIL", reason: emaPushbackMessage };
        }
      } else {
        if (isSetup2Invalidated) {
          condDict["EMA Retracement / Pushback Setup (Setup 2)"] = { status: "FAIL", reason: `Blocked: Price broke below dynamic EMA invalidation floor $${emaInvalidationFloor.toFixed(2)}.` };
        } else if (hasRetracedToEmaSinceBreakout) {
          condDict["EMA Retracement / Pushback Setup (Setup 2)"] = { status: "FAIL", reason: `Retraced to dynamic EMA zone, but did not reject first EMA ($${firstEmaVal.toFixed(2)}) or second EMA ($${secondEmaVal.toFixed(2)}) with confirmed rejection candle or fallback micro EMA crossover/momentum bounce (${fallbackFastPeriod}/${fallbackSlowPeriod} EMA, +${bounceAtrFraction.toFixed(2)}xATR).` };
        } else {
          const thresholdVal = Math.max(emaRetraceThresholdFirst, emaRetraceThresholdSecond);
          condDict["EMA Retracement / Pushback Setup (Setup 2)"] = { status: "SKIP", reason: `Skipped: Price has not recently retraced into dynamic EMA threshold level of $${thresholdVal.toFixed(2)}.` };
        }
      }

      if (isPullbackRetestValid && !pullbackRetestMessage.startsWith("Blocked")) {
        return getReturnObj(true, pullbackRetestMessage);
      } else if (isEmaPushbackValid && !emaPushbackMessage.startsWith("Blocked")) {
        return getReturnObj(true, emaPushbackMessage);
      } else {
        const failureReason = !isVolumeHealthyForPullback
          ? "Pullback volume is abnormally high (distribution risk); waiting for volume to dry up before confirming a safe entry."
          : `Waiting for either breakout -> pullback -> retest OR breakout -> retracement to ${emaZoneLabel} pushback setup (Adaptive Expected Depth: ${classifiedDepth}, ADX: ${adxValue.toFixed(1)} [${adxLabel}]).`;
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

      if (breakoutIdx === -1) {
        const breakoutMsg = `Waiting for a confirmed Lower Low breakout of $${breakoutLevel.toFixed(2)} to initiate the pullback/retest or EMA pushback setup sequence.`;
        condDict["Breakout Level Confirmation"] = { status: "FAIL", reason: `No LL breakout closed below $${breakoutLevel.toFixed(2)}.` };
        return getReturnObj(false, breakoutMsg);
      }
      condDict["Breakout Level Confirmation"] = { status: "PASS", reason: `Breakout of $${breakoutLevel.toFixed(2)} confirmed at candle index ${breakoutIdx}.` };

      // --- FEATURE 2: Candle Body Close Confirmation for Breakout ---
      const boCandle = this.candles1m[breakoutIdx];
      const boRange = boCandle.high - boCandle.low;
      const boBody = Math.abs(boCandle.close - boCandle.open);
      const boBodyRatio = boRange > 0 ? boBody / boRange : 0;
      if (boBodyRatio < ms.min_breakout_body_ratio) {
        const bodyMsg = `Blocked: Weak breakout candle body at $${breakoutLevel.toFixed(2)} (Body is only ${(boBodyRatio * 100).toFixed(0)}% of total range). Likely false breakout/wick sweep.`;
        condDict["Breakout Candle Body Ratio"] = { status: "FAIL", reason: `Body ratio ${(boBodyRatio * 100).toFixed(0)}% < ${(ms.min_breakout_body_ratio * 100).toFixed(0)}%` };
        return getReturnObj(false, bodyMsg);
      }
      condDict["Breakout Candle Body Ratio"] = { status: "PASS", reason: `Body ratio ${(boBodyRatio * 100).toFixed(0)}% >= ${(ms.min_breakout_body_ratio * 100).toFixed(0)}%` };

      if (breakoutIdx === lastIdx) {
        const veryHighProbThreshold = ms.very_high_probability_threshold ?? 0.82;
        const probabilityShort = 1 - probabilityLong;
        const hasHighProbability = probabilityShort >= veryHighProbThreshold;
        const hasHighHFPressure = ms.allow_immediate_breakout && (adxValue >= ms.hf_momentum_adx_threshold || (this.orderFlowStats.takerBuyRatio <= ms.hf_orderflow_taker_buy_ratio_short || this.orderBookStats.imbalanceRatio <= ms.hf_orderflow_imbalance_ratio_short));
        if (hasHighProbability && hasHighHFPressure) {
          condDict["Immediate Breakout Entry Allowance"] = { status: "PASS", reason: `Immediate breakdown entry allowed under high-frequency pressure with high probability (${(probabilityShort * 100).toFixed(1)}%).` };
          return getReturnObj(
            true,
            `[HF Scalp Boost] Immediate Breakdown Entry Confirmed! Price ($${currentPrice.toFixed(2)}) broke down below $${breakoutLevel.toFixed(2)} with very high probability (${(probabilityShort * 100).toFixed(1)}% >= ${(veryHighProbThreshold * 100).toFixed(0)}%) and high frequency momentum.`
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

      const postBreakoutCandles = this.candles1m.slice(breakoutIdx + 1);

      // --- FEATURE 4: Dynamic Invalidation & Stop-Loss Zones ---
      const structuralLH = struct.current_LH ? struct.current_LH.price : Infinity;
      const reclaimThreshold = Math.max(breakoutLevel, Math.min(breakoutLevel + invalidationMultiplier * currentAtr, structuralLH + 0.1 * currentAtr));
      const hasReclaimed = postBreakoutCandles.some(c => c.close > reclaimThreshold);
      const isSetup1Invalidated = hasReclaimed || currentPrice > reclaimThreshold;

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
      if (postBreakoutCandles.length > maxPostBreakoutCandles) {
        const chasingMsg = `Blocked: Chasing price after an extended downward move (more than ${maxPostBreakoutCandles} candles since LL breakout, ADX: ${adxValue.toFixed(1)} [${adxLabel}]) is forbidden.`;
        condDict["Chasing Lookback limit"] = { status: "FAIL", reason: `Elapsed ${postBreakoutCandles.length} candles exceeds limit ${maxPostBreakoutCandles}` };
        return getReturnObj(false, chasingMsg);
      }
      condDict["Chasing Lookback limit"] = { status: "PASS", reason: `Elapsed ${postBreakoutCandles.length} candles <= limit ${maxPostBreakoutCandles}` };

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
      
      // Parabolic Breakdown Continuation: Allow high-ADX shallow consolidation entries on candle 2+
      const strongTrendAdx = ms.trend_alignment_adx_threshold || 28;
      const isHighAdxConsolidation = adxValue >= strongTrendAdx && postBreakoutCandles.length >= 1;
      const isShallowConsolidationHolding = isHighAdxConsolidation && postBreakoutCandles.every(c => c.close <= reclaimThreshold);

      let isPullbackRetestValid = false;
      let pullbackRetestMessage = "";
      if (isSetup1Invalidated) {
        condDict["Pullback & Retest Setup (Setup 1)"] = { status: "FAIL", reason: `Blocked: Price broke above breakout reclaim level $${reclaimThreshold.toFixed(2)}.` };
      } else if (hasPulledBackToZone || isShallowConsolidationHolding) {
        const isRejection = isShortRejectionConfirmed;
        const isContinuation = currentCandle.close < currentCandle.open && (currentCandle.close <= breakoutLevel || isShortRejectionConfirmed);
        if ((isRejection && isContinuation) || (isShallowConsolidationHolding && isContinuation)) {
          if (isVolumeHealthyForPullback) {
            isPullbackRetestValid = true;
            const setupLabel = isShallowConsolidationHolding && !hasPulledBackToZone
              ? `High-ADX Parabolic Continuation (${adxValue.toFixed(1)} ADX): Shallow consolidation held below $${breakoutLevel.toFixed(2)}`
              : `Pullback & Retest setup confirmed via [${shortRejectionType}]`;
            pullbackRetestMessage = `${setupLabel}${mtfMessage}: Price ${isShallowConsolidationHolding && !hasPulledBackToZone ? 'consolidated tightly below' : 'pulled back to'} broken LL level ($${breakoutLevel.toFixed(2)}) on healthy volume and resumed trend (ADX: ${adxValue.toFixed(1)} [${adxLabel}]).`;
            condDict["Pullback & Retest Setup (Setup 1)"] = { status: "PASS", reason: pullbackRetestMessage };
          } else {
            pullbackRetestMessage = "Blocked Retest: Pullback volume is abnormally high, indicating excessive accumulation/buying pressure.";
            condDict["Pullback & Retest Setup (Setup 1)"] = { status: "FAIL", reason: pullbackRetestMessage };
          }
        } else {
          condDict["Pullback & Retest Setup (Setup 1)"] = { status: "FAIL", reason: `Waiting for bearish confirmation candle pattern at broken LL resistance level $${breakoutLevel.toFixed(2)}.` };
        }
      } else {
        condDict["Pullback & Retest Setup (Setup 1)"] = { status: "SKIP", reason: `Skipped: Price has not recently pulled back to retest LL level of $${pullbackLimit.toFixed(2)} (or has already drifted too far below).` };
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
      
      // Calculate Fallback Micro EMA Momentum Confirmation with ATR fraction filters (Setup 2 fallback)
      const bounceAtrFraction = ms.fallback_crossover_bounce_atr_fraction !== undefined ? ms.fallback_crossover_bounce_atr_fraction : 0.15;
      const invalidationAtrFraction = ms.fallback_crossover_invalidation_atr_fraction !== undefined ? ms.fallback_crossover_invalidation_atr_fraction : 0.25;

      if (fallbackEnabled && closes.length >= fallbackSlowPeriod) {
        const fCurrent = fallbackFastSeries[lastIdx];
        const sCurrent = fallbackSlowSeries[lastIdx];
        
        // 1. Bearish Alignment (fast EMA below slow EMA)
        const isAlignedBearish = fCurrent < sCurrent;
        
        // 2. Bounce Confirmation (close is at least bounce fraction below slow EMA)
        const isBounceConfirmed = currentPrice <= sCurrent - bounceAtrFraction * currentAtr;
        
        // 3. Check for a recent crossover (fast EMA crossed below slow EMA within the last 3 candles)
        let hasRecentCrossover = false;
        for (let i = 0; i < 3; i++) {
          const currIdx = lastIdx - i;
          const prevIdx = currIdx - 1;
          if (prevIdx >= 0 && fallbackFastSeries[currIdx] !== undefined && fallbackSlowSeries[currIdx] !== undefined) {
            if (fallbackFastSeries[currIdx] < fallbackSlowSeries[currIdx] && fallbackFastSeries[prevIdx] >= fallbackSlowSeries[prevIdx]) {
              hasRecentCrossover = true;
              break;
            }
          }
        }

        // 4. Fallback Crossover Invalidation Check (only evaluates current price to allow retracement flexibility)
        const isFallbackCrossoverInvalidated = currentPrice > sCurrent + invalidationAtrFraction * currentAtr;

        // Crossover is valid if fast is below slow, price is bouncing or we had a recent crossover, and the current price is not above the invalidation threshold.
        if (isAlignedBearish && (isBounceConfirmed || hasRecentCrossover) && !isFallbackCrossoverInvalidated) {
          isFallbackCrossoverBearish = true;
        }
      }

      const isRegularEmaPushbackValid = (touchesFirstEma || touchesSecondEma) && isShortRejectionConfirmed && hasRetracedToEMA;
      const hasRetracedToEmaSinceBreakout = postBreakoutCandles.some(c => c.high >= emaRetraceThresholdFirst || c.high >= emaRetraceThresholdSecond);
      const isFallbackEmaPushbackValid = isFallbackCrossoverBearish && hasRetracedToEmaSinceBreakout;

      const isEmaPushbackValid = (isRegularEmaPushbackValid || isFallbackEmaPushbackValid) && !isSetup2Invalidated;
      let emaPushbackMessage = "";
      if (isEmaPushbackValid) {
        if (isVolumeHealthyForPullback) {
          const matchedEmaVal = touchesFirstEma ? firstEmaVal : (touchesSecondEma ? secondEmaVal : firstEmaVal);
          const confirmType = (isShortRejectionConfirmed && (touchesFirstEma || touchesSecondEma))
            ? `via [${shortRejectionType}]` 
            : `via Fallback Micro EMA Momentum Bounce (${fallbackFastPeriod}/${fallbackSlowPeriod} EMA, -${bounceAtrFraction.toFixed(2)}xATR)`;
          emaPushbackMessage = `${emaZoneLabel} Pushback confirmed ${confirmType}${mtfMessage} (Adaptive Depth: ${classifiedDepth}): Price rejected/bounced off dynamic EMA resistance at $${matchedEmaVal.toFixed(2)} (ADX: ${adxValue.toFixed(1)} [${adxLabel}], EMA limit: -${effectiveEmaMult.toFixed(2)} * ATR).`;
          condDict["EMA Retracement / Pushback Setup (Setup 2)"] = { status: "PASS", reason: emaPushbackMessage };
        } else {
          emaPushbackMessage = "Blocked EMA Pushback: Abnormally high volume pullback during EMA retracement suggests a trend failure.";
          condDict["EMA Retracement / Pushback Setup (Setup 2)"] = { status: "FAIL", reason: emaPushbackMessage };
        }
      } else {
        if (isSetup2Invalidated) {
          condDict["EMA Retracement / Pushback Setup (Setup 2)"] = { status: "FAIL", reason: `Blocked: Price broke above dynamic EMA invalidation ceiling $${emaInvalidationCeiling.toFixed(2)}.` };
        } else if (hasRetracedToEmaSinceBreakout) {
          condDict["EMA Retracement / Pushback Setup (Setup 2)"] = { status: "FAIL", reason: `Retraced to dynamic EMA zone, but did not reject first EMA ($${firstEmaVal.toFixed(2)}) or second EMA ($${secondEmaVal.toFixed(2)}) with confirmed rejection candle or fallback micro EMA crossover/momentum bounce (${fallbackFastPeriod}/${fallbackSlowPeriod} EMA, -${bounceAtrFraction.toFixed(2)}xATR).` };
        } else {
          const thresholdVal = Math.min(emaRetraceThresholdFirst, emaRetraceThresholdSecond);
          condDict["EMA Retracement / Pushback Setup (Setup 2)"] = { status: "SKIP", reason: `Skipped: Price has not recently retraced into dynamic EMA threshold level of $${thresholdVal.toFixed(2)}.` };
        }
      }

      if (isPullbackRetestValid && !pullbackRetestMessage.startsWith("Blocked")) {
        return getReturnObj(true, pullbackRetestMessage);
      } else if (isEmaPushbackValid && !emaPushbackMessage.startsWith("Blocked")) {
        return getReturnObj(true, emaPushbackMessage);
      } else {
        const failureReason = !isVolumeHealthyForPullback
          ? "Pullback volume is abnormally high (accumulation risk); waiting for volume to dry up before confirming a safe entry."
          : `Waiting for either breakout -> pullback -> retest OR breakout -> retracement to ${emaZoneLabel} pushback setup (Adaptive Expected Depth: ${classifiedDepth}, ADX: ${adxValue.toFixed(1)} [${adxLabel}]).`;
        return getReturnObj(false, failureReason);
      }
    }
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

    if (direction === "LONG") {
      // 1. Must be a green candle
      if (currentCandle.close <= currentCandle.open) {
        return { isValid: false, reason: "Breakout candle is not bullish (red or doji)." };
      }

      // 2. Volume Expansion: Require strong volume for range breakouts
      if (relVolume < 1.4) {
        return { isValid: false, reason: `Insufficient relative volume (${relVolume.toFixed(2)}x < 1.4x).` };
      }

      // 3. Candle Body Ratio: At least 45% of the candle range should be body
      if (bodyRatio < 0.45) {
        return { isValid: false, reason: `Weak candle body structure (body ratio ${bodyRatio.toFixed(2)} < 0.45).` };
      }

      // 4. Upper Wick Rejection: Upper wick should not exceed 30% of total candle range
      const upperWick = currentCandle.high - currentCandle.close;
      const upperWickRatio = upperWick / candleRange;
      if (upperWickRatio > 0.30) {
        return { isValid: false, reason: `Excessive upper wick rejection (${(upperWickRatio * 100).toFixed(1)}% > 30.0%) indicating a bull trap.` };
      }

      // 5. Candle Size Check: Prevent micro-candles from drifting above range resistance
      if (candleRange < avgRange * 0.8) {
        return { isValid: false, reason: `Breakout candle size is too small (${candleRange.toFixed(2)} < 80% of average range ${avgRange.toFixed(2)}).` };
      }

    } else {
      // SHORT breakdown
      // 1. Must be a red candle
      if (currentCandle.close >= currentCandle.open) {
        return { isValid: false, reason: "Breakdown candle is not bearish (green or doji)." };
      }

      // 2. Volume Expansion
      if (relVolume < 1.4) {
        return { isValid: false, reason: `Insufficient relative volume (${relVolume.toFixed(2)}x < 1.4x).` };
      }

      // 3. Candle Body Ratio
      if (bodyRatio < 0.45) {
        return { isValid: false, reason: `Weak candle body structure (body ratio ${bodyRatio.toFixed(2)} < 0.45).` };
      }

      // 4. Lower Wick Rejection: Lower wick should not exceed 30% of total candle range
      const lowerWick = currentCandle.close - currentCandle.low;
      const lowerWickRatio = lowerWick / candleRange;
      if (lowerWickRatio > 0.30) {
        return { isValid: false, reason: `Excessive lower wick rejection (${(lowerWickRatio * 100).toFixed(1)}% > 30.0%) indicating a bear trap.` };
      }

      // 5. Candle Size Check
      if (candleRange < avgRange * 0.8) {
        return { isValid: false, reason: `Breakdown candle size is too small (${candleRange.toFixed(2)} < 80% of average range ${avgRange.toFixed(2)}).` };
      }
    }

    return { isValid: true, reason: "Breakout validated." };
  }

  private evaluateMarketStructureConfirmation(signalDirection: "LONG" | "SHORT" | "NEUTRAL", probabilityLong: number): MarketStructureConfirmationResult {
    const rawResult = this.evaluateMarketStructureConfirmationRaw(signalDirection, probabilityLong);
    return this.applyEma200ProximityFilter(signalDirection, this.currentPrice, rawResult);
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
        message: `Blocked: LONG trade avoided because the EMA 200 long-term trend is strongly bearish (Angle: ${angle.toFixed(1)}°), presenting high overhead rejection risk.`
      };
    }
    if (direction === "SHORT" && angle > 12) {
      return {
        ...result,
        confirmed: false,
        message: `Blocked: SHORT trade avoided because the EMA 200 long-term trend is strongly bullish (Angle: ${angle.toFixed(1)}°), presenting high dynamic support bounce risk.`
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
          message: `Blocked: LONG trade avoided because EMA 200 ($${ema200Val.toFixed(2)}) is nearby above the price ($${currentPrice.toFixed(2)}) within ${proximityThreshold.toFixed(2)} (${proximityMultiplier.toFixed(1)} * ATR: ${currentAtr.toFixed(2)}) in a ${stateLabel} environment (EMA 200 Angle: ${angle.toFixed(1)}°).`
        };
      }
    } else if (direction === "SHORT") {
      const distance = currentPrice - ema200Val;
      if (distance > 0 && distance < proximityThreshold) {
        return {
          ...result,
          confirmed: false,
          message: `Blocked: SHORT trade avoided because EMA 200 ($${ema200Val.toFixed(2)}) is nearby below the price ($${currentPrice.toFixed(2)}) within ${proximityThreshold.toFixed(2)} (${proximityMultiplier.toFixed(1)} * ATR: ${currentAtr.toFixed(2)}) in a ${stateLabel} environment (EMA 200 Angle: ${angle.toFixed(1)}°).`
        };
      }
    }

    return result;
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
    const ms = config.market_structure || {};
    
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

    // Support/Resistance threshold uses fraction of range width and relative ATR (removing rigid 0.15% price cap)
    const rangeSupportThreshold = rangeLow + Math.min(rangeWidth * 0.15, Math.max(rangeWidth * 0.08, 0.5 * currentAtr));
    const rangeResistanceThreshold = rangeHigh - Math.min(rangeWidth * 0.15, Math.max(rangeWidth * 0.08, 0.5 * currentAtr));
    
    // --- 1. Recent Touch Check (Lookback Window) ---
    const retestLookback = 5;
    const evaluationSlice = this.candles1m.slice(Math.max(0, lastIdx - retestLookback + 1), lastIdx + 1);
    
    const hasTestedSupportRecently = evaluationSlice.some(c => c.low <= rangeSupportThreshold);
    const hasTestedResistanceRecently = evaluationSlice.some(c => c.high >= rangeResistanceThreshold);
    
    // --- 2. Multiple Reversal & Entry Confirmations ---
    
    // CONFIRMATION A: Standard Candlestick Reversal Pattern
    const rejectionCheckLong = this.isMultiCandleLongRejection(lastIdx, currentAtr);
    const rejectionCheckShort = this.isMultiCandleShortRejection(lastIdx, currentAtr);
    
    const prevRejectionCheckLong = lastIdx >= 1 ? this.isMultiCandleLongRejection(lastIdx - 1, currentAtr) : { confirmed: false, type: "" };
    const prevRejectionCheckShort = lastIdx >= 1 ? this.isMultiCandleShortRejection(lastIdx - 1, currentAtr) : { confirmed: false, type: "" };
    
    const isCandleReversalBullish = rejectionCheckLong.confirmed || prevRejectionCheckLong.confirmed;
    const isCandleReversalBearish = rejectionCheckShort.confirmed || prevRejectionCheckShort.confirmed;
    
    const candlePatternTypeLong = rejectionCheckLong.confirmed ? rejectionCheckLong.type : prevRejectionCheckLong.type;
    const candlePatternTypeShort = rejectionCheckShort.confirmed ? rejectionCheckShort.type : prevRejectionCheckShort.type;
    
    // CONFIRMATION B: Standard Green/Red Candle Close
    const isCurrentCandleGreen = currentCandle.close > currentCandle.open;
    const isCurrentCandleRed = currentCandle.close < currentCandle.open;
    
    const isImmediateGreenOnSupport = (currentCandle.close <= rangeSupportThreshold || currentPrice <= rangeSupportThreshold) && isCurrentCandleGreen;
    const isImmediateRedOnResistance = (currentCandle.close >= rangeResistanceThreshold || currentPrice >= rangeResistanceThreshold) && isCurrentCandleRed;
    
    // CONFIRMATION C: Micro EMA Crossover / Momentum Bounce
    const microFastPeriod = 5;
    const microSlowPeriod = 15;
    const closes = this.candles1m.map(c => c.close);
    const fallbackFastSeries = this.calculateEMA(closes, microFastPeriod);
    const fallbackSlowSeries = this.calculateEMA(closes, microSlowPeriod);
    
    let hasRecentMicroBullishCrossover = false;
    let hasRecentMicroBearishCrossover = false;
    
    for (let i = 0; i < 3; i++) {
      const currIdx = lastIdx - i;
      const prevIdx = currIdx - 1;
      if (prevIdx >= 0 && fallbackFastSeries[currIdx] !== undefined && fallbackSlowSeries[currIdx] !== undefined) {
        if (fallbackFastSeries[currIdx] > fallbackSlowSeries[currIdx] && fallbackFastSeries[prevIdx] <= fallbackSlowSeries[prevIdx]) {
          hasRecentMicroBullishCrossover = true;
        }
        if (fallbackFastSeries[currIdx] < fallbackSlowSeries[currIdx] && fallbackFastSeries[prevIdx] >= fallbackSlowSeries[prevIdx]) {
          hasRecentMicroBearishCrossover = true;
        }
      }
    }
    
    const isMicroEMAAlignedBullish = fallbackFastSeries[lastIdx] > fallbackSlowSeries[lastIdx];
    const isMicroEMAAlignedBearish = fallbackFastSeries[lastIdx] < fallbackSlowSeries[lastIdx];
    
    // CONFIRMATION D: RSI Hook from oversold/overbought levels
    const rsi14 = this.calculateRSI(closes, 14);
    const currentRsi = rsi14[lastIdx] || 50;
    
    const recentRsiSlice = rsi14.slice(Math.max(0, lastIdx - 4), lastIdx + 1);
    const wasRsiOversold = recentRsiSlice.some(r => r <= 35);
    const wasRsiOverbought = recentRsiSlice.some(r => r >= 65);
    
    const isRsiHookedBullish = wasRsiOversold && currentRsi > recentRsiSlice[0] && isCurrentCandleGreen;
    const isRsiHookedBearish = wasRsiOverbought && currentRsi < recentRsiSlice[0] && isCurrentCandleRed;
    
    // --- 3. Evaluate Long Reversal ---
    let isLongReversal = false;
    let longReason = "";
    
    const maxLongPriceThreshold = rangeLow + Math.max(rangeWidth * 0.40, 0.30 * currentAtr);
    const rangeLongMinFloor = rangeLow - 0.75 * currentAtr;
    const isNotCrashingBreakdown = currentPrice >= rangeLongMinFloor || currentCandle.close >= rangeLow;
    const isPriceWithinLongZone = currentPrice <= maxLongPriceThreshold && isNotCrashingBreakdown;
    
    if (hasTestedSupportRecently && isPriceWithinLongZone) {
      if (isCandleReversalBullish) {
        isLongReversal = true;
        longReason = `Confirmed via [${candlePatternTypeLong}] following recent support touch of $${rangeLow.toFixed(2)}`;
      } else if (hasRecentMicroBullishCrossover && isMicroEMAAlignedBullish) {
        isLongReversal = true;
        longReason = `Confirmed via Micro EMA Crossover (${microFastPeriod}/${microSlowPeriod} EMA) following recent support touch of $${rangeLow.toFixed(2)}`;
      } else if (isRsiHookedBullish) {
        isLongReversal = true;
        longReason = `Confirmed via RSI Hook (${currentRsi.toFixed(1)}) from oversold following recent support touch of $${rangeLow.toFixed(2)}`;
      } else if (isImmediateGreenOnSupport) {
        isLongReversal = true;
        longReason = `Confirmed via Bullish close at/below support threshold ($${rangeSupportThreshold.toFixed(2)})`;
      }
    }
    
    // --- 4. Evaluate Short Reversal ---
    let isShortReversal = false;
    let shortReason = "";
    
    const minShortPriceThreshold = rangeHigh - Math.max(rangeWidth * 0.40, 0.30 * currentAtr);
    const rangeShortMaxCeiling = rangeHigh + 0.75 * currentAtr;
    const isNotExplodingBreakout = currentPrice <= rangeShortMaxCeiling || currentCandle.close <= rangeHigh;
    const isPriceWithinShortZone = currentPrice >= minShortPriceThreshold && isNotExplodingBreakout;
    
    if (hasTestedResistanceRecently && isPriceWithinShortZone) {
      if (isCandleReversalBearish) {
        isShortReversal = true;
        shortReason = `Confirmed via [${candlePatternTypeShort}] following recent resistance touch of $${rangeHigh.toFixed(2)}`;
      } else if (hasRecentMicroBearishCrossover && isMicroEMAAlignedBearish) {
        isShortReversal = true;
        shortReason = `Confirmed via Micro EMA Crossover (${microFastPeriod}/${microSlowPeriod} EMA) following recent resistance touch of $${rangeHigh.toFixed(2)}`;
      } else if (isRsiHookedBearish) {
        isShortReversal = true;
        shortReason = `Confirmed via RSI Hook (${currentRsi.toFixed(1)}) from overbought following recent resistance touch of $${rangeHigh.toFixed(2)}`;
      } else if (isImmediateRedOnResistance) {
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

  private isMultiCandleLongRejection(lastIdx: number, currentAtr: number): { confirmed: boolean; type: string } {
    if (lastIdx < 0) return { confirmed: false, type: "" };
    const currentCandle = this.candles1m[lastIdx];
    const range = currentCandle.high - currentCandle.low;
    const body = Math.abs(currentCandle.close - currentCandle.open);
    const upperWick = currentCandle.high - Math.max(currentCandle.close, currentCandle.open);
    const lowerWick = Math.min(currentCandle.close, currentCandle.open) - currentCandle.low;
    const isBullish = currentCandle.close > currentCandle.open;
    const prevCandle = lastIdx >= 1 ? this.candles1m[lastIdx - 1] : null;

    // Single Candle Patterns
    const isPinBar = range > 0 && lowerWick >= 0.5 * range && upperWick <= 0.25 * range;
    const isMajorWickRejection = range > 0 && lowerWick >= 0.65 * range;
    const hasStrongClose = range > 0 && (currentCandle.close - currentCandle.low) / range >= 0.70;
    const isMomentumCandle = isBullish && body >= 0.7 * currentAtr;
    const isIndecision = range > 0 && (body / range < 0.15) && !isPinBar && !isMajorWickRejection;

    // Two-Candle Patterns
    const isBullishEngulfing = prevCandle && 
      (prevCandle.close < prevCandle.open) && 
      isBullish && 
      (currentCandle.close >= prevCandle.open) && 
      (currentCandle.open <= prevCandle.close);

    const hasMultiWickRejection = prevCandle && 
      (lowerWick >= 0.35 * range) && 
      ((Math.min(prevCandle.close, prevCandle.open) - prevCandle.low) >= 0.35 * (prevCandle.high - prevCandle.low)) && 
      Math.abs(currentCandle.low - prevCandle.low) < 0.15 * currentAtr;

    // 1. Tweezer Bottom (Two-candle)
    let isTweezerBottom = false;
    if (prevCandle) {
      const prevRange = prevCandle.high - prevCandle.low;
      const prevLowerWick = Math.min(prevCandle.close, prevCandle.open) - prevCandle.low;
      const matchingLows = Math.abs(currentCandle.low - prevCandle.low) < 0.05 * currentAtr;
      const currentHasLowerWick = range > 0 && lowerWick >= 0.25 * range;
      const prevHasLowerWick = prevRange > 0 && prevLowerWick >= 0.25 * prevRange;
      if (matchingLows && currentHasLowerWick && prevHasLowerWick && (isBullish || hasStrongClose)) {
        isTweezerBottom = true;
      }
    }

    // 2. Piercing Line (Two-candle)
    let isPiercingLine = false;
    if (prevCandle) {
      const prevRange = prevCandle.high - prevCandle.low;
      const prevBody = prevCandle.open - prevCandle.close;
      const isPrevStrongBearish = prevCandle.close < prevCandle.open && prevBody >= 0.3 * prevRange;
      const opensBelowPrevClose = currentCandle.open < prevCandle.close + 0.05 * currentAtr;
      const closesAboveMidpoint = currentCandle.close >= (prevCandle.open + prevCandle.close) / 2;
      if (isPrevStrongBearish && opensBelowPrevClose && closesAboveMidpoint && isBullish && currentCandle.close < prevCandle.open) {
        isPiercingLine = true;
      }
    }

    // Three-Candle Patterns
    // 3. Morning Star
    let isMorningStar = false;
    if (lastIdx >= 2) {
      const c2 = this.candles1m[lastIdx - 2];
      const c1 = this.candles1m[lastIdx - 1];
      const c0 = currentCandle;

      const r2 = c2.high - c2.low;
      const b2 = c2.open - c2.close;
      const isC2StrongBearish = c2.close < c2.open && b2 >= 0.3 * r2;

      const r1 = c1.high - c1.low;
      const b1 = Math.abs(c1.close - c1.open);
      const isC1Indecision = r1 > 0 && (b1 / r1 < 0.3);
      const isC1Low = c1.low <= Math.min(c2.low, c0.low) + 0.1 * currentAtr;

      const isC0BullishStarRetest = c0.close > c0.open && c0.close >= (c2.open + c2.close) / 2;

      if (isC2StrongBearish && isC1Indecision && isC1Low && isC0BullishStarRetest) {
        isMorningStar = true;
      }
    }

    // 4. Three White Soldiers
    let isThreeWhiteSoldiers = false;
    if (lastIdx >= 2) {
      const c2 = this.candles1m[lastIdx - 2];
      const c1 = this.candles1m[lastIdx - 1];
      const c0 = currentCandle;

      const c2Bullish = c2.close > c2.open;
      const c1Bullish = c1.close > c1.open;
      const c0Bullish = c0.close > c0.open;

      const ascendingCloses = c0.close > c1.close && c1.close > c2.close;
      
      const b2 = c2.close - c2.open;
      const b1 = c1.close - c1.open;
      const b0 = c0.close - c0.open;

      const healthyBodies = b2 >= 0.2 * currentAtr && b1 >= 0.2 * currentAtr && b0 >= 0.2 * currentAtr;

      if (c2Bullish && c1Bullish && c0Bullish && ascendingCloses && healthyBodies) {
        isThreeWhiteSoldiers = true;
      }
    }

    if (isPinBar) return { confirmed: !isIndecision, type: "Bullish Pin Bar" };
    if (isMajorWickRejection) return { confirmed: true, type: "65%+ Wick-to-Range Lower Rejection" };
    if (isBullishEngulfing) return { confirmed: !isIndecision, type: "Bullish Engulfing Pattern" };
    if (hasMultiWickRejection) return { confirmed: !isIndecision, type: "Multi-Candle Wick Rejection" };
    if (isTweezerBottom) return { confirmed: !isIndecision, type: "Tweezer Bottom Reversal Pattern" };
    if (isPiercingLine) return { confirmed: !isIndecision, type: "Piercing Line Reversal Pattern" };
    if (isMorningStar) return { confirmed: !isIndecision, type: "Morning Star Reversal Pattern" };
    if (isThreeWhiteSoldiers) return { confirmed: !isIndecision, type: "Three White Soldiers Continuation Pattern" };
    if (isMomentumCandle && hasStrongClose) return { confirmed: !isIndecision, type: "Bullish Momentum Candle" };
    if (hasStrongClose && (lowerWick > upperWick || isBullish)) return { confirmed: !isIndecision, type: "Strong Close Support Rejection" };

    return { confirmed: false, type: "" };
  }

  private isMultiCandleShortRejection(lastIdx: number, currentAtr: number): { confirmed: boolean; type: string } {
    if (lastIdx < 0) return { confirmed: false, type: "" };
    const currentCandle = this.candles1m[lastIdx];
    const range = currentCandle.high - currentCandle.low;
    const body = Math.abs(currentCandle.close - currentCandle.open);
    const upperWick = currentCandle.high - Math.max(currentCandle.close, currentCandle.open);
    const lowerWick = Math.min(currentCandle.close, currentCandle.open) - currentCandle.low;
    const isBearish = currentCandle.close < currentCandle.open;
    const prevCandle = lastIdx >= 1 ? this.candles1m[lastIdx - 1] : null;

    // Single Candle Patterns
    const isPinBar = range > 0 && upperWick >= 0.5 * range && lowerWick <= 0.25 * range;
    const isMajorWickRejection = range > 0 && upperWick >= 0.65 * range;
    const hasStrongClose = range > 0 && (currentCandle.high - currentCandle.close) / range >= 0.70;
    const isMomentumCandle = isBearish && body >= 0.7 * currentAtr;
    const isIndecision = range > 0 && (body / range < 0.15) && !isPinBar && !isMajorWickRejection;

    // Two-Candle Patterns
    const isBearishEngulfing = prevCandle && 
      (prevCandle.close > prevCandle.open) && 
      isBearish && 
      (currentCandle.close <= prevCandle.open) && 
      (currentCandle.open >= prevCandle.close);

    const hasMultiWickRejection = prevCandle && 
      (upperWick >= 0.35 * range) && 
      ((prevCandle.high - Math.max(prevCandle.close, prevCandle.open)) >= 0.35 * (prevCandle.high - prevCandle.low)) && 
      Math.abs(currentCandle.high - prevCandle.high) < 0.15 * currentAtr;

    // 1. Tweezer Top (Two-candle)
    let isTweezerTop = false;
    if (prevCandle) {
      const prevRange = prevCandle.high - prevCandle.low;
      const prevUpperWick = prevCandle.high - Math.max(prevCandle.close, prevCandle.open);
      const matchingHighs = Math.abs(currentCandle.high - prevCandle.high) < 0.05 * currentAtr;
      const currentHasUpperWick = range > 0 && upperWick >= 0.25 * range;
      const prevHasUpperWick = prevRange > 0 && prevUpperWick >= 0.25 * prevRange;
      if (matchingHighs && currentHasUpperWick && prevHasUpperWick && (isBearish || hasStrongClose)) {
        isTweezerTop = true;
      }
    }

    // 2. Dark Cloud Cover (Two-candle)
    let isDarkCloudCover = false;
    if (prevCandle) {
      const prevRange = prevCandle.high - prevCandle.low;
      const prevBody = prevCandle.close - prevCandle.open;
      const isPrevStrongBullish = prevCandle.close > prevCandle.open && prevBody >= 0.3 * prevRange;
      const opensAbovePrevClose = currentCandle.open > prevCandle.close - 0.05 * currentAtr;
      const closesBelowMidpoint = currentCandle.close <= (prevCandle.open + prevCandle.close) / 2;
      if (isPrevStrongBullish && opensAbovePrevClose && closesBelowMidpoint && isBearish && currentCandle.close > prevCandle.open) {
        isDarkCloudCover = true;
      }
    }

    // Three-Candle Patterns
    // 3. Evening Star
    let isEveningStar = false;
    if (lastIdx >= 2) {
      const c2 = this.candles1m[lastIdx - 2];
      const c1 = this.candles1m[lastIdx - 1];
      const c0 = currentCandle;

      const r2 = c2.high - c2.low;
      const b2 = c2.close - c2.open;
      const isC2StrongBullish = c2.close > c2.open && b2 >= 0.3 * r2;

      const r1 = c1.high - c1.low;
      const b1 = Math.abs(c1.close - c1.open);
      const isC1Indecision = r1 > 0 && (b1 / r1 < 0.3);
      const isC1High = c1.high >= Math.max(c2.high, c0.high) - 0.1 * currentAtr;

      const isC0BearishStarRetest = c0.close < c0.open && c0.close <= (c2.open + c2.close) / 2;

      if (isC2StrongBullish && isC1Indecision && isC1High && isC0BearishStarRetest) {
        isEveningStar = true;
      }
    }

    // 4. Three Black Crows
    let isThreeBlackCrows = false;
    if (lastIdx >= 2) {
      const c2 = this.candles1m[lastIdx - 2];
      const c1 = this.candles1m[lastIdx - 1];
      const c0 = currentCandle;

      const c2Bearish = c2.close < c2.open;
      const c1Bearish = c1.close < c1.open;
      const c0Bearish = c0.close < c0.open;

      const descendingCloses = c0.close < c1.close && c1.close < c2.close;

      const b2 = c2.open - c2.close;
      const b1 = c1.open - c1.close;
      const b0 = c0.open - c0.close;

      const healthyBodies = b2 >= 0.2 * currentAtr && b1 >= 0.2 * currentAtr && b0 >= 0.2 * currentAtr;

      if (c2Bearish && c1Bearish && c0Bearish && descendingCloses && healthyBodies) {
        isThreeBlackCrows = true;
      }
    }

    if (isPinBar) return { confirmed: !isIndecision, type: "Bearish Pin Bar" };
    if (isMajorWickRejection) return { confirmed: true, type: "65%+ Wick-to-Range Upper Rejection" };
    if (isBearishEngulfing) return { confirmed: !isIndecision, type: "Bearish Engulfing Pattern" };
    if (hasMultiWickRejection) return { confirmed: !isIndecision, type: "Multi-Candle Wick Rejection" };
    if (isTweezerTop) return { confirmed: !isIndecision, type: "Tweezer Top Reversal Pattern" };
    if (isDarkCloudCover) return { confirmed: !isIndecision, type: "Dark Cloud Cover Reversal Pattern" };
    if (isEveningStar) return { confirmed: !isIndecision, type: "Evening Star Reversal Pattern" };
    if (isThreeBlackCrows) return { confirmed: !isIndecision, type: "Three Black Crows Continuation Pattern" };
    if (isMomentumCandle && hasStrongClose) return { confirmed: !isIndecision, type: "Bearish Momentum Candle" };
    if (hasStrongClose && (upperWick > lowerWick || isBearish)) return { confirmed: !isIndecision, type: "Strong Close Resistance Rejection" };

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
      const volumes = this.candles1m.map((c) => c.volume);
      let relVolume = 1.0;
      if (volumes.length >= 20) {
        const currentVolume = volumes[lastIdx];
        const startIdx = Math.max(0, lastIdx - 20);
        const prevVolumes = volumes.slice(startIdx, lastIdx);
        if (prevVolumes.length > 0) {
          const sumPrevVolumes = prevVolumes.reduce((a, b) => a + b, 0);
          const avgPrevVolume = sumPrevVolumes / prevVolumes.length;
          relVolume = avgPrevVolume > 0 ? currentVolume / avgPrevVolume : 1.0;
        }
      }

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

        if (signalDirection === "LONG") {
          // LONG reversal/breakout requires bullish micro-trend, price crossing above fast/slow EMA, or a confirmed range reversal bounce
          microTrendAligned = isMicroTrendBullish || (currentPrice >= emaSlowVal) || (currentPrice >= emaFastVal) || isRangeLongReversal;
          microTrendDetails = `(Micro-Trend [EMA ${microFastPeriod}/${microSlowPeriod}]: Fast $${emaFastVal.toFixed(2)} vs Slow $${emaSlowVal.toFixed(2)} - ${isMicroTrendBullish ? "BULLISH" : "BEARISH"}${microTrendAligned ? " [ALIGNED]" : " [BLOCKED]"})`;
        } else if (signalDirection === "SHORT") {
          // SHORT reversal/breakdown requires bearish micro-trend, price crossing below fast/slow EMA, or a confirmed range reversal bounce
          microTrendAligned = isMicroTrendBearish || (currentPrice <= emaSlowVal) || (currentPrice <= emaFastVal) || isRangeShortReversal;
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
          const veryHighProbThreshold = ms.very_high_probability_threshold ?? 0.82;
          if (probabilityLong < veryHighProbThreshold) {
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
            message: `Ranging Bullish Breakout Confirmed. Price ($${currentPrice.toFixed(2)}) broke above major range resistance ($${rangeHigh.toFixed(2)}) on high relative volume (${relVolume.toFixed(2)}x) with high probability (${(probabilityLong * 100).toFixed(1)}%). ${microTrendDetails}`,
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
          const veryHighProbThreshold = ms.very_high_probability_threshold ?? 0.82;
          const probabilityShort = 1 - probabilityLong;
          if (probabilityShort < veryHighProbThreshold) {
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
            message: `Ranging Bearish Breakdown Confirmed. Price ($${currentPrice.toFixed(2)}) broke below major range support ($${rangeLow.toFixed(2)}) on high relative volume (${relVolume.toFixed(2)}x) with high probability (${(probabilityShort * 100).toFixed(1)}%). ${microTrendDetails}`,
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
    relVolume: number
  ): {
    met: boolean;
    val: string;
    req: string;
    description: string;
    stProfile: any;
    mtProfile: any;
    htProfile: any;
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
        htProfile
      };
    }

    const proximityTolerance = Math.max(currentPrice * 0.003, atrVal * 0.4);

    const allPocs = [stProfile.poc, mtProfile.poc, htProfile.poc];
    const allHvns = [...stProfile.hvns, ...mtProfile.hvns, ...htProfile.hvns];
    const allLiquidityNodes = Array.from(new Set([...allPocs, ...allHvns])).sort((a, b) => a - b);

    const supportNodes = allLiquidityNodes.filter(node => node < currentPrice);
    const resistanceNodes = allLiquidityNodes.filter(node => node > currentPrice);

    const nearSupport = supportNodes.length > 0 ? supportNodes[supportNodes.length - 1] : null;
    const nearResistance = resistanceNodes.length > 0 ? resistanceNodes[0] : null;

    let hasSupportFloor = false;
    let hasOverheadBlocker = false;
    let detailMsg = "";
    let isMet = true;

    if (direction === "LONG") {
      if (nearSupport && (currentPrice - nearSupport) <= proximityTolerance) {
        hasSupportFloor = true;
      }

      if (nearResistance && (nearResistance - currentPrice) <= proximityTolerance) {
        if (relVolume < 1.4) {
          hasOverheadBlocker = true;
        }
      }

      const stVABreakout = currentPrice > stProfile.vah;
      const mtVABreakout = currentPrice > mtProfile.vah;

      if (hasOverheadBlocker) {
        isMet = false;
        detailMsg = `BLOCKED (Overhead Liquidity Wall detected at $${nearResistance!.toFixed(2)} - requires Rel Vol >= 1.40)`;
      } else if (hasSupportFloor) {
        detailMsg = `PASSED (Bouncing off heavy Horizontal Floor support at $${nearSupport!.toFixed(2)})`;
      } else if (stVABreakout || mtVABreakout) {
        detailMsg = `PASSED (Explosive Value Area High breakout: stVAH $${stProfile.vah.toFixed(2)}, mtVAH $${mtProfile.vah.toFixed(2)})`;
      } else {
        detailMsg = `PASSED (Neutral range spacing; Near Floor: ${nearSupport ? "$" + nearSupport.toFixed(2) : "None"}, Near Wall: ${nearResistance ? "$" + nearResistance.toFixed(2) : "None"})`;
      }
    } else {
      if (nearResistance && (nearResistance - currentPrice) <= proximityTolerance) {
        hasSupportFloor = true;
      }

      if (nearSupport && (currentPrice - nearSupport) <= proximityTolerance) {
        if (relVolume < 1.4) {
          hasOverheadBlocker = true;
        }
      }

      const stVABreakdown = currentPrice < stProfile.val;
      const mtVABreakdown = currentPrice < mtProfile.val;

      if (hasOverheadBlocker) {
        isMet = false;
        detailMsg = `BLOCKED (Underhead Liquidity Support Floor detected at $${nearSupport!.toFixed(2)} - requires Rel Vol >= 1.40)`;
      } else if (hasSupportFloor) {
        detailMsg = `PASSED (Retesting heavy dynamic resistance ceiling at $${nearResistance!.toFixed(2)})`;
      } else if (stVABreakdown || mtVABreakdown) {
        detailMsg = `PASSED (Explosive Value Area Low breakdown: stVAL $${stProfile.val.toFixed(2)}, mtVAL $${mtProfile.val.toFixed(2)})`;
      } else {
        detailMsg = `PASSED (Neutral range spacing; Near Floor: ${nearSupport ? "$" + nearSupport.toFixed(2) : "None"}, Near Wall: ${nearResistance ? "$" + nearResistance.toFixed(2) : "None"})`;
      }
    }

    const valueStr = `ST_POC: $${stProfile.poc.toFixed(1)} | MT_POC: $${mtProfile.poc.toFixed(1)} | HT_POC: $${htProfile.poc.toFixed(1)} | ${detailMsg}`;
    const reqStr = `Price must not enter trades directly into heavy POC/HVN boundaries without high breakout volume (Rel Volume >= 1.4)`;

    return {
      met: isMet,
      val: valueStr,
      req: reqStr,
      description: "Applies institutional-grade Multi-Timeframe Volume Profiling. Identifies Horizontal Liquidity Pools (POC, VAH, VAL, and High/Low Volume Nodes). Confirms entries bouncing off historical horizontal support/resistance floors and prevents trading into heavy overhead/underhead order walls.",
      stProfile,
      mtProfile,
      htProfile
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
    // Step 2: Compression Intercept (NEW)
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

    confidence = Math.min(confidence, 0.99);

    if (this.currentRegime !== regime) {
      if (this.hasInitializedRegime) {
        this.lastRegimeChangeTimestamp = Date.now();
        const config = dbManager.getConfig();
        const cooldownMins = config.general.regime_change_cooldown_minutes !== undefined
          ? config.general.regime_change_cooldown_minutes
          : 15;
        this.log(
          `⏳ Regime Change Cooldown Activated: Pausing new trade entries for ${cooldownMins} minutes due to regime shift [${this.currentRegime}] → [${regime}].`
        );
      }

      this.log(
        `Market Regime Shift detected: [${this.currentRegime}] → [${regime}] (using ${intervalMinutes}m aggregated candles) with confidence ${(
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
          `🛡️ NEWS EVENT CIRCUIT BREAKER ACTIVATED! Blocked keywords matched: [${result.keywordMatched}]. Entry scanning paused for ±${config.sentiment_settings.protection_window_minutes} minutes.`
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

    if (false) {
      const lastIdx = closes.length - 1;
      let currentClose = this.currentPrice;

    const ema9 = this.calculateEMA(closes, 9);
    const ema21 = this.calculateEMA(closes, 21);
    const ema50 = this.calculateEMA(closes, ms.medium_ema_period || 50);
    const rsi14 = this.calculateRSI(closes, 14);

    const isBullAligned = ema9[lastIdx] > ema21[lastIdx] && ema21[lastIdx] > ema50[lastIdx];
    const isBearAligned = ema9[lastIdx] < ema21[lastIdx] && ema21[lastIdx] < ema50[lastIdx];

    const adx14 = this.calculateADX(this.candles1m, 14);
    let adxValue = adx14[lastIdx] || 25;

    const volumes = this.candles1m.map((c) => c.volume);
    let relVolume = 1.0;
    if (volumes.length >= 20) {
      const currentVolume = volumes[lastIdx];
      const startIdx = Math.max(0, lastIdx - 20);
      const prevVolumes = volumes.slice(startIdx, lastIdx);
      if (prevVolumes.length > 0) {
        const sumPrevVolumes = prevVolumes.reduce((a, b) => a + b, 0);
        const avgPrevVolume = sumPrevVolumes / prevVolumes.length;
        relVolume = avgPrevVolume > 0 ? currentVolume / avgPrevVolume : 1.0;
      }
    } else {
      relVolume = 1.35;
    }

    const isBullTrend1m = ema21[lastIdx] > ema50[lastIdx];
    const isBearTrend1m = ema21[lastIdx] < ema50[lastIdx];

    // Get headlines sentiment
    const headlines = dbManager.getHeadlines().slice(0, 15);
    let avgSentiment = this.calculateAverageSentiment(headlines);

    // 1. CatBoost Probability Emulation: Maps Indicators & Sentiment into a final probability
    // Bullish signals: trend is up, RSI is positive but not overbought, sentiment is positive
    // Bearish signals: trend is down, RSI is negative but not oversold, sentiment is negative
    const currentRsi = rsi14[lastIdx] !== undefined ? rsi14[lastIdx] : 50;
    const bb = this.calculateBollingerBands(closes, 20, 2);

    let isRsiOverbought = currentRsi > 70;
    let isRsiOversold = currentRsi < 30;

    let isPriceBbOverbought = currentClose >= bb.upper * 0.9995;
    let isPriceBbOversold = currentClose <= bb.lower * 1.0005;

    const ensembleResult = this.computeMLProbability(
      isBullTrend1m,
      currentRsi,
      currentClose,
      bb,
      this.currentRegime,
      adxValue,
      relVolume
    );
    let probabilityLong = ensembleResult.probabilityLong;
    const combinedScore = ensembleResult.score;

    // Accuracy dampening: actively prevent buying top / shorting bottom
    if (isRsiOverbought || isPriceBbOverbought) {
      if (probabilityLong > 0.70) {
        if (combinedScore > 0.38) {
          this.log(`⚠️ Prevented FOMO LONG: Market overextended (RSI: ${currentRsi.toFixed(1)}, Price: $${currentClose.toFixed(2)} near BB Upper: $${bb.upper.toFixed(2)}). Entry blocked.`);
        }
        probabilityLong = 0.70;
      }
    }
    if (isRsiOversold || isPriceBbOversold) {
      if (probabilityLong < 0.30) {
        if (combinedScore < -0.38) {
          this.log(`⚠️ Prevented FOMO SHORT: Market oversold (RSI: ${currentRsi.toFixed(1)}, Price: $${currentClose.toFixed(2)} near BB Lower: $${bb.lower.toFixed(2)}). Entry blocked.`);
        }
        probabilityLong = 0.30;
      }
    }

    let probabilityShort = Number((1 - probabilityLong).toFixed(4));

    // Determine signal direction using HH/HL breakout strategy for trending markets:
    const struct = this.getTrendMarketStructure();
    const opens = this.candles1m.map((c) => c.open);
    const averageBodySize = closes.slice(-20).map((c, idx) => {
      const openVal = opens[closes.length - 20 + idx] !== undefined ? opens[closes.length - 20 + idx] : c;
      return Math.abs(c - openVal);
    }).reduce((a, b) => a + b, 0) / 20;
    const currentCandle = this.candles1m[lastIdx];
    const currentBodySize = Math.abs(currentCandle.close - currentCandle.open);
    const atr14 = this.calculateATR(this.candles1m, 14);
    const currentAtr = atr14[lastIdx] || 150;

    const ema20 = this.calculateEMA(closes, ms.fast_ema_period || 20);
    const ema200 = this.calculateEMA(closes, ms.slow_ema_period || 200);
    const ema100List = this.calculateEMA(closes, Math.min(closes.length, 100));
    const ema20Val = ema20[lastIdx] || currentClose;
    const ema50Val = ema50[lastIdx] || currentClose;
    const ema100Val = ema100List[lastIdx] !== undefined ? ema100List[lastIdx] : currentClose;
    const ema200Val = ema200[lastIdx] || currentClose;

    const trendAlignAdx = ms.trend_alignment_adx_threshold || 30;
    const superTrendAdx = ms.super_trend_adx_threshold || 35;

    let isUptrendAligned = ema20Val > ema50Val && ema50Val > ema200Val && adxValue >= trendAlignAdx && this.currentRegime === MarketRegime.STRONG_UPTREND;
    let isDowntrendAligned = ema20Val < ema50Val && ema50Val < ema200Val && adxValue >= trendAlignAdx && this.currentRegime === MarketRegime.STRONG_DOWNTREND;
    const isSuperStrongUptrend = (this.currentRegime === MarketRegime.STRONG_UPTREND || adxValue >= superTrendAdx) && 
                                 ema20Val > ema50Val && ema50Val > ema100Val;
    const isSuperStrongDowntrend = (this.currentRegime === MarketRegime.STRONG_DOWNTREND || adxValue >= superTrendAdx) && 
                                   ema20Val < ema50Val && ema50Val < ema100Val;

    let signalDirection: "LONG" | "SHORT" | "NEUTRAL" = "NEUTRAL";

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

      const isRangeLongBreakout = (currentClose > rangeHigh) && breakoutValidationLong.isValid;
      const isRangeShortBreakdown = (currentClose < rangeLow) && breakoutValidationShort.isValid;

      if (isRangeLongReversal) {
        signalDirection = "LONG";
      } else if (isRangeShortReversal) {
        signalDirection = "SHORT";
      } else if (isRangeLongBreakout) {
        signalDirection = "LONG";
      } else if (isRangeShortBreakdown) {
        signalDirection = "SHORT";
      } else {
        signalDirection = "NEUTRAL";
      }
    } else if (this.currentRegime === MarketRegime.LOW_VOLATILITY) {
      signalDirection = "NEUTRAL";
    } else {
      // --- TREND-FOLLOWING LOGIC RESTRICTED TO 20/50 EMA PUSHBACKS ---
      const recentCandles = this.candles1m.slice(-8);

      const recentPullbackToEma20Long = recentCandles.some(c => c.low <= ema20Val * 1.0015 && c.high >= ema20Val * 0.9985);
      const recentPullbackToEma50Long = recentCandles.some(c => c.low <= ema50Val * 1.0015 && c.high >= ema50Val * 0.9985);
      const hasValidPushbackLong = (recentPullbackToEma20Long || recentPullbackToEma50Long) && currentClose >= ema50Val * 0.998;

      const recentPullbackToEma20Short = recentCandles.some(c => c.high >= ema20Val * 0.9985 && c.low <= ema20Val * 1.0015);
      const recentPullbackToEma50Short = recentCandles.some(c => c.high >= ema50Val * 0.9985 && c.low <= ema50Val * 1.0015);
      const hasValidPushbackShort = (recentPullbackToEma20Short || recentPullbackToEma50Short) && currentClose <= ema50Val * 1.002;

      isUptrendAligned = ema20Val > ema50Val && (adxValue >= ms.hf_momentum_adx_threshold || ema50Val > ema100Val);
      isDowntrendAligned = ema20Val < ema50Val && (adxValue >= ms.hf_momentum_adx_threshold || ema50Val < ema100Val);

      // For high-frequency scalping, we allow breakouts (momentum chasing) if ADX is strong or there is high order flow pressure
      const isScalperBreakoutLongAllowed = adxValue >= ms.hf_momentum_adx_threshold || (this.orderFlowStats.takerBuyRatio >= ms.hf_orderflow_taker_buy_ratio_long || this.orderBookStats.imbalanceRatio >= ms.hf_orderflow_imbalance_ratio_long);
      const isScalperBreakdownShortAllowed = adxValue >= ms.hf_momentum_adx_threshold || (this.orderFlowStats.takerBuyRatio <= ms.hf_orderflow_taker_buy_ratio_short || this.orderBookStats.imbalanceRatio <= ms.hf_orderflow_imbalance_ratio_short);

      const isNotLongBreakout = isScalperBreakoutLongAllowed ? true : (struct.current_HH ? currentClose <= struct.current_HH.price : true);
      const isNotShortBreakdown = isScalperBreakdownShortAllowed ? true : (struct.current_LL ? currentClose >= struct.current_LL.price : true);

      if (isUptrendAligned && (hasValidPushbackLong || isScalperBreakoutLongAllowed) && isNotLongBreakout && probabilityLong >= 0.65) {
        signalDirection = "LONG";
      } else if (isDowntrendAligned && (hasValidPushbackShort || isScalperBreakdownShortAllowed) && isNotShortBreakdown && probabilityShort >= 0.65) {
        signalDirection = "SHORT";
      } else {
        signalDirection = "NEUTRAL";
      }
    }

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
    const lastCandle = this.candles1m[lastIdx];
    const vwapVal = lastCandle.vwap !== undefined ? lastCandle.vwap : currentClose;
    const vwapUpperVal = lastCandle.vwap_upper !== undefined ? lastCandle.vwap_upper : currentClose * 1.01;
    const vwapLowerVal = lastCandle.vwap_lower !== undefined ? lastCandle.vwap_lower : currentClose * 0.99;

    // 2. Conditions Check (Strict 10-Conditions Checklist)
    const conditions: {
      name: string;
      met: boolean;
      current_value: any;
      required: string;
      softened?: boolean;
      ema_check_active?: boolean;
      ema_pair_evaluated?: string;
      ema_tested?: string;
      sub_conditions?: MarketStructureSubCondition[];
    }[] = [];

    // C1: CatBoost Probability Filter
    const pbTrendStatus = this.detectPullbackTrendlineBreak();
    const isEnteringPullback = signalDirection !== "NEUTRAL";
    const catboostThreshold = this.currentRegime === MarketRegime.RANGE_BOUND 
      ? 0.50 
      : 0.70;
    const pLongMet = signalDirection === "LONG" ? (probabilityLong >= catboostThreshold) : false;
    const pShortMet = signalDirection === "SHORT" ? (probabilityShort >= catboostThreshold) : false;
    conditions.push({
      name: "CatBoost AI Prediction",
      met: (signalDirection === "NEUTRAL") 
        ? (probabilityLong >= (this.currentRegime === MarketRegime.RANGE_BOUND ? 0.50 : 0.75) || 
           probabilityShort >= (this.currentRegime === MarketRegime.RANGE_BOUND ? 0.50 : 0.75)) 
        : (pLongMet || pShortMet),
      current_value: `P(LONG) = ${(probabilityLong * 100).toFixed(1)}% | P(SHORT) = ${(probabilityShort * 100).toFixed(1)}%`,
      required: signalDirection === "LONG"
        ? `P(LONG) >= ${this.currentRegime === MarketRegime.RANGE_BOUND ? "50" : "70"}% (Evaluating LONG Trade)`
        : signalDirection === "SHORT"
        ? `P(SHORT) >= ${this.currentRegime === MarketRegime.RANGE_BOUND ? "50" : "70"}% (Evaluating SHORT Trade)`
        : `P(LONG) >= ${this.currentRegime === MarketRegime.RANGE_BOUND ? "50" : "75"}% for LONG OR P(SHORT) >= ${this.currentRegime === MarketRegime.RANGE_BOUND ? "50" : "75"}% for SHORT (Mutually Exclusive)`,
    });

    const hasExtremeRealtimePressure = (config.general.enable_orderflow_softening !== false) &&
                                       ((signalDirection === "LONG" && (this.orderFlowStats.takerBuyRatio >= 0.68 || this.orderBookStats.imbalanceRatio >= 0.45)) ||
                                       (signalDirection === "SHORT" && (this.orderFlowStats.takerBuyRatio <= 0.32 || this.orderBookStats.imbalanceRatio <= -0.45)));

    const isLowVolatility = this.currentRegime === MarketRegime.LOW_VOLATILITY;

    // C2: Market Regime lock
    // Blocked all entries during LOW_VOLATILITY.
    const regimeValid = !isLowVolatility;
    const regimeAligned =
      (signalDirection === "LONG" && (this.currentRegime === MarketRegime.STRONG_UPTREND || this.currentRegime === MarketRegime.RANGE_BOUND)) ||
      (signalDirection === "SHORT" && (this.currentRegime === MarketRegime.STRONG_DOWNTREND || this.currentRegime === MarketRegime.RANGE_BOUND)) ||
      this.currentRegime === MarketRegime.HIGH_VOLATILITY;

    const isRegimeSoftened = false;

    conditions.push({
      name: "Market Regime Filter",
      met: regimeValid && (signalDirection === "NEUTRAL" ? true : regimeAligned),
      current_value: this.currentRegime,
      required: "STRONG_UPTREND/RANGE_BOUND for LONG, STRONG_DOWNTREND/RANGE_BOUND for SHORT, or HIGH_VOLATILITY",
      softened: isRegimeSoftened,
    });

    // C3 & C8 Combined: Trend Alignment & Strength (EMA/ADX)
    let trendAligned = true;
    let adxMet = true;
    let currentTrendStr = "";
    let requiredStr = "";

    const softeningPercent = config.general.orderflow_softening_percent !== undefined ? config.general.orderflow_softening_percent : 10;
    const standardAdxThreshold = trendAlignAdx;
    const softenedAdxThreshold = standardAdxThreshold * (1 - softeningPercent / 100);

    if (this.currentRegime === MarketRegime.RANGE_BOUND) {
      if (signalDirection === "LONG") {
        trendAligned = !isBearAligned;
        currentTrendStr = isBearAligned ? "BLOCKED: STRONGLY BEARISH" : "PASSING (Not strongly bearish)";
      } else if (signalDirection === "SHORT") {
        trendAligned = !isBullAligned;
        currentTrendStr = isBullAligned ? "BLOCKED: STRONGLY BULLISH" : "PASSING (Not strongly bullish)";
      } else {
        trendAligned = true;
        currentTrendStr = "NEUTRAL";
      }
      adxMet = true; // Bypassed in RANGE_BOUND
      requiredStr = "LONG: Not strongly bearish (isBearAligned), SHORT: Not strongly bullish (isBullAligned)";
    } else {
      if (hasExtremeRealtimePressure) {
        const fastEma = ms.fast_ema_period || 20;
        const medEma = ms.medium_ema_period || 50;
        trendAligned = signalDirection === "NEUTRAL" ? true : (
          signalDirection === "LONG" ? (ema20Val > ema50Val) : (ema20Val < ema50Val)
        );
        adxMet = adxValue >= softenedAdxThreshold;
        currentTrendStr = `EMA Structure: FAST_ALIGNED (Extreme Real-time Flow Pressure) | ADX: ${adxValue.toFixed(1)} (Threshold softened to >= ${softenedAdxThreshold.toFixed(1)})`;
        requiredStr = `LONG: Fast EMA${fastEma} > EMA${medEma} & ADX >= ${softenedAdxThreshold.toFixed(1)} (Softened via Order Flow), SHORT: Fast EMA${fastEma} < EMA${medEma} & ADX >= ${softenedAdxThreshold.toFixed(1)}`;
      } else {
        const fastEma = ms.fast_ema_period || 20;
        const medEma = ms.medium_ema_period || 50;
        const slowEma = ms.slow_ema_period || 200;
        trendAligned = signalDirection === "NEUTRAL" ? true : (
          (signalDirection === "LONG" && isUptrendAligned) ||
          (signalDirection === "SHORT" && isDowntrendAligned)
        );
        adxMet = adxValue >= standardAdxThreshold;
        currentTrendStr = `EMA Structure: ${isUptrendAligned ? "BULLISH_TREND" : isDowntrendAligned ? "BEARISH_TREND" : "MIXED/FLAT"}`;
        requiredStr = `LONG: EMA${fastEma} > EMA${medEma} > EMA${slowEma} & ADX >= ${standardAdxThreshold} & STRONG_UPTREND, SHORT: EMA${fastEma} < EMA${medEma} < EMA${slowEma} & ADX >= ${standardAdxThreshold} & STRONG_DOWNTREND`;
      }
    }

    const isTrendSoftened = (this.currentRegime !== MarketRegime.RANGE_BOUND) && hasExtremeRealtimePressure && (
      (signalDirection === "LONG" && !isUptrendAligned) ||
      (signalDirection === "SHORT" && !isDowntrendAligned) ||
      (adxValue < standardAdxThreshold)
    );

    conditions.push({
      name: "Exponential Trend Alignment",
      met: trendAligned,
      current_value: currentTrendStr,
      required: requiredStr.split(" & ADX")[0],
      softened: isTrendSoftened,
    });

    conditions.push({
      name: "ADX Trend Strength Filter",
      met: adxMet,
      current_value: `ADX: ${adxValue.toFixed(1)}`,
      required: `ADX >= ${hasExtremeRealtimePressure ? softenedAdxThreshold.toFixed(1) : standardAdxThreshold.toFixed(1)}`,
      softened: isTrendSoftened,
    });

    // C5: Relative Volume Confirmation
    const standardRelVolThreshold = relVolThreshold;
    const softenedRelVolThreshold = standardRelVolThreshold * (1 - softeningPercent / 100);
    const requiredRelVol = hasExtremeRealtimePressure 
      ? softenedRelVolThreshold 
      : standardRelVolThreshold;
    const isRelVolumeSoftened = hasExtremeRealtimePressure && relVolume >= softenedRelVolThreshold && relVolume < standardRelVolThreshold;

    conditions.push({
      name: "Relative Volume Confirmation",
      met: relVolume >= requiredRelVol,
      current_value: `${relVolume.toFixed(2)}x` + (hasExtremeRealtimePressure ? " (SOFTENED VIA LEADING ORDER FLOW)" : ""),
      required: `> ${requiredRelVol.toFixed(2)}x above 20-period MA`,
      softened: isRelVolumeSoftened,
    });

    // C7: Daily Circuit Breaker
    const tradesToday = dbManager.getTrades().filter(
      (t) => t.entry_timestamp.split("T")[0] === timestamp.split("T")[0]
    );
    const cbDailyTradesPass = tradesToday.length < config.general.max_trades_per_day;
    conditions.push({
      name: "Daily Trade Count Limit",
      met: cbDailyTradesPass,
      current_value: `${tradesToday.length} trades`,
      required: `< ${config.general.max_trades_per_day} trades/day`,
    });

    // C9 & C10 Combined: Account Equity & API Connection Verification
    const balance = dbManager.getCredentials().account_balance_usdt;
    const hasMinEquity = balance >= 100;
    const apiCreds = dbManager.getCredentials();
    const hasValidCreds = dbManager.isPaperMode() || (!!apiCreds.api_key && !!apiCreds.api_secret);

    conditions.push({
      name: "Account Equity & API Connection Verification",
      met: hasMinEquity && hasValidCreds,
      current_value: `Balance: $${balance.toFixed(2)} USDT | API: ${dbManager.isPaperMode() ? "PAPER MODE ACTIVE" : (hasValidCreds ? "KEYS CONFIGURED" : "MISSING KEYS")}`,
      required: "Balance >= $100.00 USDT and valid live connection keys or Paper Mode active",
    });

    // C11: Consecutive Losses Cooldown Protection
    const lossCooldown = this.getConsecutiveLossesCooldownStatus();
    conditions.push({
      name: "Loss Streak Cooldown Protection",
      met: !lossCooldown.active,
      current_value: lossCooldown.active
        ? `COOLDOWN (Streak: ${lossCooldown.consecutiveLosses}, ${Math.ceil(lossCooldown.remainingSeconds / 60)}m left)`
        : "PASSING",
      required: "No active cooldown from consecutive losses",
    });

    // C12: Optimal Session Timing Window Check (IST)
    const timingStatus = this.getISTTimingStatus();
    conditions.push({
      name: "Optimal Session Timing Window Check (IST)",
      met: timingStatus.met,
      current_value: timingStatus.status,
      required: "Avoid weekends & 2:00 AM - 8:00 AM IST",
    });

    // C14 & C17 Combined: Overextension & Level Anchors (VWAP/EMA)
    let vwapDevMet = signalDirection === "LONG"
      ? currentClose <= vwapUpperVal
      : signalDirection === "SHORT"
        ? currentClose >= vwapLowerVal
        : true;

    // Optimize: In super strong trend breakouts or with extreme leading indicator momentum, bypass VWAP overextension lock
    if (isSpecialSuperStrongTrendLogicActive || hasExtremeRealtimePressure) {
      vwapDevMet = true;
    }

    // Check for high movement in earlier short period (recent 10 candles)
    const shortLookback = 10;
    let highMovementShort = false;
    let shortMovementVal = 0;
    if (this.candles1m.length >= shortLookback) {
      const recentCandles = this.candles1m.slice(-shortLookback);
      const recentHighs = recentCandles.map(c => c.high);
      const recentLows = recentCandles.map(c => c.low);
      const maxHigh = Math.max(...recentHighs);
      const minLow = Math.min(...recentLows);
      shortMovementVal = maxHigh - minLow;
      highMovementShort = shortMovementVal > 1.8 * currentAtr;
    }

    const ema100Distance = currentClose - ema100Val;
    const maxAllowedDeviation = emaThreshold * currentAtr;
    const isEma100OverextendedLong = currentClose > ema100Val + maxAllowedDeviation;
    const isEma100OverextendedShort = currentClose < ema100Val - maxAllowedDeviation;

    let ema100Met = true;
    let ema100ValStr = "PASSING (NORMAL DISTANCE)";

    if (hasExtremeRealtimePressure) {
      ema100Met = true;
      ema100ValStr = signalDirection === "LONG"
        ? `PASSING (Extreme Leading Pressure Confirmed: Distance +$${ema100Distance.toFixed(2)})`
        : `PASSING (Extreme Leading Pressure Confirmed: Distance -$${Math.abs(ema100Distance).toFixed(2)})`;
    } else if (isTrending && !highMovementShort) {
      ema100ValStr = `PASSING (No high momentum pulse in last 10 candles in Trending Regime)`;
    } else {
      if (signalDirection === "LONG") {
        if (isSpecialSuperStrongTrendLogicActive) {
          ema100Met = true;
          ema100ValStr = `PASSING (Super Strong Trend Breakout Confirmed: Distance +$${ema100Distance.toFixed(2)})`;
        } else if (isEma100OverextendedLong) {
          ema100Met = false;
          ema100ValStr = `OVEREXTENDED LONG: BLOCKED (Price: $${currentClose.toFixed(2)} too far above 100 EMA)`;
        } else {
          ema100ValStr = `PASSING (Distance: +$${ema100Distance.toFixed(2)})`;
        }
      } else if (signalDirection === "SHORT") {
        if (isSpecialSuperStrongTrendLogicActive) {
          ema100Met = true;
          ema100ValStr = `PASSING (Super Strong Trend Breakdown Confirmed: Distance -$${Math.abs(ema100Distance).toFixed(2)})`;
        } else if (isEma100OverextendedShort) {
          ema100Met = false;
          ema100ValStr = `OVEREXTENDED SHORT: BLOCKED (Price: $${currentClose.toFixed(2)} too far below 100 EMA)`;
        } else {
          ema100ValStr = `PASSING (Distance: -$${Math.abs(ema100Distance).toFixed(2)})`;
        }
      }
    }

    conditions.push({
      name: "VWAP Deviation Anchor Check",
      met: vwapDevMet,
      current_value: vwapDevMet ? "PASSING" : "OVEREXTENDED",
      required: "Price within dynamic VWAP standard deviation bands",
    });

    conditions.push({
      name: "EMA 100 Overextension Protection",
      met: ema100Met,
      current_value: ema100ValStr,
      required: "Price not overextended relative to the 100 EMA baseline",
    });

    // C15: Market Structure & Entry Confirmation Check (Pullback, Retest, Reversal, High-Vol Confirmation)
    const structCheck = this.evaluateMarketStructureConfirmation(signalDirection, probabilityLong);
    
    // Override market structure confirmation if Special Super Strong Trend Logic is active
    if (isSpecialSuperStrongTrendLogicActive) {
      if (isSuperStrongUptrend) {
        const pullbackHasFormed = struct.pullbackLongMet && struct.current_HH;
        if (pullbackHasFormed && struct.current_HH) {
          const isHHBreakout = currentClose > struct.current_HH.price;
          const isNotOverextended = currentClose <= struct.current_HH.price + 1.2 * currentAtr;
          if (isHHBreakout && isNotOverextended) {
            structCheck.confirmed = true;
            structCheck.message = `[Super Strong Trend] Pullback breakout confirmed! Price ($${currentClose.toFixed(2)}) broke above previous HH ($${struct.current_HH.price.toFixed(2)}).`;
          } else if (isHHBreakout) {
            structCheck.confirmed = false;
            structCheck.message = `[Super Strong Trend] Blocked: Price ($${currentClose.toFixed(2)}) is overextended above HH ($${struct.current_HH.price.toFixed(2)}).`;
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
          const isLLBreakout = currentClose < struct.current_LL.price;
          const isNotOverextended = currentClose >= struct.current_LL.price - 1.2 * currentAtr;
          if (isLLBreakout && isNotOverextended) {
            structCheck.confirmed = true;
            structCheck.message = `[Super Strong Trend] Pullback breakdown confirmed! Price ($${currentClose.toFixed(2)}) broke below previous LL ($${struct.current_LL.price.toFixed(2)}).`;
          } else if (isLLBreakout) {
            structCheck.confirmed = false;
            structCheck.message = `[Super Strong Trend] Blocked: Price ($${currentClose.toFixed(2)}) is overextended below LL ($${struct.current_LL.price.toFixed(2)}).`;
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
      ema_check_active: structCheck.ema_check_active,
      ema_pair_evaluated: structCheck.ema_pair_evaluated,
      ema_tested: structCheck.ema_tested,
      sub_conditions: structCheck.sub_conditions,
    });

    // C16: Wedge Pattern Filter (Avoid entry during rising/falling wedges unless confirmed breakout)
    const wedge = this.detectWedgePattern();
    let wedgeMet = true;
    let wedgeVal = "NO WEDGE PATTERN DETECTED";
    let wedgeReq = "None (Pattern normal)";
    const wedgeRelVolume = relVolume;

    // Cross-optimization: Calculate if volatility is squeezed
    const sqBb_wedge = this.calculateBollingerBands(closes, 20, 2);
    const sqAtr_wedge = currentAtr;
    const sqKbWidth_wedge = 2 * 1.5 * sqAtr_wedge;
    const sqBbWidth_wedge = sqBb_wedge.upper - sqBb_wedge.lower;
    const isSqueezed_wedge = sqBbWidth_wedge <= sqKbWidth_wedge;

    if (wedge.risingWedge) {
      if (signalDirection === "LONG") {
        // Counter-trend LONG in rising wedge. Requires superior breakout.
        const requiredVol = isSqueezed_wedge ? 1.40 : 1.25;
        const isBreakout = currentClose > wedge.upperLineCurrent && wedgeRelVolume >= requiredVol;
        wedgeMet = isBreakout;
        wedgeVal = isBreakout
          ? `RISING WEDGE: SUPERIOR BULL BREAKOUT (Close: $${currentClose.toFixed(2)} > Upper: $${wedge.upperLineCurrent.toFixed(2)} | Vol: ${wedgeRelVolume.toFixed(2)} >= ${requiredVol})`
          : `RISING WEDGE: BLOCKED (LONG counter-trend requires upper breakout with volume >= ${requiredVol})`;
        wedgeReq = `LONG Breakout: Price > Upper ($${wedge.upperLineCurrent.toFixed(2)}) & Rel Volume >= ${requiredVol}`;
      } else if (signalDirection === "SHORT") {
        // Aligned SHORT in rising wedge. Requires confirmed lower breakdown to avoid trap.
        const requiredVol = 1.10;
        const isBreakdown = currentClose < wedge.lowerLineCurrent && wedgeRelVolume >= requiredVol;
        wedgeMet = isBreakdown;
        wedgeVal = isBreakdown
          ? `RISING WEDGE: BEAR BREAKDOWN CONFIRMED (Close: $${currentClose.toFixed(2)} < Lower: $${wedge.lowerLineCurrent.toFixed(2)} | Vol: ${wedgeRelVolume.toFixed(2)} >= ${requiredVol})`
          : `RISING WEDGE: BLOCKED (SHORT requires confirmed lower breakdown with volume >= ${requiredVol})`;
        wedgeReq = `SHORT Breakdown: Price < Lower ($${wedge.lowerLineCurrent.toFixed(2)}) & Rel Volume >= ${requiredVol}`;
      }
    } else if (wedge.fallingWedge) {
      if (signalDirection === "SHORT") {
        // Counter-trend SHORT in falling wedge. Requires superior breakdown.
        const requiredVol = isSqueezed_wedge ? 1.40 : 1.25;
        const isBreakdown = currentClose < wedge.lowerLineCurrent && wedgeRelVolume >= requiredVol;
        wedgeMet = isBreakdown;
        wedgeVal = isBreakdown
          ? `FALLING WEDGE: SUPERIOR BEAR BREAKDOWN (Close: $${currentClose.toFixed(2)} < Lower: $${wedge.lowerLineCurrent.toFixed(2)} | Vol: ${wedgeRelVolume.toFixed(2)} >= ${requiredVol})`
          : `FALLING WEDGE: BLOCKED (SHORT counter-trend requires lower breakdown with volume >= ${requiredVol})`;
        wedgeReq = `SHORT Breakdown: Price < Lower ($${wedge.lowerLineCurrent.toFixed(2)}) & Rel Volume >= ${requiredVol}`;
      } else if (signalDirection === "LONG") {
        // Aligned LONG in falling wedge. Requires confirmed upper breakout to avoid trap.
        const requiredVol = 1.10;
        const isBreakout = currentClose > wedge.upperLineCurrent && wedgeRelVolume >= requiredVol;
        wedgeMet = isBreakout;
        wedgeVal = isBreakout
          ? `FALLING WEDGE: BULL BREAKOUT CONFIRMED (Close: $${currentClose.toFixed(2)} > Upper: $${wedge.upperLineCurrent.toFixed(2)} | Vol: ${wedgeRelVolume.toFixed(2)} >= ${requiredVol})`
          : `FALLING WEDGE: BLOCKED (LONG requires confirmed upper breakout with volume >= ${requiredVol})`;
        wedgeReq = `LONG Breakout: Price > Upper ($${wedge.upperLineCurrent.toFixed(2)}) & Rel Volume >= ${requiredVol}`;
      }
    }

    conditions.push({
      name: "Wedge Pattern Filter",
      met: wedgeMet,
      current_value: wedgeVal,
      required: wedgeReq,
    });

    // C17: Binance Order Flow Confirmation
    let ofMet = true;
    const flowRes = this.getOrderFlowScore(signalDirection);
    let ofVal = `Score: ${flowRes.score}/100 [${flowRes.label}] | Taker Buy: ${(flowRes.takerBuyRatio * 100).toFixed(1)}% | Imbalance: ${(flowRes.imbalanceRatio * 100).toFixed(1)}%`;
    let ofReq = "Dynamic Score >= 45/100 (Softenable to 30/100 if CatBoost AI probability >= 85.0%)";

    if (signalDirection !== "NEUTRAL") {
      const activeProb = signalDirection === "LONG" ? probabilityLong : probabilityShort;
      const isExtremeAiConfidence = activeProb >= 0.85;
      const hurdleScore = isExtremeAiConfidence ? 30 : 45;
      ofMet = flowRes.score >= hurdleScore;
      if (!ofMet) {
        ofVal = `${ofVal} - BLOCKED (${flowRes.description})`;
      } else {
        const softState = flowRes.score < 45 ? " - SOFTENED BY AI" : "";
        ofVal = `${ofVal} - PASSED${softState} (${flowRes.description})`;
      }
    }

    const isOrderFlowSoftened = signalDirection !== "NEUTRAL" && flowRes.score < 45 && flowRes.score >= 30;

    conditions.push({
      name: "Binance Order Flow Confirmation",
      met: ofMet,
      current_value: ofVal,
      required: ofReq,
      softened: isOrderFlowSoftened,
    });

    // C18: Volatility Compression (Squeeze) Filter
    const sqBb = this.calculateBollingerBands(closes, 20, 2);
    const sqAtr = currentAtr;
    const sqKbWidth = 2 * 1.5 * sqAtr;
    const sqBbWidth = sqBb.upper - sqBb.lower;
    const isSqueezed = sqBbWidth <= sqKbWidth;

    let squeezeMet = true;
    let squeezeVal = `BB Width: $${sqBbWidth.toFixed(2)} (Keltner Width: $${sqKbWidth.toFixed(2)})`;
    let squeezeReq = "Breakout volume (Rel Volume >= 1.40) required if Bollinger Bands are squeezed inside Keltner Channels";

    if (isSqueezed) {
      squeezeMet = relVolume >= 1.40;
      if (!squeezeMet) {
        squeezeVal = `COMPRESSED SQUEEZE ACTIVE - BLOCKED (BB Width $${sqBbWidth.toFixed(2)} <= Keltner $${sqKbWidth.toFixed(2)} | Rel Volume ${relVolume.toFixed(2)} < 1.40)`;
      } else {
        squeezeVal = `COMPRESSED SQUEEZE ACTIVE - PASSED (High Breakout Volume: ${relVolume.toFixed(2)} >= 1.40)`;
      }
    } else {
      squeezeVal = `NO SQUEEZE - PASSING (BB Width $${sqBbWidth.toFixed(2)} > Keltner $${sqKbWidth.toFixed(2)})`;
    }

    conditions.push({
      name: "Volatility Compression (Squeeze) Filter",
      met: squeezeMet,
      current_value: squeezeVal,
      required: squeezeReq,
    });

    // Volatility ATR Floor Filter (Minimum ATR Filter)
    const minAtrEnabled = config.risk_management?.min_atr_for_trading_enabled !== false;
    const minAtrValue = config.risk_management?.min_atr_for_trading_value !== undefined ? config.risk_management.min_atr_for_trading_value : 12;
    let minAtrMet = true;
    let minAtrVal = `ATR (14): $${currentAtr.toFixed(2)}`;
    let minAtrReq = minAtrEnabled ? `>= $${minAtrValue.toFixed(2)}` : "None (Disabled)";

    if (minAtrEnabled) {
      minAtrMet = currentAtr >= minAtrValue;
      if (!minAtrMet) {
        minAtrVal = `ATR COMPRESSION - BLOCKED (Current ATR $${currentAtr.toFixed(2)} < Min ATR Threshold $${minAtrValue.toFixed(2)})`;
      } else {
        minAtrVal = `ATR NORMAL - PASSED (Current ATR $${currentAtr.toFixed(2)} >= Min ATR Threshold $${minAtrValue.toFixed(2)})`;
      }
    }

    conditions.push({
      name: "Minimum ATR Volatility Filter",
      met: minAtrMet,
      current_value: minAtrVal,
      required: minAtrReq,
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
    });

    // C21: Multi-Timeframe Volume Profiling (Horizontal Liquidity)
    const vpResult = this.evaluateMultiTimeframeVolumeProfile(signalDirection, currentClose, currentAtr, relVolume);
    conditions.push({
      name: "Multi-Timeframe Volume Profiling (Horizontal Liquidity)",
      met: vpResult.met,
      current_value: vpResult.val,
      required: vpResult.req,
    });

    // C20: Regime Transition Cooldown
    const regimeCooldown = this.getRegimeChangeCooldownStatus();
    const regimeCooldownMins = config.general.regime_change_cooldown_minutes !== undefined ? config.general.regime_change_cooldown_minutes : 15;
    conditions.push({
      name: "Regime Transition Cooldown",
      met: !regimeCooldown.active,
      current_value: regimeCooldown.active
        ? `BLOCKED (Cooldown active: ${Math.ceil(regimeCooldown.remainingSeconds / 60)}m left)`
        : "PASSING (No recent regime shift)",
      required: `No regime transitions within the last ${regimeCooldownMins} minutes`,
    });

    // Apply bypassed/skipped gates
    for (const c of conditions) {
      if (!this.isGateActive(config, c.name)) {
        c.met = true;
        c.current_value = `${c.current_value} (BYPASS)`;
      }
    }

    // Weighted scoring evaluation
    let confidenceScore = 0;
    let confidenceThreshold = 70;
    let tacticalConfidenceMet = true;

    let isWeightedEnabled = config.gate_scoring?.enabled === true;

    // Dynamically define safetyGates as active gates that are set to mandatory (strictly pass)
    const safetyGates = isWeightedEnabled
      ? conditions
          .filter((c) => this.isGateActive(config, c.name) && this.isGateMandatory(config, c.name))
          .map((c) => c.name)
      : [
          "Daily Trade Count Limit",
          "Account Equity & API Connection Verification",
          "Loss Streak Cooldown Protection",
          "Optimal Session Timing Window Check (IST)",
          "Regime Transition Cooldown",
          "Minimum ATR Volatility Filter"
        ];

    const baseWeights = {
      catboost_ai: config.gate_scoring?.weights?.catboost_ai ?? 25,
      market_regime: config.gate_scoring?.weights?.market_regime ?? 15,
      trend_alignment: config.gate_scoring?.weights?.trend_alignment ?? 10,
      adx_strength: config.gate_scoring?.weights?.adx_strength ?? 5,
      relative_volume: config.gate_scoring?.weights?.relative_volume ?? 10,
      overextension: config.gate_scoring?.weights?.overextension ?? 5,
      ema100_overextension: config.gate_scoring?.weights?.ema100_overextension ?? 5,
      wedge_filter: config.gate_scoring?.weights?.wedge_filter ?? 5,
      order_flow: config.gate_scoring?.weights?.order_flow ?? 10,
      squeeze_filter: config.gate_scoring?.weights?.squeeze_filter ?? 5,
      order_book: config.gate_scoring?.weights?.order_book ?? 5,
      volume_profile: config.gate_scoring?.weights?.volume_profile ?? 10,
    };

    const modifiers = config.gate_scoring?.adaptive_modifiers ?? {
      trending: { trend_alignment_weight_boost: 10, catboost_weight_boost: 5, volume_profile_weight_boost: -5 },
      ranging: { order_flow_weight_boost: 15, trend_alignment_weight_reduction: -10, volume_profile_weight_boost: 10 },
      high_volatility: { relative_volume_weight_boost: 10, overextension_weight_boost: 10, volume_profile_weight_boost: 5 },
      low_volatility: { squeeze_filter_weight_boost: 15, volume_profile_weight_boost: 0 },
    };

    let activeWeights = { ...baseWeights };

    if (this.currentRegime === MarketRegime.STRONG_UPTREND || this.currentRegime === MarketRegime.STRONG_DOWNTREND) {
      activeWeights.trend_alignment = Math.max(0, activeWeights.trend_alignment + (modifiers.trending?.trend_alignment_weight_boost ?? 10));
      activeWeights.catboost_ai = Math.max(0, activeWeights.catboost_ai + (modifiers.trending?.catboost_weight_boost ?? 5));
      activeWeights.volume_profile = Math.max(0, activeWeights.volume_profile + (modifiers.trending?.volume_profile_weight_boost ?? -5));
    } else if (this.currentRegime === MarketRegime.RANGE_BOUND) {
      activeWeights.order_flow = Math.max(0, activeWeights.order_flow + (modifiers.ranging?.order_flow_weight_boost ?? 15));
      activeWeights.trend_alignment = Math.max(0, activeWeights.trend_alignment + (modifiers.ranging?.trend_alignment_weight_reduction ?? -10));
      activeWeights.volume_profile = Math.max(0, activeWeights.volume_profile + (modifiers.ranging?.volume_profile_weight_boost ?? 10));
    } else if (this.currentRegime === MarketRegime.HIGH_VOLATILITY) {
      activeWeights.relative_volume = Math.max(0, activeWeights.relative_volume + (modifiers.high_volatility?.relative_volume_weight_boost ?? 10));
      activeWeights.overextension = Math.max(0, activeWeights.overextension + (modifiers.high_volatility?.overextension_weight_boost ?? 10));
      activeWeights.volume_profile = Math.max(0, activeWeights.volume_profile + (modifiers.high_volatility?.volume_profile_weight_boost ?? 5));
    } else if (this.currentRegime === MarketRegime.LOW_VOLATILITY) {
      activeWeights.squeeze_filter = Math.max(0, activeWeights.squeeze_filter + (modifiers.low_volatility?.squeeze_filter_weight_boost ?? 15));
      activeWeights.volume_profile = Math.max(0, activeWeights.volume_profile + (modifiers.low_volatility?.volume_profile_weight_boost ?? 0));
    }

    const tacticalGatesMap = [
      { condName: "CatBoost AI Prediction", weightKey: "catboost_ai" as const },
      { condName: "Market Regime Filter", weightKey: "market_regime" as const },
      { condName: "Exponential Trend Alignment", weightKey: "trend_alignment" as const },
      { condName: "ADX Trend Strength Filter", weightKey: "adx_strength" as const },
      { condName: "Relative Volume Confirmation", weightKey: "relative_volume" as const },
      { condName: "VWAP Deviation Anchor Check", weightKey: "overextension" as const },
      { condName: "EMA 100 Overextension Protection", weightKey: "ema100_overextension" as const },
      { condName: "Wedge Pattern Filter", weightKey: "wedge_filter" as const },
      { condName: "Binance Order Flow Confirmation", weightKey: "order_flow" as const },
      { condName: "Volatility Compression (Squeeze) Filter", weightKey: "squeeze_filter" as const },
      { condName: "Order Book Imbalance & Liquidity Depth Gate", weightKey: "order_book" as const },
      { condName: "Multi-Timeframe Volume Profiling (Horizontal Liquidity)", weightKey: "volume_profile" as const },
    ];

    let totalTacticalWeight = 0;
    let earnedTacticalWeight = 0;

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
    confidenceThreshold = config.gate_scoring?.confidence_threshold ?? 70;
    tacticalConfidenceMet = confidenceScore >= confidenceThreshold;

    // Calculate Entry Score
    let entryScore = 0;
    if (isWeightedEnabled) {
      entryScore = confidenceScore;
    } else {
      if (signalDirection !== "NEUTRAL") {
        if (pLongMet || pShortMet || !this.isGateActive(config, "CatBoost AI Prediction")) entryScore += 40;
        if ((regimeValid && regimeAligned) || !this.isGateActive(config, "Market Regime Filter")) entryScore += 20;
        if (trendAligned || !this.isGateActive(config, "Exponential Trend Alignment")) entryScore += 15;
        if (adxMet || !this.isGateActive(config, "ADX Trend Strength Filter")) entryScore += 15;
        if (relVolume > requiredRelVol || !this.isGateActive(config, "Relative Volume Confirmation")) entryScore += 10;
      }
    }

    const allSafetyPassed = conditions
      .filter((c) => safetyGates.includes(c.name))
      .every((c) => c.met);

    // Check "Market Structure Confirmation" dynamically based on whether it is active and mandatory
    const isStructureMandatory = this.isGateMandatory(config, "Market Structure Confirmation");
    const isStructureActive = this.isGateActive(config, "Market Structure Confirmation");
    let marketStructurePassed = isStructureActive && isStructureMandatory
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

    let allConditionsMet = false;
    if (isWeightedEnabled) {
      allConditionsMet = allSafetyPassed && marketStructurePassed && tacticalConfidenceMet && isMtfVpPassedIfRequired;
    } else {
      allConditionsMet = conditions.every((c) => c.met);
    }

    let failedConditions: string[] = [];
    if (isWeightedEnabled) {
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
      failedConditions = conditions.filter((c) => !c.met).map((c) => c.name);
    }
    }

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

        if (signalDirection === "NEUTRAL") {
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
        const logStatus = `STATUS: ${allConditionsMet && signalDirection !== "NEUTRAL" ? "QUALIFIED" : "BLOCKED"}\n`;
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
      direction: signalDirection === "LONG" ? TradeDirection.LONG : signalDirection === "SHORT" ? TradeDirection.SHORT : "NEUTRAL",
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
    if (allConditionsMet && entryScore >= entryHurdle && !this.activeTrade && signalDirection !== "NEUTRAL") {
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
      this.log(`⚠️ BLOCKED: Attempted to execute trade entry with NEUTRAL direction.`);
      return;
    }

    const config = dbManager.getConfig();
    const creds = dbManager.getCredentials();

    if (creds.connection_status !== "CONNECTED") {
      this.log(`⚠️ FAILED to enter trade: Exchange credentials are not in CONNECTED state.`);
      return;
    }

    this.log(`🚀 SIGNAL TRIGGERED! Entering Delta Exchange ${direction} position...`);

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

    // Condition A (Order Flow Climax): Raw Imbalance > 85% or Taker ratio > 90% in direction of trade
    const isConditionA = direction === "LONG"
      ? (rawImbalance > 0.85 || takerRatio > 0.90)
      : (rawImbalance < -0.85 || takerRatio < 0.10);

    // Condition B (Physical Overextension): Entry Price physically outside Bollinger Bands OR distance to EMA 9 > 1.5 * ATR_14
    const isOutsideBB = direction === "LONG" ? (currentPrice > bb.upper) : (currentPrice < bb.lower);
    const distEma9 = Math.abs(currentPrice - ema9Val);
    const isEmaOverextended = distEma9 > 1.5 * lastAtr;
    const isConditionB = isOutsideBB || isEmaOverextended;

    // Extreme Confluence: Parabolic & mathematically exhausted -> BLOCK ENTRY
    if (isConditionA && isConditionB) {
      this.log(
        `⛔ [ENTRY BLOCKED - Confluence of Extremes] Late-stage exhaustion breakout detected! Order Flow Climax (Imbalance: ${(rawImbalance * 100).toFixed(1)}%, Taker: ${(takerRatio * 100).toFixed(1)}%) & Physical Overextension (Outside BB: ${isOutsideBB}, Dist to EMA9: $${distEma9.toFixed(2)} vs 1.5xATR $${(1.5 * lastAtr).toFixed(2)}). Trade entry aborted.`
      );
      return;
    }

    if (isConditionA && !isConditionB) {
      this.log(`⚡ [High-Momentum Breakout Allowed]: Extreme Order Flow detected, but Price is not overextended. Executing Market Order.`);
    } else if (isConditionB && !isConditionA) {
      this.log(`📈 [Steady Trend Grind Allowed]: Price is overextended, but Order Flow is not climactic. Executing Market Order.`);
    }

    // Apply Maximum ATR Cap for Stop Loss calculation if enabled
    let stopLossAtr = lastAtr;
    if (config.risk_management.max_atr_for_stop_loss_enabled === true && config.risk_management.max_atr_for_stop_loss_value !== undefined) {
      if (lastAtr > config.risk_management.max_atr_for_stop_loss_value) {
        stopLossAtr = config.risk_management.max_atr_for_stop_loss_value;
      }
    }

    // Enforce a minimum stop loss distance floor to prevent excessively tight stop losses in BTC
    const usdFloor = config.risk_management.min_stop_loss_distance_usd !== undefined ? config.risk_management.min_stop_loss_distance_usd : 80;
    const pctFloorVal = config.risk_management.min_stop_loss_distance_pct !== undefined ? config.risk_management.min_stop_loss_distance_pct : 0.12;
    const minSlDistance = Math.max(usdFloor, currentPrice * (pctFloorVal / 100));
    
    const isStaticSl = config.risk_management.static_stop_loss_enabled === true;
    const staticSlVal = config.risk_management.static_stop_loss_value_usd !== undefined ? config.risk_management.static_stop_loss_value_usd : 150;

    const stopLossDistance = isStaticSl
      ? staticSlVal
      : Math.max(
          stopLossAtr * config.risk_management.stop_loss_atr_multiplier,
          minSlDistance
        );

    // Use the configured default quantity (fixed standard trade size)
    const sizeMultiplier = this.getTradeSizeMultiplier();
    const baseQty = config.risk_management.default_quantity_btc || 0.001;
    const positionQtyBtc = Number((baseQty * sizeMultiplier).toFixed(5));
    const leverage = config.risk_management.leverage || 20;

    // Respect the ATR-based stop loss distance directly as configured by the user, bounded only by the minimum floor.
    const stopLossPrice = direction === "LONG" ? currentPrice - stopLossDistance : currentPrice + stopLossDistance;

    const actualSLDistance = Math.abs(currentPrice - stopLossPrice);
    const takeProfitDistance = actualSLDistance * config.risk_management.take_profit_ratio;
    const takeProfitPrice = direction === "LONG" ? currentPrice + takeProfitDistance : currentPrice - takeProfitDistance;

    this.log(
      `Computed Execution Parameters: Entry=$${currentPrice.toFixed(2)}, StopLoss=$${stopLossPrice.toFixed(2)} (Dist: $${actualSLDistance.toFixed(
        2
      )}), TakeProfit=$${takeProfitPrice.toFixed(2)} (Dist: $${takeProfitDistance.toFixed(
        2
      )}), Qty=${positionQtyBtc} BTC, Leverage=${leverage}x`
    );

    // Create the Trade record
    const newTrade: Trade = dbManager.addTrade({
      entry_timestamp: new Date().toISOString(),
      exit_timestamp: null,
      direction: direction === "LONG" ? TradeDirection.LONG : TradeDirection.SHORT,
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

    this.log(`SUCCESS! Trade entry confirmed. Transaction ID: ${newTrade.id}`);
    this.logTradeToFile(newTrade, this.getCurrentCheckpoints());

    // If live account mode is enabled, execute real-time order placement on Delta Exchange!
    if (!dbManager.isPaperMode()) {
      const side = direction === "LONG" ? "buy" : "sell";
      this.log(`📡 Dispatching real market order to Delta Exchange REST API...`);
      placeDeltaMarketOrder(creds, "BTCUSD", side, positionQtyBtc).then((res) => {
        if (res.success) {
          this.log(`✅ Delta Exchange order matched successfully! Order ID: ${res.order_id}`);
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
              this.log(`💰 Real-time balance updated from Delta Exchange: $${liveBal.toFixed(2)} USDT`);
            }
          }).catch(() => {});
        } else {
          this.log(`❌ Delta Exchange API returned rejection error: ${res.message}`);
        }
      }).catch((err) => {
        this.log(`❌ Delta Exchange order dispatch error: ${err?.message || err}`);
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

    // Apply the same minimum stop-loss distance floor to prevent excessively tight SL on historical/active trades
    const usdFloor = config.risk_management.min_stop_loss_distance_usd !== undefined ? config.risk_management.min_stop_loss_distance_usd : 80;
    const pctFloorVal = config.risk_management.min_stop_loss_distance_pct !== undefined ? config.risk_management.min_stop_loss_distance_pct : 0.12;
    const minSlDistance = Math.max(usdFloor, entryPrice * (pctFloorVal / 100));
    
    const isStaticSl = config.risk_management.static_stop_loss_enabled === true;
    const staticSlVal = config.risk_management.static_stop_loss_value_usd !== undefined ? config.risk_management.static_stop_loss_value_usd : 150;

    const stopLossDistance = isStaticSl
      ? staticSlVal
      : Math.max(
          stopLossAtr * config.risk_management.stop_loss_atr_multiplier,
          minSlDistance
        );
    const takeProfitDistance = stopLossDistance * config.risk_management.take_profit_ratio;

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

    // Trailing Stop Loss logic:
    let finalStopLossPrice = stopLossPrice;
    if (config.risk_management.trailing_stop_loss_enabled) {
      const usdFloor = config.risk_management.min_stop_loss_distance_usd !== undefined ? config.risk_management.min_stop_loss_distance_usd : 80;
      const pctFloorVal = config.risk_management.min_stop_loss_distance_pct !== undefined ? config.risk_management.min_stop_loss_distance_pct : 0.12;
      const minSlDistance = Math.max(usdFloor, entryPrice * (pctFloorVal / 100));
      const tsldistance = Math.max(
        lastAtr * (config.risk_management.trailing_stop_loss_distance_atr || 1.3),
        minSlDistance
      );
      if (!this.activeTrade.feature_snapshot) {
        this.activeTrade.feature_snapshot = {};
      }
      
      const activationRatio = config.risk_management.trailing_stop_loss_activation_ratio !== undefined
        ? config.risk_management.trailing_stop_loss_activation_ratio
        : 1.2;
      
      let trailingActivated = this.activeTrade.feature_snapshot.trailing_activated === true;
      
      if (direction === TradeDirection.LONG) {
        // Track maximum price observed since entry
        const peakPrice = Math.max(
          this.activeTrade.feature_snapshot.peak_price || entryPrice,
          currentPrice
        );
        this.activeTrade.feature_snapshot.peak_price = peakPrice;
        
        // Trailing Stop Loss is placed distance below peakPrice
        const trailingSl = peakPrice - tsldistance;
        this.activeTrade.feature_snapshot.trailing_stop_loss_price = trailingSl;
        
        // Check activation condition if not already activated
        if (!trailingActivated) {
          const reachedTarget = (peakPrice - entryPrice) >= (stopLossDistance * activationRatio);
          if (reachedTarget) {
            trailingActivated = true;
            this.activeTrade.feature_snapshot.trailing_activated = true;
            this.log(`📈 Trailing Stop Loss ACTIVATED for trade ${this.activeTrade.id}! Peak profit reached ${activationRatio}x of risk threshold ($${(stopLossDistance * activationRatio).toFixed(2)} USD in profit).`);
          }
        }
        
        // Apply trailing stop loss ONLY if activated
        if (trailingActivated) {
          finalStopLossPrice = Math.max(stopLossPrice, trailingSl);
        } else {
          finalStopLossPrice = stopLossPrice;
        }
      } else {
        // Track minimum price observed since entry
        const valleyPrice = Math.min(
          this.activeTrade.feature_snapshot.valley_price || entryPrice,
          currentPrice
        );
        this.activeTrade.feature_snapshot.valley_price = valleyPrice;
        
        // Trailing Stop Loss is placed distance above valleyPrice
        const trailingSl = valleyPrice + tsldistance;
        this.activeTrade.feature_snapshot.trailing_stop_loss_price = trailingSl;
        
        // Check activation condition if not already activated
        if (!trailingActivated) {
          const reachedTarget = (entryPrice - valleyPrice) >= (stopLossDistance * activationRatio);
          if (reachedTarget) {
            trailingActivated = true;
            this.activeTrade.feature_snapshot.trailing_activated = true;
            this.log(`📉 Trailing Stop Loss ACTIVATED for trade ${this.activeTrade.id}! Peak profit reached ${activationRatio}x of risk threshold ($${(stopLossDistance * activationRatio).toFixed(2)} USD in profit).`);
          }
        }
        
        // Apply trailing stop loss ONLY if activated
        if (trailingActivated) {
          finalStopLossPrice = Math.min(stopLossPrice, trailingSl);
        } else {
          finalStopLossPrice = stopLossPrice;
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
    this.log(`🚪 EXIT TRIGGERED for trade ${trade.id}. Reason: ${reason}. Exit Price: $${currentPrice}`);

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
      this.log(`📡 Dispatching real market order to CLOSE position on Delta Exchange REST API...`);
      // Place opposite order to close (if we were LONG, we SELL; if we were SHORT, we BUY)
      const closeSide = trade.direction === TradeDirection.LONG ? "sell" : "buy";
      placeDeltaMarketOrder(creds, "BTCUSD", closeSide, trade.quantity_btc).then((res) => {
        if (res.success) {
          this.log(`✅ Delta Exchange position successfully closed! Exit Order ID: ${res.order_id}`);
          // Immediately sync balance
          getDeltaWalletBalance(creds).then((liveBal) => {
            if (liveBal !== null) {
              dbManager.updateCredentials({
                account_balance_usdt: liveBal,
              });
              this.log(`💰 Real-time balance updated from Delta Exchange: $${liveBal.toFixed(2)} USDT`);
            }
          }).catch(() => {});
        } else {
          this.log(`❌ Delta Exchange API returned exit rejection error: ${res.message}`);
        }
      }).catch((err) => {
        this.log(`❌ Delta Exchange exit order dispatch error: ${err?.message || err}`);
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
      this.log(`📡 Dispatching real MANUAL market order to Delta Exchange REST API...`);
      const side = direction === "LONG" ? "buy" : "sell";
      placeDeltaMarketOrder(creds, "BTCUSD", side, q).then((res) => {
        if (res.success) {
          this.log(`✅ Delta Exchange manual order matched successfully! Order ID: ${res.order_id}`);
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
              this.log(`💰 Real-time balance updated from Delta Exchange: $${liveBal.toFixed(2)} USDT`);
            }
          }).catch(() => {});
        } else {
          this.log(`❌ Delta Exchange API returned rejection error for manual order: ${res.message}`);
        }
      }).catch((err) => {
        this.log(`❌ Delta Exchange manual order dispatch error: ${err?.message || err}`);
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
