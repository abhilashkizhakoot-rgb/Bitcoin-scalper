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
}

export interface BacktestTrade {
  id: string;
  timestamp: string;
  entryTimestampMs: number;
  exitTimestampMs: number;
  setupId: string;
  setupName: string;
  direction: "LONG" | "SHORT";
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
  regimeBreakdown: Record<string, RegimePerformance>;
  trades: BacktestTrade[];
  equityCurve: { timestamp: string; equity: number }[];
}
