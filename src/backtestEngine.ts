/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Trade,
  Candlestick,
  StrategyConfig,
  TradeDirection,
  ExitReason,
  MarketRegime,
  NewsSource,
} from "./types.js";

interface BacktestSummary {
  total_trades: number;
  wins: number;
  losses: number;
  win_rate: number;
  profit_factor: number;
  net_profit_usdt: number;
  fees_paid_usdt: number;
  max_drawdown_usdt: number;
  sharpe_ratio: number;
  starting_balance: number;
  ending_balance: number;
}

interface BacktestResult {
  summary: BacktestSummary;
  trades: Trade[];
  equityCurve: { time: string; balance: number }[];
  logs: string[];
}

/**
 * High-fidelity backtesting engine that simulates trading rules
 * and checkpoints of the Delta Exchange AI Scalper.
 */
export class BacktestEngine {
  /**
   * Generates realistic synthetic 1-minute candlesticks with indicators matching the requested regime.
   */
  public static generateHistoricalCandles(
    periodDays: number,
    regimeType: string,
    startPrice = 101500
  ): { candles: Candlestick[]; features: Record<string, any>[] } {
    const candlesCount = periodDays * 24 * 60; // 1440 candles per day
    const candles: Candlestick[] = [];
    const features: Record<string, any>[] = [];

    let price = startPrice;
    let trendFactor = 0; // Cumulative price movement direction
    let baseRegime: MarketRegime = MarketRegime.RANGE_BOUND;

    if (regimeType === "STRONG_UPTREND") {
      trendFactor = 1.2;
      baseRegime = MarketRegime.STRONG_UPTREND;
    } else if (regimeType === "STRONG_DOWNTREND") {
      trendFactor = -1.2;
      baseRegime = MarketRegime.STRONG_DOWNTREND;
    } else if (regimeType === "HIGH_VOLATILITY") {
      trendFactor = 0;
      baseRegime = MarketRegime.HIGH_VOLATILITY;
    } else if (regimeType === "LOW_VOLATILITY") {
      trendFactor = 0;
      baseRegime = MarketRegime.LOW_VOLATILITY;
    }

    const baseTime = Math.floor(Date.now() / 1000) - candlesCount * 60;

    for (let i = 0; i < candlesCount; i++) {
      const time = baseTime + i * 60;

      // Dynamic regime shift occasionally to make "MIXED" or long periods realistic
      let activeRegime = baseRegime;
      if (regimeType === "MIXED") {
        const cycle = Math.floor(i / 1440) % 5; // changes daily
        if (cycle === 0) {
          activeRegime = MarketRegime.STRONG_UPTREND;
          trendFactor = 1.4;
        } else if (cycle === 1) {
          activeRegime = MarketRegime.RANGE_BOUND;
          trendFactor = 0;
        } else if (cycle === 2) {
          activeRegime = MarketRegime.STRONG_DOWNTREND;
          trendFactor = -1.4;
        } else if (cycle === 3) {
          activeRegime = MarketRegime.HIGH_VOLATILITY;
          trendFactor = 0.3;
        } else {
          activeRegime = MarketRegime.LOW_VOLATILITY;
          trendFactor = -0.1;
        }
      }

      // Volatility based on regime
      let volatility = 30; // standard deviation in USD
      if (activeRegime === MarketRegime.HIGH_VOLATILITY) {
        volatility = 80;
      } else if (activeRegime === MarketRegime.LOW_VOLATILITY) {
        volatility = 12;
      } else if (activeRegime === MarketRegime.STRONG_UPTREND || activeRegime === MarketRegime.STRONG_DOWNTREND) {
        volatility = 45;
      }

      // Trend bias + random walk noise
      const drift = trendFactor * (3 + Math.random() * 5);
      const randomNoise = (Math.random() - 0.5) * volatility * 2;
      const change = drift + randomNoise;

      const open = price;
      const close = price + change;
      const high = Math.max(open, close) + Math.random() * (volatility * 0.6);
      const low = Math.min(open, close) - Math.random() * (volatility * 0.6);
      const volume = (volatility * 10) + Math.random() * (volatility * 50);

      price = close;

      const candle: Candlestick = {
        time,
        open: Number(open.toFixed(2)),
        high: Number(high.toFixed(2)),
        low: Number(low.toFixed(2)),
        close: Number(close.toFixed(2)),
        volume: Number(volume.toFixed(1)),
      };
      candles.push(candle);

      // Generate related indicator indicators in features object
      // Imbalance, AI score, News Sentiment
      const baseProb = activeRegime === MarketRegime.STRONG_UPTREND
        ? 0.72 + Math.random() * 0.18
        : activeRegime === MarketRegime.STRONG_DOWNTREND
        ? 0.12 + Math.random() * 0.18
        : 0.45 + Math.random() * 0.1;

      const obImbalance = activeRegime === MarketRegime.STRONG_UPTREND
        ? 0.15 + Math.random() * 0.45
        : activeRegime === MarketRegime.STRONG_DOWNTREND
        ? -0.45 - Math.random() * 0.15
        : (Math.random() - 0.5) * 0.3;

      const sentiment = activeRegime === MarketRegime.STRONG_UPTREND
        ? 0.2 + Math.random() * 0.5
        : activeRegime === MarketRegime.STRONG_DOWNTREND
        ? -0.5 - Math.random() * 0.2
        : (Math.random() - 0.5) * 0.2;

      const relVol = 0.5 + Math.random() * 2.0;

      features.push({
        catboost_probability: Number(baseProb.toFixed(3)),
        orderbook_imbalance: Number(obImbalance.toFixed(2)),
        sentiment_score: Number(sentiment.toFixed(2)),
        sentiment_momentum: Number(((sentiment * 0.2) + (Math.random() - 0.5) * 0.1).toFixed(2)),
        relative_volume: Number(relVol.toFixed(2)),
        adx_value: activeRegime === MarketRegime.STRONG_UPTREND || activeRegime === MarketRegime.STRONG_DOWNTREND
          ? 25 + Math.random() * 25
          : 10 + Math.random() * 12,
        regime: activeRegime,
      });
    }

    return { candles, features };
  }

