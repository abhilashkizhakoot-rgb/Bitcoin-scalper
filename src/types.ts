/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export enum ConnectionStatus {
  NOT_CONFIGURED = "NOT_CONFIGURED",
  TESTING = "TESTING",
  CONNECTED = "CONNECTED",
  FAILED = "FAILED",
  EXPIRED = "EXPIRED",
  DISABLED = "DISABLED",
}

export enum TradeDirection {
  LONG = "LONG",
  SHORT = "SHORT",
}

export enum ExitReason {
  TAKE_PROFIT = "TAKE_PROFIT",
  STOP_LOSS = "STOP_LOSS",
  TIME_LIMIT_29MIN = "TIME_LIMIT_29MIN",
  SENTIMENT_REVERSAL = "SENTIMENT_REVERSAL",
  REGIME_CHANGE = "REGIME_CHANGE",
  CIRCUIT_BREAKER = "CIRCUIT_BREAKER",
  MANUAL_EXIT = "MANUAL_EXIT",
}

export enum MarketRegime {
  STRONG_UPTREND = "STRONG_UPTREND",
  STRONG_DOWNTREND = "STRONG_DOWNTREND",
  RANGE_BOUND = "RANGE_BOUND",
  HIGH_VOLATILITY = "HIGH_VOLATILITY",
  LOW_VOLATILITY = "LOW_VOLATILITY",
}

export enum NewsSource {
  COINDESK = "COINDESK",
  COINTELEGRAPH = "COINTELEGRAPH",
  THEBLOCK = "THEBLOCK",
  BITCOIN_MAGAZINE = "BITCOIN_MAGAZINE",
  TWITTER = "TWITTER",
  REDDIT = "REDDIT",
  CRYPTOPANIC = "CRYPTOPANIC",
}

export interface ExchangeCredentials {
  id: string;
  exchange_name: string;
  api_url: string;
  ws_url: string;
  api_key: string;
  api_secret: string; // Partially masked when returned to frontend
  connection_status: ConnectionStatus;
  last_tested_at: string | null;
  last_successful_connection: string | null;
  connection_error_message: string | null;
  account_balance_usdt: number;
  account_email: string;
  product_id: number;
  product_symbol: string;
  is_testnet: boolean;
  is_india: boolean;
  created_at: string;
  updated_at: string;
}

export interface Trade {
  id: string;
  entry_timestamp: string;
  exit_timestamp: string | null;
  direction: TradeDirection;
  entry_price: number;
  exit_price: number | null;
  quantity_btc: number;
  leverage: number;
  pnl_usdt: number | null;
  pnl_pct: number | null;
  fees_paid_usdt: number;
  exit_reason: ExitReason | null;
  catboost_probability: number;
  regime_at_entry: MarketRegime;
  sentiment_score_at_entry: number;
  sentiment_momentum_at_entry: number;
  entry_signal_score: number;
  max_favorable_excursion: number; // Max price reach in trade direction %
  max_adverse_excursion: number; // Max drawdown in trade direction %
  hold_duration_seconds: number;
  is_win: boolean | null;
  feature_snapshot: Record<string, any>;
  created_at: string;
}

export interface TradingSignal {
  id: string;
  trade_id: string | null;
  timestamp: string;
  catboost_probability: number;
  direction: TradeDirection | "NEUTRAL";
  regime_detected: MarketRegime;
  sentiment_score: number;
  sentiment_momentum: number;
  all_conditions_met: boolean;
  failed_conditions: string[];
  executed: boolean;
  rejection_reason: string | null;
  created_at: string;
}

export interface RegimeLog {
  id: string;
  detected_at: string;
  regime: MarketRegime;
  confidence: number;
  adx_value: number;
  atr_expansion_ratio: number;
  bb_width_percentile: number;
  ema_structure: string;
  realized_volatility: number;
  volume_expansion: number;
  created_at: string;
}

export interface SentimentLog {
  id: string;
  refreshed_at: string;
  source: NewsSource;
  headline_count: number;
  positive_count: number;
  neutral_count: number;
  negative_count: number;
  current_sentiment: number;
  sentiment_30m_avg: number;
  sentiment_1h_avg: number;
  sentiment_4h_avg: number;
  sentiment_momentum: number;
  sentiment_volatility: number;
  news_intensity_30m: number;
  news_intensity_60m: number;
  processing_time_ms: number;
  created_at: string;
}

