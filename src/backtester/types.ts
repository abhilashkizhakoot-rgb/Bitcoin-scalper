/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { MarketRegime, Candlestick } from "../types.js";

export interface BacktestSetupOption {
  id: string;
  name: string;
  description: string;
  category: "trend" | "range" | "reversal" | "orderflow";
}

export const DEFAULT_AVAILABLE_SETUPS: BacktestSetupOption[] = [
  {
    id: "setup_1_pullback_retest",
    name: "Setup 1: Pullback & Retest",
    description: "Breakout of key horizontal range boundary followed by retest of broken level as new support/resistance with rejection confirmation.",
    category: "trend",
  },
  {
    id: "setup_2_dynamic_ema_pushback",
    name: "Setup 2: Dynamic EMA Pushback",
    description: "Trend continuation bounce off dynamic EMA 20/50 support/resistance band with trend alignment and volume expansion.",
    category: "trend",
  },
  {
    id: "setup_3_liquidity_sweep",
    name: "Setup 3: Liquidity Sweep Reversal",
    description: "Aggressive multi-timeframe swing high/low sweep that rapidly reclaims internal structure with CVD delta absorption.",
    category: "reversal",
  },
  {
    id: "setup_4_fvg_retest",
    name: "Setup 4: Fair Value Gap Retest",
    description: "Impulse imbalance mitigation at consequent encroachment (50% CE) with institutional volume validation.",
    category: "trend",
  },
  {
    id: "setup_9_range_failed_auction",
    name: "Setup 9: Range Failed Auction Reclaim",
    description: "Swing Failure Pattern (SFP) outside range boundary that snaps back inside with order flow absorption.",
    category: "reversal",
  },
  {
    id: "setup_10_vwap_band_rejection",
    name: "Setup 10: VWAP Band Rejection",
    description: "Mean-reversion bounce off ±2 standard deviation VWAP bands with CVD exhaustion and delta divergence.",
    category: "reversal",
  },
  {
    id: "setup_11_eqh_eql_double_touch",
    name: "Setup 11: EQH/EQL Double Touch",
    description: "Equal Highs/Equal Lows liquidity grab sweep with rapid pin-bar reclaim.",
    category: "reversal",
  },
  {
    id: "setup_12_cvd_absorption",
    name: "Setup 12: CVD Absorption & Delta Divergence",
    description: "Heavy delta divergence where aggressive taker market orders fail to push price through passive limit walls.",
    category: "orderflow",
  },
  {
    id: "setup_13_oi_flush_cascade",
    name: "Setup 13: OI Flush & Cascade Fade",
    description: "Fades sudden liquidation-driven cascade extremes coinciding with rapid Open Interest contraction and exhaustion wicks.",
    category: "orderflow",
  },
  {
    id: "setup_14_fresh_momentum_impulse",
    name: "Setup 14: Fresh Momentum Impulse",
    description: "High-velocity breakout continuation with volume expansion and trend alignment.",
    category: "trend",
  },
  {
    id: "setup_15_trendline_bounce",
    name: "Setup 15: Trendline Bounce & Retest",
    description: "Multi-touch ascending/descending dynamic trendline bounce with golden 3rd touch and liquidity sweep reclaim.",
    category: "trend",
  },
  {
    id: "all",
    name: "All Core Setups Combined",
    description: "Evaluates all 11 setups collectively using global multi-regime priority rules.",
    category: "trend",
  },
];

export interface BacktestRequest {
  setupId: string; // Specific setup ID (e.g. 'setup_15_trendline_bounce') or 'all'
  symbol?: string; // Default: 'BTCUSDT'
  days: number; // e.g. 1, 3, 7, 14
  startTime?: number; // Optional custom start timestamp in ms
  endTime?: number; // Optional custom end timestamp in ms
  initialBalance?: number; // Default: 10,000 USD
  positionSizeBtc?: number; // Default: 0.01 BTC
  leverage?: number; // Default: 20
  simulateFees?: boolean; // Default: true
  isolationMode?: boolean; // If true, only the selected setup is allowed to enter trades
  excludeWeekends?: boolean; // If true, weekend candles (Saturday & Sunday UTC) are excluded
  sessionFilter?: string; // Optional session filter (e.g. 'all', 'asia_open', 'europe_us_overlap')
  respectSessionMatrix?: boolean; // If true, enforces Session x Setup Matrix during backtest
  respectDaySessionMatrix?: boolean; // If true, enforces Days vs Sessions Matrix during backtest
  respectUnifiedConfluenceMatrix?: boolean; // If true, enforces Single Unified Confluence Matrix
}