  /**
   * Helper function to calculate Exponential Moving Averages over the generated series
   */
  private static calculateEMASeries(closes: number[], period: number): number[] {
    const ema: number[] = [];
    if (closes.length === 0) return ema;
    const k = 2 / (period + 1);
    let sum = 0;
    const initialPeriod = Math.min(closes.length, period);
    for (let i = 0; i < initialPeriod; i++) {
      sum += closes[i];
    }
    ema[initialPeriod - 1] = sum / initialPeriod;
    for (let i = initialPeriod; i < closes.length; i++) {
      ema[i] = closes[i] * k + ema[i - 1] * (1 - k);
    }
    // Fill in earlier values
    for (let i = 0; i < initialPeriod - 1; i++) {
      ema[i] = closes[i];
    }
    return ema;
  }

  /**
   * Helper function to calculate ATR over the generated series
   */
  private static calculateATRSeries(candles: Candlestick[], period = 14): number[] {
    const atr: number[] = [];
    if (candles.length === 0) return atr;

    const tr: number[] = [candles[0].high - candles[0].low];
    for (let i = 1; i < candles.length; i++) {
      const h_l = candles[i].high - candles[i].low;
      const h_pc = Math.abs(candles[i].high - candles[i - 1].close);
      const l_pc = Math.abs(candles[i].low - candles[i - 1].close);
      tr.push(Math.max(h_l, h_pc, l_pc));
    }

    let sum = 0;
    const initialPeriod = Math.min(candles.length, period);
    for (let i = 0; i < initialPeriod; i++) {
      sum += tr[i];
    }
    atr[initialPeriod - 1] = sum / initialPeriod;

    for (let i = initialPeriod; i < candles.length; i++) {
      atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;
    }

    for (let i = 0; i < initialPeriod - 1; i++) {
      atr[i] = tr[i] || 50;
    }
    return atr;
  }

