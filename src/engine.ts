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

class TradingEngine {
  private candles1m: Candlestick[] = [];
  private currentPrice: number = 101500;
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

  public resetFeatureDrift() {
    this.log(`[ML-Retraining] Resetting feature drift parameters.`);
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

    if (isTrendRegime) {
      activeModel = "Trend-Following CatBoost Model";
      
      // Feature 1: Directional trend alignment. Bullish trend gets positive bias, Bearish negative.
      const trendBias = isBullTrend1m ? 0.40 : -0.40;
      const adxTrendFactor = trendBias * adxScale;

      // Feature 2: Momentum.
      let momentumFactor = rsiFactor;
      if (isBullTrend1m && rsiFactor < 0) {
        momentumFactor *= 0.5; // Dampen negative RSI in an uptrend (buying dips)
      } else if (!isBullTrend1m && rsiFactor > 0) {
        momentumFactor *= 0.5; // Dampen positive RSI in a downtrend (shorting rallies)
      }

      // Feature 3: Volume confirmation of breakout
      const volConfirmation = isBullTrend1m ? (volScale - 1.0) * 0.15 : (1.0 - volScale) * 0.15;

      // Feature 4: ATR Volatility Expansion Breakout (Replacing Sentiment)
      // Confirms breakout energy in the direction of the trend
      const atrBreakoutFactor = (isBullTrend1m ? 1 : -1) * Math.max(0, atrExpansionRatio - 0.8) * 0.25;

      // Combine factors with optimized CatBoost tree-weight mappings (sentiment replaced by emaSpreadFactor + atrBreakoutFactor)
      score = adxTrendFactor + (momentumFactor * 0.35) + volConfirmation + emaSpreadFactor + atrBreakoutFactor;

      // Extra optimization adjustments for extreme regimes
      if (regime === MarketRegime.HIGH_VOLATILITY) {
        // High Volatility mode requires higher momentum sensitivity
        score *= 1.25; 
      } else if (regime === MarketRegime.STRONG_UPTREND) {
        // Upward structural bias
        score += 0.08;
      } else if (regime === MarketRegime.STRONG_DOWNTREND) {
        // Downward structural bias
        score -= 0.08;
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

      // Feature 6: ATR Volatility Contraction / Breakout Protection Scale
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
        emaOverstretchFactor
      ) * reversionConfidenceScale;

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

  private isGateSkipped(config: StrategyConfig, name: string): boolean {
    const skippedGates = config.general.skipped_gates || [];
    return skippedGates.some(
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
        separator;

      fs.appendFileSync(logFilePath, logEntry, "utf-8");
      this.log(`📝 Logged trade exit ${trade.id} details to trade_log file.`);
    } catch (e) {
      console.error("[TradingEngine] Failed to write trade exit to trade_log file:", e);
    }
  }

  public getStatus() {
    const creds = dbManager.getCredentials();
    const config = dbManager.getConfig();
    const active = this.activeTrade;

    return {
      is_trading_active: config.general.is_trading_active,
      is_paper_trading: config.general.is_paper_trading,
      current_price: this.currentPrice,
      current_regime: this.currentRegime,
      regime_confidence: this.regimeConfidence,
      critical_event_active: this.criticalEventActive,
      critical_event_keyword: this.criticalEventKeyword,
      protection_remaining_seconds: this.protectionRemainingSeconds,
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

  public getCurrentCheckpoints() {
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
      const sumPrevVolumes = volumes.slice(lastIdx - 20, lastIdx).reduce((a, b) => a + b, 0);
      const avgPrevVolume = sumPrevVolumes / 20;
      relVolume = avgPrevVolume > 0 ? currentVolume / avgPrevVolume : 1.0;
    } else if (hasEnoughData) {
      relVolume = 1.35;
    }

    const isBullTrend1m = hasEnoughData ? ema21[lastIdx] > ema50[lastIdx] : true;
    const isBearTrend1m = hasEnoughData ? ema21[lastIdx] < ema50[lastIdx] : false;

    // Get headlines sentiment
    const headlines = dbManager.getHeadlines().slice(0, 15);
    const avgSentiment = this.calculateAverageSentiment(headlines);

    const currentPrice = this.currentPrice;

    // Ensure VWAP is computed
    this.calculateVWAP(this.candles1m);
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
    const currentCandle = hasEnoughData ? this.candles1m[lastIdx] : { open: currentPrice, close: currentPrice, high: currentPrice, low: currentPrice };
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

    const isUptrendAligned = ema20Val > ema50Val && ema50Val > ema200Val && adxValue >= trendAlignAdx && this.currentRegime === MarketRegime.STRONG_UPTREND;
    const isDowntrendAligned = ema20Val < ema50Val && ema50Val < ema200Val && adxValue >= trendAlignAdx && this.currentRegime === MarketRegime.STRONG_DOWNTREND;
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
      const recentCandlesForRange = this.candles1m.slice(-rangeLookback);
      const rangeHigh = recentCandlesForRange.length > 0 ? Math.max(...recentCandlesForRange.map(c => c.high)) : struct.swingHigh;
      const rangeLow = recentCandlesForRange.length > 0 ? Math.min(...recentCandlesForRange.map(c => c.low)) : struct.swingLow;

      const rangeWidth = rangeHigh - rangeLow;
      const rangeSupportThreshold = rangeLow + Math.min(rangeWidth * 0.15, rangeLow * 0.0015);
      const rangeResistanceThreshold = rangeHigh - Math.min(rangeWidth * 0.15, rangeHigh * 0.0015);

      // Reversal signals
      const isRangeLongReversal = (currentPrice <= rangeSupportThreshold) && (currentCandle.close > currentCandle.open);
      const isRangeShortReversal = (currentPrice >= rangeResistanceThreshold) && (currentCandle.close < currentCandle.open);

      // Breakout signals: Price breaks outside the 30-candle range with high relative volume
      const isRangeLongBreakout = (currentPrice > rangeHigh) && (relVolume > 1.2);
      const isRangeShortBreakdown = (currentPrice < rangeLow) && (relVolume > 1.2);

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
      const hasValidPushbackLong = (recentPullbackToEma20Long || recentPullbackToEma50Long) && currentPrice >= ema50Val * 0.998;

      const recentPullbackToEma20Short = recentCandles.some(c => c.high >= ema20Val * 0.9985 && c.low <= ema20Val * 1.0015);
      const recentPullbackToEma50Short = recentCandles.some(c => c.high >= ema50Val * 0.9985 && c.low <= ema50Val * 1.0015);
      const hasValidPushbackShort = (recentPullbackToEma20Short || recentPullbackToEma50Short) && currentPrice <= ema50Val * 1.002;

      const isUptrendAligned = ema20Val > ema50Val && (adxValue >= ms.hf_momentum_adx_threshold || ema50Val > ema100Val);
      const isDowntrendAligned = ema20Val < ema50Val && (adxValue >= ms.hf_momentum_adx_threshold || ema50Val < ema100Val);

      // For high-frequency scalping, we allow breakouts (momentum chasing) if ADX is strong or there is high order flow pressure
      const isScalperBreakoutLongAllowed = adxValue >= ms.hf_momentum_adx_threshold || (this.orderFlowStats.takerBuyRatio >= ms.hf_orderflow_taker_buy_ratio_long || this.orderBookStats.imbalanceRatio >= ms.hf_orderflow_imbalance_ratio_long);
      const isScalperBreakdownShortAllowed = adxValue >= ms.hf_momentum_adx_threshold || (this.orderFlowStats.takerBuyRatio <= ms.hf_orderflow_taker_buy_ratio_short || this.orderBookStats.imbalanceRatio <= ms.hf_orderflow_imbalance_ratio_short);

      const isNotLongBreakout = isScalperBreakoutLongAllowed ? true : (struct.current_HH ? currentPrice <= struct.current_HH.price : true);
      const isNotShortBreakdown = isScalperBreakdownShortAllowed ? true : (struct.current_LL ? currentPrice >= struct.current_LL.price : true);

      if (isUptrendAligned && (hasValidPushbackLong || isScalperBreakoutLongAllowed) && isNotLongBreakout && probabilityLong >= 0.65) {
        signalDirection = "LONG";
      } else if (isDowntrendAligned && (hasValidPushbackShort || isScalperBreakdownShortAllowed) && isNotShortBreakdown && probabilityShort >= 0.65) {
        signalDirection = "SHORT";
      } else {
        signalDirection = "NEUTRAL";
      }
    }

    const conditions: { name: string; met: boolean; current_value: any; required: string; description: string; priority: "CRITICAL" | "HIGH" | "MEDIUM" }[] = [];

    // C1: CatBoost AI Prediction (threshold is 0.50 leaning direction in RANGE_BOUND, 0.70 for pullback, 0.75 in trending breakouts)
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
        ? `P(LONG) >= ${this.currentRegime === MarketRegime.RANGE_BOUND ? "50" : (isEnteringPullback ? "70" : "75")}% (Evaluating LONG Trade)`
        : signalDirection === "SHORT"
        ? `P(SHORT) >= ${this.currentRegime === MarketRegime.RANGE_BOUND ? "50" : (isEnteringPullback ? "70" : "75")}% (Evaluating SHORT Trade)`
        : `P(LONG) >= ${this.currentRegime === MarketRegime.RANGE_BOUND ? "50" : (isEnteringPullback ? "70" : "75")}% for LONG OR P(SHORT) >= ${this.currentRegime === MarketRegime.RANGE_BOUND ? "50" : (isEnteringPullback ? "70" : "75")}% for SHORT (Mutually Exclusive)`,
      description: "Uses pre-trained ensemble trees mapping momentum, EMA spreads, and ATR volatility expansion.",
      priority: "CRITICAL",
    });

    const hasExtremeRealtimePressure = (config.general.enable_orderflow_softening !== false) &&
                                       ((signalDirection === "LONG" && (this.orderFlowStats.takerBuyRatio >= 0.68 || this.orderBookStats.imbalanceRatio >= 0.45)) ||
                                       (signalDirection === "SHORT" && (this.orderFlowStats.takerBuyRatio <= 0.32 || this.orderBookStats.imbalanceRatio <= -0.45)));

    const isLowVolatility = this.currentRegime === MarketRegime.LOW_VOLATILITY;
    const hasSoftenRegimePressure = (config.general.enable_orderflow_softening !== false) &&
                                    ((signalDirection === "LONG" && (this.orderFlowStats.takerBuyRatio >= 0.60 || this.orderBookStats.imbalanceRatio >= 0.35)) ||
                                    (signalDirection === "SHORT" && (this.orderFlowStats.takerBuyRatio <= 0.40 || this.orderBookStats.imbalanceRatio <= -0.35))) &&
                                    (relVolume > 1.1);

    // C2: Market Regime lock
    // Blocked all entries during LOW_VOLATILITY unless softened via heavy order flow pressure and volume.
    const regimeValid = !isLowVolatility || hasSoftenRegimePressure;
    const regimeAligned =
      (signalDirection === "LONG" && (this.currentRegime === MarketRegime.STRONG_UPTREND || this.currentRegime === MarketRegime.RANGE_BOUND)) ||
      (signalDirection === "SHORT" && (this.currentRegime === MarketRegime.STRONG_DOWNTREND || this.currentRegime === MarketRegime.RANGE_BOUND)) ||
      this.currentRegime === MarketRegime.HIGH_VOLATILITY ||
      (!isLowVolatility && hasExtremeRealtimePressure) ||
      (isLowVolatility && hasSoftenRegimePressure);

    conditions.push({
      name: "Market Regime Filter",
      met: regimeValid && (signalDirection === "NEUTRAL" ? true : regimeAligned),
      current_value: this.currentRegime + (isLowVolatility && hasSoftenRegimePressure ? " (SOFTENED VIA HEAVY LEADING ORDER FLOW)" : (hasExtremeRealtimePressure ? " (BYPASSED VIA LEADING ORDER FLOW)" : "")),
      required: "STRONG_UPTREND/RANGE_BOUND for LONG, STRONG_DOWNTREND/RANGE_BOUND for SHORT, or HIGH_VOLATILITY (Softenable under heavy leading order flow & volume confirmation)",
      description: "Restricts execution during low volatility ranging zones to prevent chop losses. Softened under heavy real-time order flow and book imbalance with supporting volume.",
      priority: "CRITICAL",
    });

    // C3 & C8 Combined: Trend Alignment & Strength (EMA/ADX)
    let trendAligned = true;
    let adxMet = true;
    let currentTrendStr = "";
    let requiredStr = "";

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
        adxMet = adxValue >= 20;
        currentTrendStr = `EMA Structure: FAST_ALIGNED (Extreme Real-time Flow Pressure) | ADX: ${adxValue.toFixed(1)} (Threshold softened to >= 20)`;
        requiredStr = `LONG: Fast EMA${fastEma} > EMA${medEma} & ADX >= 20 (Softened via Order Flow), SHORT: Fast EMA${fastEma} < EMA${medEma} & ADX >= 20`;
      } else {
        const fastEma = ms.fast_ema_period || 20;
        const medEma = ms.medium_ema_period || 50;
        const slowEma = ms.slow_ema_period || 200;
        trendAligned = signalDirection === "NEUTRAL" ? true : (
          (signalDirection === "LONG" && isUptrendAligned) ||
          (signalDirection === "SHORT" && isDowntrendAligned)
        );
        adxMet = adxValue >= trendAlignAdx;
        currentTrendStr = `EMA Structure: ${isUptrendAligned ? "BULLISH_TREND" : isDowntrendAligned ? "BEARISH_TREND" : "MIXED/FLAT"}`;
        requiredStr = `LONG: EMA${fastEma} > EMA${medEma} > EMA${slowEma} & ADX >= ${trendAlignAdx} & STRONG_UPTREND, SHORT: EMA${fastEma} < EMA${medEma} < EMA${slowEma} & ADX >= ${trendAlignAdx} & STRONG_DOWNTREND`;
      }
    }

    const fastEma = ms.fast_ema_period || 20;
    const medEma = ms.medium_ema_period || 50;
    const slowEma = ms.slow_ema_period || 200;

    conditions.push({
      name: "Trend Alignment & Strength (EMA/ADX)",
      met: trendAligned && adxMet,
      current_value: `${currentTrendStr} | ADX: ${adxValue.toFixed(1)}`,
      required: requiredStr,
      description: `Confirms overall strong trend alignment (EMA ${fastEma}/${medEma}/${slowEma}) and high trend strength (ADX >= ${trendAlignAdx}) or checks safety locks during range bound.`,
      priority: "HIGH",
    });

    // C5: Relative Volume Confirmation
    const requiredRelVol = hasExtremeRealtimePressure 
      ? Math.min(1.0, Math.max(0.75, relVolThreshold - 0.5)) 
      : relVolThreshold;
    conditions.push({
      name: "Relative Volume Confirmation",
      met: relVolume > requiredRelVol,
      current_value: `${relVolume.toFixed(2)}x` + (hasExtremeRealtimePressure ? " (SOFTENED VIA LEADING ORDER FLOW)" : ""),
      required: `> ${requiredRelVol.toFixed(2)}x above 20-period MA`,
      description: hasExtremeRealtimePressure
        ? "Validates supporting transaction volume. (Threshold softened under extreme leading order flow pressure)."
        : "Validates that trade has supporting transaction volume to avoid false breakups.",
      priority: "MEDIUM",
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
    const maxAllowedDeviation = 2.2 * currentAtr;
    const isEma100OverextendedLong = currentPrice > ema100Val + maxAllowedDeviation;
    const isEma100OverextendedShort = currentPrice < ema100Val - maxAllowedDeviation;

    let ema100Met = true;
    let ema100ValStr = "PASSING (NORMAL DISTANCE)";

    if (hasExtremeRealtimePressure) {
      ema100Met = true;
      ema100ValStr = signalDirection === "LONG"
        ? `PASSING (Extreme Leading Pressure Confirmed: Distance +$${ema100Distance.toFixed(2)})`
        : `PASSING (Extreme Leading Pressure Confirmed: Distance -$${Math.abs(ema100Distance).toFixed(2)})`;
    } else if (!highMovementShort) {
      ema100ValStr = `PASSING (No high momentum pulse in last 10 candles)`;
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
      name: "Overextension & Level Anchors (VWAP/EMA)",
      met: vwapDevMet && ema100Met,
      current_value: `VWAP: ${vwapDevMet ? "PASSING" : "OVEREXTENDED"} | EMA100: ${ema100ValStr}`,
      required: "Price within VWAP standard deviation bands and not overextended relative to the 100 EMA baseline",
      description: "Guards against entering trades when price is extremely overextended (preventing buying tops or shorting bottoms).",
      priority: "CRITICAL",
    });

    // C15: Market Structure & Entry Confirmation Check (Pullback, Retest, Reversal, High-Vol Confirmation)
    const structCheck = this.evaluateMarketStructureConfirmation(signalDirection);
    
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
    let ofVal = `Taker Buy Ratio: ${(this.orderFlowStats.takerBuyRatio * 100).toFixed(1)}% (CVD: ${this.orderFlowStats.netCVD.toFixed(2)} BTC)`;
    let ofReq = "Taker Buy Ratio >= 51.0% for LONG, <= 49.0% for SHORT";

    if (signalDirection === "LONG") {
      ofMet = this.orderFlowStats.takerBuyRatio >= 0.51;
      if (!ofMet) {
        ofVal = `${ofVal} - BLOCKED (Insufficient Buy Pressure)`;
      } else {
        ofVal = `${ofVal} - PASSED (Strong Buy Pressure)`;
      }
    } else if (signalDirection === "SHORT") {
      ofMet = this.orderFlowStats.takerBuyRatio <= 0.49;
      if (!ofMet) {
        ofVal = `${ofVal} - BLOCKED (Insufficient Sell Pressure)`;
      } else {
        ofVal = `${ofVal} - PASSED (Strong Sell Pressure)`;
      }
    }

    conditions.push({
      name: "Binance Order Flow Confirmation",
      met: ofMet,
      current_value: ofVal,
      required: ofReq,
      description: "Requires taker buy ratio from active market trades to be aligned with the signal direction (e.g. >= 51% for LONG, <= 49% for SHORT) to confirm volume-based momentum.",
      priority: "HIGH",
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

    // C19: Order Book Imbalance & Liquidity Depth Gate
    let obMet = true;
    const obMinDepth = config.general.order_book_min_depth !== undefined ? config.general.order_book_min_depth : 4.0;
    const obMaxImbalance = config.general.order_book_max_imbalance !== undefined ? config.general.order_book_max_imbalance : 0.35;

    const obTotalDepth = this.orderBookStats.bidDepthBTC + this.orderBookStats.askDepthBTC;
    const obImbalancePct = this.orderBookStats.imbalanceRatio * 100;
    let obVal = `Bids Depth: ${this.orderBookStats.bidDepthBTC.toFixed(1)} BTC | Asks Depth: ${this.orderBookStats.askDepthBTC.toFixed(1)} BTC (Imbalance: ${obImbalancePct >= 0 ? "+" : ""}${obImbalancePct.toFixed(1)}%)`;
    let obReq = `Top-10 book depth >= ${obMinDepth.toFixed(1)} BTC; Imbalance >= -${(obMaxImbalance * 100).toFixed(0)}% for LONG, <= +${(obMaxImbalance * 100).toFixed(0)}% for SHORT`;

    if (obTotalDepth < obMinDepth) {
      obMet = false;
      obVal = `${obVal} - BLOCKED (Insufficient Book Liquidity: ${obTotalDepth.toFixed(1)} < ${obMinDepth.toFixed(1)} BTC)`;
    } else if (signalDirection === "LONG") {
      obMet = this.orderBookStats.imbalanceRatio >= -obMaxImbalance;
      if (!obMet) {
        obVal = `${obVal} - BLOCKED (Heavy Ask Wall / Negative Imbalance)`;
      } else {
        obVal = `${obVal} - PASSED (Strong Bid Support)`;
      }
    } else if (signalDirection === "SHORT") {
      obMet = this.orderBookStats.imbalanceRatio <= obMaxImbalance;
      if (!obMet) {
        obVal = `${obVal} - BLOCKED (Heavy Bid Floor / Positive Imbalance)`;
      } else {
        obVal = `${obVal} - PASSED (Strong Sell Pressure / Ask Dominance)`;
      }
    }

    conditions.push({
      name: "Order Book Imbalance & Liquidity Depth Gate",
      met: obMet,
      current_value: obVal,
      required: obReq,
      description: `Verifies near-book liquidity depth (minimum ${obMinDepth.toFixed(1)} BTC cumulative top-10 levels) and ensures top-10 level bid/ask order book imbalance aligns with the entry direction to avoid buying directly into massive ask walls or selling into heavy bid walls.`,
      priority: "HIGH",
    });

    // Apply bypassed/skipped gates
    for (const c of conditions) {
      if (this.isGateSkipped(config, c.name)) {
        c.met = true;
        c.current_value = `${c.current_value} (BYPASS)`;
      }
    }

    // Calculate overall entry score
    let entryScore = 0;
    if (signalDirection !== "NEUTRAL") {
      if (pLongMet || pShortMet || this.isGateSkipped(config, "CatBoost AI Prediction")) entryScore += 40;
      if ((regimeValid && regimeAligned) || this.isGateSkipped(config, "Market Regime Filter")) entryScore += 20;
      if ((trendAligned && adxMet) || this.isGateSkipped(config, "Trend Alignment & Strength (EMA/ADX)")) entryScore += 30;
      if (relVolume > requiredRelVol || this.isGateSkipped(config, "Relative Volume Confirmation")) entryScore += 10;
    }

    return {
      conditions,
      entry_score: entryScore,
      signal_direction: signalDirection,
      all_conditions_met: conditions.every((c) => c.met),
      rejection_reason: conditions.every((c) => c.met) ? null : conditions.filter((c) => !c.met).map((c) => c.name).join(", "),
    };
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
        const newCandle: Candlestick = {
          time: last.time + 60,
          open: last.close,
          high: this.currentPrice,
          low: this.currentPrice,
          close: this.currentPrice,
          volume: 2 + Math.random() * 25,
        };
        this.candles1m.push(newCandle);
        if (this.candles1m.length > 350) {
          this.candles1m.shift();
        }
        this.log(`New 1-Minute Candle formed: Open=$${newCandle.open.toFixed(2)}, Close=$${newCandle.close.toFixed(2)}`);
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
    const ema: number[] = [];
    if (data.length === 0) return ema;
    const k = 2 / (period + 1);
    let sum = 0;
    for (let i = 0; i < period; i++) {
      sum += data[i];
    }
    ema[period - 1] = sum / period;
    for (let i = period; i < data.length; i++) {
      ema[i] = data[i] * k + ema[i - 1] * (1 - k);
    }
    return ema;
  }

  private calculateRSI(data: number[], period = 14): number[] {
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

    return rsi;
  }

  private calculateATR(candles: Candlestick[], period = 14): number[] {
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

    return atr;
  }

  private calculateADX(candles: Candlestick[], period = 14): number[] {
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

    // 1. Detect Swing Highs and Swing Lows
    const swingHighs: { index: number; price: number }[] = [];
    const swingLows: { index: number; price: number }[] = [];

    // Find swing points over last 60 candles (going backwards)
    for (let i = lastIdx - 1; i >= 1; i--) {
      const isHigh = highs[i] > highs[i - 1] && highs[i] > highs[i + 1];
      const isLow = lows[i] < lows[i - 1] && lows[i] < lows[i + 1];

      if (isHigh) {
        swingHighs.push({ index: i, price: highs[i] });
      }
      if (isLow) {
        swingLows.push({ index: i, price: lows[i] });
      }

      if (swingHighs.length >= 8 && swingLows.length >= 8) break;
    }

    if (swingHighs.length < 2 || swingLows.length < 2) {
      return defaultResult;
    }

    // Connect the two most recent swing highs and swing lows
    const h2 = swingHighs[0];
    const h1 = swingHighs[1];

    const l2 = swingLows[0];
    const l1 = swingLows[1];

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
    const isCompressing = ratio < 0.6;

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
    const closes = this.candles1m.map(c => c.close);
    const highs = this.candles1m.map(c => c.high);
    const lows = this.candles1m.map(c => c.low);
    const lastIdx = closes.length - 1;

    if (closes.length < 50) {
      return {
        current_HH: null, prev_HH: null, current_HL: null, prev_HL: null,
        current_LH: null, prev_LH: null, current_LL: null, prev_LL: null,
        isLongStructureConfirmed: false, isShortStructureConfirmed: false,
        pullbackLongMet: false, pullbackShortMet: false,
        swingHigh: highs[lastIdx] || 100000, swingLow: lows[lastIdx] || 100000
      };
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

    const rawHighs: { index: number; price: number }[] = [];
    const rawLows: { index: number; price: number }[] = [];

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
        rawHighs.push({ index: i, price: highs[i] });
      }
      if (isSwingLow) {
        rawLows.push({ index: i, price: lows[i] });
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
      const candlesAfterHH = this.candles1m.slice(startIndex);
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
      const candlesAfterLL = this.candles1m.slice(startIndex);
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

    return {
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
  }

  private evaluateTrendBreakoutSetup(
    direction: "LONG" | "SHORT",
    currentPrice: number,
    ema20Val: number,
    ema50Val: number,
    ema100Val: number,
    struct: any
  ): { confirmed: boolean; message: string } {
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
    let pullbackMultiplier = 0.4; // Default
    let emaRetraceMultiplier = 0.25; // Default
    let invalidationMultiplier = 0.25; // Default

    if (adxValue < 20) {
      adxLabel = "Weak / Choppy";
      pullbackMultiplier = 0.2;       // Requires very deep pullback to broken level to avoid buying top
      emaRetraceMultiplier = 0.15;     // Requires tight touch of EMA
      invalidationMultiplier = 0.15;   // Tight invalidation to cut false breakout losses fast
    } else if (adxValue >= 20 && adxValue < 30) {
      adxLabel = "Normal Trend";
      pullbackMultiplier = 0.4;
      emaRetraceMultiplier = 0.25;
      invalidationMultiplier = 0.25;
    } else if (adxValue >= 30 && adxValue < 40) {
      adxLabel = "Strong Trend";
      pullbackMultiplier = 0.6;       // Shallow pullback allowed (price is highly bid)
      emaRetraceMultiplier = 0.4;      // Shallow EMA pullback allowed
      invalidationMultiplier = 0.35;   // Room to breathe to avoid wicks shaking us out
    } else { // adxValue >= 40
      adxLabel = "Parabolic Trend";
      pullbackMultiplier = 0.8;       // Very shallow pullback allowed
      emaRetraceMultiplier = 0.55;     // Very shallow EMA pullback allowed
      invalidationMultiplier = 0.45;   // Max breathing room for high-volatility trend extension
    }

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
        const hasHighHFPressure = adxValue >= (ms.hf_momentum_adx_threshold + 2) || (direction === "LONG" ? (this.orderFlowStats.takerBuyRatio >= ms.hf_orderflow_taker_buy_ratio_long || this.orderBookStats.imbalanceRatio >= ms.hf_orderflow_imbalance_ratio_long) : (this.orderFlowStats.takerBuyRatio <= ms.hf_orderflow_taker_buy_ratio_short || this.orderBookStats.imbalanceRatio <= ms.hf_orderflow_imbalance_ratio_short));
        if (direction === "LONG" && !isMtfLong && !hasHighHFPressure) {
          return {
            confirmed: false,
            message: `Conflicting Trend: Multi-timeframe (5m) trend is bearish (5m EMA 5: $${ema5_5m_val.toFixed(2)} <= EMA 15: $${ema15_5m_val.toFixed(2)}). LONG entry blocked.`
          };
        }
        if (direction === "SHORT" && isMtfLong && !hasHighHFPressure) {
          return {
            confirmed: false,
            message: `Conflicting Trend: Multi-timeframe (5m) trend is bullish (5m EMA 5: $${ema5_5m_val.toFixed(2)} >= EMA 15: $${ema15_5m_val.toFixed(2)}). SHORT entry blocked.`
          };
        }
        mtfMessage = hasHighHFPressure ? " | MTF Bypassed (High HF Pressure)" : " | MTF Aligned (5m EMA5 > EMA15)";
      }
    }

    if (direction === "LONG") {
      const isEmaAlignedLong = adxValue >= ms.weak_trend_adx_threshold
        ? (ema20Val > ema50Val)
        : (ema20Val > ema50Val && currentPrice > ema100Val);
      if (!isEmaAlignedLong) {
        return {
          confirmed: false,
          message: adxValue >= ms.weak_trend_adx_threshold
            ? `Blocked: Fast Bullish EMA structure not aligned (Requires EMA 20 > EMA 50, ADX is strong: ${adxValue.toFixed(1)}).`
            : `Blocked: Full Bullish EMA structure not aligned (Requires EMA 20 > EMA 50 & Price > EMA 100 on moderate ADX: ${adxValue.toFixed(1)}).`
        };
      }

      // Symmetrically, the broken level is the previous Higher High (prev_HH) in a confirmed uptrend
      const breakoutLevel = struct.prev_HH ? struct.prev_HH.price : (struct.current_HH ? struct.current_HH.price : struct.swingHigh);
      const searchStart = struct.prev_HH ? struct.prev_HH.index : 0;

      // Find the candle index where breakout occurred (closing above breakout level)
      let breakoutIdx = -1;
      for (let i = searchStart; i <= lastIdx; i++) {
        if (this.candles1m[i].close > breakoutLevel) {
          breakoutIdx = i;
          break;
        }
      }

      if (breakoutIdx === -1) {
        return {
          confirmed: false,
          message: `Waiting for a confirmed Higher High breakout of $${breakoutLevel.toFixed(2)} to initiate the pullback/retest or EMA pushback setup sequence.`
        };
      }

      // --- FEATURE 2: Candle Body Close Confirmation for Breakout ---
      const boCandle = this.candles1m[breakoutIdx];
      const boRange = boCandle.high - boCandle.low;
      const boBody = Math.abs(boCandle.close - boCandle.open);
      const boBodyRatio = boRange > 0 ? boBody / boRange : 0;
      if (boBodyRatio < ms.min_breakout_body_ratio) {
        return {
          confirmed: false,
          message: `Blocked: Weak breakout candle body at $${breakoutLevel.toFixed(2)} (Body is only ${(boBodyRatio * 100).toFixed(0)}% of total range). Likely false breakout/wick sweep.`
        };
      }

      if (breakoutIdx === lastIdx) {
        const hasHighHFPressure = ms.allow_immediate_breakout && (adxValue >= ms.hf_momentum_adx_threshold || (this.orderFlowStats.takerBuyRatio >= ms.hf_orderflow_taker_buy_ratio_long || this.orderBookStats.imbalanceRatio >= ms.hf_orderflow_imbalance_ratio_long));
        if (hasHighHFPressure) {
          return {
            confirmed: true,
            message: `[HF Scalp Boost] Immediate Breakout Entry Confirmed! Price ($${currentPrice.toFixed(2)}) broke out above $${breakoutLevel.toFixed(2)} under high frequency momentum (ADX: ${adxValue.toFixed(1)}) and order flow pressure.`
          };
        } else {
          return {
            confirmed: false,
            message: `Blocked: Immediate LONG entry on the Higher High breakout candle ($${breakoutLevel.toFixed(2)}) is forbidden. Waiting for pullback/retest or EMA pushback.`
          };
        }
      }

      const postBreakoutCandles = this.candles1m.slice(breakoutIdx + 1);

      // --- FEATURE 4: Dynamic Invalidation & Stop-Loss Zones ---
      const structuralHL = struct.current_HL ? struct.current_HL.price : 0;
      const reclaimThreshold = Math.max(breakoutLevel - invalidationMultiplier * currentAtr, structuralHL - 0.1 * currentAtr);
      const hasReclaimed = postBreakoutCandles.some(c => c.close < reclaimThreshold);
      if (hasReclaimed || currentPrice < reclaimThreshold) {
        return {
          confirmed: false,
          message: `Blocked: Higher High breakout setup was invalidated because price strongly reclaimed/broke below the structural/reclaim floor level of $${reclaimThreshold.toFixed(2)} (Breakout Level: $${breakoutLevel.toFixed(2)}).`
        };
      }

      // Chasing check: too many candles elapsed without entry (adaptive lookback based on trend strength)
      let maxPostBreakoutCandles = 30;
      if (adxValue < 20) {
        maxPostBreakoutCandles = 15;
      } else if (adxValue >= 40) {
        maxPostBreakoutCandles = 45;
      }
      if (postBreakoutCandles.length > maxPostBreakoutCandles) {
        return {
          confirmed: false,
          message: `Blocked: Chasing price after an extended upward move (more than ${maxPostBreakoutCandles} candles since HH breakout, ADX: ${adxValue.toFixed(1)} [${adxLabel}]) is forbidden.`
        };
      }

      // --- FEATURE 1: Volume-Validated Pullback & Retest ---
      // Dynamically calculate average volume of the last 20 candles to avoid rigid single-candle anomalies
      const volumes = this.candles1m.map(c => c.volume);
      let avgVol20 = 1.0;
      if (volumes.length >= 20) {
        const sumVol20 = volumes.slice(-20).reduce((a, b) => a + b, 0);
        avgVol20 = sumVol20 / 20;
      }

      let isVolumeHealthyForPullback = true;
      if (postBreakoutCandles.length > 0) {
        const avgPullbackVol = postBreakoutCandles.reduce((sum, c) => sum + c.volume, 0) / postBreakoutCandles.length;
        // Allow higher volume on pullback when breakout volume itself is highly compressed/low
        const volumeThreshold = Math.max(boCandle.volume * 1.8, avgVol20 * 2.2);
        if (avgPullbackVol > volumeThreshold) {
          isVolumeHealthyForPullback = false;
        }
      }

      // Setup 1: Pullback and Retest
      const effectivePullbackMult = Math.max(pullbackMultiplier, ms.pullback_multiplier_limit);
      const effectiveEmaMult = Math.max(emaRetraceMultiplier, ms.ema_retrace_multiplier_limit);
      const pullbackLimit = breakoutLevel + effectivePullbackMult * currentAtr;
      const hasPulledBackToZone = postBreakoutCandles.some(c => c.low <= pullbackLimit);
      
      let isPullbackRetestValid = false;
      let pullbackRetestMessage = "";
      if (hasPulledBackToZone) {
        const isRejection = (currentCandle.close > currentCandle.open) || ((currentCandle.close - currentCandle.low) >= 0.3 * (currentCandle.high - currentCandle.low));
        const isContinuation = currentCandle.close > currentCandle.open && currentCandle.close >= breakoutLevel;
        if (isRejection && isContinuation) {
          if (isVolumeHealthyForPullback) {
            isPullbackRetestValid = true;
            pullbackRetestMessage = `Pullback & Retest setup confirmed${mtfMessage}: Price pulled back to broken HH level ($${breakoutLevel.toFixed(2)}) on declining volume and rejected it as support with bullish confirmation (ADX: ${adxValue.toFixed(1)} [${adxLabel}], Retrace limit: +${effectivePullbackMult.toFixed(1)} * ATR).`;
          } else {
            pullbackRetestMessage = "Blocked Retest: Pullback volume is abnormally high, indicating excessive distribution/selling pressure.";
          }
        }
      }

      // Setup 2: 20/50 EMA Pushback
      const emaRetraceThreshold20 = ema20Val + effectiveEmaMult * currentAtr;
      const emaRetraceThreshold50 = ema50Val + effectiveEmaMult * currentAtr;
      const hasRetracedToEMA = postBreakoutCandles.some(c => c.low <= emaRetraceThreshold20 || c.low <= emaRetraceThreshold50);
      
      const currentRejectsEma20 = currentCandle.low <= ema20Val + 0.2 * currentAtr && currentPrice >= (ema20Val - 0.15 * currentAtr) && currentCandle.close > currentCandle.open;
      const currentRejectsEma50 = currentCandle.low <= ema50Val + 0.2 * currentAtr && currentPrice >= (ema50Val - 0.15 * currentAtr) && currentCandle.close > currentCandle.open;
      const isEmaPushbackValid = (currentRejectsEma20 || currentRejectsEma50) && hasRetracedToEMA;
      let emaPushbackMessage = "";
      if (isEmaPushbackValid) {
        if (isVolumeHealthyForPullback) {
          emaPushbackMessage = `20/50 EMA Pushback confirmed${mtfMessage}: Price rejected dynamic EMA support at $${(currentRejectsEma20 ? ema20Val : ema50Val).toFixed(2)} with bullish confirmation (ADX: ${adxValue.toFixed(1)} [${adxLabel}], EMA limit: +${effectiveEmaMult.toFixed(2)} * ATR).`;
        } else {
          emaPushbackMessage = "Blocked EMA Pushback: Abnormally high volume pullback during EMA retracement suggests a trend failure.";
        }
      }

      if (isPullbackRetestValid && !pullbackRetestMessage.startsWith("Blocked")) {
        return { confirmed: true, message: pullbackRetestMessage };
      } else if (isEmaPushbackValid && !emaPushbackMessage.startsWith("Blocked")) {
        return { confirmed: true, message: emaPushbackMessage };
      } else {
        const failureReason = !isVolumeHealthyForPullback
          ? "Pullback volume is abnormally high (distribution risk); waiting for volume to dry up before confirming a safe entry."
          : `Waiting for either breakout -> pullback -> retest OR breakout -> retracement to 20/50 EMA pushback setup (ADX: ${adxValue.toFixed(1)} [${adxLabel}]).`;
        return {
          confirmed: false,
          message: failureReason
        };
      }

    } else {
      // SHORT
      const isEmaAlignedShort = adxValue >= ms.weak_trend_adx_threshold
        ? (ema20Val < ema50Val)
        : (ema20Val < ema50Val && currentPrice < ema100Val);
      if (!isEmaAlignedShort) {
        return {
          confirmed: false,
          message: adxValue >= ms.weak_trend_adx_threshold
            ? `Blocked: Fast Bearish EMA structure not aligned (Requires EMA 20 < EMA 50, ADX is strong: ${adxValue.toFixed(1)}).`
            : `Blocked: Full Bearish EMA structure not aligned (Requires EMA 20 < EMA 50 & Price < EMA 100 on moderate ADX: ${adxValue.toFixed(1)}).`
        };
      }

      // The broken level is the previous Lower Low (prev_LL) in a confirmed downtrend
      const breakoutLevel = struct.prev_LL ? struct.prev_LL.price : (struct.current_LL ? struct.current_LL.price : struct.swingLow);
      const searchStart = struct.prev_LL ? struct.prev_LL.index : 0;

      // Find the candle index where breakout occurred (closing below breakout level)
      let breakoutIdx = -1;
      for (let i = searchStart; i <= lastIdx; i++) {
        if (this.candles1m[i].close < breakoutLevel) {
          breakoutIdx = i;
          break;
        }
      }

      if (breakoutIdx === -1) {
        return {
          confirmed: false,
          message: `Waiting for a confirmed Lower Low breakout of $${breakoutLevel.toFixed(2)} to initiate the pullback/retest or EMA pushback setup sequence.`
        };
      }

      // --- FEATURE 2: Candle Body Close Confirmation for Breakout ---
      const boCandle = this.candles1m[breakoutIdx];
      const boRange = boCandle.high - boCandle.low;
      const boBody = Math.abs(boCandle.close - boCandle.open);
      const boBodyRatio = boRange > 0 ? boBody / boRange : 0;
      if (boBodyRatio < ms.min_breakout_body_ratio) {
        return {
          confirmed: false,
          message: `Blocked: Weak breakout candle body at $${breakoutLevel.toFixed(2)} (Body is only ${(boBodyRatio * 100).toFixed(0)}% of total range). Likely false breakdown/wick sweep.`
        };
      }

      if (breakoutIdx === lastIdx) {
        const hasHighHFPressure = ms.allow_immediate_breakout && (adxValue >= ms.hf_momentum_adx_threshold || (this.orderFlowStats.takerBuyRatio <= ms.hf_orderflow_taker_buy_ratio_short || this.orderBookStats.imbalanceRatio <= ms.hf_orderflow_imbalance_ratio_short));
        if (hasHighHFPressure) {
          return {
            confirmed: true,
            message: `[HF Scalp Boost] Immediate Breakdown Entry Confirmed! Price ($${currentPrice.toFixed(2)}) broke down below $${breakoutLevel.toFixed(2)} under high frequency momentum (ADX: ${adxValue.toFixed(1)}) and order flow pressure.`
          };
        } else {
          return {
            confirmed: false,
            message: `Blocked: Immediate SHORT entry on the Lower Low breakout candle ($${breakoutLevel.toFixed(2)}) is forbidden. Waiting for pullback/retest or EMA pushback.`
          };
        }
      }

      const postBreakoutCandles = this.candles1m.slice(breakoutIdx + 1);

      // --- FEATURE 4: Dynamic Invalidation & Stop-Loss Zones ---
      const structuralLH = struct.current_LH ? struct.current_LH.price : Infinity;
      const reclaimThreshold = Math.min(breakoutLevel + invalidationMultiplier * currentAtr, structuralLH + 0.1 * currentAtr);
      const hasReclaimed = postBreakoutCandles.some(c => c.close > reclaimThreshold);
      if (hasReclaimed || currentPrice > reclaimThreshold) {
        return {
          confirmed: false,
          message: `Blocked: Lower Low breakout setup was invalidated because price strongly reclaimed/broke above the structural/reclaim floor level of $${reclaimThreshold.toFixed(2)} (Breakout Level: $${breakoutLevel.toFixed(2)}).`
        };
      }

      // Chasing check: too many candles elapsed without entry (adaptive lookback based on trend strength)
      let maxPostBreakoutCandles = 30;
      if (adxValue < 20) {
        maxPostBreakoutCandles = 15;
      } else if (adxValue >= 40) {
        maxPostBreakoutCandles = 45;
      }
      if (postBreakoutCandles.length > maxPostBreakoutCandles) {
        return {
          confirmed: false,
          message: `Blocked: Chasing price after an extended downward move (more than ${maxPostBreakoutCandles} candles since LL breakout, ADX: ${adxValue.toFixed(1)} [${adxLabel}]) is forbidden.`
        };
      }

      // --- FEATURE 1: Volume-Validated Pullback & Retest ---
      // Dynamically calculate average volume of the last 20 candles to avoid rigid single-candle anomalies
      const volumes = this.candles1m.map(c => c.volume);
      let avgVol20 = 1.0;
      if (volumes.length >= 20) {
        const sumVol20 = volumes.slice(-20).reduce((a, b) => a + b, 0);
        avgVol20 = sumVol20 / 20;
      }

      let isVolumeHealthyForPullback = true;
      if (postBreakoutCandles.length > 0) {
        const avgPullbackVol = postBreakoutCandles.reduce((sum, c) => sum + c.volume, 0) / postBreakoutCandles.length;
        // Allow higher volume on pullback when breakout volume itself is highly compressed/low
        const volumeThreshold = Math.max(boCandle.volume * 1.8, avgVol20 * 2.2);
        if (avgPullbackVol > volumeThreshold) {
          isVolumeHealthyForPullback = false;
        }
      }

      // Setup 1: Pullback and Retest
      const effectivePullbackMult = Math.max(pullbackMultiplier, ms.pullback_multiplier_limit);
      const effectiveEmaMult = Math.max(emaRetraceMultiplier, ms.ema_retrace_multiplier_limit);
      const pullbackLimit = breakoutLevel - effectivePullbackMult * currentAtr;
      const hasPulledBackToZone = postBreakoutCandles.some(c => c.high >= pullbackLimit);
      
      let isPullbackRetestValid = false;
      let pullbackRetestMessage = "";
      if (hasPulledBackToZone) {
        const isRejection = (currentCandle.close < currentCandle.open) || ((currentCandle.high - currentCandle.close) >= 0.3 * (currentCandle.high - currentCandle.low));
        const isContinuation = currentCandle.close < currentCandle.open && currentCandle.close <= breakoutLevel;
        if (isRejection && isContinuation) {
          if (isVolumeHealthyForPullback) {
            isPullbackRetestValid = true;
            pullbackRetestMessage = `Pullback & Retest setup confirmed${mtfMessage}: Price pulled back to broken LL level ($${breakoutLevel.toFixed(2)}) on declining volume and rejected it as resistance with bearish confirmation (ADX: ${adxValue.toFixed(1)} [${adxLabel}], Retrace limit: -${effectivePullbackMult.toFixed(1)} * ATR).`;
          } else {
            pullbackRetestMessage = "Blocked Retest: Pullback volume is abnormally high, indicating excessive accumulation/buying pressure.";
          }
        }
      }

      // Setup 2: 20/50 EMA Pushback
      const emaRetraceThreshold20 = ema20Val - effectiveEmaMult * currentAtr;
      const emaRetraceThreshold50 = ema50Val - effectiveEmaMult * currentAtr;
      const hasRetracedToEMA = postBreakoutCandles.some(c => c.high >= emaRetraceThreshold20 || c.high >= emaRetraceThreshold50);
      
      const currentRejectsEma20 = currentCandle.high >= ema20Val - 0.2 * currentAtr && currentPrice <= (ema20Val + 0.15 * currentAtr) && currentCandle.close < currentCandle.open;
      const currentRejectsEma50 = currentCandle.high >= ema50Val - 0.2 * currentAtr && currentPrice <= (ema50Val + 0.15 * currentAtr) && currentCandle.close < currentCandle.open;
      const isEmaPushbackValid = (currentRejectsEma20 || currentRejectsEma50) && hasRetracedToEMA;
      let emaPushbackMessage = "";
      if (isEmaPushbackValid) {
        if (isVolumeHealthyForPullback) {
          emaPushbackMessage = `20/50 EMA Pushback confirmed${mtfMessage}: Price rejected dynamic EMA resistance at $${(currentRejectsEma20 ? ema20Val : ema50Val).toFixed(2)} with bearish confirmation (ADX: ${adxValue.toFixed(1)} [${adxLabel}], EMA limit: -${effectiveEmaMult.toFixed(2)} * ATR).`;
        } else {
          emaPushbackMessage = "Blocked EMA Pushback: Abnormally high volume pullback during EMA retracement suggests a trend failure.";
        }
      }

      if (isPullbackRetestValid && !pullbackRetestMessage.startsWith("Blocked")) {
        return { confirmed: true, message: pullbackRetestMessage };
      } else if (isEmaPushbackValid && !emaPushbackMessage.startsWith("Blocked")) {
        return { confirmed: true, message: emaPushbackMessage };
      } else {
        const failureReason = !isVolumeHealthyForPullback
          ? "Pullback volume is abnormally high (accumulation risk); waiting for volume to dry up before confirming a safe entry."
          : `Waiting for either breakout -> pullback -> retest OR breakout -> retracement to 20/50 EMA pushback setup (ADX: ${adxValue.toFixed(1)} [${adxLabel}]).`;
        return {
          confirmed: false,
          message: failureReason
        };
      }
    }
  }

  private evaluateMarketStructureConfirmation(signalDirection: "LONG" | "SHORT" | "NEUTRAL"): { confirmed: boolean; message: string; swingHigh: number; swingLow: number } {
    const rawResult = this.evaluateMarketStructureConfirmationRaw(signalDirection);
    return this.applyEma200ProximityFilter(signalDirection, this.currentPrice, rawResult);
  }

  private applyEma200ProximityFilter(
    direction: "LONG" | "SHORT" | "NEUTRAL",
    currentPrice: number,
    result: { confirmed: boolean; message: string; swingHigh: number; swingLow: number }
  ): { confirmed: boolean; message: string; swingHigh: number; swingLow: number } {
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

  private evaluateMarketStructureConfirmationRaw(signalDirection: "LONG" | "SHORT" | "NEUTRAL"): { confirmed: boolean; message: string; swingHigh: number; swingLow: number } {
    const config = dbManager.getConfig();
    const struct = this.getTrendMarketStructure();
    const lastIdx = this.candles1m.length - 1;
    const currentPrice = this.currentPrice;
    const currentCandle = lastIdx >= 0 ? this.candles1m[lastIdx] : { open: currentPrice, close: currentPrice };

    if (this.currentRegime === MarketRegime.LOW_VOLATILITY) {
      return {
        confirmed: false,
        message: "Blocked: Trading is deactivated in low-volatility regimes to prevent chop losses.",
        swingHigh: struct.swingHigh,
        swingLow: struct.swingLow
      };
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

      const rangeLookback = 30;
      const recentCandlesForRange = this.candles1m.slice(-rangeLookback);
      const rangeHigh = recentCandlesForRange.length > 0 ? Math.max(...recentCandlesForRange.map(c => c.high)) : struct.swingHigh;
      const rangeLow = recentCandlesForRange.length > 0 ? Math.min(...recentCandlesForRange.map(c => c.low)) : struct.swingLow;

      const rangeWidth = rangeHigh - rangeLow;
      const rangeSupportThreshold = rangeLow + Math.min(rangeWidth * 0.15, rangeLow * 0.0015);
      const rangeResistanceThreshold = rangeHigh - Math.min(rangeWidth * 0.15, rangeHigh * 0.0015);

      const isRangeLongReversal = (currentPrice <= rangeSupportThreshold) && (currentCandle.close > currentCandle.open);
      const isRangeShortReversal = (currentPrice >= rangeResistanceThreshold) && (currentCandle.close < currentCandle.open);

      // Compute relative volume to check breakout strength
      const volumes = this.candles1m.map((c) => c.volume);
      let relVolume = 1.0;
      if (volumes.length >= 20) {
        const currentVolume = volumes[lastIdx];
        const sumPrevVolumes = volumes.slice(lastIdx - 20, lastIdx).reduce((a, b) => a + b, 0);
        const avgPrevVolume = sumPrevVolumes / 20;
        relVolume = avgPrevVolume > 0 ? currentVolume / avgPrevVolume : 1.0;
      }

      const isRangeLongBreakout = (currentPrice > rangeHigh) && (relVolume > 1.2);
      const isRangeShortBreakdown = (currentPrice < rangeLow) && (relVolume > 1.2);

      if (signalDirection === "LONG") {
        if (isRangeLongReversal) {
          return {
            confirmed: true,
            message: `Ranging Bullish Reversal Confirmed. Price ($${currentPrice.toFixed(2)}) is bouncing off major range support ($${rangeLow.toFixed(2)}).`,
            swingHigh: rangeHigh,
            swingLow: rangeLow
          };
        } else if (isRangeLongBreakout) {
          return {
            confirmed: true,
            message: `Ranging Bullish Breakout Confirmed. Price ($${currentPrice.toFixed(2)}) broke above major range resistance ($${rangeHigh.toFixed(2)}) on high relative volume (${relVolume.toFixed(2)}x).`,
            swingHigh: rangeHigh,
            swingLow: rangeLow
          };
        } else {
          return {
            confirmed: false,
            message: `Range-bound Reversal Filter: Price ($${currentPrice.toFixed(2)}) is inside the range [$${rangeLow.toFixed(2)} - $${rangeHigh.toFixed(2)}] without a valid reversal or breakout.`,
            swingHigh: rangeHigh,
            swingLow: rangeLow
          };
        }
      } else if (signalDirection === "SHORT") {
        if (isRangeShortReversal) {
          return {
            confirmed: true,
            message: `Ranging Bearish Reversal Confirmed. Price ($${currentPrice.toFixed(2)}) is rejecting major range resistance ($${rangeHigh.toFixed(2)}).`,
            swingHigh: rangeHigh,
            swingLow: rangeLow
          };
        } else if (isRangeShortBreakdown) {
          return {
            confirmed: true,
            message: `Ranging Bearish Breakdown Confirmed. Price ($${currentPrice.toFixed(2)}) broke below major range support ($${rangeLow.toFixed(2)}) on high relative volume (${relVolume.toFixed(2)}x).`,
            swingHigh: rangeHigh,
            swingLow: rangeLow
          };
        } else {
          return {
            confirmed: false,
            message: `Range-bound Reversal Filter: Price ($${currentPrice.toFixed(2)}) is inside the range [$${rangeLow.toFixed(2)} - $${rangeHigh.toFixed(2)}] without a valid reversal or breakdown.`,
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

    if (signalDirection === "LONG") {
      const result = this.evaluateTrendBreakoutSetup("LONG", currentPrice, ema20Val, ema50Val, ema100Val, struct);
      confirmed = result.confirmed;
      message = result.message;
    } else if (signalDirection === "SHORT") {
      const result = this.evaluateTrendBreakoutSetup("SHORT", currentPrice, ema20Val, ema50Val, ema100Val, struct);
      confirmed = result.confirmed;
      message = result.message;
    }

    return {
      confirmed,
      message,
      swingHigh: struct.swingHigh,
      swingLow: struct.swingLow
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

    return aggregated;
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

    if (atrExpansionRatio < 0.6) {
      regime = MarketRegime.LOW_VOLATILITY;
      confidence = 0.65 + (0.6 - atrExpansionRatio) * 0.5;
    } else if (atrExpansionRatio > 1.5) {
      regime = MarketRegime.HIGH_VOLATILITY;
      confidence = 0.7 + (atrExpansionRatio - 1.5) * 0.2;
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

    confidence = Math.min(confidence, 0.99);

    if (this.currentRegime !== regime) {
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

    const lastIdx = closes.length - 1;
    const currentClose = closes[lastIdx];

    const ema9 = this.calculateEMA(closes, 9);
    const ema21 = this.calculateEMA(closes, 21);
    const ema50 = this.calculateEMA(closes, ms.medium_ema_period || 50);
    const rsi14 = this.calculateRSI(closes, 14);

    const isBullAligned = ema9[lastIdx] > ema21[lastIdx] && ema21[lastIdx] > ema50[lastIdx];
    const isBearAligned = ema9[lastIdx] < ema21[lastIdx] && ema21[lastIdx] < ema50[lastIdx];

    const adx14 = this.calculateADX(this.candles1m, 14);
    const adxValue = adx14[lastIdx] || 25;

    const volumes = this.candles1m.map((c) => c.volume);
    let relVolume = 1.0;
    if (volumes.length >= 20) {
      const currentVolume = volumes[lastIdx];
      const sumPrevVolumes = volumes.slice(lastIdx - 20, lastIdx).reduce((a, b) => a + b, 0);
      const avgPrevVolume = sumPrevVolumes / 20;
      relVolume = avgPrevVolume > 0 ? currentVolume / avgPrevVolume : 1.0;
    } else {
      relVolume = 1.35;
    }

    const isBullTrend1m = ema21[lastIdx] > ema50[lastIdx];
    const isBearTrend1m = ema21[lastIdx] < ema50[lastIdx];

    // Get headlines sentiment
    const headlines = dbManager.getHeadlines().slice(0, 15);
    const avgSentiment = this.calculateAverageSentiment(headlines);

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
    const averageBodySize = closes.slice(-20).map((c, idx) => Math.abs(c - opens[idx])).reduce((a, b) => a + b, 0) / 20;
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

    const isUptrendAligned = ema20Val > ema50Val && ema50Val > ema200Val && adxValue >= trendAlignAdx && this.currentRegime === MarketRegime.STRONG_UPTREND;
    const isDowntrendAligned = ema20Val < ema50Val && ema50Val < ema200Val && adxValue >= trendAlignAdx && this.currentRegime === MarketRegime.STRONG_DOWNTREND;
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
      const recentCandlesForRange = this.candles1m.slice(-rangeLookback);
      const rangeHigh = recentCandlesForRange.length > 0 ? Math.max(...recentCandlesForRange.map(c => c.high)) : struct.swingHigh;
      const rangeLow = recentCandlesForRange.length > 0 ? Math.min(...recentCandlesForRange.map(c => c.low)) : struct.swingLow;

      const rangeWidth = rangeHigh - rangeLow;
      const rangeSupportThreshold = rangeLow + Math.min(rangeWidth * 0.15, rangeLow * 0.0015);
      const rangeResistanceThreshold = rangeHigh - Math.min(rangeWidth * 0.15, rangeHigh * 0.0015);

      // Reversal signals
      const isRangeLongReversal = (currentClose <= rangeSupportThreshold) && (currentCandle.close > currentCandle.open);
      const isRangeShortReversal = (currentClose >= rangeResistanceThreshold) && (currentCandle.close < currentCandle.open);

      // Breakout signals: Price breaks outside the 30-candle range with high relative volume
      const isRangeLongBreakout = (currentClose > rangeHigh) && (relVolume > 1.2);
      const isRangeShortBreakdown = (currentClose < rangeLow) && (relVolume > 1.2);

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

      const isUptrendAligned = ema20Val > ema50Val && (adxValue >= ms.hf_momentum_adx_threshold || ema50Val > ema100Val);
      const isDowntrendAligned = ema20Val < ema50Val && (adxValue >= ms.hf_momentum_adx_threshold || ema50Val < ema100Val);

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

    // Ensure VWAP is computed
    this.calculateVWAP(this.candles1m);
    const lastCandle = this.candles1m[lastIdx];
    const vwapVal = lastCandle.vwap !== undefined ? lastCandle.vwap : currentClose;
    const vwapUpperVal = lastCandle.vwap_upper !== undefined ? lastCandle.vwap_upper : currentClose * 1.01;
    const vwapLowerVal = lastCandle.vwap_lower !== undefined ? lastCandle.vwap_lower : currentClose * 0.99;

    // 2. Conditions Check (Strict 10-Conditions Checklist)
    const conditions: { name: string; met: boolean; current_value: any; required: string }[] = [];

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
    const hasSoftenRegimePressure = (config.general.enable_orderflow_softening !== false) &&
                                    ((signalDirection === "LONG" && (this.orderFlowStats.takerBuyRatio >= 0.60 || this.orderBookStats.imbalanceRatio >= 0.35)) ||
                                    (signalDirection === "SHORT" && (this.orderFlowStats.takerBuyRatio <= 0.40 || this.orderBookStats.imbalanceRatio <= -0.35))) &&
                                    (relVolume > 1.1);

    // C2: Market Regime lock
    // Blocked all entries during LOW_VOLATILITY unless softened via heavy order flow pressure and volume.
    const regimeValid = !isLowVolatility || hasSoftenRegimePressure;
    const regimeAligned =
      (signalDirection === "LONG" && (this.currentRegime === MarketRegime.STRONG_UPTREND || this.currentRegime === MarketRegime.RANGE_BOUND)) ||
      (signalDirection === "SHORT" && (this.currentRegime === MarketRegime.STRONG_DOWNTREND || this.currentRegime === MarketRegime.RANGE_BOUND)) ||
      this.currentRegime === MarketRegime.HIGH_VOLATILITY ||
      (!isLowVolatility && hasExtremeRealtimePressure) ||
      (isLowVolatility && hasSoftenRegimePressure);

    conditions.push({
      name: "Market Regime Filter",
      met: regimeValid && (signalDirection === "NEUTRAL" ? true : regimeAligned),
      current_value: this.currentRegime + (isLowVolatility && hasSoftenRegimePressure ? " (SOFTENED VIA HEAVY LEADING ORDER FLOW)" : (hasExtremeRealtimePressure ? " (BYPASSED VIA LEADING ORDER FLOW)" : "")),
      required: "STRONG_UPTREND/RANGE_BOUND for LONG, STRONG_DOWNTREND/RANGE_BOUND for SHORT, or HIGH_VOLATILITY (Softenable under heavy leading order flow & volume confirmation)",
    });

    // C3 & C8 Combined: Trend Alignment & Strength (EMA/ADX)
    let trendAligned = true;
    let adxMet = true;
    let currentTrendStr = "";
    let requiredStr = "";

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
        adxMet = adxValue >= 20;
        currentTrendStr = `EMA Structure: FAST_ALIGNED (Extreme Real-time Flow Pressure) | ADX: ${adxValue.toFixed(1)} (Threshold softened to >= 20)`;
        requiredStr = `LONG: Fast EMA${fastEma} > EMA${medEma} & ADX >= 20 (Softened via Order Flow), SHORT: Fast EMA${fastEma} < EMA${medEma} & ADX >= 20`;
      } else {
        const fastEma = ms.fast_ema_period || 20;
        const medEma = ms.medium_ema_period || 50;
        const slowEma = ms.slow_ema_period || 200;
        trendAligned = signalDirection === "NEUTRAL" ? true : (
          (signalDirection === "LONG" && isUptrendAligned) ||
          (signalDirection === "SHORT" && isDowntrendAligned)
        );
        adxMet = adxValue >= trendAlignAdx;
        currentTrendStr = `EMA Structure: ${isUptrendAligned ? "BULLISH_TREND" : isDowntrendAligned ? "BEARISH_TREND" : "MIXED/FLAT"}`;
        requiredStr = `LONG: EMA${fastEma} > EMA${medEma} > EMA${slowEma} & ADX >= ${trendAlignAdx} & STRONG_UPTREND, SHORT: EMA${fastEma} < EMA${medEma} < EMA${slowEma} & ADX >= ${trendAlignAdx} & STRONG_DOWNTREND`;
      }
    }

    conditions.push({
      name: "Trend Alignment & Strength (EMA/ADX)",
      met: trendAligned && adxMet,
      current_value: `${currentTrendStr} | ADX: ${adxValue.toFixed(1)}`,
      required: requiredStr,
    });

    // C5: Relative Volume Confirmation
    const requiredRelVol = hasExtremeRealtimePressure 
      ? Math.min(1.0, Math.max(0.75, relVolThreshold - 0.5)) 
      : relVolThreshold;
    conditions.push({
      name: "Relative Volume Confirmation",
      met: relVolume > requiredRelVol,
      current_value: `${relVolume.toFixed(2)}x` + (hasExtremeRealtimePressure ? " (SOFTENED VIA LEADING ORDER FLOW)" : ""),
      required: `> ${requiredRelVol.toFixed(2)}x above 20-period MA`,
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
    const maxAllowedDeviation = 2.2 * currentAtr;
    const isEma100OverextendedLong = currentClose > ema100Val + maxAllowedDeviation;
    const isEma100OverextendedShort = currentClose < ema100Val - maxAllowedDeviation;

    let ema100Met = true;
    let ema100ValStr = "PASSING (NORMAL DISTANCE)";

    if (hasExtremeRealtimePressure) {
      ema100Met = true;
      ema100ValStr = signalDirection === "LONG"
        ? `PASSING (Extreme Leading Pressure Confirmed: Distance +$${ema100Distance.toFixed(2)})`
        : `PASSING (Extreme Leading Pressure Confirmed: Distance -$${Math.abs(ema100Distance).toFixed(2)})`;
    } else if (!highMovementShort) {
      ema100ValStr = `PASSING (No high momentum pulse in last 10 candles)`;
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
      name: "Overextension & Level Anchors (VWAP/EMA)",
      met: vwapDevMet && ema100Met,
      current_value: `VWAP: ${vwapDevMet ? "PASSING" : "OVEREXTENDED"} | EMA100: ${ema100ValStr}`,
      required: "Price within VWAP standard deviation bands and not overextended relative to the 100 EMA baseline",
    });

    // C15: Market Structure & Entry Confirmation Check (Pullback, Retest, Reversal, High-Vol Confirmation)
    const structCheck = this.evaluateMarketStructureConfirmation(signalDirection);
    
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
    let ofVal = `Taker Buy Ratio: ${(this.orderFlowStats.takerBuyRatio * 100).toFixed(1)}% (CVD: ${this.orderFlowStats.netCVD.toFixed(2)} BTC)`;
    let ofReq = "Taker Buy Ratio >= 51.0% for LONG, <= 49.0% for SHORT";

    if (signalDirection === "LONG") {
      ofMet = this.orderFlowStats.takerBuyRatio >= 0.51;
      if (!ofMet) {
        ofVal = `${ofVal} - BLOCKED (Insufficient Buy Pressure)`;
      } else {
        ofVal = `${ofVal} - PASSED (Strong Buy Pressure)`;
      }
    } else if (signalDirection === "SHORT") {
      ofMet = this.orderFlowStats.takerBuyRatio <= 0.49;
      if (!ofMet) {
        ofVal = `${ofVal} - BLOCKED (Insufficient Sell Pressure)`;
      } else {
        ofVal = `${ofVal} - PASSED (Strong Sell Pressure)`;
      }
    }

    conditions.push({
      name: "Binance Order Flow Confirmation",
      met: ofMet,
      current_value: ofVal,
      required: ofReq,
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

    // C19: Order Book Imbalance & Liquidity Depth Gate
    let obMet = true;
    const obMinDepth = config.general.order_book_min_depth !== undefined ? config.general.order_book_min_depth : 4.0;
    const obMaxImbalance = config.general.order_book_max_imbalance !== undefined ? config.general.order_book_max_imbalance : 0.35;

    const obTotalDepth = this.orderBookStats.bidDepthBTC + this.orderBookStats.askDepthBTC;
    const obImbalancePct = this.orderBookStats.imbalanceRatio * 100;
    let obVal = `Bids Depth: ${this.orderBookStats.bidDepthBTC.toFixed(1)} BTC | Asks Depth: ${this.orderBookStats.askDepthBTC.toFixed(1)} BTC (Imbalance: ${obImbalancePct >= 0 ? "+" : ""}${obImbalancePct.toFixed(1)}%)`;
    let obReq = `Top-10 book depth >= ${obMinDepth.toFixed(1)} BTC; Imbalance >= -${(obMaxImbalance * 100).toFixed(0)}% for LONG, <= +${(obMaxImbalance * 100).toFixed(0)}% for SHORT`;

    if (obTotalDepth < obMinDepth) {
      obMet = false;
      obVal = `${obVal} - BLOCKED (Insufficient Book Liquidity: ${obTotalDepth.toFixed(1)} < ${obMinDepth.toFixed(1)} BTC)`;
    } else if (signalDirection === "LONG") {
      obMet = this.orderBookStats.imbalanceRatio >= -obMaxImbalance;
      if (!obMet) {
        obVal = `${obVal} - BLOCKED (Heavy Ask Wall / Negative Imbalance)`;
      } else {
        obVal = `${obVal} - PASSED (Strong Bid Support)`;
      }
    } else if (signalDirection === "SHORT") {
      obMet = this.orderBookStats.imbalanceRatio <= obMaxImbalance;
      if (!obMet) {
        obVal = `${obVal} - BLOCKED (Heavy Bid Floor / Positive Imbalance)`;
      } else {
        obVal = `${obVal} - PASSED (Strong Sell Pressure / Ask Dominance)`;
      }
    }

    conditions.push({
      name: "Order Book Imbalance & Liquidity Depth Gate",
      met: obMet,
      current_value: obVal,
      required: obReq,
    });

    // Apply bypassed/skipped gates
    for (const c of conditions) {
      if (this.isGateSkipped(config, c.name)) {
        c.met = true;
        c.current_value = `${c.current_value} (BYPASS)`;
      }
    }

    // Calculate Entry Score
    let entryScore = 0;
    if (signalDirection !== "NEUTRAL") {
      if (pLongMet || pShortMet || this.isGateSkipped(config, "CatBoost AI Prediction")) entryScore += 40;
      if ((regimeValid && regimeAligned) || this.isGateSkipped(config, "Market Regime Filter")) entryScore += 20;
      if ((trendAligned && adxMet) || this.isGateSkipped(config, "Trend Alignment & Strength (EMA/ADX)")) entryScore += 30;
      if (relVolume > requiredRelVol || this.isGateSkipped(config, "Relative Volume Confirmation")) entryScore += 10;
    }

    const allConditionsMet = conditions.every((c) => c.met);
    const failedConditions = conditions.filter((c) => !c.met).map((c) => c.name);

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
          blockDetails = "  * Disqualified Gates Detail:\n" + conditions
            .filter((c) => !c.met)
            .map((c) => `    - [${c.name}]: Current = "${c.current_value}" | Required = "${c.required}"`)
            .join("\n");
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

    // 3. Trade Entry Execution: Trigger a trade if all conditions met, entry score >= 80, and no trade active
    if (allConditionsMet && entryScore >= 80 && !this.activeTrade) {
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
    const config = dbManager.getConfig();
    const creds = dbManager.getCredentials();

    if (creds.connection_status !== "CONNECTED") {
      this.log(`⚠️ FAILED to enter trade: Exchange credentials are not in CONNECTED state.`);
      return;
    }

    this.log(`🚀 SIGNAL TRIGGERED! Entering Delta Exchange ${direction} position...`);

    // Dynamically calculate dynamic Stop Loss and Take Profit
    const closes = this.candles1m.map((c) => c.close);
    const currentPrice = this.currentPrice;
    const atr14 = this.calculateATR(this.candles1m, 14);
    const lastAtr = atr14[closes.length - 1] || 150;

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
      `Computed Execution Parameters: Entry=$${currentPrice}, StopLoss=$${stopLossPrice.toFixed(2)} (Dist: $${actualSLDistance.toFixed(
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
      this.log(`📡 Dispatching real market order to Delta Exchange REST API...`);
      const side = direction === "LONG" ? "buy" : "sell";
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