export interface BacktestTrade {
  id: string;
  timestamp: string;
  entryTimestampMs: number;
  exitTimestampMs: number;
  setupId: string;
  setupName: string;
  direction: "LONG" | "SHORT";
  sessionId?: string;
  sessionName?: string;
  dayId?: string;
  dayName?: string;
  confluenceRuleId?: string;
  confluenceRuleName?: string;
  entryPrice: number;
  exitPrice: number;
  stopLoss: number;
  takeProfit: number;
  entryAtr: number;
  maxFavorableExcursionUsd: number;
  maxFavorableExcursionAtr: number;
  maxAdverseExcursionUsd: number;
  maxAdverseExcursionAtr: number;
  exitReason: "TAKE_PROFIT" | "STOP_LOSS" | "TIME_LIMIT";
  holdDurationSeconds: number;
  grossPnlUsd: number;
  feesUsd: number;
  netPnlUsd: number;
  pnlPercent: number;
  marketRegime: MarketRegime;
  entryDescription: string;
}

export interface SessionPerformance {
  sessionId: string;
  sessionName: string;
  tradesCount: number;
  winCount: number;
  lossCount: number;
  winRate: number;
  netPnlUsd: number;
  profitFactor: number;
}

export interface WeekdayPerformance {
  dayId: string;
  dayName: string;
  tradesCount: number;
  winCount: number;
  lossCount: number;
  winRate: number;
  netPnlUsd: number;
  profitFactor: number;
  averageHoldDurationSeconds?: number;
}

export interface RegimePerformance {
  regime: MarketRegime;
  tradesCount: number;
  winCount: number;
  lossCount: number;
  winRate: number;
  netPnlUsd: number;
  profitFactor: number;
}

export interface BacktestResult {
  runId: string;
  setupId: string;
  setupName: string;
  symbol: string;
  days: number;
  periodStart: string;
  periodEnd: string;
  totalCandlesAnalyzed: number;
  initialBalance: number;
  finalBalance: number;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  profitFactor: number;
  expectancyUsd: number;
  grossProfitUsd: number;
  grossLossUsd: number;
  totalFeesUsd: number;
  netPnlUsd: number;
  netPnlPercent: number;
  maxDrawdownUsd: number;
  maxDrawdownPercent: number;
  averageWinUsd: number;
  averageLossUsd: number;
  winLossRatio: number;
  averageMfeUsd: number;
  averageMfeAtr: number;
  averageMaeUsd: number;
  averageMaeAtr: number;
  averageHoldDurationSeconds: number;
  longTradesCount: number;
  longWinRate: number;
  shortTradesCount: number;
  shortWinRate: number;
  gatedSignalsCount?: number;
  regimeBreakdown: Record<string, RegimePerformance>;
  sessionBreakdown: Record<string, SessionPerformance>;
  weekdayBreakdown?: Record<string, WeekdayPerformance>;
  trades: BacktestTrade[];
  equityCurve: { timestamp: string; equity: number }[];
}

export interface BacktestRankItem {
  rank: number;
  setupId: string;
  setupName: string;
  category: "trend" | "range" | "reversal" | "orderflow";
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  wins?: number;
  losses?: number;
  winRate: number; // percentage, e.g. 75.0
  bayesianWinRate: number;
  profitFactor: number;
  netPnlUsd: number;
  netPnl?: number;
  expectancyUsd: number;
  maxDrawdownPercent: number;
  longTrades: number;
  longWinRate: number;
  shortTrades: number;
  shortWinRate: number;
  averageHoldDurationSeconds: number;
  tier: "TIER_1_ULTRA_HIGH" | "TIER_2_STRONG" | "TIER_3_MODERATE" | "TIER_4_LOW";
  recommendation: string;
}

export interface BacktestRankResult {
  runId: string;
  days: number;
  symbol: string;
  periodStart: string;
  periodEnd: string;
  totalCandlesAnalyzed: number;
  candlesEvaluated?: number;
  rankings: BacktestRankItem[];
  summary: {
    totalSetupsEvaluated: number;
    highestWinRateSetup: string;
    highestWinRate: number;
    averageWinRate: number;
    totalBacktestTrades: number;
  };
}
