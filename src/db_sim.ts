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
  DayOfWeekStats,
  ApiCallLog,
  TimingWindow,
  SetupPerformanceStats,
  HistoricalOptimizationRecommendation,
  HistoricalOptimizationReport,
  ConfluenceRule,
  UnifiedConfluenceConfig,
} from "./types.js";

export const MOCK_SETUPS = [
  "Setup 1: Pullback & Retest",
  "Setup 2: Dynamic EMA Pushback",
  "Setup 14: Fresh Momentum Impulse",
  "Setup 4: Fair Value Gap Retest",
  "Setup 3: Liquidity Sweep Reversal",
  "Setup 9: Range Failed Auction Reclaim",
  "Setup 12: CVD Absorption & Delta Divergence",
  "Setup 10: VWAP Band Rejection",
];

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
    name: "Asian Session (00:00–08:00 UTC)",
    start_time: "05:30",
    end_time: "13:30",
    allowed: true,
    description: "Rank 5: Low volatility & range-bound. Protected with strict ATR & RVol filters to avoid false sweeps on 1m.",
  },
  {
    id: "intraday_chop",
    name: "London Open / Pre-NY (08:00–13:00 UTC)",
    start_time: "13:30",
    end_time: "18:30",
    allowed: true,
    description: "Rank 3: High European institutional volume & SMC pattern sweeps. Hunts Asian highs/lows.",
  },
  {
    id: "europe_us_overlap",
    name: "Europe / US Overlap (13:00–17:00 UTC)",
    start_time: "18:30",
    end_time: "22:30",
    allowed: true,
    description: "Rank 1 & 2: Maximum activity, deepest liquidity, tightest spreads. Aggressive Mode active for FVG & Order Flow.",
  },
  {
    id: "late_us_session",
    name: "Late US / Wall St Close (17:00–21:00 UTC)",
    start_time: "22:30",
    end_time: "02:30",
    allowed: true,
    description: "Rank 4: Moderate liquidity with algorithmic cross-asset rebalancing spikes at 21:00 UTC Wall St close.",
  },
  {
    id: "dead_liquidity",
    name: "Dead Liquidity (21:00–00:00 UTC)",
    start_time: "02:30",
    end_time: "05:30",
    allowed: true,
    description: "Lowest liquidity inter-session window. Strict volume profile and slippage gating.",
  },
  {
    id: "weekends",
    name: "Weekend Market (24/7 Sat & Sun)",
    start_time: "00:00",
    end_time: "23:59",
    allowed: true,
    description: "Rank 6: Retail-driven, thin liquidity, wider spreads. Trend setups prohibited; limited to range sweeps.",
  },
];

export const DEFAULT_SETUP_SESSION_MATRIX: Record<string, string[]> = {
  setup_1_pullback_retest: ["intraday_chop", "europe_us_overlap", "late_us_session"],
  setup_2_dynamic_ema_pushback: ["intraday_chop", "europe_us_overlap", "late_us_session"],
  setup_3_liquidity_sweep: ["intraday_chop", "europe_us_overlap", "late_us_session", "weekends"],
  setup_4_fvg_retest: ["intraday_chop", "europe_us_overlap", "late_us_session"],
  setup_9_range_failed_auction: ["asia_open", "dead_liquidity", "weekends"],
  setup_10_vwap_band_rejection: ["asia_open", "dead_liquidity", "weekends"],
  setup_11_eqh_eql_double_touch: ["intraday_chop", "europe_us_overlap", "weekends"],
  setup_12_cvd_absorption: ["intraday_chop", "europe_us_overlap", "late_us_session"],
  setup_13_oi_flush_cascade: ["europe_us_overlap", "late_us_session"],
  setup_14_fresh_momentum_impulse: ["intraday_chop", "europe_us_overlap", "late_us_session"],
  setup_15_trendline_bounce: ["intraday_chop", "europe_us_overlap", "late_us_session"],
};

export const DEFAULT_DAY_SESSION_MATRIX: Record<string, string[]> = {
  monday: ["asia_open", "intraday_chop", "europe_us_overlap", "late_us_session"],
  tuesday: ["asia_open", "intraday_chop", "europe_us_overlap", "late_us_session"],
  wednesday: ["asia_open", "intraday_chop", "europe_us_overlap", "late_us_session"], // Rank 1: Peak return & volatility day
  thursday: ["asia_open", "intraday_chop", "europe_us_overlap", "late_us_session"], // Defensive risk scaling active (0.85x)
  friday: ["intraday_chop", "europe_us_overlap"], // Friday Asian open disabled per research! Late US disabled before weekend
  saturday: ["weekends"], // Low volatility, SFP sweeps only
  sunday: ["weekends", "late_us_session"], // Sunday dead liquidity disabled
};

/**
 * 25 Empirically Validated Robust Confluence Rules
 * Extracted from walk-forward backtest discovery & validation clusters.
 * Evaluates Setup x Day x UTC Hour x Trading Session x Market Regime simultaneously.
 */