export interface NewsHeadline {
  id: string;
  timestamp: string;
  source: NewsSource;
  headline: string;
  sentiment_score: number; // -1 to +1
  category: "NEUTRAL" | "BULLISH" | "BEARISH";
  has_critical_keyword: boolean;
  matched_keyword: string | null;
}

export interface TimingWindow {
  id: string;
  name: string;
  start_time: string; // "HH:MM" (IST)
  end_time: string;   // "HH:MM" (IST)
  allowed: boolean;
  description: string;
}

export interface StrategyConfig {
  general: {
    is_trading_active: boolean;
    cooldown_minutes: number;
    max_trades_per_day: number;
    is_paper_trading: boolean;
    skipped_gates?: string[];
    required_gates?: string[];
    mandatory_gates?: string[];
    weighted_gates?: string[];
    relative_volume_threshold?: number;
    adx_threshold?: number;
    timing_windows?: TimingWindow[];
    regime_candle_interval_minutes?: number;
    data_feed_source?: "BINANCE" | "DELTA_EXCHANGE";
    enable_block_logging?: boolean;
    enable_trade_logging?: boolean;
    enable_orderflow_softening?: boolean;
    orderflow_softening_percent?: number;
    order_book_min_depth?: number;
    order_book_max_imbalance?: number;
    order_book_max_spoof_risk?: number;
    regime_change_cooldown_minutes?: number;
    regime_macro_slope_lookback?: number;
    regime_macro_slope_threshold?: number;
    regime_ribbon_compression_threshold?: number;
    require_volume_profile_in_ranging?: boolean;
    regime_adaptive_gates_enabled?: boolean;
    regime_adaptive_preset?: "BALANCED_ADAPTIVE" | "DEFENSIVE_STRICT" | "AGGRESSIVE_TREND" | "CUSTOM";
    regime_gate_overrides?: Record<string, {
      mandatory_gates?: string[];
      weighted_gates?: string[];
      bypassed_gates?: string[];
    }>;
  };
  ml_settings: {
    entry_threshold_long: number; // e.g. 0.80
    entry_threshold_short: number; // e.g. 0.20
    model_version: string;
    last_trained_at: string;
    training_window_months: number;
    validation_auc: number;
    auto_retrain_weekly: boolean;
    retrain_on_perf_drop: boolean;
  };
  sentiment_settings: {
    entry_threshold_long: number; // e.g. 0.25
    entry_threshold_short: number; // e.g. -0.25
    require_momentum_long: boolean;
    require_momentum_short: boolean;
    block_on_critical_keywords: boolean;
    protection_window_minutes: number;
    critical_keywords: string[];
    weights: Record<NewsSource, number>;
    refresh_rates_min: Record<NewsSource, number>;
  };
  risk_management: {
    risk_per_trade_pct: number; // e.g. 0.5
    max_risk_per_trade_pct: number; // e.g. 1.0
    stop_loss_atr_multiplier: number; // e.g. 1.3
    take_profit_ratio: number; // e.g. 2.0 (1:2 R:R)
    max_consecutive_losses: number; // e.g. 3
    consecutive_losses_cooldown_minutes: number; // e.g. 30
    daily_loss_limit_pct: number; // e.g. 2.0
    weekly_loss_limit_pct: number; // e.g. 5.0
    intra_trade_drawdown_limit_pct: number; // e.g. 1.5
    leverage: number; // leverage setting (e.g. 10x, 20x, 50x)
    default_quantity_btc: number; // default trading size (e.g. 0.001)
    simulate_paper_fees?: boolean; // Whether to simulate exchange fees in paper mode
    delta_india_gst_enabled?: boolean; // Whether to apply 18% GST to trading fees
    delta_scalper_offer_enabled?: boolean; // Pay zero closing fee if trade is closed within 30 minutes
    default_order_execution?: "MAKER" | "TAKER"; // Default order execution type
    trailing_stop_loss_enabled?: boolean; // Dynamic trailing stop loss trigger
    trailing_stop_loss_distance_atr?: number; // ATR distance multiplier for trailing
    trailing_stop_loss_activation_ratio?: number; // Multiple of initial stop loss distance to activate trailing (e.g. 1.2x)
    min_stop_loss_distance_usd?: number; // Minimum USD distance floor for stop loss
    min_stop_loss_distance_pct?: number; // Minimum percentage distance floor for stop loss (e.g. 0.12 for 0.12%)
    static_stop_loss_enabled?: boolean; // Enable/disable static stop loss override
    static_stop_loss_value_usd?: number; // Static stop loss distance in USD
    max_atr_for_stop_loss_enabled?: boolean; // Enable/disable maximum ATR cap for stop loss calculation
    max_atr_for_stop_loss_value?: number; // Maximum ATR value to cap at
    min_atr_for_trading_enabled?: boolean; // Enable/disable minimum ATR floor for trading
    min_atr_for_trading_value?: number; // Minimum ATR value below which trading is blocked
    overextension_ema_trending_threshold?: number; // EMA overextension threshold in trending markets (default: 2.2)
    overextension_ema_ranging_threshold?: number; // EMA overextension threshold in ranging/other markets (default: 1.2)
    overextension_vwap_trending_multiplier?: number; // VWAP band multiplier in trending markets (default: 1.5)
    overextension_vwap_ranging_multiplier?: number; // VWAP band multiplier in ranging/other markets (default: 1.0)
  };
  market_structure: {
    min_breakout_body_ratio: number; // e.g. 0.22 (22% body ratio)
    allow_immediate_breakout: boolean; // e.g. true (momentum chasing)
    hf_momentum_adx_threshold: number; // e.g. 30 (strong ADX breakout threshold)
    hf_orderflow_taker_buy_ratio_long: number; // e.g. 0.58 (Taker Buy Ratio for immediate entry)
    hf_orderflow_imbalance_ratio_long: number; // e.g. 0.30 (Imbalance Ratio for immediate entry)
    hf_orderflow_taker_buy_ratio_short: number; // e.g. 0.42 (Taker Buy Ratio for immediate entry)
    hf_orderflow_imbalance_ratio_short: number; // e.g. -0.30 (Imbalance Ratio for immediate entry)
    pullback_multiplier_limit: number; // e.g. 0.6 (Minimum allowed retrace factor)
    ema_retrace_multiplier_limit: number; // e.g. 0.4 (EMA dynamic support/resistance)
    pullback_volume_dryup_threshold_mult?: number; // Multiplier of average volume for pullback dry-up (default: 1.5)
    pullback_volume_breakout_ratio?: number; // Ratio of breakout volume for pullback (default: 0.85)
    bypass_ema200_on_momentum: boolean; // e.g. true (By-pass EMA 200 restriction on strong ADX/orderflow)
    ema200_proximity_divisor: number; // e.g. 3.0 (Scale down proximity barriers)
    weak_trend_adx_threshold: number; // e.g. 25 (Threshold above which trend EMAs are fast-aligned)
    trend_alignment_adx_threshold?: number; // ADX threshold for strong trend alignment (default: 30)
    super_trend_adx_threshold?: number; // ADX threshold for super strong trend (default: 35)
    fast_ema_period?: number; // Fast EMA period (default: 20)
    medium_ema_period?: number; // Medium EMA period (default: 50)
    slow_ema_period?: number; // Slow EMA period (default: 200)
    micro_trend_alignment_enabled?: boolean; // Enable Micro-Trend Alignment Filter (default: true)
    micro_trend_fast_period?: number; // Fast period for micro-trend tracking (default: 5)
    micro_trend_slow_period?: number; // Slow period for micro-trend tracking (default: 15)
    fallback_crossover_enabled?: boolean; // Enable Fallback Crossover Confirmation (default: true)
    fallback_crossover_fast_period?: number; // Fast period for fallback crossover (default: 5)
    fallback_crossover_slow_period?: number; // Slow period for fallback crossover (default: 15)
    fallback_crossover_bounce_atr_fraction?: number; // Bounce confirmation multiplier of ATR (default: 0.15)
    fallback_crossover_invalidation_atr_fraction?: number; // Crossover invalidation multiplier of ATR (default: 0.25)
    crossover_only_strategy_enabled?: boolean; // Enable/disable isolated 5/15 crossover only strategy
    crossover_only_fast_period?: number; // Fast EMA period for the crossover-only strategy
    crossover_only_slow_period?: number; // Slow EMA period for the crossover-only strategy
    crossover_only_rsi_limit?: number; // RSI limit to prevent overbought longs (>limit) or oversold shorts (<100-limit) (default: 70)
    crossover_only_adx_threshold?: number; // Minimum ADX to confirm strong trend for crossover (default: 25)
    crossover_only_lookback_candles?: number; // Max lookback candles for crossover event check (default: 5)
    timeframe_minutes?: number; // Market Structure Timeframe in minutes (default: 5)
    very_high_probability_threshold?: number; // Probability threshold above which direct breakouts are traded, otherwise waiting for pullback (default: 0.82)
    liquidity_sweep_enabled?: boolean; // Enable Liquidity Sweep Strategy (Setup 3) (default: true)
    liquidity_sweep_lookback_candles?: number; // Lookback candles to identify liquidity pools (default: 20)
    liquidity_sweep_min_wick_ratio?: number; // Minimum wick ratio for sweep candle (default: 0.35)
    liquidity_sweep_volume_mult?: number; // Minimum volume multiplier for liquidity sweep (default: 1.0)
    choch_confirmation_enabled?: boolean; // Require Change of Character (CHoCH) post-sweep confirmation
    fvg_strategy_enabled?: boolean; // Enable Fair Value Gap (FVG) / Inefficiency Retest Strategy
    fvg_min_gap_atr_ratio?: number; // Minimum FVG gap size relative to ATR (default 0.12)
    fvg_entry_level?: "BOUNDARY" | "CONSEQUENT_ENCROACHMENT"; // Entry on FVG boundary or 50% midpoint (CE)
    eqh_eql_detection_enabled?: boolean; // Enable Equal Highs / Equal Lows Liquidity Pool Detector
    eqh_eql_tolerance_pct?: number; // Tolerance % for EQH/EQL touches (default 0.08%)
    order_block_strategy_enabled?: boolean; // Enable Institutional Order Block (OB) Retest Strategy
    asian_session_sweep_enabled?: boolean; // Enable Asian Session High/Low Sweep Strategy
    smc_tp_targeting_enabled?: boolean; // Enable SMC Dynamic Take-Profit targeting opposing liquidity
  };
  gate_scoring?: {
    enabled: boolean;
    confidence_threshold: number; // e.g., 70
    enable_weight_discounting?: boolean; // Enable discounting for softened gates
    softened_gate_discount_factor?: number; // E.g., 0.5 (meaning 50% of weight is counted)
    weights: {
      catboost_ai: number;
      market_regime: number;
      trend_alignment: number;
      relative_volume: number;
      overextension: number;
      wedge_filter: number;
      order_flow: number;
      squeeze_filter: number;
      order_book: number;
      volume_profile: number;
      adx_strength?: number;
      ema100_overextension?: number;
    };
    adaptive_modifiers?: {
      trending: {
        trend_alignment_weight_boost: number;
        catboost_weight_boost: number;
        volume_profile_weight_boost?: number;
        adx_strength_weight_boost?: number;
        order_flow_weight_boost?: number;
        squeeze_filter_weight_reduction?: number;
      };
      ranging: {
        order_flow_weight_boost: number;
        trend_alignment_weight_reduction: number;
        volume_profile_weight_boost?: number;
        overextension_weight_boost?: number;
        order_book_weight_boost?: number;
        adx_strength_weight_reduction?: number;
      };
      high_volatility: {
        relative_volume_weight_boost: number;
        overextension_weight_boost: number;
        volume_profile_weight_boost?: number;
        order_book_weight_boost?: number;
        order_flow_weight_boost?: number;
        trend_alignment_weight_reduction?: number;
      };
      low_volatility: {
        squeeze_filter_weight_boost: number;
        volume_profile_weight_boost?: number;
        wedge_filter_weight_boost?: number;
        relative_volume_weight_reduction?: number;
        order_flow_weight_boost?: number;
      };
    };
  };
}

export interface ConfigHistoryEntry {
  id: string;
  timestamp: string;
  category: string;
  changed_by: string;
  changes: {
    key: string;
    old_value: any;
    new_value: any;
  }[];
}

export interface DailyStats {
  date: string;
  total_trades: number;
  wins: number;
  losses: number;
  win_rate: number;
  profit_factor: number;
  net_profit_usdt: number;
  max_drawdown_usdt: number;
}

export interface Candlestick {
  time: number; // unix timestamp in seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  vwap?: number;
  vwap_upper?: number;
  vwap_lower?: number;
}

export interface ApiCallLog {
  id: string;
  timestamp: string;
  service: "Delta Exchange" | "Binance" | "RSS Feed" | "Unknown";
  method: string;
  url: string;
  request_headers: Record<string, string>;
  request_body?: string;
  response_status: number;
  response_headers?: Record<string, string>;
  response_body: string;
  latency_ms: number;
}

export interface MarketStructureSubCondition {
  name: string;
  status: "PASS" | "FAIL" | "SKIP";
  reason: string;
}

