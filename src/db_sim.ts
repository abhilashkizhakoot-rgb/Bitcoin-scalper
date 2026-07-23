/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from "fs";
import * as path from "path";
import {
  ExchangeCredentials,
  Trade,
  TradingSignal,
  RegimeLog,
  SentimentLog,
  NewsHeadline,
  StrategyConfig,
  ConfigHistoryEntry,
  ConnectionStatus,
  TradeDirection,
  ExitReason,
  MarketRegime,
  NewsSource,
  DailyStats,
  ApiCallLog,
  TimingWindow,
} from "./types.js";

const DATA_DIR = process.env.DATA_DIR || process.cwd();
if (DATA_DIR && !fs.existsSync(DATA_DIR)) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (e) {
    console.error(`Failed to create DATA_DIR ${DATA_DIR}:`, e);
  }
}
const DB_FILE_PATH = path.join(DATA_DIR, "db_store.json");
const DB_PAPER_FILE_PATH = path.join(DATA_DIR, "db_paper_store.json");

export const DEFAULT_TIMING_WINDOWS: TimingWindow[] = [
  {
    id: "asia_open",
    name: "Asia Open Front-run",
    start_time: "05:00",
    end_time: "09:30",
    allowed: true,
    description: "Optimal morning momentum. High probability trend capture session.",
  },
  {
    id: "intraday_chop",
    name: "Intra-day Chop",
    start_time: "09:30",
    end_time: "18:30",
    allowed: false,
    description: "Avoid period. High noise, low momentum, and sideways chop.",
  },
  {
    id: "europe_us_overlap",
    name: "US / Europe Overlap",
    start_time: "18:30",
    end_time: "22:30",
    allowed: true,
    description: "Best Window. Peak liquidity, volume, and lowest spreads with high institutional action.",
  },
  {
    id: "late_us_session",
    name: "Late US Session",
    start_time: "22:30",
    end_time: "01:30",
    allowed: true,
    description: "Active derivatives positioning. Ideal session for momentum breakouts.",
  },
  {
    id: "dead_liquidity",
    name: "Dead Liquidity",
    start_time: "01:30",
    end_time: "05:00",
    allowed: false,
    description: "Strict Avoid period. Extremely thin orderbooks and high slippage risk.",
  },
  {
    id: "weekends",
    name: "Weekends",
    start_time: "00:00",
    end_time: "23:59",
    allowed: false,
    description: "Volume drops significantly on weekends, increasing the risk of sharp liquidations and false trends.",
  },
];

interface DatabaseSchema {
  credentials: ExchangeCredentials;
  trades: Trade[];
  signals: TradingSignal[];
  regime_logs: RegimeLog[];
  sentiment_logs: SentimentLog[];
  headlines: NewsHeadline[];
  config: StrategyConfig;
  config_profiles: Record<string, StrategyConfig>;
  config_history: ConfigHistoryEntry[];
}

const DEFAULT_CONFIG: StrategyConfig = {
  general: {
    is_trading_active: false,
    cooldown_minutes: 30,
    max_trades_per_day: 8,
    is_paper_trading: true,
    skipped_gates: [],
    relative_volume_threshold: 1.3,
    adx_threshold: 22.0,
    timing_windows: DEFAULT_TIMING_WINDOWS,
    regime_candle_interval_minutes: 3,
    data_feed_source: "BINANCE",
    enable_block_logging: true,
    enable_trade_logging: true,
    enable_orderflow_softening: true,
    orderflow_softening_percent: 10,
    order_book_min_depth: 4.0,
    order_book_max_imbalance: 0.35,
    regime_change_cooldown_minutes: 15,
    regime_macro_slope_lookback: 5,
    regime_macro_slope_threshold: 0.0005,
    regime_ribbon_compression_threshold: 0.0015,
    require_volume_profile_in_ranging: true,
  },
  ml_settings: {
    entry_threshold_long: 0.80,
    entry_threshold_short: 0.20,
    model_version: "v2.4.1",
    last_trained_at: new Date(Date.now() - 24 * 3600000 * 2).toISOString(),
    training_window_months: 6,
    validation_auc: 0.84,
    auto_retrain_weekly: true,
    retrain_on_perf_drop: true,
  },
  sentiment_settings: {
    entry_threshold_long: 0.25,
    entry_threshold_short: -0.25,
    require_momentum_long: true,
    require_momentum_short: true,
    block_on_critical_keywords: true,
    protection_window_minutes: 15,
    critical_keywords: [
      "CPI", "FOMC", "federal reserve", "interest rate", "inflation",
      "ETF", "SEC", "regulation", "hack", "exploit", "ban", "halving",
      "fork", "upgrade", "delist", "security breach", "stolen"
    ],
    weights: {
      [NewsSource.COINDESK]: 25,
      [NewsSource.COINTELEGRAPH]: 20,
      [NewsSource.THEBLOCK]: 20,
      [NewsSource.BITCOIN_MAGAZINE]: 15,
      [NewsSource.CRYPTOPANIC]: 10,
      [NewsSource.TWITTER]: 5,
      [NewsSource.REDDIT]: 5,
    },
    refresh_rates_min: {
      [NewsSource.COINDESK]: 5,
      [NewsSource.COINTELEGRAPH]: 5,
      [NewsSource.THEBLOCK]: 5,
      [NewsSource.BITCOIN_MAGAZINE]: 5,
      [NewsSource.CRYPTOPANIC]: 5,
      [NewsSource.TWITTER]: 10,
      [NewsSource.REDDIT]: 15,
    },
  },
  risk_management: {
    risk_per_trade_pct: 0.5,
    max_risk_per_trade_pct: 1.0,
    stop_loss_atr_multiplier: 2.2,
    take_profit_ratio: 2.5,
    max_consecutive_losses: 3,
    consecutive_losses_cooldown_minutes: 30,
    daily_loss_limit_pct: 2.0,
    weekly_loss_limit_pct: 5.0,
    intra_trade_drawdown_limit_pct: 1.5,
    leverage: 20,
    default_quantity_btc: 0.001,
    simulate_paper_fees: true,
    delta_india_gst_enabled: true,
    delta_scalper_offer_enabled: true,
    default_order_execution: "TAKER",
    trailing_stop_loss_enabled: true,
    trailing_stop_loss_distance_atr: 1.8,
    trailing_stop_loss_activation_ratio: 1.2,
    min_stop_loss_distance_usd: 80,
    min_stop_loss_distance_pct: 0.12,
    static_stop_loss_enabled: false,
    static_stop_loss_value_usd: 150,
    max_atr_for_stop_loss_enabled: false,
    max_atr_for_stop_loss_value: 100,
    min_atr_for_trading_enabled: true,
    min_atr_for_trading_value: 12, // Default 12, which is higher than low value 11
    overextension_ema_trending_threshold: 2.2,
    overextension_ema_ranging_threshold: 1.2,
    overextension_vwap_trending_multiplier: 1.5,
    overextension_vwap_ranging_multiplier: 1.0,
  },
  market_structure: {
    min_breakout_body_ratio: 0.22,
    allow_immediate_breakout: true,
    hf_momentum_adx_threshold: 30,
    hf_orderflow_taker_buy_ratio_long: 0.58,
    hf_orderflow_imbalance_ratio_long: 0.30,
    hf_orderflow_taker_buy_ratio_short: 0.42,
    hf_orderflow_imbalance_ratio_short: -0.30,
    pullback_multiplier_limit: 0.6,
    ema_retrace_multiplier_limit: 0.4,
    pullback_volume_dryup_threshold_mult: 1.5,
    pullback_volume_breakout_ratio: 0.85,
    bypass_ema200_on_momentum: true,
    ema200_proximity_divisor: 3.0,
    weak_trend_adx_threshold: 25,
    trend_alignment_adx_threshold: 30,
    super_trend_adx_threshold: 35,
    fast_ema_period: 20,
    medium_ema_period: 50,
    slow_ema_period: 200,
    micro_trend_alignment_enabled: true,
    micro_trend_fast_period: 5,
    micro_trend_slow_period: 15,
    fallback_crossover_enabled: true,
    fallback_crossover_fast_period: 5,
    fallback_crossover_slow_period: 15,
    fallback_crossover_bounce_atr_fraction: 0.15,
    fallback_crossover_invalidation_atr_fraction: 0.25,
    crossover_only_strategy_enabled: false,
    crossover_only_fast_period: 5,
    crossover_only_slow_period: 15,
    crossover_only_rsi_limit: 70,
    crossover_only_adx_threshold: 25,
    timeframe_minutes: 5,
    very_high_probability_threshold: 0.82,
  },
  gate_scoring: {
    enabled: true,
    confidence_threshold: 70,
    enable_weight_discounting: true,
    softened_gate_discount_factor: 0.5,
    weights: {
      catboost_ai: 25,
      market_regime: 15,
      trend_alignment: 15,
      relative_volume: 10,
      overextension: 10,
      wedge_filter: 5,
      order_flow: 10,
      squeeze_filter: 5,
      order_book: 5,
      volume_profile: 10,
    },
    adaptive_modifiers: {
      trending: {
        trend_alignment_weight_boost: 10,
        catboost_weight_boost: 5,
        volume_profile_weight_boost: -5,
      },
      ranging: {
        order_flow_weight_boost: 15,
        trend_alignment_weight_reduction: -10,
        volume_profile_weight_boost: 10,
      },
      high_volatility: {
        relative_volume_weight_boost: 10,
        overextension_weight_boost: 10,
        volume_profile_weight_boost: 5,
      },
      low_volatility: {
        squeeze_filter_weight_boost: 15,
        volume_profile_weight_boost: 0,
      },
    },
  },
};