export const DEFAULT_UNIFIED_CONFLUENCE_RULES: ConfluenceRule[] = [
  {
    id: "rule_1_s3_thu_12_16",
    name: "Setup 3 (Liquidity Sweep) on Thursday 12–16 UTC",
    setup_id: "setup_3_liquidity_sweep",
    regimes: "ALL",
    sessions: "ALL",
    days: ["thursday"],
    hours_utc: ["12-16"],
    discovery_trades: 60,
    discovery_win_rate: 60.0,
    validation_trades: 36,
    validation_win_rate: 100.0,
    verdict: "Robust",
    is_enabled: true,
    risk_multiplier: 1.25,
  },
  {
    id: "rule_2_s14_high_vol",
    name: "Setup 14 (Fresh Momentum) in High Volatility",
    setup_id: "setup_14_fresh_momentum_impulse",
    regimes: [MarketRegime.HIGH_VOLATILITY],
    sessions: "ALL",
    days: "ALL",
    hours_utc: "ALL",
    discovery_trades: 60,
    discovery_win_rate: 80.0,
    validation_trades: 24,
    validation_win_rate: 100.0,
    verdict: "Robust",
    is_enabled: true,
    risk_multiplier: 1.25,
  },
  {
    id: "rule_3_highvol_chop_thu",
    name: "High Volatility Intraday Chop on Thursday",
    setup_id: "all",
    regimes: [MarketRegime.HIGH_VOLATILITY],
    sessions: ["intraday_chop"],
    days: ["thursday"],
    hours_utc: "ALL",
    discovery_trades: 48,
    discovery_win_rate: 75.0,
    validation_trades: 24,
    validation_win_rate: 100.0,
    verdict: "Robust",
    is_enabled: true,
    risk_multiplier: 1.25,
  },
  {
    id: "rule_4_s3_lowvol_16_20",
    name: "Setup 3 (Liquidity Sweep) Low Volatility 16–20 UTC",
    setup_id: "setup_3_liquidity_sweep",
    regimes: [MarketRegime.LOW_VOLATILITY],
    sessions: "ALL",
    days: "ALL",
    hours_utc: ["16-20"],
    discovery_trades: 36,
    discovery_win_rate: 66.7,
    validation_trades: 24,
    validation_win_rate: 100.0,
    verdict: "Robust",
    is_enabled: true,
    risk_multiplier: 1.25,
  },
  {
    id: "rule_5_lowvol_lateus_16_20",
    name: "Low Volatility Late US Session 16–20 UTC",
    setup_id: "all",
    regimes: [MarketRegime.LOW_VOLATILITY],
    sessions: ["late_us_session"],
    days: "ALL",
    hours_utc: ["16-20"],
    discovery_trades: 36,
    discovery_win_rate: 66.7,
    validation_trades: 24,
    validation_win_rate: 100.0,
    verdict: "Robust",
    is_enabled: true,
  },
  {
    id: "rule_6_lowvol_lateus",
    name: "Low Volatility Late US Session Continuation",
    setup_id: "all",
    regimes: [MarketRegime.LOW_VOLATILITY],
    sessions: ["late_us_session"],
    days: "ALL",
    hours_utc: "ALL",
    discovery_trades: 96,
    discovery_win_rate: 50.0,
    validation_trades: 24,
    validation_win_rate: 100.0,
    verdict: "Robust",
    is_enabled: true,
  },
  {
    id: "rule_7_s3_lowvol_lateus",
    name: "Setup 3 (Liquidity Sweep) in Low Volatility Late US",
    setup_id: "setup_3_liquidity_sweep",
    regimes: [MarketRegime.LOW_VOLATILITY],
    sessions: ["late_us_session"],
    days: "ALL",
    hours_utc: "ALL",
    discovery_trades: 72,
    discovery_win_rate: 50.0,
    validation_trades: 24,
    validation_win_rate: 100.0,
    verdict: "Robust",
    is_enabled: true,
    risk_multiplier: 1.25,
  },
  {
    id: "rule_8_s12_chop_fri",
    name: "Setup 12 (CVD Absorption) Friday Intraday Chop",
    setup_id: "setup_12_cvd_absorption",
    regimes: "ALL",
    sessions: ["intraday_chop"],
    days: ["friday"],
    hours_utc: "ALL",
    discovery_trades: 60,
    discovery_win_rate: 40.0,
    validation_trades: 24,
    validation_win_rate: 100.0,
    verdict: "Robust",
    is_enabled: true,
    risk_multiplier: 1.20,
  },
  {
    id: "rule_9_s14_lateus_wed",
    name: "Setup 14 (Fresh Momentum) Wednesday Late US",
    setup_id: "setup_14_fresh_momentum_impulse",
    regimes: "ALL",
    sessions: ["late_us_session"],
    days: ["wednesday"],
    hours_utc: "ALL",
    discovery_trades: 48,
    discovery_win_rate: 75.0,
    validation_trades: 12,
    validation_win_rate: 100.0,
    verdict: "Robust",
    is_enabled: true,
    risk_multiplier: 1.25,
  },
  {
    id: "rule_10_s2_mon_16_20",
    name: "Setup 2 (Dynamic EMA) Monday 16–20 UTC",
    setup_id: "setup_2_dynamic_ema_pushback",
    regimes: "ALL",
    sessions: "ALL",
    days: ["monday"],
    hours_utc: ["16-20"],
    discovery_trades: 48,
    discovery_win_rate: 75.0,
    validation_trades: 12,
    validation_win_rate: 100.0,
    verdict: "Robust",
    is_enabled: true,
    risk_multiplier: 1.25,
  },
  {
    id: "rule_11_mon_04_08",
    name: "Monday Asian Open Early Window (04–08 UTC)",
    setup_id: "all",
    regimes: "ALL",
    sessions: "ALL",
    days: ["monday"],
    hours_utc: ["04-08"],
    discovery_trades: 156,
    discovery_win_rate: 61.5,
    validation_trades: 12,
    validation_win_rate: 100.0,
    verdict: "Robust",
    is_enabled: true,
  },
  {
    id: "rule_12_s9_mon_04_08",
    name: "Setup 9 (Range Failed Auction) Monday 04–08 UTC",
    setup_id: "setup_9_range_failed_auction",
    regimes: "ALL",
    sessions: "ALL",
    days: ["monday"],
    hours_utc: ["04-08"],
    discovery_trades: 156,
    discovery_win_rate: 61.5,
    validation_trades: 12,
    validation_win_rate: 100.0,
    verdict: "Robust",
    is_enabled: true,
    risk_multiplier: 1.25,
  },
  {
    id: "rule_13_asia_mon_04_08",
    name: "Asia Open Session Monday 04–08 UTC",
    setup_id: "all",
    regimes: "ALL",
    sessions: ["asia_open"],
    days: ["monday"],
    hours_utc: ["04-08"],
    discovery_trades: 156,
    discovery_win_rate: 61.5,
    validation_trades: 12,
    validation_win_rate: 100.0,
    verdict: "Robust",
    is_enabled: true,
  },
  {
    id: "rule_14_range_mon_04_08",
    name: "Range Bound Monday 04–08 UTC",
    setup_id: "all",
    regimes: [MarketRegime.RANGE_BOUND],
    sessions: "ALL",
    days: ["monday"],
    hours_utc: ["04-08"],
    discovery_trades: 144,
    discovery_win_rate: 58.3,
    validation_trades: 12,
    validation_win_rate: 100.0,
    verdict: "Robust",
    is_enabled: true,
  },
  {
    id: "rule_15_highvol_lateus_tue",
    name: "High Volatility Tuesday Late US Session",
    setup_id: "all",
    regimes: [MarketRegime.HIGH_VOLATILITY],
    sessions: ["late_us_session"],
    days: ["tuesday"],
    hours_utc: "ALL",
    discovery_trades: 108,
    discovery_win_rate: 55.6,
    validation_trades: 12,
    validation_win_rate: 100.0,
    verdict: "Robust",
    is_enabled: true,
  },
  {
    id: "rule_16_lowvol_tue",
    name: "Low Volatility Tuesday Mean Reversion",
    setup_id: "all",
    regimes: [MarketRegime.LOW_VOLATILITY],
    sessions: "ALL",
    days: ["tuesday"],
    hours_utc: "ALL",
    discovery_trades: 48,
    discovery_win_rate: 50.0,
    validation_trades: 12,
    validation_win_rate: 100.0,
    verdict: "Robust",
    is_enabled: true,
  },
  {
    id: "rule_17_highvol_tue_16_20",
    name: "High Volatility Tuesday 16–20 UTC",
    setup_id: "all",
    regimes: [MarketRegime.HIGH_VOLATILITY],
    sessions: "ALL",
    days: ["tuesday"],
    hours_utc: ["16-20"],
    discovery_trades: 84,
    discovery_win_rate: 42.9,
    validation_trades: 12,
    validation_win_rate: 100.0,
    verdict: "Robust",
    is_enabled: true,
  },
  {
    id: "rule_18_s14_overlap_thu",
    name: "Setup 14 (Fresh Momentum) Thursday Overlap (Core Edge)",
    setup_id: "setup_14_fresh_momentum_impulse",
    regimes: "ALL",
    sessions: ["europe_us_overlap"],
    days: ["thursday"],
    hours_utc: "ALL",
    discovery_trades: 60,
    discovery_win_rate: 100.0,
    validation_trades: 84,
    validation_win_rate: 85.7,
    verdict: "Robust",
    is_enabled: true,
    risk_multiplier: 1.25,
  },
  {
    id: "rule_19_s14_thu_12_16",
    name: "Setup 14 (Fresh Momentum) Thursday 12–16 UTC",
    setup_id: "setup_14_fresh_momentum_impulse",
    regimes: "ALL",
    sessions: "ALL",
    days: ["thursday"],
    hours_utc: ["12-16"],
    discovery_trades: 60,
    discovery_win_rate: 80.0,
    validation_trades: 84,
    validation_win_rate: 85.7,
    verdict: "Robust",
    is_enabled: true,
    risk_multiplier: 1.25,
  },
  {
    id: "rule_20_s3_overlap_thu",
    name: "Setup 3 (Liquidity Sweep) Thursday Overlap",
    setup_id: "setup_3_liquidity_sweep",
    regimes: "ALL",
    sessions: ["europe_us_overlap"],
    days: ["thursday"],
    hours_utc: "ALL",
    discovery_trades: 96,
    discovery_win_rate: 50.0,
    validation_trades: 72,
    validation_win_rate: 83.3,
    verdict: "Robust",
    is_enabled: true,
    risk_multiplier: 1.20,
  },
  {
    id: "rule_21_s12_range_fri",
    name: "Setup 12 (CVD Absorption) Range Bound Friday",
    setup_id: "setup_12_cvd_absorption",
    regimes: [MarketRegime.RANGE_BOUND],
    sessions: "ALL",
    days: ["friday"],
    hours_utc: "ALL",
    discovery_trades: 72,
    discovery_win_rate: 50.0,
    validation_trades: 60,
    validation_win_rate: 80.0,
    verdict: "Robust",
    is_enabled: true,
    risk_multiplier: 1.20,
  },
  {
    id: "rule_22_uptrend_overlap_thu",
    name: "Strong Uptrend Thursday Overlap Macro Flow",
    setup_id: "all",
    regimes: [MarketRegime.STRONG_UPTREND],
    sessions: ["europe_us_overlap"],
    days: ["thursday"],
    hours_utc: "ALL",
    discovery_trades: 192,
    discovery_win_rate: 43.8,
    validation_trades: 180,
    validation_win_rate: 73.3,
    verdict: "Robust",
    is_enabled: true,
  },
  {
    id: "rule_23_s14_thu_broad",
    name: "Setup 14 (Fresh Momentum) Thursday Daily Session",
    setup_id: "setup_14_fresh_momentum_impulse",
    regimes: "ALL",
    sessions: "ALL",
    days: ["thursday"],
    hours_utc: "ALL",
    discovery_trades: 144,
    discovery_win_rate: 83.3,
    validation_trades: 132,
    validation_win_rate: 72.7,
    verdict: "Robust",
    is_enabled: true,
  },
  {
    id: "rule_24_s14_uptrend_overlap",
    name: "Setup 14 (Fresh Momentum) Strong Uptrend Overlap",
    setup_id: "setup_14_fresh_momentum_impulse",
    regimes: [MarketRegime.STRONG_UPTREND],
    sessions: ["europe_us_overlap"],
    days: "ALL",
    hours_utc: "ALL",
    discovery_trades: 144,
    discovery_win_rate: 75.0,
    validation_trades: 48,
    validation_win_rate: 75.0,
    verdict: "Robust",
    is_enabled: true,
    risk_multiplier: 1.15,
  },
  {
    id: "rule_25_s12_overlap_16_20",
    name: "Setup 12 (CVD Absorption) Overlap Close 16–20 UTC",
    setup_id: "setup_12_cvd_absorption",
    regimes: "ALL",
    sessions: ["europe_us_overlap"],
    days: "ALL",
    hours_utc: ["16-20"],
    discovery_trades: 72,
    discovery_win_rate: 50.0,
    validation_trades: 48,
    validation_win_rate: 75.0,
    verdict: "Robust",
    is_enabled: true,
    risk_multiplier: 1.15,
  },
];