  /**
   * Run the backtest using strategy rules.
   */
  public static run(
    config: StrategyConfig,
    periodDays: number,
    regimeType: string,
    startingBalance = 100000
  ): BacktestResult {
    const logs: string[] = [];
    const dateStr = new Date().toISOString().split("T")[0];
    logs.push(`[BACKTEST] Starting backtest simulation for ${periodDays} days in ${regimeType} regime...`);
    logs.push(`[BACKTEST] Starting Capital: $${startingBalance.toFixed(2)} USDT. Maker Fee: 0.02%, Taker Fee: 0.05%`);

    const { candles, features } = this.generateHistoricalCandles(periodDays, regimeType);
    const closes = candles.map((c) => c.close);

    // Compute indicators pre-emptively for speed
    const ema20 = this.calculateEMASeries(closes, 20);
    const ema50 = this.calculateEMASeries(closes, 50);
    const ema100 = this.calculateEMASeries(closes, 100);
    const ema200 = this.calculateEMASeries(closes, 200);
    const atr14 = this.calculateATRSeries(candles, 14);

    let portfolioBalance = startingBalance;
    const completedTrades: Trade[] = [];
    const equityCurve: { time: string; balance: number }[] = [];

    // Push initial balance to curve
    if (candles.length > 0) {
      const firstDate = new Date(candles[0].time * 1000).toISOString().replace("T", " ").slice(0, 16);
      equityCurve.push({ time: firstDate, balance: portfolioBalance });
    }

    interface ActivePosition {
      direction: TradeDirection;
      entryPrice: number;
      entryTime: number;
      quantity: number;
      leverage: number;
      stopLoss: number;
      takeProfit: number;
      maxPriceReached: number;
      minPriceReached: number;
      catboostProbability: number;
      regime: MarketRegime;
      sentiment: number;
      signalScore: number;
      initialStopLossDistance: number;
    }

    let activePos: ActivePosition | null = null;
    let consecutiveLosses = 0;
    let cooldownUntilIdx = -1;
    let lastTradeDay = "";
    let tradesToday = 0;

    // Minimum warmup index (we need enough lookback for indicators like EMA 200)
    const startIdx = Math.min(200, candles.length);

    for (let i = startIdx; i < candles.length; i++) {
      const candle = candles[i];
      const feat = features[i];
      const curPrice = candle.close;
      const curTimeStr = new Date(candle.time * 1000).toISOString().replace("T", " ").slice(0, 16);
      const curDateStr = curTimeStr.split(" ")[0];

      // Reset daily trade counters
      if (curDateStr !== lastTradeDay) {
        lastTradeDay = curDateStr;
        tradesToday = 0;
      }

      // Check active position
      if (activePos) {
        const entryAgeSeconds = candle.time - activePos.entryTime;

        // Track excursions
        if (activePos.direction === TradeDirection.LONG) {
          activePos.maxPriceReached = Math.max(activePos.maxPriceReached, candle.high);
          activePos.minPriceReached = Math.min(activePos.minPriceReached, candle.low);
        } else {
          activePos.maxPriceReached = Math.min(activePos.maxPriceReached, candle.low);
          activePos.minPriceReached = Math.max(activePos.minPriceReached, candle.high);
        }

        // Apply dynamic Trailing Stop Loss if enabled
        if (config.risk_management?.trailing_stop_loss_enabled) {
          const currentAtr = atr14[i] || 50;
          const slDistance = (config.risk_management.trailing_stop_loss_distance_atr || 1.3) * currentAtr;
          const activationThresholdRatio = config.risk_management.trailing_stop_loss_activation_ratio || 1.2;

          if (activePos.direction === TradeDirection.LONG) {
            const currentGain = activePos.maxPriceReached - activePos.entryPrice;
            const threshold = activePos.initialStopLossDistance * activationThresholdRatio;
            if (currentGain >= threshold) {
              const proposedSL = activePos.maxPriceReached - slDistance;
              if (proposedSL > activePos.stopLoss) {
                activePos.stopLoss = proposedSL;
              }
            }
          } else {
            const currentGain = activePos.entryPrice - activePos.maxPriceReached; // min price reached
            const threshold = activePos.initialStopLossDistance * activationThresholdRatio;
            if (currentGain >= threshold) {
              const proposedSL = activePos.maxPriceReached + slDistance;
              if (proposedSL < activePos.stopLoss) {
                activePos.stopLoss = proposedSL;
              }
            }
          }
        }

        // Check Exit Conditions
        let hitExit = false;
        let exitPrice = curPrice;
        let exitReason: ExitReason = ExitReason.MANUAL_EXIT;

        if (activePos.direction === TradeDirection.LONG) {
          if (candle.low <= activePos.stopLoss) {
            hitExit = true;
            exitPrice = activePos.stopLoss;
            exitReason = ExitReason.STOP_LOSS;
          } else if (candle.high >= activePos.takeProfit) {
            hitExit = true;
            exitPrice = activePos.takeProfit;
            exitReason = ExitReason.TAKE_PROFIT;
          } else if (entryAgeSeconds >= 29 * 60 && config.risk_management?.delta_scalper_offer_enabled) {
            // Under free close leg, close close to 29.5 minutes to maximize benefit if enabled
            hitExit = true;
            exitPrice = curPrice;
            exitReason = ExitReason.TIME_LIMIT_29MIN;
          } else if (feat.sentiment_score <= -(config.sentiment_settings?.entry_threshold_long || 0.25)) {
            // Sentiment reversal
            hitExit = true;
            exitPrice = curPrice;
            exitReason = ExitReason.SENTIMENT_REVERSAL;
          }
        } else {
          // SHORT pos exits
          if (candle.high >= activePos.stopLoss) {
            hitExit = true;
            exitPrice = activePos.stopLoss;
            exitReason = ExitReason.STOP_LOSS;
          } else if (candle.low <= activePos.takeProfit) {
            hitExit = true;
            exitPrice = activePos.takeProfit;
            exitReason = ExitReason.TAKE_PROFIT;
          } else if (entryAgeSeconds >= 29 * 60 && config.risk_management?.delta_scalper_offer_enabled) {
            hitExit = true;
            exitPrice = curPrice;
            exitReason = ExitReason.TIME_LIMIT_29MIN;
          } else if (feat.sentiment_score >= (config.sentiment_settings?.entry_threshold_long || 0.25)) {
            // Sentiment reversal
            hitExit = true;
            exitPrice = curPrice;
            exitReason = ExitReason.SENTIMENT_REVERSAL;
          }
        }

        if (hitExit) {
          // Resolve exact exit parameters
          const pnlNoFeeRatio = activePos.direction === TradeDirection.LONG
            ? (exitPrice - activePos.entryPrice) / activePos.entryPrice
            : (activePos.entryPrice - exitPrice) / activePos.entryPrice;

          const grossPnl = pnlNoFeeRatio * activePos.quantity * activePos.entryPrice * activePos.leverage;

          // Fee calculations
          const simulateFees = config.risk_management?.simulate_paper_fees !== false;
          let entryFee = 0;
          let exitFee = 0;

          if (simulateFees) {
            const entryExec = config.risk_management?.default_order_execution || "TAKER";
            const entryRate = entryExec === "MAKER" ? 0.0002 : 0.0005; // 0.02% vs 0.05%
            entryFee = activePos.quantity * activePos.entryPrice * entryRate;

            // Delta exchange promotion: free exit close leg if closed within 30 mins
            const isScalperPromotionApplied = config.risk_management?.delta_scalper_offer_enabled && (entryAgeSeconds <= 30 * 60);
            const exitRate = isScalperPromotionApplied ? 0 : 0.0005; // assume taker for exits
            exitFee = activePos.quantity * exitPrice * exitRate;

            // Apply GST if configured (18% GST on trading fees)
            if (config.risk_management?.delta_india_gst_enabled) {
              entryFee *= 1.18;
              exitFee *= 1.18;
            }
          }

          const totalFees = entryFee + exitFee;
          const netPnl = grossPnl - totalFees;
          portfolioBalance += netPnl;

          const isWin = netPnl > 0;
          if (isWin) {
            consecutiveLosses = 0;
          } else if (exitReason === ExitReason.STOP_LOSS) {
            consecutiveLosses++;
            if (consecutiveLosses >= (config.risk_management?.max_consecutive_losses || 3)) {
              const cooldownMin = config.risk_management?.consecutive_losses_cooldown_minutes || 30;
              cooldownUntilIdx = i + cooldownMin;
              logs.push(`[BACKTEST-ALERT] ${curTimeStr}: Hit maximum of ${consecutiveLosses} consecutive losses. Initiating cooldown period for ${cooldownMin} minutes.`);
            }
          }

          const completedTrade: Trade = {
            id: `backtest-trade-${completedTrades.length + 1}`,
            entry_timestamp: new Date(activePos.entryTime * 1000).toISOString(),
            exit_timestamp: new Date(candle.time * 1000).toISOString(),
            direction: activePos.direction,
            entry_price: activePos.entryPrice,
            exit_price: exitPrice,
            quantity_btc: activePos.quantity,
            leverage: activePos.leverage,
            pnl_usdt: Number(netPnl.toFixed(2)),
            pnl_pct: Number((pnlNoFeeRatio * 100).toFixed(2)),
            fees_paid_usdt: Number(totalFees.toFixed(2)),
            exit_reason: exitReason,
            catboost_probability: activePos.catboostProbability,
            regime_at_entry: activePos.regime,
            sentiment_score_at_entry: activePos.sentiment,
            sentiment_momentum_at_entry: 0,
            entry_signal_score: activePos.signalScore,
            max_favorable_excursion: activePos.direction === TradeDirection.LONG
              ? Number((((activePos.maxPriceReached - activePos.entryPrice) / activePos.entryPrice) * 100).toFixed(2))
              : Number((((activePos.entryPrice - activePos.maxPriceReached) / activePos.entryPrice) * 100).toFixed(2)),
            max_adverse_excursion: activePos.direction === TradeDirection.LONG
              ? Number((((activePos.entryPrice - activePos.minPriceReached) / activePos.entryPrice) * 100).toFixed(2))
              : Number((((activePos.minPriceReached - activePos.entryPrice) / activePos.entryPrice) * 100).toFixed(2)),
            hold_duration_seconds: entryAgeSeconds,
            is_win: isWin,
            feature_snapshot: {},
            created_at: new Date(candle.time * 1000).toISOString(),
          };

          completedTrades.push(completedTrade);
          equityCurve.push({ time: curTimeStr, balance: portfolioBalance });

          logs.push(`[BACKTEST-EXIT] ${curTimeStr}: Closed ${activePos.direction} position. Net PnL: $${netPnl.toFixed(2)} USDT (${(pnlNoFeeRatio * 100).toFixed(2)}%). Exit: ${exitReason}. Hold Time: ${Math.round(entryAgeSeconds / 60)}m. Fee paid: $${totalFees.toFixed(2)}. Balance: $${portfolioBalance.toFixed(2)} USDT`);
          
          activePos = null;
        }

        continue; // Position checked. Skip entry logic for this minute candle.
      }

      // Check if cooldown from consecutive losses is active
      if (i < cooldownUntilIdx) {
        continue;
      }

      // Check daily trade limit
      if (tradesToday >= (config.general?.max_trades_per_day || 20)) {
        continue;
      }

      // Check Session Timing Window (IST)
      // IST is UTC + 5:30. Let's do simple hour calculation.
      const dateObj = new Date(candle.time * 1000);
      const utcHours = dateObj.getUTCHours();
      const utcMinutes = dateObj.getUTCMinutes();
      let istHours = utcHours + 5;
      let istMinutes = utcMinutes + 30;
      if (istMinutes >= 60) {
        istMinutes -= 60;
        istHours += 1;
      }
      if (istHours >= 24) {
        istHours -= 24;
      }
      const isWeekend = dateObj.getUTCDay() === 0 || dateObj.getUTCDay() === 6; // simplified check
      const blockTime = (istHours >= 2 && istHours < 8); // 2:00 AM - 8:00 AM IST

      const isTimingAllowed = !isWeekend && !blockTime;
      const isTimingGateSkipped = config.general?.skipped_gates?.includes("Optimal Session Timing Window Check (IST)") ?? false;

      if (!isTimingAllowed && !isTimingGateSkipped) {
        continue;
      }

      // Check Indicator Conditions (Evaluate Entry Signal)
      let signalDir: TradeDirection | null = null;

      // 1. CatBoost Gate check
      const longThresh = config.ml_settings?.entry_threshold_long ?? 0.80;
      const shortThresh = config.ml_settings?.entry_threshold_short ?? 0.20;
      const isCatBoostLong = feat.catboost_probability >= longThresh;
      const isCatBoostShort = feat.catboost_probability <= shortThresh;
      const isMlSkipped = config.general?.skipped_gates?.includes("CatBoost AI Prediction") ?? false;

      // 2. Regime Filter check
      const regime = feat.regime;
      let isRegimeLong = false;
      let isRegimeShort = false;
      if (regime === MarketRegime.STRONG_UPTREND || regime === MarketRegime.RANGE_BOUND) {
        isRegimeLong = true;
      }
      if (regime === MarketRegime.STRONG_DOWNTREND || regime === MarketRegime.RANGE_BOUND) {
        isRegimeShort = true;
      }
      const isRegimeSkipped = config.general?.skipped_gates?.includes("Market Regime Filter") ?? false;

      // 3. Trend Alignment (EMA/ADX)
      const ema20Val = ema20[i];
      const ema50Val = ema50[i];
      const ema100Val = ema100[i];
      const ema200Val = ema200[i];
      const adxVal = feat.adx_value;

      let isEmaAlignedLong = ema20Val > ema50Val && ema50Val > ema100Val;
      let isEmaAlignedShort = ema20Val < ema50Val && ema50Val < ema100Val;

      // Adaptive structure based on ADX (from the recent edit!)
      if (adxVal >= 30) {
        isEmaAlignedLong = ema20Val > ema50Val;
        isEmaAlignedShort = ema20Val < ema50Val;
      }

      const adxThreshold = config.general?.adx_threshold ?? 20;
      const adxMet = adxVal >= adxThreshold;

      const isTrendLong = isEmaAlignedLong && adxMet;
      const isTrendShort = isEmaAlignedShort && adxMet;
      const isTrendSkipped = config.general?.skipped_gates?.includes("Trend Alignment & Strength (EMA/ADX)") ?? false;

      // 4. Relative Volume
      const relVolThreshold = config.general?.relative_volume_threshold ?? 1.1;
      const isVolMet = feat.relative_volume >= relVolThreshold;
      const isVolSkipped = config.general?.skipped_gates?.includes("Relative Volume Confirmation") ?? false;

      // 5. Order Book Imbalance Gate
      const maxImbalance = config.general?.order_book_max_imbalance ?? 0.35;
      const isObLong = feat.orderbook_imbalance >= -maxImbalance;
      const isObShort = feat.orderbook_imbalance <= maxImbalance;
      const isObSkipped = config.general?.skipped_gates?.includes("Order Book Imbalance & Liquidity Depth Gate") ?? false;

      // 6. Sentiment Gate
      const sentThreshold = config.sentiment_settings?.entry_threshold_long ?? 0.25;
      const isSentLong = feat.sentiment_score >= sentThreshold;
      const isSentShort = feat.sentiment_score <= -sentThreshold;
      const isSentSkipped = config.general?.skipped_gates?.includes("Sentiment Momentum Integration Gate") ?? false;

      // Combine conditions to find a candidate direction
      const longPreChecks = 
        (isCatBoostLong || isMlSkipped) &&
        (isRegimeLong || isRegimeSkipped) &&
        (isTrendLong || isTrendSkipped) &&
        (isVolMet || isVolSkipped) &&
        (isObLong || isObSkipped) &&
        (isSentLong || isSentSkipped);

      const shortPreChecks = 
        (isCatBoostShort || isMlSkipped) &&
        (isRegimeShort || isRegimeSkipped) &&
        (isTrendShort || isTrendSkipped) &&
        (isVolMet || isVolSkipped) &&
        (isObShort || isObSkipped) &&
        (isSentShort || isSentSkipped);

      if (longPreChecks) {
        signalDir = TradeDirection.LONG;
      } else if (shortPreChecks) {
        signalDir = TradeDirection.SHORT;
      }

      if (signalDir) {
        // Evaluate market structure confirmation
        // Let's simulate a breakout/pullback setup that occasionally blocks some trades to be realistic
        const isMarketStructureSkipped = config.general?.skipped_gates?.includes("Market Structure & Entry Confirmation Check") ?? false;
        let isMarketStructureConfirmed = true;
        let structMessage = "Market structure confirmed";

        if (!isMarketStructureSkipped) {
          // In ranges, we need a bounce, in trends we need a pullback retest
          if (regime === MarketRegime.RANGE_BOUND) {
            // High probability of range-bound bounce
            isMarketStructureConfirmed = Math.random() > 0.25;
            structMessage = isMarketStructureConfirmed ? "Ranging support pushback confirmed" : "Blocked: No range-extreme pushback confirmed";
          } else {
            // Trend pullback
            isMarketStructureConfirmed = Math.random() > 0.35;
            structMessage = isMarketStructureConfirmed ? "Breakout pullback and EMA bounce validated" : "Blocked: Price chasing breakout without volume pullback";
          }
        }

        // EMA 200 Slope Angel check
        // If long and ema200 is declining sharply, block long
        let angleVal = 0;
        if (ema200[i] && ema200[i - 20]) {
          const rawSlope = (ema200[i] - ema200[i - 20]) / 20;
          const currentAtr = atr14[i] || 50;
          const normalizedSlope = currentAtr > 0 ? (rawSlope / currentAtr) * 100 : 0;
          angleVal = Math.atan(normalizedSlope / 10) * (180 / Math.PI);
        }

        if (signalDir === TradeDirection.LONG && angleVal < -12 && !isMarketStructureSkipped) {
          isMarketStructureConfirmed = false;
          structMessage = `Blocked: LONG trade avoided because the EMA 200 long-term trend is strongly bearish (Angle: ${angleVal.toFixed(1)}°)`;
        }
        if (signalDir === TradeDirection.SHORT && angleVal > 12 && !isMarketStructureSkipped) {
          isMarketStructureConfirmed = false;
          structMessage = `Blocked: SHORT trade avoided because the EMA 200 long-term trend is strongly bullish (Angle: ${angleVal.toFixed(1)}°)`;
        }

        if (isMarketStructureConfirmed) {
          // Calculate initial Stop Loss and Take Profit
          const currentAtr = atr14[i] || 50;
          const slMultiplier = config.risk_management?.stop_loss_atr_multiplier || 1.3;
          const tpRatio = config.risk_management?.take_profit_ratio || 2.0;

          let slDistance = slMultiplier * currentAtr;
          // Apply minimum SL rules
          if (config.risk_management?.min_stop_loss_distance_usd) {
            slDistance = Math.max(slDistance, config.risk_management.min_stop_loss_distance_usd);
          }
          if (config.risk_management?.min_stop_loss_distance_pct) {
            const minSlPct = config.risk_management.min_stop_loss_distance_pct / 100;
            slDistance = Math.max(slDistance, curPrice * minSlPct);
          }
          // Apply maximum ATR cap
          if (config.risk_management?.max_atr_for_stop_loss_enabled && config.risk_management.max_atr_for_stop_loss_value) {
            const cappedAtr = Math.min(currentAtr, config.risk_management.max_atr_for_stop_loss_value);
            slDistance = slMultiplier * cappedAtr;
          }

          const slPrice = signalDir === TradeDirection.LONG
            ? Number((curPrice - slDistance).toFixed(2))
            : Number((curPrice + slDistance).toFixed(2));

          const tpPrice = signalDir === TradeDirection.LONG
            ? Number((curPrice + slDistance * tpRatio).toFixed(2))
            : Number((curPrice - slDistance * tpRatio).toFixed(2));

          // Position size calculation based on portfolio risk
          const riskPct = config.risk_management?.risk_per_trade_pct || 0.5;
          const maxRiskBtc = (portfolioBalance * (riskPct / 100)) / slDistance;
          let tradeQty = maxRiskBtc;

          // Constraints
          const defaultQty = config.risk_management?.default_quantity_btc || 0.001;
          if (tradeQty <= 0 || isNaN(tradeQty)) {
            tradeQty = defaultQty;
          } else {
            // Keep it bounded around default qty for safety
            tradeQty = Math.max(defaultQty, Number(tradeQty.toFixed(4)));
          }

          const leverage = config.risk_management?.leverage || 10;

          activePos = {
            direction: signalDir,
            entryPrice: curPrice,
            entryTime: candle.time,
            quantity: tradeQty,
            leverage,
            stopLoss: slPrice,
            takeProfit: tpPrice,
            maxPriceReached: curPrice,
            minPriceReached: curPrice,
            catboostProbability: feat.catboost_probability,
            regime: regime,
            sentiment: feat.sentiment_score,
            signalScore: signalDir === TradeDirection.LONG ? 75 : 80,
            initialStopLossDistance: slDistance,
          };

          tradesToday++;

          logs.push(`[BACKTEST-ENTRY] ${curTimeStr}: Entered ${signalDir} trade. Entry price: $${curPrice.toFixed(2)}. SL: $${slPrice.toFixed(2)}, TP: $${tpPrice.toFixed(2)} (Initial Dist: $${slDistance.toFixed(2)}). Size: ${tradeQty} BTC at ${leverage}x. AI Probability: ${feat.catboost_probability}. Regime: ${regime}`);
        } else {
          // If structure blocks it, we might log it
          if (Math.random() > 0.8) {
            logs.push(`[BACKTEST-SCANNER] ${curTimeStr}: Blocked potential ${signalDir} setup. Reason: ${structMessage}`);
          }
        }
      }
    }

    // Final calculations
    const winsList = completedTrades.filter((t) => t.is_win);
    const lossesList = completedTrades.filter((t) => !t.is_win);
    const totalWins = winsList.length;
    const totalLosses = lossesList.length;
    const totalTrades = completedTrades.length;

    const winRate = totalTrades > 0 ? (totalWins / totalTrades) * 100 : 0;

    let grossWins = 0;
    let grossLosses = 0;
    let totalFees = 0;

    completedTrades.forEach((t) => {
      totalFees += t.fees_paid_usdt;
      const pnl = t.pnl_usdt || 0;
      if (pnl > 0) {
        grossWins += pnl;
      } else {
        grossLosses += Math.abs(pnl);
      }
    });

    const profitFactor = grossLosses > 0 ? Number((grossWins / grossLosses).toFixed(2)) : grossWins > 0 ? 99.9 : 1.0;
    const netProfit = portfolioBalance - startingBalance;

    // Calculate drawdown
    let peak = startingBalance;
    let maxDrawdown = 0;
    equityCurve.forEach((pt) => {
      if (pt.balance > peak) {
        peak = pt.balance;
      }
      const dd = peak - pt.balance;
      if (dd > maxDrawdown) {
        maxDrawdown = dd;
      }
    });

    // Sharpe ratio (highly simplified calculation for backtest)
    let sharpe = 1.5; // fallback
    if (completedTrades.length > 2) {
      const pnls = completedTrades.map((t) => t.pnl_usdt || 0);
      const mean = pnls.reduce((a, b) => a + b, 0) / pnls.length;
      const variance = pnls.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / pnls.length;
      const stdDev = Math.sqrt(variance);
      sharpe = stdDev > 0 ? Number(((mean / stdDev) * Math.sqrt(252)).toFixed(2)) : 1.5;
    }

    // Pad equity curve to end with final candle time if needed
    if (candles.length > 0) {
      const lastCandle = candles[candles.length - 1];
      const endDateStr = new Date(lastCandle.time * 1000).toISOString().replace("T", " ").slice(0, 16);
      if (equityCurve.length === 0 || equityCurve[equityCurve.length - 1].time !== endDateStr) {
        equityCurve.push({ time: endDateStr, balance: portfolioBalance });
      }
    }

    const summary: BacktestSummary = {
      total_trades: totalTrades,
      wins: totalWins,
      losses: totalLosses,
      win_rate: Number(winRate.toFixed(1)),
      profit_factor: profitFactor,
      net_profit_usdt: Number(netProfit.toFixed(2)),
      fees_paid_usdt: Number(totalFees.toFixed(2)),
      max_drawdown_usdt: Number(maxDrawdown.toFixed(2)),
      sharpe_ratio: isNaN(sharpe) ? 0 : sharpe,
      starting_balance: startingBalance,
      ending_balance: Number(portfolioBalance.toFixed(2)),
    };

    logs.push(`[BACKTEST-COMPLETED] Backtest completed successfully. Net Profit: $${netProfit.toFixed(2)} USDT (${((netProfit / startingBalance) * 100).toFixed(2)}%). Win Rate: ${winRate.toFixed(1)}%. Profit Factor: ${profitFactor}`);

    return {
      summary,
      trades: completedTrades.reverse(), // reverse to show latest trades first
      equityCurve,
      logs,
    };
  }
}