const DEFAULT_CREDENTIALS: ExchangeCredentials = {
  id: "delta-exchange-prod-key",
  exchange_name: "Delta Exchange",
  api_url: "https://api.delta.exchange",
  ws_url: "wss://production.delta.exchange",
  api_key: "delta_prod_api_key_xxxxxxxxxxxxx",
  api_secret: "delta_prod_api_secret_yyyyyyyyyyyyy",
  connection_status: ConnectionStatus.NOT_CONFIGURED,
  last_tested_at: new Date().toISOString(),
  last_successful_connection: "",
  connection_error_message: "API keys are not configured. Please supply valid Delta Exchange credentials.",
  account_balance_usdt: 104520.35,
  account_email: "abhilashkizhakoot@gmail.com",
  product_id: 1,
  product_symbol: "BTCUSD-FUTURES",
  is_testnet: false,
  is_india: false,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

// Generates high-fidelity historical data so the app has instantly impressive charts and analytics
function generateMockHistory(): DatabaseSchema {
  const trades: Trade[] = [];
  const signals: TradingSignal[] = [];
  const regime_logs: RegimeLog[] = [];
  const sentiment_logs: SentimentLog[] = [];
  const headlines: NewsHeadline[] = [];

  const now = Date.now();
  let currentBalance = 100000; // Starting capital is $100,000

  // 1. Generate historical regimes (last 24 hours, every 5 mins)
  const regimes = [
    MarketRegime.STRONG_UPTREND,
    MarketRegime.STRONG_DOWNTREND,
    MarketRegime.RANGE_BOUND,
    MarketRegime.HIGH_VOLATILITY,
    MarketRegime.LOW_VOLATILITY,
  ];

  for (let i = 288; i >= 0; i--) {
    const timestamp = new Date(now - i * 5 * 60 * 1000).toISOString();
    // Weighted selection of regime based on indexes
    let regimeIndex = 2; // Range bound by default
    if (i > 200 && i < 250) regimeIndex = 0; // Uptrend
    else if (i > 120 && i < 170) regimeIndex = 1; // Downtrend
    else if (i > 50 && i < 80) regimeIndex = 3; // High vol
    else if (i < 20) regimeIndex = 4; // Low vol

    regime_logs.push({
      id: `regime-${288 - i}`,
      detected_at: timestamp,
      regime: regimes[regimeIndex],
      confidence: 0.65 + Math.random() * 0.3,
      adx_value: regimeIndex === 0 || regimeIndex === 1 ? 28 + Math.random() * 15 : 12 + Math.random() * 10,
      atr_expansion_ratio: regimeIndex === 3 ? 1.6 + Math.random() * 0.8 : 0.8 + Math.random() * 0.5,
      bb_width_percentile: regimeIndex === 4 ? Math.random() * 15 : 40 + Math.random() * 50,
      ema_structure: regimeIndex === 0 ? "BULLISH_ALIGNED" : regimeIndex === 1 ? "BEARISH_ALIGNED" : "MIXED",
      realized_volatility: 0.01 + Math.random() * 0.04,
      volume_expansion: 0.7 + Math.random() * 2.1,
      created_at: timestamp,
    });

    // 2. Generate historical sentiment logs
    if (i % 3 === 0) {
      sentiment_logs.push({
        id: `sent-log-${Math.floor(288 - i / 3)}`,
        refreshed_at: timestamp,
        source: NewsSource.COINDESK,
        headline_count: 5 + Math.floor(Math.random() * 8),
        positive_count: regimeIndex === 0 ? 6 : regimeIndex === 1 ? 1 : 3,
        neutral_count: 3,
        negative_count: regimeIndex === 0 ? 1 : regimeIndex === 1 ? 5 : 2,
        current_sentiment: regimeIndex === 0 ? 0.45 + Math.random() * 0.3 : regimeIndex === 1 ? -0.45 - Math.random() * 0.3 : -0.1 + Math.random() * 0.2,
        sentiment_30m_avg: regimeIndex === 0 ? 0.38 : regimeIndex === 1 ? -0.35 : 0.02,
        sentiment_1h_avg: regimeIndex === 0 ? 0.32 : regimeIndex === 1 ? -0.30 : 0.01,
        sentiment_4h_avg: 0.1,
        sentiment_momentum: regimeIndex === 0 ? 0.15 : regimeIndex === 1 ? -0.15 : 0.01,
        sentiment_volatility: 0.12,
        news_intensity_30m: 10 + Math.floor(Math.random() * 15),
        news_intensity_60m: 20 + Math.floor(Math.random() * 25),
        processing_time_ms: 200 + Math.floor(Math.random() * 300),
        created_at: timestamp,
      });
    }
  }

  // 3. Generate 25 historical trades over the last 3 days
  const basePrice = 101250;
  for (let k = 25; k >= 1; k--) {
    const tradeHoursAgo = k * 2.8 + Math.random() * 1.5;
    const entryTime = new Date(now - tradeHoursAgo * 3600 * 1000);
    const exitTime = new Date(entryTime.getTime() + (10 + Math.floor(Math.random() * 18)) * 60000); // 10-28 mins duration

    const direction = Math.random() > 0.42 ? TradeDirection.LONG : TradeDirection.SHORT;
    const isWin = Math.random() > 0.34; // ~66% Win Rate

    const entryPrice = basePrice + (direction === TradeDirection.LONG ? -200 : 200) + Math.random() * 1000 - Math.random() * 1000;
    const atrValue = 120 + Math.random() * 80;
    const stopDistance = atrValue * 1.3;
    const takeProfitDistance = stopDistance * 2;

    let exitPrice = entryPrice;
    let exitReason: ExitReason;

    if (isWin) {
      exitPrice = direction === TradeDirection.LONG ? entryPrice + takeProfitDistance : entryPrice - takeProfitDistance;
      exitReason = ExitReason.TAKE_PROFIT;
    } else {
      exitPrice = direction === TradeDirection.LONG ? entryPrice - stopDistance : entryPrice + stopDistance;
      exitReason = Math.random() > 0.7 ? ExitReason.TIME_LIMIT_29MIN : ExitReason.STOP_LOSS;
    }

    const tradeRiskUsdt = currentBalance * 0.005; // 0.5% risk
    const quantityBtc = Number((tradeRiskUsdt / stopDistance).toFixed(4));
    const leverage = 20;

    let pnlUsdt = 0;
    if (direction === TradeDirection.LONG) {
      pnlUsdt = (exitPrice - entryPrice) * quantityBtc;
    } else {
      pnlUsdt = (entryPrice - exitPrice) * quantityBtc;
    }

    // Fees paid: 0.05% of position size on entry and exit
    const positionValue = entryPrice * quantityBtc;
    const feesPaid = positionValue * 0.0006 * 2;
    pnlUsdt -= feesPaid;

    currentBalance += pnlUsdt;

    const catboostProbability = direction === TradeDirection.LONG
      ? (isWin ? 0.81 + Math.random() * 0.15 : 0.70 + Math.random() * 0.12)
      : (isWin ? 0.05 + Math.random() * 0.12 : 0.15 + Math.random() * 0.14);

    const regime = direction === TradeDirection.LONG ? MarketRegime.STRONG_UPTREND : MarketRegime.STRONG_DOWNTREND;

    trades.push({
      id: `trade-hist-${26 - k}`,
      entry_timestamp: entryTime.toISOString(),
      exit_timestamp: exitTime.toISOString(),
      direction,
      entry_price: Number(entryPrice.toFixed(2)),
      exit_price: Number(exitPrice.toFixed(2)),
      quantity_btc: quantityBtc,
      leverage,
      pnl_usdt: Number(pnlUsdt.toFixed(2)),
      pnl_pct: Number(((pnlUsdt / currentBalance) * 100).toFixed(4)),
      fees_paid_usdt: Number(feesPaid.toFixed(4)),
      exit_reason: exitReason,
      catboost_probability: Number(catboostProbability.toFixed(4)),
      regime_at_entry: regime,
      sentiment_score_at_entry: direction === TradeDirection.LONG ? 0.35 + Math.random() * 0.3 : -0.35 - Math.random() * 0.3,
      sentiment_momentum_at_entry: direction === TradeDirection.LONG ? 0.12 : -0.11,
      entry_signal_score: 82 + Math.floor(Math.random() * 16),
      max_favorable_excursion: isWin ? 2.1 : 0.4 + Math.random() * 0.6,
      max_adverse_excursion: isWin ? 0.3 + Math.random() * 0.4 : 1.35,
      hold_duration_seconds: Math.floor((exitTime.getTime() - entryTime.getTime()) / 1000),
      is_win: isWin,
      feature_snapshot: {
        adx: 32.5,
        atr_14: atrValue,
        rsi_14: direction === TradeDirection.LONG ? 62 : 38,
        macd_hist: direction === TradeDirection.LONG ? 12.5 : -14.2,
      },
      created_at: entryTime.toISOString(),
    });

    // 4. Generate some matching signals
    signals.push({
      id: `sig-${26 - k}`,
      trade_id: `trade-hist-${26 - k}`,
      timestamp: entryTime.toISOString(),
      catboost_probability: Number(catboostProbability.toFixed(4)),
      direction,
      regime_detected: regime,
      sentiment_score: direction === TradeDirection.LONG ? 0.45 : -0.42,
      sentiment_momentum: direction === TradeDirection.LONG ? 0.12 : -0.15,
      all_conditions_met: true,
      failed_conditions: [],
      executed: true,
      rejection_reason: null,
      created_at: entryTime.toISOString(),
    });
  }

  // 5. Generate typical high-fidelity crypto headlines
  const sampleHeadlines = [
    { text: "US Core CPI Inflation Clocks In at 0.2%, Matching Market Estimates", score: 0.15, isCritical: true, keyword: "CPI" },
    { text: "Bitcoin Futures Open Interest Hits Lifetime High on Delta Exchange", score: 0.62, isCritical: false, keyword: null },
    { text: "Securities and Exchange Commission Approves Spot Bitcoin ETF Options Options Trading", score: 0.85, isCritical: true, keyword: "ETF" },
    { text: "Whale Wallet Deposits $150M of Bitcoin to Binances Orderbooks, Prompting Liquidation Fears", score: -0.45, isCritical: false, keyword: null },
    { text: "Federal Reserve Chair Powell Signals Multiple Interest Rate Cuts Coming in 2026", score: 0.72, isCritical: true, keyword: "federal reserve" },
    { text: "Major Cryptocurrency Bridge Exploited for $45 Million in Ethereum and WBTC", score: -0.82, isCritical: true, keyword: "exploit" },
    { text: "Bitcoin Difficulty Jumps 4.2% as Hashrate Peaks to New All-Time Milestones", score: 0.35, isCritical: false, keyword: null },
    { text: "Germany Finalizes Strict Crypto Staking and Token Valuation Policy Guidelines", score: -0.12, isCritical: true, keyword: "regulation" },
    { text: "FOMC Statement Confirms 25 Basis Points Rate Cut to Target Volatility Reduction", score: 0.65, isCritical: true, keyword: "FOMC" },
    { text: "Bitcoin Halving Nears with Mining Pool Revenue Dropping Slightly Ahead of Schedule", score: 0.1, isCritical: true, keyword: "halving" },
  ];

  sampleHeadlines.forEach((sh, idx) => {
    headlines.push({
      id: `hl-${idx + 1}`,
      timestamp: new Date(now - idx * 32 * 60000).toISOString(),
      source: idx % 2 === 0 ? NewsSource.COINDESK : NewsSource.THEBLOCK,
      headline: sh.text,
      sentiment_score: sh.score,
      category: sh.score > 0.25 ? "BULLISH" : sh.score < -0.25 ? "BEARISH" : "NEUTRAL",
      has_critical_keyword: sh.isCritical,
      matched_keyword: sh.keyword,
    });
  });

  return {
    credentials: {
      ...DEFAULT_CREDENTIALS,
      account_balance_usdt: Number(currentBalance.toFixed(2)),
    },
    trades,
    signals,
    regime_logs,
    sentiment_logs,
    headlines,
    config: DEFAULT_CONFIG,
    config_profiles: {
      "Conservative Default": DEFAULT_CONFIG,
      "Aggressive Grid": {
        ...DEFAULT_CONFIG,
        ml_settings: {
          ...DEFAULT_CONFIG.ml_settings,
          entry_threshold_long: 0.72,
          entry_threshold_short: 0.28,
        },
        risk_management: {
          ...DEFAULT_CONFIG.risk_management,
          risk_per_trade_pct: 1.0,
        },
      },
    },
    config_history: [
      {
        id: "hist-1",
        timestamp: new Date(now - 4 * 3600 * 1000).toISOString(),
        category: "ml_settings",
        changed_by: "System Optimizer",
        changes: [
          { key: "entry_threshold_long", old_value: 0.85, new_value: 0.80 },
        ],
      },
    ],
  };
}

function generateMockPaperHistory(): { credentials: ExchangeCredentials; trades: Trade[]; signals: TradingSignal[] } {
  const trades: Trade[] = [];
  const signals: TradingSignal[] = [];
  const now = Date.now();
  let currentBalance = 100000; // Starting capital is $100,000 USDT for paper account
  const basePrice = 101250;

  for (let k = 15; k >= 1; k--) {
    const tradeHoursAgo = k * 4.2 + Math.random() * 2.5;
    const entryTime = new Date(now - tradeHoursAgo * 3600 * 1000);
    const exitTime = new Date(entryTime.getTime() + (12 + Math.floor(Math.random() * 15)) * 60000);

    const direction = Math.random() > 0.45 ? TradeDirection.LONG : TradeDirection.SHORT;
    const isWin = Math.random() > 0.38; // ~62% Win Rate for paper trading

    const entryPrice = basePrice + (direction === TradeDirection.LONG ? -150 : 150) + Math.random() * 800 - Math.random() * 800;
    const atrValue = 130 + Math.random() * 60;
    const stopDistance = atrValue * 1.3;
    const takeProfitDistance = stopDistance * 2.0;

    let exitPrice = entryPrice;
    let exitReason: ExitReason;

    if (isWin) {
      exitPrice = direction === TradeDirection.LONG ? entryPrice + takeProfitDistance : entryPrice - takeProfitDistance;
      exitReason = ExitReason.TAKE_PROFIT;
    } else {
      exitPrice = direction === TradeDirection.LONG ? entryPrice - stopDistance : entryPrice + stopDistance;
      exitReason = Math.random() > 0.8 ? ExitReason.TIME_LIMIT_29MIN : ExitReason.STOP_LOSS;
    }

    const tradeRiskUsdt = currentBalance * 0.005; // 0.5% risk
    const quantityBtc = Number((tradeRiskUsdt / stopDistance).toFixed(4));
    const leverage = 20;

    let pnlUsdt = 0;
    if (direction === TradeDirection.LONG) {
      pnlUsdt = (exitPrice - entryPrice) * quantityBtc;
    } else {
      pnlUsdt = (entryPrice - exitPrice) * quantityBtc;
    }

    const positionValue = entryPrice * quantityBtc;
    const feesPaid = positionValue * 0.0006 * 2;
    pnlUsdt -= feesPaid;

    currentBalance += pnlUsdt;

    const catboostProbability = direction === TradeDirection.LONG
      ? (isWin ? 0.80 + Math.random() * 0.14 : 0.69 + Math.random() * 0.10)
      : (isWin ? 0.06 + Math.random() * 0.10 : 0.16 + Math.random() * 0.12);

    const regime = direction === TradeDirection.LONG ? MarketRegime.STRONG_UPTREND : MarketRegime.STRONG_DOWNTREND;

    trades.push({
      id: `trade-paper-hist-${16 - k}`,
      entry_timestamp: entryTime.toISOString(),
      exit_timestamp: exitTime.toISOString(),
      direction,
      entry_price: Number(entryPrice.toFixed(2)),
      exit_price: Number(exitPrice.toFixed(2)),
      quantity_btc: quantityBtc,
      leverage,
      pnl_usdt: Number(pnlUsdt.toFixed(2)),
      pnl_pct: Number(((pnlUsdt / currentBalance) * 100).toFixed(4)),
      fees_paid_usdt: Number(feesPaid.toFixed(4)),
      exit_reason: exitReason,
      catboost_probability: Number(catboostProbability.toFixed(4)),
      regime_at_entry: regime,
      sentiment_score_at_entry: direction === TradeDirection.LONG ? 0.30 + Math.random() * 0.3 : -0.30 - Math.random() * 0.3,
      sentiment_momentum_at_entry: direction === TradeDirection.LONG ? 0.10 : -0.10,
      entry_signal_score: 80 + Math.floor(Math.random() * 18),
      max_favorable_excursion: isWin ? 2.0 : 0.3 + Math.random() * 0.5,
      max_adverse_excursion: isWin ? 0.2 + Math.random() * 0.4 : 1.30,
      hold_duration_seconds: Math.floor((exitTime.getTime() - entryTime.getTime()) / 1000),
      is_win: isWin,
      feature_snapshot: {
        last_price: entryPrice,
        atr_14: atrValue,
        regime,
        average_sentiment: direction === TradeDirection.LONG ? 0.35 : -0.35,
      },
      created_at: entryTime.toISOString(),
    });

    signals.push({
      id: `sig-paper-${16 - k}`,
      trade_id: `trade-paper-hist-${16 - k}`,
      timestamp: entryTime.toISOString(),
      catboost_probability: Number(catboostProbability.toFixed(4)),
      direction,
      regime_detected: regime,
      sentiment_score: direction === TradeDirection.LONG ? 0.40 : -0.38,
      sentiment_momentum: direction === TradeDirection.LONG ? 0.10 : -0.12,
      all_conditions_met: true,
      failed_conditions: [],
      executed: true,
      rejection_reason: null,
      created_at: entryTime.toISOString(),
    });
  }

  return {
    credentials: {
      ...DEFAULT_CREDENTIALS,
      id: "delta-exchange-paper-key",
      exchange_name: "Delta Exchange (Paper)",
      api_key: "PAPER_TRADING_API_KEY",
      api_secret: "PAPER_TRADING_API_SECRET",
      account_balance_usdt: Number(currentBalance.toFixed(2)),
      connection_status: ConnectionStatus.CONNECTED,
      last_tested_at: new Date().toISOString(),
      last_successful_connection: new Date().toISOString(),
      connection_error_message: null,
    },
    trades,
    signals,
  };
}

class DatabaseManager {
  private cache: DatabaseSchema | null = null;
  private paperCache: { credentials: ExchangeCredentials; trades: Trade[]; signals: TradingSignal[] } | null = null;
  private apiLogs: ApiCallLog[] = [];

  constructor() {
    this.init();
  }

  private init() {
    try {
      if (fs.existsSync(DB_FILE_PATH)) {
        const fileContent = fs.readFileSync(DB_FILE_PATH, "utf-8");
        this.cache = JSON.parse(fileContent);
        
        // Migrate legacy/default 2.0 Take Profit ratio to 3.5 to offset round-trip exchange fees
        if (this.cache && this.cache.config) {
          let updated = false;
          if (this.cache.config.risk_management) {
            if (!this.cache.config.risk_management.take_profit_ratio || this.cache.config.risk_management.take_profit_ratio <= 2.0) {
              this.cache.config.risk_management.take_profit_ratio = 3.5;
              updated = true;
            }
            if (this.cache.config.risk_management.min_atr_for_trading_enabled === undefined) {
              this.cache.config.risk_management.min_atr_for_trading_enabled = true;
              updated = true;
            }
            if (this.cache.config.risk_management.min_atr_for_trading_value === undefined) {
              this.cache.config.risk_management.min_atr_for_trading_value = 12;
              updated = true;
            }
          }
          if (this.cache.config.general) {
            if (this.cache.config.general.enable_trade_logging === undefined) {
              this.cache.config.general.enable_trade_logging = true;
              updated = true;
            }
          }
          if (updated) {
            this.save();
          }
        }
      } else {
        const mockData = generateMockHistory();
        this.cache = mockData;
        this.save();
      }
    } catch (e) {
      console.error("Failed to initialize database store, generating temporary memory-based database:", e);
      this.cache = generateMockHistory();
    }

    try {
      if (fs.existsSync(DB_PAPER_FILE_PATH)) {
        const fileContent = fs.readFileSync(DB_PAPER_FILE_PATH, "utf-8");
        this.paperCache = JSON.parse(fileContent);
      } else {
        const mockPaperData = generateMockPaperHistory();
        this.paperCache = mockPaperData;
        this.savePaper();
      }
    } catch (e) {
      console.error("Failed to initialize paper database store, using memory-based paper database:", e);
      this.paperCache = generateMockPaperHistory();
    }
  }

  private save() {
    try {
      if (this.cache) {
        fs.writeFileSync(DB_FILE_PATH, JSON.stringify(this.cache, null, 2), "utf-8");
      }
    } catch (e) {
      console.error("Failed to write state to db_store.json:", e);
    }
  }

  private savePaper() {
    try {
      if (this.paperCache) {
        fs.writeFileSync(DB_PAPER_FILE_PATH, JSON.stringify(this.paperCache, null, 2), "utf-8");
      }
    } catch (e) {
      console.error("Failed to write paper state to db_paper_store.json:", e);
    }
  }

  public isPaperMode(): boolean {
    return !!this.cache?.config?.general?.is_paper_trading;
  }

  public getCredentials(): ExchangeCredentials {
    if (this.isPaperMode()) {
      return this.paperCache!.credentials;
    }
    return this.cache!.credentials;
  }

  public updateCredentials(creds: Partial<ExchangeCredentials>): ExchangeCredentials {
    if (this.isPaperMode()) {
      this.paperCache!.credentials = {
        ...this.paperCache!.credentials,
        ...creds,
        updated_at: new Date().toISOString(),
      };
      this.savePaper();
      return this.paperCache!.credentials;
    }
    this.cache!.credentials = {
      ...this.cache!.credentials,
      ...creds,
      updated_at: new Date().toISOString(),
    };
    this.save();
    return this.cache!.credentials;
  }

  public getTrades(): Trade[] {
    if (this.isPaperMode()) {
      return this.paperCache!.trades;
    }
    return this.cache!.trades;
  }

  public getLiveTrades(): Trade[] {
    return this.cache!.trades;
  }

  public getPaperTrades(): Trade[] {
    return this.paperCache!.trades;
  }

  public getTradeById(id: string): Trade | undefined {
    return this.getTrades().find((t) => t.id === id);
  }

  public addTrade(trade: Omit<Trade, "id" | "created_at">): Trade {
    const isPaper = this.isPaperMode();
    const newTrade: Trade = {
      ...trade,
      id: isPaper 
        ? `trade-paper-${Date.now()}-${Math.floor(Math.random() * 1000)}`
        : `trade-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      created_at: new Date().toISOString(),
    };
    if (isPaper) {
      this.paperCache!.trades.unshift(newTrade);
      this.savePaper();
    } else {
      this.cache!.trades.unshift(newTrade);
      this.save();
    }
    return newTrade;
  }

  public updateTrade(id: string, updates: Partial<Trade>): Trade {
    const isPaper = this.isPaperMode();
    const list = isPaper ? this.paperCache!.trades : this.cache!.trades;
    const idx = list.findIndex((t) => t.id === id);
    if (idx === -1) {
      throw new Error(`Trade with ID ${id} not found`);
    }
    const updatedTrade = {
      ...list[idx],
      ...updates,
    };
    list[idx] = updatedTrade;
    if (isPaper) {
      this.savePaper();
    } else {
      this.save();
    }
    return updatedTrade;
  }

  public getSignals(): TradingSignal[] {
    if (this.isPaperMode()) {
      return this.paperCache!.signals;
    }
    return this.cache!.signals;
  }

  public addSignal(signal: Omit<TradingSignal, "id" | "created_at">): TradingSignal {
    const isPaper = this.isPaperMode();
    const newSignal: TradingSignal = {
      ...signal,
      id: isPaper ? `sig-paper-${Date.now()}` : `sig-${Date.now()}`,
      created_at: new Date().toISOString(),
    };
    if (isPaper) {
      this.paperCache!.signals.unshift(newSignal);
      if (this.paperCache!.signals.length > 300) {
        this.paperCache!.signals.pop();
      }
      this.savePaper();
    } else {
      this.cache!.signals.unshift(newSignal);
      if (this.cache!.signals.length > 300) {
        this.cache!.signals.pop();
      }
      this.save();
    }
    return newSignal;
  }

  public addRegimeLog(log: Omit<RegimeLog, "id" | "created_at">): RegimeLog {
    const newLog: RegimeLog = {
      ...log,
      id: `regime-log-${Date.now()}`,
      created_at: new Date().toISOString(),
    };
    this.cache!.regime_logs.unshift(newLog);
    if (this.cache!.regime_logs.length > 1000) {
      this.cache!.regime_logs.pop();
    }
    this.save();
    return newLog;
  }

  public addSentimentLog(log: Omit<SentimentLog, "id" | "created_at">): SentimentLog {
    const newLog: SentimentLog = {
      ...log,
      id: `sent-log-${Date.now()}`,
      created_at: new Date().toISOString(),
    };
    this.cache!.sentiment_logs.unshift(newLog);
    if (this.cache!.sentiment_logs.length > 500) {
      this.cache!.sentiment_logs.pop();
    }
    this.save();
    return newLog;
  }

  public getHeadlines(): NewsHeadline[] {
    return this.cache!.headlines;
  }

  public addHeadline(hl: Omit<NewsHeadline, "id">): NewsHeadline {
    const newHeadline: NewsHeadline = {
      ...hl,
      id: `hl-${Date.now()}`,
    };
    this.cache!.headlines.unshift(newHeadline);
    if (this.cache!.headlines.length > 200) {
      this.cache!.headlines.pop();
    }
    this.save();
    return newHeadline;
  }

  public getConfig(): StrategyConfig {
    let changed = false;
    if (this.cache?.config?.general) {
      if (!this.cache.config.general.skipped_gates) {
        this.cache.config.general.skipped_gates = [];
        changed = true;
      }
      if (this.cache.config.general.relative_volume_threshold === undefined) {
        this.cache.config.general.relative_volume_threshold = 1.3;
        changed = true;
      }
      if (this.cache.config.general.adx_threshold === undefined) {
        this.cache.config.general.adx_threshold = 22.0;
        changed = true;
      }
      if (!this.cache.config.general.timing_windows) {
        this.cache.config.general.timing_windows = DEFAULT_TIMING_WINDOWS;
        changed = true;
      }
      if (this.cache.config.general.enable_block_logging === undefined) {
        this.cache.config.general.enable_block_logging = true;
        changed = true;
      }
      if (this.cache.config.general.enable_orderflow_softening === undefined) {
        this.cache.config.general.enable_orderflow_softening = true;
        changed = true;
      }
      if (this.cache.config.general.orderflow_softening_percent === undefined) {
        this.cache.config.general.orderflow_softening_percent = 10;
        changed = true;
      }
      if (this.cache.config.general.order_book_min_depth === undefined) {
        this.cache.config.general.order_book_min_depth = 4.0;
        changed = true;
      }
      if (this.cache.config.general.order_book_max_imbalance === undefined) {
        this.cache.config.general.order_book_max_imbalance = 0.35;
        changed = true;
      }
      if (this.cache.config.general.regime_change_cooldown_minutes === undefined) {
        this.cache.config.general.regime_change_cooldown_minutes = 15;
        changed = true;
      }
      if (this.cache.config.general.regime_macro_slope_lookback === undefined) {
        this.cache.config.general.regime_macro_slope_lookback = 5;
        changed = true;
      }
      if (this.cache.config.general.regime_macro_slope_threshold === undefined) {
        this.cache.config.general.regime_macro_slope_threshold = 0.0005;
        changed = true;
      }
      if (this.cache.config.general.regime_ribbon_compression_threshold === undefined) {
        this.cache.config.general.regime_ribbon_compression_threshold = 0.0015;
        changed = true;
      }
      if (this.cache.config.general.require_volume_profile_in_ranging === undefined) {
        this.cache.config.general.require_volume_profile_in_ranging = true;
        changed = true;
      }
    }
    if (this.cache?.config?.risk_management) {
      if (this.cache.config.risk_management.default_quantity_btc === undefined) {
        this.cache.config.risk_management.default_quantity_btc = 0.001;
        changed = true;
      }
      if (this.cache.config.risk_management.consecutive_losses_cooldown_minutes === undefined) {
        this.cache.config.risk_management.consecutive_losses_cooldown_minutes = 30;
        changed = true;
      }
      if (this.cache.config.risk_management.simulate_paper_fees === undefined) {
        this.cache.config.risk_management.simulate_paper_fees = true;
        changed = true;
      }
      if (this.cache.config.risk_management.delta_india_gst_enabled === undefined) {
        this.cache.config.risk_management.delta_india_gst_enabled = true;
        changed = true;
      }
      if (this.cache.config.risk_management.delta_scalper_offer_enabled === undefined) {
        this.cache.config.risk_management.delta_scalper_offer_enabled = true;
        changed = true;
      }
      if (this.cache.config.risk_management.stop_loss_atr_multiplier === undefined || this.cache.config.risk_management.stop_loss_atr_multiplier <= 1.4) {
        this.cache.config.risk_management.stop_loss_atr_multiplier = 2.2;
        changed = true;
      }
      if (this.cache.config.risk_management.take_profit_ratio === undefined || this.cache.config.risk_management.take_profit_ratio > 3.0) {
        this.cache.config.risk_management.take_profit_ratio = 2.5;
        changed = true;
      }
      if (this.cache.config.risk_management.default_order_execution === undefined) {
        this.cache.config.risk_management.default_order_execution = "TAKER";
        changed = true;
      }
      if (this.cache.config.risk_management.trailing_stop_loss_enabled === undefined) {
        this.cache.config.risk_management.trailing_stop_loss_enabled = true;
        changed = true;
      }
      if (this.cache.config.risk_management.trailing_stop_loss_distance_atr === undefined || this.cache.config.risk_management.trailing_stop_loss_distance_atr <= 1.3) {
        this.cache.config.risk_management.trailing_stop_loss_distance_atr = 1.8;
        changed = true;
      }
      if (this.cache.config.risk_management.trailing_stop_loss_activation_ratio === undefined) {
        this.cache.config.risk_management.trailing_stop_loss_activation_ratio = 1.2;
        changed = true;
      }
      if (this.cache.config.risk_management.min_stop_loss_distance_usd === undefined) {
        this.cache.config.risk_management.min_stop_loss_distance_usd = 80;
        changed = true;
      }
      if (this.cache.config.risk_management.min_stop_loss_distance_pct === undefined) {
        this.cache.config.risk_management.min_stop_loss_distance_pct = 0.12;
        changed = true;
      }
      if (this.cache.config.risk_management.static_stop_loss_enabled === undefined) {
        this.cache.config.risk_management.static_stop_loss_enabled = false;
        changed = true;
      }
      if (this.cache.config.risk_management.static_stop_loss_value_usd === undefined) {
        this.cache.config.risk_management.static_stop_loss_value_usd = 150;
        changed = true;
      }
      if (this.cache.config.risk_management.max_atr_for_stop_loss_enabled === undefined) {
        this.cache.config.risk_management.max_atr_for_stop_loss_enabled = false;
        changed = true;
      }
      if (this.cache.config.risk_management.max_atr_for_stop_loss_value === undefined) {
        this.cache.config.risk_management.max_atr_for_stop_loss_value = 100;
        changed = true;
      }
      if (this.cache.config.risk_management.overextension_ema_trending_threshold === undefined) {
        this.cache.config.risk_management.overextension_ema_trending_threshold = 2.2;
        changed = true;
      }
      if (this.cache.config.risk_management.overextension_ema_ranging_threshold === undefined) {
        this.cache.config.risk_management.overextension_ema_ranging_threshold = 1.2;
        changed = true;
      }
      if (this.cache.config.risk_management.overextension_vwap_trending_multiplier === undefined) {
        this.cache.config.risk_management.overextension_vwap_trending_multiplier = 1.5;
        changed = true;
      }
      if (this.cache.config.risk_management.overextension_vwap_ranging_multiplier === undefined) {
        this.cache.config.risk_management.overextension_vwap_ranging_multiplier = 1.0;
        changed = true;
      }
    }

    if (!this.cache?.config?.market_structure) {
      this.cache!.config.market_structure = { ...DEFAULT_CONFIG.market_structure };
      changed = true;
    } else {
      const ms = this.cache!.config.market_structure;
      const def = DEFAULT_CONFIG.market_structure;
      if (ms.min_breakout_body_ratio === undefined) { ms.min_breakout_body_ratio = def.min_breakout_body_ratio; changed = true; }
      if (ms.allow_immediate_breakout === undefined) { ms.allow_immediate_breakout = def.allow_immediate_breakout; changed = true; }
      if (ms.hf_momentum_adx_threshold === undefined) { ms.hf_momentum_adx_threshold = def.hf_momentum_adx_threshold; changed = true; }
      if (ms.hf_orderflow_taker_buy_ratio_long === undefined) { ms.hf_orderflow_taker_buy_ratio_long = def.hf_orderflow_taker_buy_ratio_long; changed = true; }
      if (ms.hf_orderflow_imbalance_ratio_long === undefined) { ms.hf_orderflow_imbalance_ratio_long = def.hf_orderflow_imbalance_ratio_long; changed = true; }
      if (ms.hf_orderflow_taker_buy_ratio_short === undefined) { ms.hf_orderflow_taker_buy_ratio_short = def.hf_orderflow_taker_buy_ratio_short; changed = true; }
      if (ms.hf_orderflow_imbalance_ratio_short === undefined) { ms.hf_orderflow_imbalance_ratio_short = def.hf_orderflow_imbalance_ratio_short; changed = true; }
      if (ms.pullback_multiplier_limit === undefined) { ms.pullback_multiplier_limit = def.pullback_multiplier_limit; changed = true; }
      if (ms.ema_retrace_multiplier_limit === undefined) { ms.ema_retrace_multiplier_limit = def.ema_retrace_multiplier_limit; changed = true; }
      if (ms.pullback_volume_dryup_threshold_mult === undefined) { ms.pullback_volume_dryup_threshold_mult = def.pullback_volume_dryup_threshold_mult ?? 1.5; changed = true; }
      if (ms.pullback_volume_breakout_ratio === undefined) { ms.pullback_volume_breakout_ratio = def.pullback_volume_breakout_ratio ?? 0.85; changed = true; }
      if (ms.bypass_ema200_on_momentum === undefined) { ms.bypass_ema200_on_momentum = def.bypass_ema200_on_momentum; changed = true; }
      if (ms.ema200_proximity_divisor === undefined) { ms.ema200_proximity_divisor = def.ema200_proximity_divisor; changed = true; }
      if (ms.weak_trend_adx_threshold === undefined) { ms.weak_trend_adx_threshold = def.weak_trend_adx_threshold; changed = true; }
      if (ms.trend_alignment_adx_threshold === undefined) { ms.trend_alignment_adx_threshold = def.trend_alignment_adx_threshold || 30; changed = true; }
      if (ms.super_trend_adx_threshold === undefined) { ms.super_trend_adx_threshold = def.super_trend_adx_threshold || 35; changed = true; }
      if (ms.fast_ema_period === undefined) { ms.fast_ema_period = def.fast_ema_period || 20; changed = true; }
      if (ms.medium_ema_period === undefined) { ms.medium_ema_period = def.medium_ema_period || 50; changed = true; }
      if (ms.slow_ema_period === undefined) { ms.slow_ema_period = def.slow_ema_period || 200; changed = true; }
      if (ms.micro_trend_alignment_enabled === undefined) { ms.micro_trend_alignment_enabled = def.micro_trend_alignment_enabled !== false; changed = true; }
      if (ms.micro_trend_fast_period === undefined) { ms.micro_trend_fast_period = def.micro_trend_fast_period || 5; changed = true; }
      if (ms.micro_trend_slow_period === undefined) { ms.micro_trend_slow_period = def.micro_trend_slow_period || 15; changed = true; }
      if (ms.fallback_crossover_enabled === undefined) { ms.fallback_crossover_enabled = def.fallback_crossover_enabled !== false; changed = true; }
      if (ms.fallback_crossover_fast_period === undefined) { ms.fallback_crossover_fast_period = def.fallback_crossover_fast_period || 5; changed = true; }
      if (ms.fallback_crossover_slow_period === undefined) { ms.fallback_crossover_slow_period = def.fallback_crossover_slow_period || 15; changed = true; }
      if (ms.fallback_crossover_bounce_atr_fraction === undefined) { ms.fallback_crossover_bounce_atr_fraction = def.fallback_crossover_bounce_atr_fraction ?? 0.15; changed = true; }
      if (ms.fallback_crossover_invalidation_atr_fraction === undefined) { ms.fallback_crossover_invalidation_atr_fraction = def.fallback_crossover_invalidation_atr_fraction ?? 0.25; changed = true; }
      if (ms.crossover_only_strategy_enabled === undefined) { ms.crossover_only_strategy_enabled = def.crossover_only_strategy_enabled ?? false; changed = true; }
      if (ms.crossover_only_fast_period === undefined) { ms.crossover_only_fast_period = def.crossover_only_fast_period || 5; changed = true; }
      if (ms.crossover_only_slow_period === undefined) { ms.crossover_only_slow_period = def.crossover_only_slow_period || 15; changed = true; }
      if (ms.crossover_only_rsi_limit === undefined) { ms.crossover_only_rsi_limit = def.crossover_only_rsi_limit !== undefined ? def.crossover_only_rsi_limit : 70; changed = true; }
      if (ms.crossover_only_adx_threshold === undefined) { ms.crossover_only_adx_threshold = def.crossover_only_adx_threshold !== undefined ? def.crossover_only_adx_threshold : 25; changed = true; }
      if (ms.timeframe_minutes === undefined) { ms.timeframe_minutes = def.timeframe_minutes || 5; changed = true; }
      if (ms.very_high_probability_threshold === undefined) { ms.very_high_probability_threshold = def.very_high_probability_threshold || 0.82; changed = true; }
    }

    if (!this.cache?.config?.gate_scoring) {
      this.cache!.config.gate_scoring = { ...DEFAULT_CONFIG.gate_scoring };
      changed = true;
    } else {
      const gs = this.cache!.config.gate_scoring;
      const def = DEFAULT_CONFIG.gate_scoring;
      if (gs.enabled === undefined) { gs.enabled = def.enabled; changed = true; }
      if (gs.confidence_threshold === undefined) { gs.confidence_threshold = def.confidence_threshold; changed = true; }
      if (gs.enable_weight_discounting === undefined) { gs.enable_weight_discounting = def.enable_weight_discounting; changed = true; }
      if (gs.softened_gate_discount_factor === undefined) { gs.softened_gate_discount_factor = def.softened_gate_discount_factor; changed = true; }
      if (!gs.weights) {
        gs.weights = { ...def.weights };
        changed = true;
      } else {
        if (gs.weights.catboost_ai === undefined) { gs.weights.catboost_ai = def.weights.catboost_ai; changed = true; }
        if (gs.weights.market_regime === undefined) { gs.weights.market_regime = def.weights.market_regime; changed = true; }
        if (gs.weights.trend_alignment === undefined) { gs.weights.trend_alignment = def.weights.trend_alignment; changed = true; }
        if (gs.weights.relative_volume === undefined) { gs.weights.relative_volume = def.weights.relative_volume; changed = true; }
        if (gs.weights.overextension === undefined) { gs.weights.overextension = def.weights.overextension; changed = true; }
        if (gs.weights.wedge_filter === undefined) { gs.weights.wedge_filter = def.weights.wedge_filter; changed = true; }
        if (gs.weights.order_flow === undefined) { gs.weights.order_flow = def.weights.order_flow; changed = true; }
        if (gs.weights.squeeze_filter === undefined) { gs.weights.squeeze_filter = def.weights.squeeze_filter; changed = true; }
        if (gs.weights.order_book === undefined) { gs.weights.order_book = def.weights.order_book; changed = true; }
        if (gs.weights.volume_profile === undefined) { gs.weights.volume_profile = def.weights.volume_profile ?? 10; changed = true; }
      }
      if (!gs.adaptive_modifiers) {
        gs.adaptive_modifiers = { ...def.adaptive_modifiers };
        changed = true;
      } else {
        if (!gs.adaptive_modifiers.trending) { gs.adaptive_modifiers.trending = { ...def.adaptive_modifiers.trending }; changed = true; }
        else if (gs.adaptive_modifiers.trending.volume_profile_weight_boost === undefined) { gs.adaptive_modifiers.trending.volume_profile_weight_boost = def.adaptive_modifiers.trending.volume_profile_weight_boost ?? -5; changed = true; }

        if (!gs.adaptive_modifiers.ranging) { gs.adaptive_modifiers.ranging = { ...def.adaptive_modifiers.ranging }; changed = true; }
        else if (gs.adaptive_modifiers.ranging.volume_profile_weight_boost === undefined) { gs.adaptive_modifiers.ranging.volume_profile_weight_boost = def.adaptive_modifiers.ranging.volume_profile_weight_boost ?? 10; changed = true; }

        if (!gs.adaptive_modifiers.high_volatility) { gs.adaptive_modifiers.high_volatility = { ...def.adaptive_modifiers.high_volatility }; changed = true; }
        else if (gs.adaptive_modifiers.high_volatility.volume_profile_weight_boost === undefined) { gs.adaptive_modifiers.high_volatility.volume_profile_weight_boost = def.adaptive_modifiers.high_volatility.volume_profile_weight_boost ?? 5; changed = true; }

        if (!gs.adaptive_modifiers.low_volatility) { gs.adaptive_modifiers.low_volatility = { ...def.adaptive_modifiers.low_volatility }; changed = true; }
        else if (gs.adaptive_modifiers.low_volatility.volume_profile_weight_boost === undefined) { gs.adaptive_modifiers.low_volatility.volume_profile_weight_boost = def.adaptive_modifiers.low_volatility.volume_profile_weight_boost ?? 0; changed = true; }
      }
    }

    if (changed) {
      this.save();
    }
    return this.cache!.config;
  }

  public updateConfig(category: keyof StrategyConfig, updates: any, changedBy = "Admin UI"): StrategyConfig {
    const oldVal = { ...this.cache!.config[category] };
    const newVal = { ...oldVal, ...updates };

    this.cache!.config[category] = newVal as any;

    const changesList = Object.keys(updates).map((key) => ({
      key: `${category}.${key}`,
      old_value: oldVal[key],
      new_value: updates[key],
    }));

    if (changesList.length > 0) {
      this.cache!.config_history.unshift({
        id: `change-${Date.now()}`,
        timestamp: new Date().toISOString(),
        category,
        changed_by: changedBy,
        changes: changesList,
      });

      if (this.cache!.config_history.length > 100) {
        this.cache!.config_history.pop();
      }
    }

    this.save();
    return this.cache!.config;
  }

  public getProfiles(): Record<string, StrategyConfig> {
    return this.cache!.config_profiles;
  }

  public saveProfile(name: string, config: StrategyConfig) {
    this.cache!.config_profiles[name] = config;
    this.save();
  }

  public deleteProfile(name: string) {
    delete this.cache!.config_profiles[name];
    this.save();
  }

  public loadProfile(name: string): StrategyConfig {
    const profile = this.cache!.config_profiles[name];
    if (!profile) {
      throw new Error(`Profile ${name} not found`);
    }
    this.cache!.config = { ...profile };
    this.save();
    return this.cache!.config;
  }

  public getConfigHistory(): ConfigHistoryEntry[] {
    return this.cache!.config_history;
  }

  public getAnalyticsSummary(): any {
    const trades = this.getTrades().filter((t) => t.exit_price !== null);
    const winTrades = trades.filter((t) => t.is_win);
    const lossTrades = trades.filter((t) => !t.is_win);

    const totalTrades = trades.length;
    const wins = winTrades.length;
    const losses = lossTrades.length;
    const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;

    const grossProfit = winTrades.reduce((acc, t) => acc + (t.pnl_usdt || 0), 0);
    const grossLoss = Math.abs(lossTrades.reduce((acc, t) => acc + (t.pnl_usdt || 0), 0));
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 99.9 : 0;

    const netProfit = trades.reduce((acc, t) => acc + (t.pnl_usdt || 0), 0);
    const totalFees = trades.reduce((acc, t) => acc + (t.fees_paid_usdt || 0), 0);

    // Calculate max drawdown on our trades list
    let runningBalance = 100000;
    let peak = 100000;
    let maxDd = 0;
    const sortedTradesAsc = [...trades].sort(
      (a, b) => new Date(a.entry_timestamp).getTime() - new Date(b.entry_timestamp).getTime()
    );

    sortedTradesAsc.forEach((t) => {
      runningBalance += t.pnl_usdt || 0;
      if (runningBalance > peak) peak = runningBalance;
      const dd = peak - runningBalance;
      if (dd > maxDd) maxDd = dd;
    });

    // Sharpe ratio (approximation)
    const returns = sortedTradesAsc.map((t) => t.pnl_pct || 0);
    const avgReturn = returns.reduce((acc, r) => acc + r, 0) / (returns.length || 1);
    const variance = returns.reduce((acc, r) => acc + Math.pow(r - avgReturn, 2), 0) / (returns.length || 1);
    const stdDev = Math.sqrt(variance);
    const sharpeRatio = stdDev > 0 ? (avgReturn / stdDev) * Math.sqrt(252 * 4) : 0; // scaled for short timeline

    return {
      total_trades: totalTrades,
      wins,
      losses,
      win_rate: Number(winRate.toFixed(2)),
      profit_factor: Number(profitFactor.toFixed(2)),
      net_profit_usdt: Number(netProfit.toFixed(2)),
      fees_paid_usdt: Number(totalFees.toFixed(2)),
      max_drawdown_usdt: Number(maxDd.toFixed(2)),
      sharpe_ratio: Number(sharpeRatio.toFixed(2)),
      current_balance: this.getCredentials().account_balance_usdt,
    };
  }

  public getEquityCurve(): { timestamp: string; balance: number }[] {
    const trades = this.getTrades().filter((t) => t.exit_price !== null);
    const sortedTradesAsc = [...trades].sort(
      (a, b) => new Date(a.entry_timestamp).getTime() - new Date(b.entry_timestamp).getTime()
    );

    let runningBalance = 100000;
    const curve = [{ timestamp: new Date(Date.now() - 3 * 24 * 3600000).toISOString(), balance: 100000 }];

    sortedTradesAsc.forEach((t) => {
      runningBalance += t.pnl_usdt || 0;
      curve.push({
        timestamp: t.exit_timestamp || t.entry_timestamp,
        balance: Number(runningBalance.toFixed(2)),
      });
    });

    return curve;
  }

  public getDailyBreakdown(): DailyStats[] {
    const trades = this.getTrades().filter((t) => t.exit_price !== null);
    const grouped: Record<string, Trade[]> = {};

    trades.forEach((t) => {
      const dateStr = t.entry_timestamp.split("T")[0];
      if (!grouped[dateStr]) grouped[dateStr] = [];
      grouped[dateStr].push(t);
    });

    const breakdown: DailyStats[] = [];

    Object.keys(grouped)
      .sort()
      .forEach((date) => {
        const dayTrades = grouped[date];
        const dayWins = dayTrades.filter((t) => t.is_win);
        const dayLosses = dayTrades.filter((t) => !t.is_win);
        const dayWinsCount = dayWins.length;
        const dayLossesCount = dayLosses.length;
        const total = dayTrades.length;
        const winRate = total > 0 ? (dayWinsCount / total) * 100 : 0;

        const dayGrossProfit = dayWins.reduce((acc, t) => acc + (t.pnl_usdt || 0), 0);
        const dayGrossLoss = Math.abs(dayLosses.reduce((acc, t) => acc + (t.pnl_usdt || 0), 0));
        const profitFactor = dayGrossLoss > 0 ? dayGrossProfit / dayGrossLoss : dayGrossProfit > 0 ? 99.9 : 0;

        const netProfit = dayTrades.reduce((acc, t) => acc + (t.pnl_usdt || 0), 0);

        breakdown.push({
          date,
          total_trades: total,
          wins: dayWinsCount,
          losses: dayLossesCount,
          win_rate: Number(winRate.toFixed(2)),
          profit_factor: Number(profitFactor.toFixed(2)),
          net_profit_usdt: Number(netProfit.toFixed(2)),
          max_drawdown_usdt: 0, // Simplified daily drawdown
        });
      });

    return breakdown;
  }

  public getPerformanceByRegime(): Record<string, { trades: number; win_rate: number; pnl: number }> {
    const trades = this.getTrades().filter((t) => t.exit_price !== null);
    const analysis: Record<string, { trades: number; wins: number; pnl: number }> = {
      [MarketRegime.STRONG_UPTREND]: { trades: 0, wins: 0, pnl: 0 },
      [MarketRegime.STRONG_DOWNTREND]: { trades: 0, wins: 0, pnl: 0 },
      [MarketRegime.RANGE_BOUND]: { trades: 0, wins: 0, pnl: 0 },
      [MarketRegime.HIGH_VOLATILITY]: { trades: 0, wins: 0, pnl: 0 },
      [MarketRegime.LOW_VOLATILITY]: { trades: 0, wins: 0, pnl: 0 },
    };

    trades.forEach((t) => {
      const r = t.regime_at_entry;
      if (analysis[r]) {
        analysis[r].trades += 1;
        if (t.is_win) analysis[r].wins += 1;
        analysis[r].pnl += t.pnl_usdt || 0;
      }
    });

    const result: Record<string, { trades: number; win_rate: number; pnl: number }> = {};
    Object.keys(analysis).forEach((r) => {
      const data = analysis[r];
      result[r] = {
        trades: data.trades,
        win_rate: data.trades > 0 ? Number(((data.wins / data.trades) * 100).toFixed(2)) : 0,
        pnl: Number(data.pnl.toFixed(2)),
      };
    });

    return result;
  }

  public clearTrades(mode: "live" | "paper" | "both") {
    if (mode === "live" || mode === "both") {
      if (this.cache) {
        this.cache.trades = [];
        this.save();
      }
    }
    if (mode === "paper" || mode === "both") {
      if (this.paperCache) {
        this.paperCache.trades = [];
        this.savePaper();
      }
    }
  }

  public addApiLog(log: Omit<ApiCallLog, "id" | "timestamp">) {
    const fullLog: ApiCallLog = {
      ...log,
      id: "log_" + Math.random().toString(36).substring(2, 11),
      timestamp: new Date().toISOString(),
    };
    this.apiLogs.unshift(fullLog);
    if (this.apiLogs.length > 50) {
      this.apiLogs.pop();
    }
    return fullLog;
  }

  public getApiLogs() {
    return this.apiLogs;
  }
}

export const dbManager = new DatabaseManager();