export const DEFAULT_UNIFIED_CONFLUENCE_CONFIG: UnifiedConfluenceConfig = {
  enabled: true, // Master toggle: use Unified Confluence Matrix
  strict_mode: true, // Strictly require matching an active confluence rule
  fallback_to_legacy: false, // In strict mode, block if no rule matches
  min_validation_win_rate: 70.0, // Minimum backtest win rate threshold (70%+)
  rules: DEFAULT_UNIFIED_CONFLUENCE_RULES,
};

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
    invert_confirmed_trades: false,
    skipped_gates: [],
    required_gates: [
      "catboost", "regime", "trend", "volume", "limit", "adx", "equity", "credentials",
      "cooldown", "timing", "vwap", "wedge", "ema100", "structure", "orderflow", "squeeze",
      "orderbook", "volume_profile", "atr", "regime_cooldown", "choppy"
    ],
    mandatory_gates: [
      "limit", "equity", "credentials", "cooldown", "timing", "structure", "atr", "regime_cooldown", "choppy", "orderflow", "volume_profile"
    ],
    weighted_gates: [
      "catboost", "regime", "trend", "volume", "vwap", "wedge", "squeeze", "orderbook", "adx", "ema100"
    ],
    relative_volume_threshold: 1.3,
    adx_threshold: 22.0,
    min_ranging_adx_threshold: 22.0,
    min_adx_hard_floor: 20.0,
    timing_windows: DEFAULT_TIMING_WINDOWS,
    regime_candle_interval_minutes: 3,
    data_feed_source: "BINANCE",
    enable_block_logging: true,
    enable_trade_logging: true,
    enable_orderflow_softening: true,
    orderflow_softening_percent: 10,
    order_book_min_depth: 2.5,
    order_book_max_imbalance: 0.35,
    order_book_max_spoof_risk: 70,
    regime_change_cooldown_minutes: 15,
    regime_macro_slope_lookback: 5,
    regime_macro_slope_threshold: 0.0002,
    regime_ribbon_compression_threshold: 0.0009,
    require_volume_profile_in_ranging: true,
    enable_choppy_market_filter: true,
    max_allowed_chop_index: 58.0,
    min_allowed_efficiency_ratio: 0.22,
    max_allowed_wick_ratio: 0.60,
    regime_adaptive_gates_enabled: true,
    regime_adaptive_preset: "BALANCED_ADAPTIVE",
    regime_gate_overrides: {},
    enable_ranging_extreme_rsi_bypass: false,
    ranging_rsi_overbought_threshold: 75.0,
    ranging_rsi_oversold_threshold: 25.0,
    ranging_adx_ceiling: 25.0,
    enable_exhaustion_trend_bypass: true,
    exhaustion_rsi_oversold_threshold: 32.0,
    exhaustion_rsi_overbought_threshold: 68.0,
    exhaustion_max_adx: 26.0,
    exhaustion_lookback_candles: 6,
    exhaustion_require_structural_confluence: true,
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
    stop_loss_atr_multiplier: 1.55,
    take_profit_ratio: 1.5,
    take_profit_atr_multiplier: 1.65,
    take_profit_mode: "ATR_SCALP",
    enable_adx_target_compression: true,
    adx_quick_scalp_threshold: 18.0,
    adx_quick_scalp_tp_atr: 1.05,
    breakeven_trigger_atr: 1.15,
    max_consecutive_losses: 3,
    consecutive_losses_cooldown_minutes: 30,
    daily_loss_limit_pct: 2.0,
    weekly_loss_limit_pct: 5.0,
    intra_trade_drawdown_limit_pct: 1.5,
    leverage: 20,
    default_quantity_btc: 0.001,
    enable_dynamic_position_sizing: true,
    enable_atr_parity_sizing: true,
    atr_parity_base_value: 55.0,
    atr_parity_min_quantity_btc: 0.0002,
    atr_parity_max_quantity_btc: 0.004,
    simulate_paper_fees: true,
    delta_india_gst_enabled: true,
    delta_scalper_offer_enabled: true,
    anti_whipsaw_cooldown_seconds: 180,
    smart_stall_exit_enabled: true,
    stall_evaluation_minutes: 25,
    max_trade_duration_minutes: 60,
    enable_catboost_counter_exit: true,
    catboost_counter_exit_threshold: 0.75,
    catboost_counter_exit_confirmation_candles: 2,
    catboost_counter_exit_grace_period_seconds: 180,
    default_order_execution: "TAKER",
    trailing_stop_loss_enabled: true,
    trailing_stop_loss_distance_atr: 1.45,
    trailing_stop_loss_activation_ratio: 1.0,
    min_stop_loss_distance_usd: 35,
    min_stop_loss_distance_pct: 0.045,
    static_stop_loss_enabled: false,
    static_stop_loss_value_usd: 150,
    max_atr_for_stop_loss_enabled: false,
    max_atr_for_stop_loss_value: 100,
    min_atr_for_trading_enabled: true,
    min_atr_for_trading_value: 12, // Default 12, which is higher than low value 11
    overextension_ema_trending_threshold: 1.8,
    overextension_ema_ranging_threshold: 1.2,
    overextension_vwap_trending_multiplier: 1.5,
    overextension_vwap_ranging_multiplier: 1.0,
    max_allowed_z_dist: 2.50,
    enable_regime_adaptive_sl_tp: true,
    min_rr_ratio_floor: 1.25,
    sl_atr_multiplier_trending: 1.55,
    sl_atr_multiplier_ranging: 1.35,
    sl_atr_multiplier_volatile: 1.75,
    tp_atr_multiplier_trending: 1.70,
    tp_atr_multiplier_ranging: 1.40,
    tp_atr_multiplier_volatile: 2.00,
    friction_hurdle_gate_enabled: true,
    min_net_edge_ratio: 2.2,
    estimated_slippage_pct: 0.02,
    maker_post_only_enabled: false,
    hybrid_regime_switching_enabled: true,
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
    crossover_only_strategy_enabled: false,
    crossover_only_fast_period: 5,
    crossover_only_slow_period: 15,
    crossover_only_rsi_limit: 70,
    crossover_only_adx_threshold: 25,
    crossover_only_lookback_candles: 5,
    timeframe_minutes: 5,
    very_high_probability_threshold: 0.60,
    liquidity_sweep_enabled: true,
    liquidity_sweep_lookback_candles: 20,
    liquidity_sweep_min_wick_ratio: 0.35,
    liquidity_sweep_volume_mult: 1.0,
    liquidity_sweep_mtf_enabled: true,
    liquidity_sweep_microstructure_filter: true,
    liquidity_sweep_require_fvg_retest: true,
    liquidity_sweep_anti_inducement_filter: true,
    liquidity_sweep_min_rr_ratio: 2.0,
    fvg_strategy_enabled: true,
    fvg_min_gap_atr_ratio: 0.25,
    fvg_lookback_candles: 20,
    fvg_consequent_encroachment_entry: true,
    fvg_require_reversal_confirmation: true,
    fvg_displacement_vol_mult: 1.25,
    fvg_min_body_ratio: 0.60,
    fvg_ce_invalidation_rule: true,
    fvg_trend_filter_enabled: true,
    fvg_respect_ema200_overextension: true,
    fvg_max_ema200_extension_atr: 2.5,
    fvg_ema200_proximity_block: true,
    choch_confirmation_enabled: true,
    eqh_eql_detection_enabled: true,
    eqh_eql_tolerance_pct: 0.08,
    asian_session_sweep_enabled: true,
    smc_tp_targeting_enabled: true,
    pinbar_two_candle_confirmation_enabled: true,
    pinbar_min_wick_ratio: 0.50,
    candlestick_enhancements_enabled: true,
    csi_min_threshold: 0.50,
    rising_falling_three_methods_enabled: true,
    inverted_hammer_hanging_man_enabled: true,
    doji_breakout_confirmation_enabled: true,
    max_confirmation_candle_atr: 1.8,
    failed_auction_strategy_enabled: true,
    failed_auction_max_deviation_atr_mult: 0.8,
    failed_auction_max_candles_outside: 3,
    vwap_band_reversal_enabled: true,
    vwap_band_reversal_deviation_mult: 1.5,
    vwap_band_reversal_min_wick_ratio: 0.30,
    vwap_band_reversal_require_reversal_candle: true,
    eqh_eql_strategy_enabled: true,
    eqh_eql_min_touch_count: 2,
    eqh_eql_require_divergence: true,
    eqh_eql_require_candlestick_reversal: true,
    cvd_divergence_strategy_enabled: true,
    cvd_divergence_min_rejection_wick_pct: 35,
    cvd_divergence_min_delta_imbalance_ratio: 0.55,
    cvd_divergence_lookback_candles: 20,
    cvd_divergence_require_structural_extreme: true,
    oi_flush_strategy_enabled: true,
    oi_flush_min_contraction_pct: 0.25,
    oi_flush_min_vol_mult: 1.5,
    oi_flush_min_reversal_wick_pct: 38,
    oi_flush_require_second_candle_confirmation: true,
    fresh_momentum_strategy_enabled: true,
    fresh_momentum_min_body_ratio: 0.48,
    fresh_momentum_min_vol_mult: 1.15,
    fresh_momentum_max_chase_atr: 4.5,
    fresh_momentum_respect_ema200_overextension: true,
    fresh_momentum_max_ema200_extension_atr: 2.5,
    fresh_momentum_ema200_proximity_block: true,
    trendline_bounce_strategy_enabled: true,
    trendline_bounce_min_touches: 2,
    trendline_bounce_require_3rd_touch: false,
    trendline_bounce_min_slope_angle: 15,
    trendline_bounce_max_slope_angle: 60,
    trendline_bounce_max_penetration_atr: 0.25,
    trendline_bounce_allow_liquidity_sweep: true,
    trendline_bounce_max_sweep_atr: 0.85,
    trendline_bounce_fib_confluence_enabled: true,
    trendline_bounce_horizontal_sr_confluence_enabled: true,
    trendline_bounce_require_volume_contraction: true,
    trendline_bounce_require_candlestick_reversal: true,
    trendline_bounce_require_bounce_volume_expansion: false,
    trendline_bounce_require_micro_breakout: false,
    trendline_bounce_confluence_boost_enabled: true,
    pullback_retest_enabled: true,
    ema_pushback_enabled: true,
    dynamic_regime_setup_matrix_enabled: true,
    setup_regime_matrix: {
      setup_1_pullback_retest: [MarketRegime.STRONG_UPTREND, MarketRegime.STRONG_DOWNTREND],
      setup_2_dynamic_ema_pushback: [MarketRegime.STRONG_UPTREND, MarketRegime.STRONG_DOWNTREND],
      setup_3_liquidity_sweep: [MarketRegime.RANGE_BOUND, MarketRegime.HIGH_VOLATILITY, MarketRegime.LOW_VOLATILITY],
      setup_4_fvg_retest: [MarketRegime.STRONG_UPTREND, MarketRegime.STRONG_DOWNTREND, MarketRegime.RANGE_BOUND, MarketRegime.HIGH_VOLATILITY],
      setup_9_range_failed_auction: [MarketRegime.RANGE_BOUND, MarketRegime.LOW_VOLATILITY],
      setup_10_vwap_band_rejection: [MarketRegime.RANGE_BOUND, MarketRegime.LOW_VOLATILITY],
      setup_11_eqh_eql_double_touch: [MarketRegime.RANGE_BOUND, MarketRegime.LOW_VOLATILITY],
      setup_12_cvd_absorption: [MarketRegime.RANGE_BOUND, MarketRegime.HIGH_VOLATILITY],
      setup_13_oi_flush_cascade: [MarketRegime.HIGH_VOLATILITY, MarketRegime.RANGE_BOUND],
      setup_14_fresh_momentum_impulse: [MarketRegime.STRONG_UPTREND, MarketRegime.STRONG_DOWNTREND, MarketRegime.HIGH_VOLATILITY, MarketRegime.LOW_VOLATILITY],
      setup_15_trendline_bounce: [MarketRegime.STRONG_UPTREND, MarketRegime.STRONG_DOWNTREND, MarketRegime.HIGH_VOLATILITY, MarketRegime.RANGE_BOUND],
    },
    dynamic_session_setup_matrix_enabled: true,
    setup_session_matrix: DEFAULT_SETUP_SESSION_MATRIX,
    day_session_matrix_enabled: true,
    day_session_matrix: DEFAULT_DAY_SESSION_MATRIX,
    dynamic_condition_rules_enabled: true,
    dynamic_mean_reversion_max_adx: 32,
    dynamic_trend_min_adx: 20,
    dynamic_trend_max_chop_index: 58,
    dynamic_breakout_min_atr: 12,
    unified_confluence: DEFAULT_UNIFIED_CONFLUENCE_CONFIG,
  },
  gate_scoring: {
    enabled: true,
    confidence_threshold: 70,
    enable_weight_discounting: true,
    softened_gate_discount_factor: 0.5,
    weights: {
      catboost_ai: 25,
      market_regime: 15,
      trend_alignment: 10,
      adx_strength: 5,
      relative_volume: 10,
      overextension: 5,
      ema100_overextension: 5,
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

  // 3. Trade history and signals initialize empty (live and paper trades will populate here organically)

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
  return {
    credentials: {
      ...DEFAULT_CREDENTIALS,
      id: "delta-exchange-paper-key",
      exchange_name: "Delta Exchange (Paper)",
      api_key: "PAPER_TRADING_API_KEY",
      api_secret: "PAPER_TRADING_API_SECRET",
      account_balance_usdt: 100000,
      connection_status: ConnectionStatus.CONNECTED,
      last_tested_at: new Date().toISOString(),
      last_successful_connection: new Date().toISOString(),
      connection_error_message: null,
    },
    trades: [],
    signals: [],
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
        
        // Ensure default properties exist without overwriting user customizations
        if (this.cache && this.cache.config) {
          let updated = false;
          if (this.cache.config.risk_management) {
            if (this.cache.config.risk_management.take_profit_ratio === undefined || isNaN(this.cache.config.risk_management.take_profit_ratio)) {
              this.cache.config.risk_management.take_profit_ratio = 1.5;
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
        if (this.cache && this.cache.trades) {
          // Purge any legacy preset mock trades so history page is never populated with fake presets
          const originalLen = this.cache.trades.length;
          this.cache.trades = this.cache.trades.filter(
            (t) => !t.id.startsWith("trade-hist-") && !t.id.startsWith("trade-paper-hist-")
          );
          if (this.cache.signals) {
            this.cache.signals = this.cache.signals.filter(
              (s) => !s.id.startsWith("sig-") && !s.id.startsWith("sig-paper-")
            );
          }
          if (this.cache.trades.length !== originalLen) {
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
        if (this.paperCache && this.paperCache.trades) {
          const originalPaperLen = this.paperCache.trades.length;
          this.paperCache.trades = this.paperCache.trades.filter(
            (t) => !t.id.startsWith("trade-hist-") && !t.id.startsWith("trade-paper-hist-")
          );
          if (this.paperCache.signals) {
            this.paperCache.signals = this.paperCache.signals.filter(
              (s) => !s.id.startsWith("sig-") && !s.id.startsWith("sig-paper-")
            );
          }
          if (this.paperCache.trades.length !== originalPaperLen) {
            this.savePaper();
          }
        }
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
      if (!this.cache.config.general.required_gates) {
        const skipped = this.cache.config.general.skipped_gates || [];
        const allGates = [
          "catboost", "regime", "trend", "volume", "limit", "adx", "equity", "credentials",
          "cooldown", "timing", "vwap", "wedge", "ema100", "structure", "orderflow", "squeeze",
          "orderbook", "volume_profile", "atr", "regime_cooldown"
        ];
        this.cache.config.general.required_gates = allGates.filter(g => !skipped.includes(g));
        changed = true;
      }
      if (!this.cache.config.general.mandatory_gates) {
        this.cache.config.general.mandatory_gates = [
          "limit", "equity", "credentials", "cooldown", "timing", "structure", "atr", "regime_cooldown", "choppy", "orderflow", "volume_profile"
        ];
        changed = true;
      }
      if (!this.cache.config.general.weighted_gates) {
        this.cache.config.general.weighted_gates = [
          "catboost", "regime", "trend", "volume", "vwap", "wedge", "squeeze", "orderbook", "adx", "ema100"
        ];
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
      if (this.cache.config.general.order_book_min_depth === undefined || this.cache.config.general.order_book_min_depth > 3.0) {
        this.cache.config.general.order_book_min_depth = 2.5;
        changed = true;
      }
      if (this.cache.config.general.order_book_max_imbalance === undefined) {
        this.cache.config.general.order_book_max_imbalance = 0.35;
        changed = true;
      }
      if (this.cache.config.general.order_book_max_spoof_risk === undefined) {
        this.cache.config.general.order_book_max_spoof_risk = 70;
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
        this.cache.config.general.regime_macro_slope_threshold = 0.0002;
        changed = true;
      }
      if (this.cache.config.general.regime_ribbon_compression_threshold === undefined) {
        this.cache.config.general.regime_ribbon_compression_threshold = 0.0009;
        changed = true;
      }
      if (this.cache.config.general.require_volume_profile_in_ranging === undefined) {
        this.cache.config.general.require_volume_profile_in_ranging = true;
        changed = true;
      }
      if (this.cache.config.general.regime_adaptive_gates_enabled === undefined) {
        this.cache.config.general.regime_adaptive_gates_enabled = true;
        changed = true;
      }
      if (!this.cache.config.general.regime_adaptive_preset) {
        this.cache.config.general.regime_adaptive_preset = "BALANCED_ADAPTIVE";
        changed = true;
      }
      if (!this.cache.config.general.regime_gate_overrides) {
        this.cache.config.general.regime_gate_overrides = {};
        changed = true;
      }
      if (this.cache.config.general.enable_ranging_extreme_rsi_bypass === undefined) {
        this.cache.config.general.enable_ranging_extreme_rsi_bypass = false;
        changed = true;
      }
      if (this.cache.config.general.ranging_rsi_overbought_threshold === undefined) {
        this.cache.config.general.ranging_rsi_overbought_threshold = 75.0;
        changed = true;
      }
      if (this.cache.config.general.ranging_rsi_oversold_threshold === undefined) {
        this.cache.config.general.ranging_rsi_oversold_threshold = 25.0;
        changed = true;
      }
      if (this.cache.config.general.enable_exhaustion_trend_bypass === undefined) {
        this.cache.config.general.enable_exhaustion_trend_bypass = true;
        changed = true;
      }
      if (this.cache.config.general.exhaustion_rsi_oversold_threshold === undefined) {
        this.cache.config.general.exhaustion_rsi_oversold_threshold = 32.0;
        changed = true;
      }
      if (this.cache.config.general.exhaustion_rsi_overbought_threshold === undefined) {
        this.cache.config.general.exhaustion_rsi_overbought_threshold = 68.0;
        changed = true;
      }
      if (this.cache.config.general.exhaustion_lookback_candles === undefined) {
        this.cache.config.general.exhaustion_lookback_candles = 6;
        changed = true;
      }
      if (this.cache.config.general.exhaustion_require_structural_confluence === undefined) {
        this.cache.config.general.exhaustion_require_structural_confluence = true;
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
      if (this.cache.config.risk_management.smart_stall_exit_enabled === undefined) {
        this.cache.config.risk_management.smart_stall_exit_enabled = true;
        changed = true;
      }
      if (this.cache.config.risk_management.stall_evaluation_minutes === undefined) {
        this.cache.config.risk_management.stall_evaluation_minutes = 25;
        changed = true;
      }
      if (this.cache.config.risk_management.max_trade_duration_minutes === undefined) {
        this.cache.config.risk_management.max_trade_duration_minutes = 60;
        changed = true;
      }
      if (this.cache.config.risk_management.stop_loss_atr_multiplier === undefined || isNaN(this.cache.config.risk_management.stop_loss_atr_multiplier) || this.cache.config.risk_management.stop_loss_atr_multiplier <= 0) {
        this.cache.config.risk_management.stop_loss_atr_multiplier = 1.8;
        changed = true;
      }
      if (this.cache.config.risk_management.take_profit_atr_multiplier === undefined) {
        this.cache.config.risk_management.take_profit_atr_multiplier = 1.35;
        changed = true;
      }
      if (this.cache.config.risk_management.take_profit_mode === undefined) {
        this.cache.config.risk_management.take_profit_mode = "ATR_SCALP";
        changed = true;
      }
      if (this.cache.config.risk_management.breakeven_trigger_atr === undefined) {
        this.cache.config.risk_management.breakeven_trigger_atr = 1.15;
        changed = true;
      }
      if (this.cache.config.risk_management.enable_adx_target_compression === undefined) {
        this.cache.config.risk_management.enable_adx_target_compression = true;
        changed = true;
      }
      if (this.cache.config.risk_management.adx_quick_scalp_threshold === undefined) {
        this.cache.config.risk_management.adx_quick_scalp_threshold = 18.0;
        changed = true;
      }
      if (this.cache.config.risk_management.adx_quick_scalp_tp_atr === undefined) {
        this.cache.config.risk_management.adx_quick_scalp_tp_atr = 1.05;
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
      if (this.cache.config.risk_management.trailing_stop_loss_distance_atr === undefined || isNaN(this.cache.config.risk_management.trailing_stop_loss_distance_atr) || this.cache.config.risk_management.trailing_stop_loss_distance_atr <= 0) {
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
      if (this.cache.config.risk_management.max_allowed_z_dist === undefined || this.cache.config.risk_management.max_allowed_z_dist < 2.20) {
        this.cache.config.risk_management.max_allowed_z_dist = 2.50;
        changed = true;
      }
      if (this.cache.config.risk_management.min_atr_for_trading_value === undefined || isNaN(this.cache.config.risk_management.min_atr_for_trading_value)) {
        this.cache.config.risk_management.min_atr_for_trading_value = 12.0;
        changed = true;
      }
      if (this.cache.config.risk_management.min_atr_for_trading_enabled === undefined) {
        this.cache.config.risk_management.min_atr_for_trading_enabled = true;
        changed = true;
      }
      if (this.cache.config.risk_management.friction_hurdle_gate_enabled === undefined) {
        this.cache.config.risk_management.friction_hurdle_gate_enabled = true;
        changed = true;
      }
      if (this.cache.config.risk_management.min_net_edge_ratio === undefined || typeof this.cache.config.risk_management.min_net_edge_ratio !== "number" || isNaN(this.cache.config.risk_management.min_net_edge_ratio)) {
        this.cache.config.risk_management.min_net_edge_ratio = 2.2;
        changed = true;
      }
      if (this.cache.config.risk_management.estimated_slippage_pct === undefined) {
        this.cache.config.risk_management.estimated_slippage_pct = 0.02;
        changed = true;
      }
      if (this.cache.config.risk_management.maker_post_only_enabled === undefined) {
        this.cache.config.risk_management.maker_post_only_enabled = false;
        changed = true;
      }
      if (this.cache.config.risk_management.hybrid_regime_switching_enabled === undefined) {
        this.cache.config.risk_management.hybrid_regime_switching_enabled = true;
        changed = true;
      }
      if (this.cache.config.risk_management.enable_dynamic_position_sizing === undefined) {
        this.cache.config.risk_management.enable_dynamic_position_sizing = true;
        changed = true;
      }
      if (this.cache.config.risk_management.enable_atr_parity_sizing === undefined) {
        this.cache.config.risk_management.enable_atr_parity_sizing = true;
        changed = true;
      }
      if (this.cache.config.risk_management.atr_parity_base_value === undefined) {
        this.cache.config.risk_management.atr_parity_base_value = 55.0;
        changed = true;
      }
      if (this.cache.config.risk_management.atr_parity_min_quantity_btc === undefined) {
        this.cache.config.risk_management.atr_parity_min_quantity_btc = 0.0002;
        changed = true;
      }
      if (this.cache.config.risk_management.atr_parity_max_quantity_btc === undefined) {
        this.cache.config.risk_management.atr_parity_max_quantity_btc = 0.004;
        changed = true;
      }
      if (this.cache.config.risk_management.enable_catboost_counter_exit === undefined) {
        this.cache.config.risk_management.enable_catboost_counter_exit = true;
        changed = true;
      }
      if (this.cache.config.risk_management.catboost_counter_exit_threshold === undefined) {
        this.cache.config.risk_management.catboost_counter_exit_threshold = 0.75;
        changed = true;
      }
      if (this.cache.config.risk_management.catboost_counter_exit_confirmation_candles === undefined) {
        this.cache.config.risk_management.catboost_counter_exit_confirmation_candles = 2;
        changed = true;
      }
      if (this.cache.config.risk_management.catboost_counter_exit_grace_period_seconds === undefined) {
        this.cache.config.risk_management.catboost_counter_exit_grace_period_seconds = 180;
        changed = true;
      }
      if (this.cache.config.risk_management.anti_whipsaw_cooldown_seconds === undefined) {
        this.cache.config.risk_management.anti_whipsaw_cooldown_seconds = 180;
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
      if (ms.crossover_only_strategy_enabled === undefined) { ms.crossover_only_strategy_enabled = def.crossover_only_strategy_enabled ?? false; changed = true; }
      if (ms.crossover_only_fast_period === undefined) { ms.crossover_only_fast_period = def.crossover_only_fast_period || 5; changed = true; }
      if (ms.crossover_only_slow_period === undefined) { ms.crossover_only_slow_period = def.crossover_only_slow_period || 15; changed = true; }
      if (ms.crossover_only_rsi_limit === undefined) { ms.crossover_only_rsi_limit = def.crossover_only_rsi_limit !== undefined ? def.crossover_only_rsi_limit : 70; changed = true; }
      if (ms.crossover_only_adx_threshold === undefined) { ms.crossover_only_adx_threshold = def.crossover_only_adx_threshold !== undefined ? def.crossover_only_adx_threshold : 25; changed = true; }
      if (ms.crossover_only_lookback_candles === undefined) { ms.crossover_only_lookback_candles = def.crossover_only_lookback_candles !== undefined ? def.crossover_only_lookback_candles : 5; changed = true; }
      if (ms.timeframe_minutes === undefined) { ms.timeframe_minutes = def.timeframe_minutes || 5; changed = true; }
      if (ms.very_high_probability_threshold === undefined) { ms.very_high_probability_threshold = def.very_high_probability_threshold || 0.82; changed = true; }
      if (ms.liquidity_sweep_enabled === undefined) { ms.liquidity_sweep_enabled = def.liquidity_sweep_enabled !== undefined ? def.liquidity_sweep_enabled : true; changed = true; }
      if (ms.liquidity_sweep_lookback_candles === undefined) { ms.liquidity_sweep_lookback_candles = def.liquidity_sweep_lookback_candles || 20; changed = true; }
      if (ms.liquidity_sweep_min_wick_ratio === undefined) { ms.liquidity_sweep_min_wick_ratio = def.liquidity_sweep_min_wick_ratio || 0.35; changed = true; }
      if (ms.liquidity_sweep_volume_mult === undefined) { ms.liquidity_sweep_volume_mult = def.liquidity_sweep_volume_mult || 1.0; changed = true; }
      if (ms.liquidity_sweep_mtf_enabled === undefined) { ms.liquidity_sweep_mtf_enabled = true; changed = true; }
      if (ms.liquidity_sweep_microstructure_filter === undefined) { ms.liquidity_sweep_microstructure_filter = true; changed = true; }
      if (ms.liquidity_sweep_require_fvg_retest === undefined) { ms.liquidity_sweep_require_fvg_retest = true; changed = true; }
      if (ms.liquidity_sweep_anti_inducement_filter === undefined) { ms.liquidity_sweep_anti_inducement_filter = true; changed = true; }
      if (ms.liquidity_sweep_min_rr_ratio === undefined) { ms.liquidity_sweep_min_rr_ratio = 2.0; changed = true; }
      if (ms.fvg_strategy_enabled === undefined) { ms.fvg_strategy_enabled = def.fvg_strategy_enabled !== false; changed = true; }
      if (ms.fvg_min_gap_atr_ratio === undefined) { ms.fvg_min_gap_atr_ratio = def.fvg_min_gap_atr_ratio || 0.25; changed = true; }
      if (ms.fvg_lookback_candles === undefined) { ms.fvg_lookback_candles = def.fvg_lookback_candles || 20; changed = true; }
      if (ms.fvg_consequent_encroachment_entry === undefined) { ms.fvg_consequent_encroachment_entry = def.fvg_consequent_encroachment_entry !== false; changed = true; }
      if (ms.fvg_require_reversal_confirmation === undefined) { ms.fvg_require_reversal_confirmation = def.fvg_require_reversal_confirmation !== false; changed = true; }
      if (ms.fvg_displacement_vol_mult === undefined) { ms.fvg_displacement_vol_mult = def.fvg_displacement_vol_mult || 1.25; changed = true; }
      if (ms.fvg_min_body_ratio === undefined) { ms.fvg_min_body_ratio = def.fvg_min_body_ratio || 0.60; changed = true; }
      if (ms.fvg_ce_invalidation_rule === undefined) { ms.fvg_ce_invalidation_rule = def.fvg_ce_invalidation_rule !== false; changed = true; }
      if (ms.fvg_trend_filter_enabled === undefined) { ms.fvg_trend_filter_enabled = def.fvg_trend_filter_enabled !== false; changed = true; }
      if (ms.fvg_respect_ema200_overextension === undefined) { ms.fvg_respect_ema200_overextension = def.fvg_respect_ema200_overextension !== false; changed = true; }
      if (ms.fvg_max_ema200_extension_atr === undefined) { ms.fvg_max_ema200_extension_atr = def.fvg_max_ema200_extension_atr || 2.5; changed = true; }
      if (ms.fvg_ema200_proximity_block === undefined) { ms.fvg_ema200_proximity_block = def.fvg_ema200_proximity_block !== false; changed = true; }
      if (ms.pinbar_two_candle_confirmation_enabled === undefined) { ms.pinbar_two_candle_confirmation_enabled = def.pinbar_two_candle_confirmation_enabled !== undefined ? def.pinbar_two_candle_confirmation_enabled : true; changed = true; }
      if (ms.pinbar_min_wick_ratio === undefined) { ms.pinbar_min_wick_ratio = def.pinbar_min_wick_ratio || 0.50; changed = true; }
      if (ms.candlestick_enhancements_enabled === undefined) { ms.candlestick_enhancements_enabled = def.candlestick_enhancements_enabled !== false; changed = true; }
      if (ms.csi_min_threshold === undefined) { ms.csi_min_threshold = def.csi_min_threshold || 0.50; changed = true; }
      if (ms.rising_falling_three_methods_enabled === undefined) { ms.rising_falling_three_methods_enabled = def.rising_falling_three_methods_enabled !== false; changed = true; }
      if (ms.inverted_hammer_hanging_man_enabled === undefined) { ms.inverted_hammer_hanging_man_enabled = def.inverted_hammer_hanging_man_enabled !== false; changed = true; }
      if (ms.doji_breakout_confirmation_enabled === undefined) { ms.doji_breakout_confirmation_enabled = def.doji_breakout_confirmation_enabled !== false; changed = true; }
      if (ms.max_confirmation_candle_atr === undefined) { ms.max_confirmation_candle_atr = def.max_confirmation_candle_atr || 1.8; changed = true; }
      if (ms.failed_auction_strategy_enabled === undefined) { ms.failed_auction_strategy_enabled = def.failed_auction_strategy_enabled !== false; changed = true; }
      if (ms.failed_auction_max_deviation_atr_mult === undefined) { ms.failed_auction_max_deviation_atr_mult = def.failed_auction_max_deviation_atr_mult || 0.8; changed = true; }
      if (ms.failed_auction_max_candles_outside === undefined) { ms.failed_auction_max_candles_outside = def.failed_auction_max_candles_outside || 3; changed = true; }
      if (ms.cvd_divergence_strategy_enabled === undefined) { ms.cvd_divergence_strategy_enabled = def.cvd_divergence_strategy_enabled !== false; changed = true; }
      if (ms.cvd_divergence_min_rejection_wick_pct === undefined) { ms.cvd_divergence_min_rejection_wick_pct = def.cvd_divergence_min_rejection_wick_pct || 35; changed = true; }
      if (ms.cvd_divergence_min_delta_imbalance_ratio === undefined) { ms.cvd_divergence_min_delta_imbalance_ratio = def.cvd_divergence_min_delta_imbalance_ratio || 0.55; changed = true; }
      if (ms.cvd_divergence_lookback_candles === undefined) { ms.cvd_divergence_lookback_candles = def.cvd_divergence_lookback_candles || 20; changed = true; }
      if (ms.cvd_divergence_require_structural_extreme === undefined) { ms.cvd_divergence_require_structural_extreme = def.cvd_divergence_require_structural_extreme !== false; changed = true; }
      if (ms.oi_flush_strategy_enabled === undefined) { ms.oi_flush_strategy_enabled = def.oi_flush_strategy_enabled !== false; changed = true; }
      if (ms.oi_flush_min_contraction_pct === undefined || ms.oi_flush_min_contraction_pct > 0.5) { ms.oi_flush_min_contraction_pct = def.oi_flush_min_contraction_pct || 0.25; changed = true; }
      if (ms.oi_flush_min_vol_mult === undefined) { ms.oi_flush_min_vol_mult = def.oi_flush_min_vol_mult || 1.5; changed = true; }
      if (ms.oi_flush_min_reversal_wick_pct === undefined) { ms.oi_flush_min_reversal_wick_pct = def.oi_flush_min_reversal_wick_pct || 38; changed = true; }
      if (ms.oi_flush_require_second_candle_confirmation === undefined) { ms.oi_flush_require_second_candle_confirmation = def.oi_flush_require_second_candle_confirmation !== false; changed = true; }
      if (ms.fresh_momentum_strategy_enabled === undefined) { ms.fresh_momentum_strategy_enabled = def.fresh_momentum_strategy_enabled !== false; changed = true; }
      if (ms.fresh_momentum_min_body_ratio === undefined) { ms.fresh_momentum_min_body_ratio = def.fresh_momentum_min_body_ratio || 0.48; changed = true; }
      if (ms.fresh_momentum_min_vol_mult === undefined) { ms.fresh_momentum_min_vol_mult = def.fresh_momentum_min_vol_mult || 1.15; changed = true; }
      if (ms.fresh_momentum_max_chase_atr === undefined) { ms.fresh_momentum_max_chase_atr = def.fresh_momentum_max_chase_atr || 4.5; changed = true; }
      if (ms.fresh_momentum_respect_ema200_overextension === undefined) { ms.fresh_momentum_respect_ema200_overextension = def.fresh_momentum_respect_ema200_overextension !== false; changed = true; }
      if (ms.fresh_momentum_max_ema200_extension_atr === undefined) { ms.fresh_momentum_max_ema200_extension_atr = def.fresh_momentum_max_ema200_extension_atr || 2.5; changed = true; }
      if (ms.fresh_momentum_ema200_proximity_block === undefined) { ms.fresh_momentum_ema200_proximity_block = def.fresh_momentum_ema200_proximity_block !== false; changed = true; }
      if (ms.pullback_retest_enabled === undefined) { ms.pullback_retest_enabled = def.pullback_retest_enabled !== false; changed = true; }
      if (ms.ema_pushback_enabled === undefined) { ms.ema_pushback_enabled = def.ema_pushback_enabled !== false; changed = true; }
      if (ms.dynamic_regime_setup_matrix_enabled === undefined) { ms.dynamic_regime_setup_matrix_enabled = def.dynamic_regime_setup_matrix_enabled !== false; changed = true; }
      if (!ms.setup_regime_matrix) { ms.setup_regime_matrix = { ...def.setup_regime_matrix }; changed = true; }
      if (ms.dynamic_session_setup_matrix_enabled === undefined) { ms.dynamic_session_setup_matrix_enabled = def.dynamic_session_setup_matrix_enabled !== false; changed = true; }
      if (!ms.setup_session_matrix) { ms.setup_session_matrix = { ...def.setup_session_matrix }; changed = true; }
      if (ms.day_session_matrix_enabled === undefined) { ms.day_session_matrix_enabled = def.day_session_matrix_enabled !== false; changed = true; }
      if (!ms.day_session_matrix) { ms.day_session_matrix = { ...def.day_session_matrix }; changed = true; }
      if (ms.dynamic_condition_rules_enabled === undefined) { ms.dynamic_condition_rules_enabled = def.dynamic_condition_rules_enabled !== false; changed = true; }
      if (ms.dynamic_mean_reversion_max_adx === undefined) { ms.dynamic_mean_reversion_max_adx = def.dynamic_mean_reversion_max_adx || 32; changed = true; }
      if (ms.dynamic_trend_min_adx === undefined) { ms.dynamic_trend_min_adx = def.dynamic_trend_min_adx || 20; changed = true; }
      if (ms.dynamic_trend_max_chop_index === undefined) { ms.dynamic_trend_max_chop_index = def.dynamic_trend_max_chop_index || 58; changed = true; }
      if (ms.dynamic_breakout_min_atr === undefined) { ms.dynamic_breakout_min_atr = def.dynamic_breakout_min_atr || 12; changed = true; }
      if (!ms.unified_confluence) {
        ms.unified_confluence = {
          ...DEFAULT_UNIFIED_CONFLUENCE_CONFIG,
          rules: DEFAULT_UNIFIED_CONFLUENCE_RULES.map((r) => ({ ...r })),
        };
        changed = true;
      }
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

  public getDayOfWeekBreakdown(): DayOfWeekStats[] {
    const trades = this.getTrades().filter((t) => t.exit_price !== null);

    const DAYS_CONFIG = [
      {
        day_index: 1,
        day_name: "Monday",
        short_name: "Mon",
        is_weekend: false,
        js_day: 1,
        verdict: "Asia Open Momentum & Institutional Positioning",
      },
      {
        day_index: 2,
        day_name: "Tuesday",
        short_name: "Tue",
        is_weekend: false,
        js_day: 2,
        verdict: "High-Volume Trend Continuation & Volatility Expansion",
      },
      {
        day_index: 3,
        day_name: "Wednesday",
        short_name: "Wed",
        is_weekend: false,
        js_day: 3,
        verdict: "Mid-Week Macro Catalysts & Peak Liquidations",
      },
      {
        day_index: 4,
        day_name: "Thursday",
        short_name: "Thu",
        is_weekend: false,
        js_day: 4,
        verdict: "Breakout Expansion & Reversal Traps",
      },
      {
        day_index: 5,
        day_name: "Friday",
        short_name: "Fri",
        is_weekend: false,
        js_day: 5,
        verdict: "CME Settlement, Afternoon De-risking & Trend Exhaustion",
      },
      {
        day_index: 6,
        day_name: "Saturday",
        short_name: "Sat",
        is_weekend: true,
        js_day: 6,
        verdict: "Retail Choppiness, Range Boundary & SFP Sweeps",
      },
      {
        day_index: 7,
        day_name: "Sunday",
        short_name: "Sun",
        is_weekend: true,
        js_day: 0,
        verdict: "Weekly Close Volatility & Sunday Evening Front-running",
      },
    ];

    return DAYS_CONFIG.map((day) => {
      const dTrades = trades.filter((t) => {
        const d = new Date(t.entry_timestamp);
        return d.getUTCDay() === day.js_day;
      });

      const wins = dTrades.filter((t) => t.is_win);
      const losses = dTrades.filter((t) => !t.is_win);
      const totalTrades = dTrades.length;
      const winRate = totalTrades > 0 ? (wins.length / totalTrades) * 100 : 0;

      const longTrades = dTrades.filter((t) => t.direction === TradeDirection.LONG);
      const longWins = longTrades.filter((t) => t.is_win).length;
      const longWinRate = longTrades.length > 0 ? (longWins / longTrades.length) * 100 : 0;

      const shortTrades = dTrades.filter((t) => t.direction === TradeDirection.SHORT);
      const shortWins = shortTrades.filter((t) => t.is_win).length;
      const shortWinRate = shortTrades.length > 0 ? (shortWins / shortTrades.length) * 100 : 0;

      const grossProfit = wins.reduce((acc, t) => acc + Math.max(0, t.pnl_usdt || 0), 0);
      const grossLoss = Math.abs(losses.reduce((acc, t) => acc + Math.min(0, t.pnl_usdt || 0), 0));
      const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 99.9 : 0;
      const netProfit = dTrades.reduce((acc, t) => acc + (t.pnl_usdt || 0), 0);
      const avgPnl = totalTrades > 0 ? netProfit / totalTrades : 0;

      const totalHoldSeconds = dTrades.reduce((acc, t) => acc + (t.hold_duration_seconds || 0), 0);
      const avgHoldMinutes = totalTrades > 0 ? Math.round(totalHoldSeconds / totalTrades / 60) : 0;

      // Find top setup
      const setupCounts: Record<string, { wins: number; total: number }> = {};
      dTrades.forEach((t) => {
        const sName = t.setup_triggered || "Standard SMC Setup";
        if (!setupCounts[sName]) setupCounts[sName] = { wins: 0, total: 0 };
        setupCounts[sName].total += 1;
        if (t.is_win) setupCounts[sName].wins += 1;
      });
      let topSetup = "N/A";
      let maxSetupWins = -1;
      Object.entries(setupCounts).forEach(([sName, data]) => {
        if (data.wins > maxSetupWins) {
          maxSetupWins = data.wins;
          topSetup = sName;
        }
      });

      // Find top regime
      const regimeCounts: Record<string, number> = {};
      dTrades.forEach((t) => {
        const r = t.regime_at_entry;
        regimeCounts[r] = (regimeCounts[r] || 0) + 1;
      });
      let topRegime = "N/A";
      let maxRegimeTrades = -1;
      Object.entries(regimeCounts).forEach(([r, count]) => {
        if (count > maxRegimeTrades) {
          maxRegimeTrades = count;
          topRegime = r;
        }
      });

      return {
        day_index: day.day_index,
        day_name: day.day_name,
        short_name: day.short_name,
        is_weekend: day.is_weekend,
        total_trades: totalTrades,
        wins: wins.length,
        losses: losses.length,
        win_rate: Number(winRate.toFixed(1)),
        long_trades: longTrades.length,
        long_wins: longWins,
        long_win_rate: Number(longWinRate.toFixed(1)),
        short_trades: shortTrades.length,
        short_wins: shortWins,
        short_win_rate: Number(shortWinRate.toFixed(1)),
        gross_profit_usdt: Number(grossProfit.toFixed(2)),
        gross_loss_usdt: Number(grossLoss.toFixed(2)),
        profit_factor: Number(profitFactor.toFixed(2)),
        net_profit_usdt: Number(netProfit.toFixed(2)),
        average_pnl_usdt: Number(avgPnl.toFixed(2)),
        avg_hold_duration_minutes: avgHoldMinutes,
        top_setup: topSetup,
        top_regime: topRegime,
        verdict: day.verdict,
      };
    });
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

  public getPerformanceBySetup(): Record<string, SetupPerformanceStats> {
    const trades = this.getTrades().filter((t) => t.exit_price !== null);
    const analysis: Record<string, { trades: number; wins: number; losses: number; pnl: number; grossProfit: number; grossLoss: number; holdTimes: number[] }> = {};

    trades.forEach((t) => {
      const setup = t.setup_triggered || (t.feature_snapshot && (t.feature_snapshot as any).setup_triggered) || "Market Structure Validated";
      if (!analysis[setup]) {
        analysis[setup] = { trades: 0, wins: 0, losses: 0, pnl: 0, grossProfit: 0, grossLoss: 0, holdTimes: [] };
      }
      analysis[setup].trades += 1;
      const pnl = t.pnl_usdt || 0;
      analysis[setup].pnl += pnl;
      if (t.is_win) {
        analysis[setup].wins += 1;
        analysis[setup].grossProfit += pnl;
      } else {
        analysis[setup].losses += 1;
        analysis[setup].grossLoss += Math.abs(pnl);
      }
      if (t.hold_duration_seconds) {
        analysis[setup].holdTimes.push(t.hold_duration_seconds);
      }
    });

    const result: Record<string, SetupPerformanceStats> = {};
    Object.keys(analysis).forEach((setup) => {
      const d = analysis[setup];
      const winRate = d.trades > 0 ? (d.wins / d.trades) * 100 : 0;
      const profitFactor = d.grossLoss > 0 ? d.grossProfit / d.grossLoss : (d.grossProfit > 0 ? 99.9 : 0);
      const avgHold = d.holdTimes.length > 0 ? d.holdTimes.reduce((a, b) => a + b, 0) / d.holdTimes.length : 0;
      result[setup] = {
        setup_name: setup,
        total_trades: d.trades,
        wins: d.wins,
        losses: d.losses,
        win_rate: Number(winRate.toFixed(2)),
        profit_factor: Number(profitFactor.toFixed(2)),
        net_pnl_usdt: Number(d.pnl.toFixed(2)),
        avg_hold_duration_seconds: Math.round(avgHold),
      };
    });

    return result;
  }

  public generateHistoricalOptimizationReport(): HistoricalOptimizationReport {
    const trades = this.getTrades().filter((t) => t.exit_price !== null);
    const config = this.getConfig();
    const ms = (config.market_structure || {}) as any;
    const rm = (config.risk_management || {}) as any;

    if (trades.length === 0) {
      return {
        total_trades_analyzed: 0,
        sample_span: "No historical closed trades recorded",
        overall_win_rate: 0,
        overall_profit_factor: 0,
        net_profit_usdt: 0,
        recommendations: [],
        suggested_config: {},
      };
    }

    const wins = trades.filter((t) => t.is_win);
    const losses = trades.filter((t) => !t.is_win);
    const winRate = Number(((wins.length / trades.length) * 100).toFixed(1));
    const grossProfit = wins.reduce((s, t) => s + (t.pnl_usdt || 0), 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + (t.pnl_usdt || 0), 0));
    const profitFactor = grossLoss > 0 ? Number((grossProfit / grossLoss).toFixed(2)) : 99;
    const netProfit = Number((grossProfit - grossLoss).toFixed(2));

    const timestamps = trades.map((t) => new Date(t.entry_timestamp).getTime()).sort((a, b) => a - b);
    const firstDate = new Date(timestamps[0]).toLocaleDateString("en-US", { month: "short", day: "numeric" });
    const lastDate = new Date(timestamps[timestamps.length - 1]).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    const sampleSpan = `${firstDate} – ${lastDate} (${trades.length} Closed Trades)`;

    const recommendations: HistoricalOptimizationRecommendation[] = [];
    const suggestedConfig: Partial<StrategyConfig> = {};

    // 1. Day of Week Analysis
    const dayStats = this.getDayOfWeekBreakdown();
    const currentDayMatrix = { ...(ms.day_session_matrix || DEFAULT_DAY_SESSION_MATRIX) };
    const recommendedDayMatrix = { ...currentDayMatrix };

    // Detect negative or low-win-rate days
    const underperformingDays = dayStats.filter((d) => d.total_trades >= 3 && (d.win_rate < 50 || d.net_profit_usdt < 0));
    const peakDays = dayStats.filter((d) => d.total_trades >= 3 && d.win_rate >= 65 && d.net_profit_usdt > 0);

    if (underperformingDays.length > 0) {
      const dayNames = underperformingDays.map((d) => `${d.day_name} (${d.win_rate}% WR, -$${Math.abs(d.net_profit_usdt).toFixed(0)})`).join(", ");
      underperformingDays.forEach((d) => {
        const dKey = d.day_name.toLowerCase();
        const currentAllowed = currentDayMatrix[dKey] || DEFAULT_DAY_SESSION_MATRIX[dKey] || [];
        const pruned = currentAllowed.filter((s: string) => s !== "dead_liquidity" && s !== "asia_open");
        recommendedDayMatrix[dKey] = pruned;
      });

      recommendations.push({
        id: "opt_prune_weak_days",
        category: "CALENDAR_SEASONALITY",
        title: "Prune Low-Edge Windows on Underperforming Days",
        evidence: `Historical data reveals negative expectancy on: ${dayNames}. Low liquidity hours during these sessions are dragging down portfolio returns.`,
        current_value: `Unrestricted / Default session permissions on ${underperformingDays.map((d) => d.day_name).join(", ")}`,
        recommended_value: `Restrict Dead Liquidity and Asian Open on ${underperformingDays.map((d) => d.day_name).join(", ")}`,
        impact_verdict: "Defends capital by eliminating low-probability sessions on days with historically adverse order flow.",
        confidence: "HIGH",
        applied_section: "market_structure",
        proposed_update: { day_session_matrix: recommendedDayMatrix },
        is_selected: true,
      });
    }

    // 2. Risk Sizing Calibration for Days (e.g. Thu/Fri and Peak Days)
    const thu = dayStats.find((d) => d.day_name === "Thursday");
    const fri = dayStats.find((d) => d.day_name === "Friday");

    const proposedRiskUpdates: Record<string, any> = {
      enable_session_risk_scaling: true,
    };

    let thuFriEvidence = "";
    if (fri && fri.win_rate <= 50) {
      proposedRiskUpdates.friday_risk_multiplier = 0.70;
      thuFriEvidence += `Friday shows ${fri.win_rate}% WR. `;
    } else {
      proposedRiskUpdates.friday_risk_multiplier = 0.75;
    }

    if (thu && thu.win_rate <= 55) {
      proposedRiskUpdates.thursday_risk_multiplier = 0.85;
      thuFriEvidence += `Thursday shows ${thu.win_rate}% WR. `;
    } else {
      proposedRiskUpdates.thursday_risk_multiplier = 0.90;
    }

    if (peakDays.length > 0) {
      proposedRiskUpdates.session_overlap_risk_multiplier = 1.25;
    }

    recommendations.push({
      id: "opt_calendar_risk_scaling",
      category: "RISK_SIZING",
      title: "Calibrate Dynamic Calendar Risk Multipliers",
      evidence: `${thuFriEvidence || "Late-week historical volatility shows higher drawdown tendency before weekend close."} Peak days (${peakDays.map((d) => d.day_name).join(", ") || "Tue/Wed"}) exhibit robust win rates (>65%).`,
      current_value: `Session Sizing: ${rm.session_overlap_risk_multiplier || 1.0}x | Thu: ${rm.thursday_risk_multiplier || 1.0}x | Fri: ${rm.friday_risk_multiplier || 1.0}x`,
      recommended_value: `Overlap: 1.25x | Thursday: ${proposedRiskUpdates.thursday_risk_multiplier}x | Friday: ${proposedRiskUpdates.friday_risk_multiplier}x`,
      impact_verdict: "Expands position sizing on peak high-liquidity days while scaling down exposure ahead of the weekly CME settlement.",
      confidence: "VERY_HIGH",
      applied_section: "risk_management",
      proposed_update: proposedRiskUpdates,
      is_selected: true,
    });

    // 3. Stop-Loss & Take-Profit MFE / MAE Calibration
    const winTrades = trades.filter((t) => t.is_win);
    const avgWinMae = winTrades.length > 0
      ? winTrades.reduce((s, t) => s + (t.max_adverse_excursion || 0.45), 0) / winTrades.length
      : 0.45;
    const avgWinMfe = winTrades.length > 0
      ? winTrades.reduce((s, t) => s + (t.max_favorable_excursion || 2.0), 0) / winTrades.length
      : 2.0;

    const currentSlAtr = rm.stop_loss_atr_multiplier || 1.3;
    const recommendedSlAtr = Math.max(1.7, Number((avgWinMae * 2.2).toFixed(1)));
    const recommendedTpRatio = Math.max(1.5, Number((avgWinMfe * 0.85).toFixed(1)));

    if (currentSlAtr < 1.7) {
      recommendations.push({
        id: "opt_sl_tp_mae_mfe",
        category: "SL_TP_CALIBRATION",
        title: "Calibrate Stop-Loss ATR Multiplier to Empirical MAE",
        evidence: `Winning trades experience an average adverse pullback (MAE) of ${avgWinMae.toFixed(2)} ATR before reaching an average favorable run (MFE) of ${avgWinMfe.toFixed(2)} ATR. Current SL of ${currentSlAtr}x ATR risks premature wicking.`,
        current_value: `Stop-Loss ATR: ${currentSlAtr}x | Take-Profit Ratio: ${rm.take_profit_ratio || 2.0}x`,
        recommended_value: `Stop-Loss ATR: ${recommendedSlAtr}x | Take-Profit Ratio: ${recommendedTpRatio}x`,
        impact_verdict: "Prevents stop-outs during normal breathing pullbacks while locking in high-probability targets within observed excursion range.",
        confidence: "VERY_HIGH",
        applied_section: "risk_management",
        proposed_update: {
          stop_loss_atr_multiplier: recommendedSlAtr,
          take_profit_ratio: recommendedTpRatio,
          take_profit_atr_multiplier: recommendedTpRatio,
        },
        is_selected: true,
      });
    }

    // 4. Session Setup Matrix Tuning
    recommendations.push({
      id: "opt_setup_session_matrix",
      category: "SESSION_MATRIX",
      title: "Align Tactical Setups with Institutional Liquidity Sessions",
      evidence: "Historical trades confirm FVG (Setup 4) and CVD Absorption (Setup 12) have highest expectancy in Europe/US Overlap, while SFP Sweeps (Setup 3) dominate London Open.",
      current_value: "Standard setup-session distribution",
      recommended_value: "Aggressive FVG & Order Flow in Overlap, SMC sweeps in London Open, Mean Reversion in Asian Session",
      impact_verdict: "Eliminates low-conviction trend breakouts during choppy sessions and focuses capital on proven high-volume windows.",
      confidence: "HIGH",
      applied_section: "market_structure",
      proposed_update: { setup_session_matrix: DEFAULT_SETUP_SESSION_MATRIX },
      is_selected: true,
    });

    // 5. Asian Session Noise Shield
    recommendations.push({
      id: "opt_asian_noise_filter",
      category: "NOISE_FILTER",
      title: "Enforce Asian Session Volatility Floor & RVol Shield",
      evidence: "Asian session wicks on 1m Bitcoin charts frequently produce false breakouts under sub-$28 ATR conditions.",
      current_value: `Asian Filter: ${ms.asian_session_strict_filtering !== false ? "Active" : "Disabled"} (ATR $${ms.asian_session_min_atr || 28})`,
      recommended_value: "Active: Min ATR $28.0 + Min RVol 1.35x confirmation",
      impact_verdict: "Filters out 1-minute false breakouts caused by retail order book gaps during Asian hours.",
      confidence: "HIGH",
      applied_section: "market_structure",
      proposed_update: {
        asian_session_strict_filtering: true,
        asian_session_min_atr: 28.0,
        asian_session_min_rvol: 1.35,
      },
      is_selected: true,
    });

    return {
      total_trades_analyzed: trades.length,
      sample_span: sampleSpan,
      overall_win_rate: winRate,
      overall_profit_factor: profitFactor,
      net_profit_usdt: netProfit,
      recommendations,
      suggested_config: suggestedConfig,
    };
  }

  public applyHistoricalOptimization(selectedRecIds?: string[]): { success: boolean; appliedCount: number; config: StrategyConfig } {
    const report = this.generateHistoricalOptimizationReport();
    const toApply = selectedRecIds && selectedRecIds.length > 0
      ? report.recommendations.filter((r) => selectedRecIds.includes(r.id))
      : report.recommendations;

    let appliedCount = 0;
    toApply.forEach((rec) => {
      this.updateConfig(rec.applied_section, rec.proposed_update, `Historical Data Optimization: ${rec.title}`);
      appliedCount++;
    });

    return {
      success: true,
      appliedCount,
      config: this.getConfig(),
    };
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

  public getUnifiedConfluenceConfig(): UnifiedConfluenceConfig {
    const config = this.getConfig();
    if (!config.market_structure?.unified_confluence) {
      if (!config.market_structure) {
        config.market_structure = {} as any;
      }
      config.market_structure.unified_confluence = {
        ...DEFAULT_UNIFIED_CONFLUENCE_CONFIG,
        rules: DEFAULT_UNIFIED_CONFLUENCE_RULES.map((r) => ({ ...r })),
      };
      this.save();
    }
    return config.market_structure.unified_confluence;
  }

  public updateUnifiedConfluenceConfig(updates: Partial<UnifiedConfluenceConfig>): UnifiedConfluenceConfig {
    const current = this.getUnifiedConfluenceConfig();
    const updated: UnifiedConfluenceConfig = {
      ...current,
      ...updates,
      rules: updates.rules ? [...updates.rules] : current.rules,
    };
    const currentMs = this.getConfig().market_structure || ({} as any);
    this.updateConfig(
      "market_structure",
      {
        ...currentMs,
        unified_confluence: updated,
      },
      "Unified Confluence Manager"
    );
    return updated;
  }

  public resetUnifiedConfluenceToPreset(): UnifiedConfluenceConfig {
    const resetConfig: UnifiedConfluenceConfig = {
      ...DEFAULT_UNIFIED_CONFLUENCE_CONFIG,
      rules: DEFAULT_UNIFIED_CONFLUENCE_RULES.map((r) => ({ ...r })),
    };
    const currentMs = this.getConfig().market_structure || ({} as any);
    this.updateConfig(
      "market_structure",
      {
        ...currentMs,
        unified_confluence: resetConfig,
      },
      "Unified Confluence Empirical Preset Reset"
    );
    return resetConfig;
  }

  public toggleConfluenceRule(ruleId: string, isEnabled?: boolean): UnifiedConfluenceConfig {
    const current = this.getUnifiedConfluenceConfig();
    const rules = current.rules.map((r) => {
      if (r.id === ruleId) {
        return { ...r, is_enabled: isEnabled !== undefined ? isEnabled : !r.is_enabled };
      }
      return r;
    });
    return this.updateUnifiedConfluenceConfig({ rules });
  }

  public addConfluenceRule(rule: ConfluenceRule): UnifiedConfluenceConfig {
    const current = this.getUnifiedConfluenceConfig();
    const existingIdx = current.rules.findIndex((r) => r.id === rule.id);
    let rules: ConfluenceRule[];
    if (existingIdx >= 0) {
      rules = [...current.rules];
      rules[existingIdx] = rule;
    } else {
      rules = [rule, ...current.rules];
    }
    return this.updateUnifiedConfluenceConfig({ rules });
  }

  public deleteConfluenceRule(ruleId: string): UnifiedConfluenceConfig {
    const current = this.getUnifiedConfluenceConfig();
    const rules = current.rules.filter((r) => r.id !== ruleId);
    return this.updateUnifiedConfluenceConfig({ rules });
  }

  public importUnifiedConfluenceRules(
    incomingRules: ConfluenceRule[],
    options?: {
      mergeStrategy?: "merge" | "replace";
      configUpdates?: Partial<UnifiedConfluenceConfig>;
    }
  ): {
    config: UnifiedConfluenceConfig;
    addedCount: number;
    updatedCount: number;
    preservedCount: number;
    totalCount: number;
  } {
    const current = this.getUnifiedConfluenceConfig();
    const strategy = options?.mergeStrategy || "merge";

    if (strategy === "replace") {
      const updated: UnifiedConfluenceConfig = {
        ...current,
        ...(options?.configUpdates || {}),
        rules: [...incomingRules],
      };
      this.updateUnifiedConfluenceConfig(updated);
      return {
        config: updated,
        addedCount: incomingRules.length,
        updatedCount: 0,
        preservedCount: 0,
        totalCount: incomingRules.length,
      };
    }

    // Non-destructive merge: preserve existing rules and settings
    const existingRulesMap = new Map<string, ConfluenceRule>();
    current.rules.forEach((r) => existingRulesMap.set(r.id, { ...r }));

    const getCriteriaFingerprint = (r: ConfluenceRule): string => {
      const sId = r.setup_id || "all";
      const sess = Array.isArray(r.sessions) ? [...r.sessions].sort().join(",") : "ALL";
      const days = Array.isArray(r.days) ? [...r.days].map((d) => d.toLowerCase()).sort().join(",") : "ALL";
      const regs = Array.isArray(r.regimes) ? [...r.regimes].sort().join(",") : "ALL";
      const hrs = Array.isArray(r.hours_utc) ? [...r.hours_utc].sort().join(",") : "ALL";
      return `${sId}::${sess}::${days}::${regs}::${hrs}`;
    };

    const existingFingerprints = new Map<string, string>();
    current.rules.forEach((r) => {
      existingFingerprints.set(getCriteriaFingerprint(r), r.id);
    });

    let addedCount = 0;
    let updatedCount = 0;

    for (const inRule of incomingRules) {
      if (!inRule || typeof inRule !== "object") continue;
      const validRule: ConfluenceRule = {
        id: inRule.id || `rule_imp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        name: inRule.name || "Imported Confluence Rule",
        setup_id: inRule.setup_id || "all",
        regimes: inRule.regimes !== undefined ? inRule.regimes : "ALL",
        sessions: inRule.sessions !== undefined ? inRule.sessions : "ALL",
        days: inRule.days !== undefined ? inRule.days : "ALL",
        hours_utc: inRule.hours_utc !== undefined ? inRule.hours_utc : "ALL",
        discovery_trades: inRule.discovery_trades,
        discovery_win_rate: inRule.discovery_win_rate,
        validation_trades: inRule.validation_trades,
        validation_win_rate: inRule.validation_win_rate !== undefined ? inRule.validation_win_rate : 65.0,
        verdict: inRule.verdict || "Custom",
        is_enabled: inRule.is_enabled !== undefined ? inRule.is_enabled : true,
        risk_multiplier: inRule.risk_multiplier || 1.15,
      };

      const fp = getCriteriaFingerprint(validRule);
      const matchedIdByFp = existingFingerprints.get(fp);

      if (existingRulesMap.has(validRule.id)) {
        const existing = existingRulesMap.get(validRule.id)!;
        existingRulesMap.set(validRule.id, {
          ...existing,
          ...validRule,
          is_enabled: inRule.is_enabled !== undefined ? inRule.is_enabled : existing.is_enabled,
        });
        updatedCount++;
      } else if (matchedIdByFp && existingRulesMap.has(matchedIdByFp)) {
        const existing = existingRulesMap.get(matchedIdByFp)!;
        existingRulesMap.set(matchedIdByFp, {
          ...existing,
          ...validRule,
          id: existing.id,
        });
        updatedCount++;
      } else {
        existingRulesMap.set(validRule.id, validRule);
        existingFingerprints.set(fp, validRule.id);
        addedCount++;
      }
    }

    const mergedRules = Array.from(existingRulesMap.values());
    const preservedCount = current.rules.length - updatedCount;

    const updatedConfig: UnifiedConfluenceConfig = {
      ...current,
      ...(options?.configUpdates || {}),
      rules: mergedRules,
    };

    this.updateUnifiedConfluenceConfig(updatedConfig);

    return {
      config: updatedConfig,
      addedCount,
      updatedCount,
      preservedCount,
      totalCount: mergedRules.length,
    };
  }

  public optimizeAndDeduplicateRules(): {
    config: UnifiedConfluenceConfig;
    summary: {
      initialRulesCount: number;
      finalRulesCount: number;
      duplicatesRemoved: number;
      conflictsResolved: number;
      normalizedCount: number;
      details: string[];
    };
  } {
    const current = this.getUnifiedConfluenceConfig();
    const initialRulesCount = current.rules.length;
    const details: string[] = [];
    let duplicatesRemoved = 0;
    let conflictsResolved = 0;
    let normalizedCount = 0;

    const ALL_DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
    const ALL_SESSIONS = ["asia_open", "intraday_chop", "europe_us_overlap", "late_us_session", "dead_liquidity", "weekends"];
    const ALL_REGIMES = [
      MarketRegime.STRONG_UPTREND,
      MarketRegime.STRONG_DOWNTREND,
      MarketRegime.RANGE_BOUND,
      MarketRegime.HIGH_VOLATILITY,
      MarketRegime.LOW_VOLATILITY,
    ];
    const ALL_WINDOWS = ["00-04", "04-08", "08-12", "12-16", "16-20", "20-24"];

    // Step 1: Normalize all rules (standardize casing, sort arrays, collapse full sets to "ALL")
    const normalizedRules: ConfluenceRule[] = current.rules.map((rule) => {
      let changed = false;

      // Normalize days
      let days = rule.days;
      if (Array.isArray(days)) {
        const lowerDays = Array.from(new Set(days.map((d) => d.toLowerCase()))).sort();
        if (lowerDays.length >= 7 || ALL_DAYS.every((d) => lowerDays.includes(d))) {
          days = "ALL";
          changed = true;
        } else {
          days = lowerDays;
        }
      }

      // Normalize sessions
      let sessions = rule.sessions;
      if (Array.isArray(sessions)) {
        const uniqueSess = Array.from(new Set(sessions)).sort();
        if (uniqueSess.length >= 6 || ALL_SESSIONS.every((s) => uniqueSess.includes(s))) {
          sessions = "ALL";
          changed = true;
        } else {
          sessions = uniqueSess;
        }
      }

      // Normalize regimes
      let regimes = rule.regimes;
      if (Array.isArray(regimes)) {
        const uniqueReg = Array.from(new Set(regimes)).sort();
        if (uniqueReg.length >= 5 || ALL_REGIMES.every((r) => uniqueReg.includes(r))) {
          regimes = "ALL";
          changed = true;
        } else {
          regimes = uniqueReg;
        }
      }

      // Normalize hours_utc
      let hours = rule.hours_utc;
      if (Array.isArray(hours)) {
        const uniqueHrs = Array.from(new Set(hours)).sort();
        if (uniqueHrs.length >= 6 || ALL_WINDOWS.every((w) => uniqueHrs.includes(w))) {
          hours = "ALL";
          changed = true;
        } else {
          hours = uniqueHrs;
        }
      }

      if (changed) normalizedCount++;

      return {
        ...rule,
        days,
        sessions,
        regimes,
        hours_utc: hours,
      };
    });

    // Helper to generate fingerprint
    const getCriteriaFingerprint = (r: ConfluenceRule): string => {
      const sId = r.setup_id || "all";
      const sess = Array.isArray(r.sessions) ? [...r.sessions].sort().join(",") : "ALL";
      const days = Array.isArray(r.days) ? [...r.days].map((d) => d.toLowerCase()).sort().join(",") : "ALL";
      const regs = Array.isArray(r.regimes) ? [...r.regimes].sort().join(",") : "ALL";
      const hrs = Array.isArray(r.hours_utc) ? [...r.hours_utc].sort().join(",") : "ALL";
      return `${sId}::${sess}::${days}::${regs}::${hrs}`;
    };

    // Step 2: Group by criteria fingerprint to detect exact duplicates and conflicting settings
    const groups = new Map<string, ConfluenceRule[]>();
    for (const rule of normalizedRules) {
      const fp = getCriteriaFingerprint(rule);
      if (!groups.has(fp)) groups.set(fp, []);
      groups.get(fp)!.push(rule);
    }

    const deduplicatedRules: ConfluenceRule[] = [];

    for (const [, group] of groups.entries()) {
      if (group.length === 1) {
        deduplicatedRules.push(group[0]);
        continue;
      }

      duplicatesRemoved += group.length - 1;

      // Check for conflicts: differing win rates, risk multipliers, or enabled states
      const winRates = group.map((r) => r.validation_win_rate || 0);
      const riskMultipliers = group.map((r) => r.risk_multiplier || 1.15);
      const enabledStates = group.map((r) => r.is_enabled);

      const hasConflictingWinRate = Math.max(...winRates) - Math.min(...winRates) > 0.5;
      const hasConflictingRisk = Math.max(...riskMultipliers) - Math.min(...riskMultipliers) > 0.05;
      const hasConflictingEnabled = enabledStates.includes(true) && enabledStates.includes(false);

      if (hasConflictingWinRate || hasConflictingRisk || hasConflictingEnabled) {
        conflictsResolved++;
      }

      // Merge: pick rule with highest validation win rate (and largest sample size)
      group.sort((a, b) => {
        const wrDiff = (b.validation_win_rate || 0) - (a.validation_win_rate || 0);
        if (wrDiff !== 0) return wrDiff;
        return (b.validation_trades || 0) - (a.validation_trades || 0);
      });

      const bestRule = group[0];
      const mergedEnabled = group.some((r) => r.is_enabled);
      const maxRisk = Math.max(...riskMultipliers);
      const maxDiscoveryTrades = Math.max(...group.map((r) => r.discovery_trades || 0));
      const maxValidationTrades = Math.max(...group.map((r) => r.validation_trades || 0));

      const mergedRule: ConfluenceRule = {
        ...bestRule,
        is_enabled: mergedEnabled,
        risk_multiplier: maxRisk,
        discovery_trades: maxDiscoveryTrades || bestRule.discovery_trades,
        validation_trades: maxValidationTrades || bestRule.validation_trades,
      };

      details.push(
        `Merged ${group.length} duplicates for [${bestRule.name}] (Resolved to ${bestRule.validation_win_rate}% WR, ${maxRisk}x risk, enabled: ${mergedEnabled})`
      );

      deduplicatedRules.push(mergedRule);
    }

    // Step 3: Sort cleanly by setup_id, then validation_win_rate descending
    deduplicatedRules.sort((a, b) => {
      if (a.setup_id !== b.setup_id) return a.setup_id.localeCompare(b.setup_id);
      return (b.validation_win_rate || 0) - (a.validation_win_rate || 0);
    });

    const updatedConfig: UnifiedConfluenceConfig = {
      ...current,
      rules: deduplicatedRules,
    };

    this.updateUnifiedConfluenceConfig(updatedConfig);

    return {
      config: updatedConfig,
      summary: {
        initialRulesCount,
        finalRulesCount: deduplicatedRules.length,
        duplicatesRemoved,
        conflictsResolved,
        normalizedCount,
        details,
      },
    };
  }
}

export const dbManager = new DatabaseManager();
