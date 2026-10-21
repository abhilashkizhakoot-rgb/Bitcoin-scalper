/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { MarketRegime, ConfluenceRule } from "../types.js";
import {
  BacktestTrade,
  DiscoveredConfluenceCluster,
  ConfluenceOptimizationComparison,
  DimensionPerformanceBreakdown,
  ConfluenceOptimizationReport,
  ConfluenceOptimizerRequest,
} from "./types.js";
import { runIsolatedBacktest } from "./backtestRunner.js";

interface InternalClusterBucket {
  key: string;
  setupId: string;
  setupName: string;
  regimes: MarketRegime[] | "ALL";
  sessions: string[] | "ALL";
  days: string[] | "ALL";
  hoursUtc: string[] | "ALL";
  trades: BacktestTrade[];
}

// In-memory cache for fast interactive tuning on sliders
let cachedBacktestTrades: {
  days: number;
  symbol: string;
  timestamp: number;
  trades: BacktestTrade[];
  candlesAnalyzed: number;
} | null = null;

export async function runConfluenceOptimization(
  request: ConfluenceOptimizerRequest,
  providedTrades?: BacktestTrade[]
): Promise<ConfluenceOptimizationReport> {
  const days = Math.min(180, Math.max(1, request.days || 14));
  const symbol = request.symbol || "BTCUSDT";
  const minWinRate = request.minWinRateThreshold !== undefined ? request.minWinRateThreshold : 60.0;
  const minTrades = request.minTradesThreshold !== undefined ? Math.max(2, request.minTradesThreshold) : 5;
  const forceRerun = request.forceRerun === true;

  let allTrades: BacktestTrade[] = [];
  let totalCandlesAnalyzed = days * 1440;

  // 1. Acquire raw, un-gated trades across the selected lookback period
  if (providedTrades && providedTrades.length > 0) {
    allTrades = providedTrades;
  } else if (
    !forceRerun &&
    cachedBacktestTrades &&
    cachedBacktestTrades.days === days &&
    cachedBacktestTrades.symbol === symbol &&
    Date.now() - cachedBacktestTrades.timestamp < 10 * 60 * 1000 // 10 minute cache
  ) {
    allTrades = cachedBacktestTrades.trades;
    totalCandlesAnalyzed = cachedBacktestTrades.candlesAnalyzed;
  } else {
    // Run an ungated backtest simulation across all 11 core setups
    const backtestResult = await runIsolatedBacktest({
      setupId: request.setupId || "all",
      symbol,
      days,
      respectUnifiedConfluenceMatrix: false,
      respectSessionMatrix: false,
      respectDaySessionMatrix: false,
      simulateFees: true,
      excludeWeekends: true,
    });

    allTrades = backtestResult.trades || [];
    totalCandlesAnalyzed = backtestResult.totalCandlesAnalyzed || days * 1440;

    cachedBacktestTrades = {
      days,
      symbol,
      timestamp: Date.now(),
      trades: allTrades,
      candlesAnalyzed: totalCandlesAnalyzed,
    };
  }

  // Helper to extract UTC 4-hour window: '00-04', '04-08', '08-12', '12-16', '16-20', '20-24'
  const getUtcWindow = (t: BacktestTrade): string => {
    const d = new Date(t.entryTimestampMs || Date.parse(t.timestamp));
    const h = d.getUTCHours();
    const start = Math.floor(h / 4) * 4;
    const end = start + 4;
    return `${String(start).padStart(2, "0")}-${String(end).padStart(2, "0")}`;
  };

  // Helper to get normalized dayId
  const getDayId = (t: BacktestTrade): string => {
    if (t.dayId) return t.dayId.toLowerCase();
    const d = new Date(t.entryTimestampMs || Date.parse(t.timestamp));
    const dayNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    return dayNames[d.getUTCDay()];
  };

  // 2. Compute 1D Dimension Breakdowns
  const setupMap: Record<string, { name: string; trades: BacktestTrade[] }> = {};
  const sessionMap: Record<string, { name: string; trades: BacktestTrade[] }> = {};
  const regimeMap: Record<string, { name: string; trades: BacktestTrade[] }> = {};
  const weekdayMap: Record<string, { name: string; trades: BacktestTrade[] }> = {};
  const windowMap: Record<string, { name: string; trades: BacktestTrade[] }> = {};

  const DAY_LABELS: Record<string, string> = {
    monday: "Monday",
    tuesday: "Tuesday",
    wednesday: "Wednesday",
    thursday: "Thursday",
    friday: "Friday",
    saturday: "Saturday",
    sunday: "Sunday",
  };

  const SESSION_LABELS: Record<string, string> = {
    asia_open: "Asian Session (00:00–08:00 UTC)",
    intraday_chop: "London Open / Pre-NY (08:00–13:00 UTC)",
    europe_us_overlap: "Europe / US Overlap (13:00–17:00 UTC)",
    late_us_session: "Late US / Wall St Close (17:00–21:00 UTC)",
    dead_liquidity: "Dead Liquidity / Rollover (21:00–00:00 UTC)",
    weekends: "Weekend Low Liquidity Churn",
  };

  for (const t of allTrades) {
    // Setup
    if (!setupMap[t.setupId]) setupMap[t.setupId] = { name: t.setupName || t.setupId, trades: [] };
    setupMap[t.setupId].trades.push(t);

    // Session
    const sessId = t.sessionId || "asia_open";
    if (!sessionMap[sessId]) sessionMap[sessId] = { name: SESSION_LABELS[sessId] || t.sessionName || sessId, trades: [] };
    sessionMap[sessId].trades.push(t);

    // Regime
    const reg = t.marketRegime || MarketRegime.RANGE_BOUND;
    if (!regimeMap[reg]) regimeMap[reg] = { name: reg, trades: [] };
    regimeMap[reg].trades.push(t);

    // Weekday
    const day = getDayId(t);
    if (!weekdayMap[day]) weekdayMap[day] = { name: DAY_LABELS[day] || day, trades: [] };
    weekdayMap[day].trades.push(t);

    // Window
    const win = getUtcWindow(t);
    if (!windowMap[win]) windowMap[win] = { name: `${win} UTC Window`, trades: [] };
    windowMap[win].trades.push(t);
  }

  const calcBreakdown = (map: Record<string, { name: string; trades: BacktestTrade[] }>): DimensionPerformanceBreakdown[] => {
    return Object.entries(map).map(([id, item]) => {
      const wins = item.trades.filter((x) => x.netPnlUsd > 0).length;
      const losses = item.trades.filter((x) => x.netPnlUsd <= 0).length;
      const count = item.trades.length;
      const winRate = count > 0 ? Number(((wins / count) * 100).toFixed(1)) : 0;
      const netPnlUsd = Number(item.trades.reduce((s, x) => s + x.netPnlUsd, 0).toFixed(2));
      const grossProfit = item.trades.filter((x) => x.grossPnlUsd > 0).reduce((s, x) => s + x.grossPnlUsd, 0);
      const grossLoss = Math.abs(item.trades.filter((x) => x.grossPnlUsd < 0).reduce((s, x) => s + x.grossPnlUsd, 0));
      const profitFactor = grossLoss > 0 ? Number((grossProfit / grossLoss).toFixed(2)) : grossProfit > 0 ? 99 : 0;
      return {
        id,
        name: item.name,
        winRate,
        tradesCount: count,
        winCount: wins,
        lossCount: losses,
        netPnlUsd,
        profitFactor,
      };
    }).sort((a, b) => b.winRate - a.winRate);
  };

  const dimensionBreakdowns = {
    setups: calcBreakdown(setupMap),
    sessions: calcBreakdown(sessionMap),
    regimes: calcBreakdown(regimeMap),
    weekdays: calcBreakdown(weekdayMap),
    timeWindows: calcBreakdown(windowMap),
  };

  // 3. Multi-Dimensional Combinatorial Bucketing
  const clusterBuckets: Record<string, InternalClusterBucket> = {};

  const addTradeToBucket = (
    key: string,
    setupId: string,
    setupName: string,
    regimes: MarketRegime[] | "ALL",
    sessions: string[] | "ALL",
    days: string[] | "ALL",
    hoursUtc: string[] | "ALL",
    trade: BacktestTrade
  ) => {
    if (!clusterBuckets[key]) {
      clusterBuckets[key] = {
        key,
        setupId,
        setupName,
        regimes,
        sessions,
        days,
        hoursUtc,
        trades: [],
      };
    }
    clusterBuckets[key].trades.push(trade);
  };

  for (const t of allTrades) {
    const sId = t.setupId;
    const sName = t.setupName || sId;
    const sessId = t.sessionId || "asia_open";
    const day = getDayId(t);
    const reg = t.marketRegime || MarketRegime.RANGE_BOUND;
    const win = getUtcWindow(t);

    // Pair 1: Setup x Session
    addTradeToBucket(
      `s_${sId}__sess_${sessId}`,
      sId,
      sName,
      "ALL",
      [sessId],
      "ALL",
      "ALL",
      t
    );

    // Pair 2: Setup x Weekday
    addTradeToBucket(
      `s_${sId}__day_${day}`,
      sId,
      sName,
      "ALL",
      "ALL",
      [day],
      "ALL",
      t
    );

    // Pair 3: Setup x Regime
    addTradeToBucket(
      `s_${sId}__reg_${reg}`,
      sId,
      sName,
      [reg],
      "ALL",
      "ALL",
      "ALL",
      t
    );

    // Pair 4: Setup x UTC Window
    addTradeToBucket(
      `s_${sId}__win_${win}`,
      sId,
      sName,
      "ALL",
      "ALL",
      "ALL",
      [win],
      t
    );

    // Triplet 1: Setup x Session x Weekday (High Empirical Significance)
    addTradeToBucket(
      `s_${sId}__sess_${sessId}__day_${day}`,
      sId,
      sName,
      "ALL",
      [sessId],
      [day],
      "ALL",
      t
    );

    // Triplet 2: Setup x Session x Regime
    addTradeToBucket(
      `s_${sId}__sess_${sessId}__reg_${reg}`,
      sId,
      sName,
      [reg],
      [sessId],
      "ALL",
      "ALL",
      t
    );

    // Triplet 3: Setup x Session x UTC Window
    addTradeToBucket(
      `s_${sId}__sess_${sessId}__win_${win}`,
      sId,
      sName,
      "ALL",
      [sessId],
      "ALL",
      [win],
      t
    );

    // Triplet 4: Setup x Regime x Weekday
    addTradeToBucket(
      `s_${sId}__reg_${reg}__day_${day}`,
      sId,
      sName,
      [reg],
      "ALL",
      [day],
      "ALL",
      t
    );

    // Macro 1: Cross-Setup Session x Weekday (Universal Confluence)
    addTradeToBucket(
      `s_all__sess_${sessId}__day_${day}`,
      "all",
      "All Setups Combined",
      "ALL",
      [sessId],
      [day],
      "ALL",
      t
    );

    // Macro 2: Cross-Setup Regime x Session (Universal Confluence)
    addTradeToBucket(
      `s_all__reg_${reg}__sess_${sessId}`,
      "all",
      "All Setups Combined",
      [reg],
      [sessId],
      "ALL",
      "ALL",
      t
    );
  }

  // 4. Filter & Evaluate Discovered Clusters
  const discoveredClusters: DiscoveredConfluenceCluster[] = [];

  for (const bucket of Object.values(clusterBuckets)) {
    const tradesCount = bucket.trades.length;
    if (tradesCount < minTrades) continue;

    const winTrades = bucket.trades.filter((x) => x.netPnlUsd > 0);
    const winCount = winTrades.length;
    const lossCount = tradesCount - winCount;
    const winRate = Number(((winCount / tradesCount) * 100).toFixed(1));

    if (winRate < minWinRate) continue;

    const netPnlUsd = Number(bucket.trades.reduce((s, x) => s + x.netPnlUsd, 0).toFixed(2));
    const grossProfit = winTrades.reduce((s, x) => s + x.grossPnlUsd, 0);
    const grossLoss = Math.abs(bucket.trades.filter((x) => x.grossPnlUsd < 0).reduce((s, x) => s + x.grossPnlUsd, 0));
    const profitFactor = grossLoss > 0 ? Number((grossProfit / grossLoss).toFixed(2)) : grossProfit > 0 ? 99 : 0;
    const expectancyUsd = Number((netPnlUsd / tradesCount).toFixed(2));
    const avgHoldDurationSeconds = Math.round(
      bucket.trades.reduce((s, x) => s + x.holdDurationSeconds, 0) / tradesCount
    );

    // Statistical Confidence via Wilson Score 95% lower bound
    const z = 1.96;
    const p = winCount / tradesCount;
    const denominator = 1 + (z * z) / tradesCount;
    const centerAdjusted = p + (z * z) / (2 * tradesCount);
    const rad = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * tradesCount)) / tradesCount);
    const lowerBound = (centerAdjusted - rad) / denominator;
    const confidenceScore = Math.min(
      100,
      Math.max(0, Math.round(lowerBound * 100 * (1 + 0.2 * Math.log10(tradesCount / minTrades))))
    );

    // Verdict Categorization
    let verdict: "Elite" | "Robust" | "Moderate" = "Moderate";
    let riskMultiplier = 1.10;
    if (winRate >= 75.0) {
      verdict = "Elite";
      riskMultiplier = 1.25;
    } else if (winRate >= 65.0) {
      verdict = "Robust";
      riskMultiplier = 1.20;
    } else {
      verdict = "Moderate";
      riskMultiplier = 1.15;
    }

    // Compose Human-Friendly Name
    const parts: string[] = [];
    if (bucket.setupId !== "all") {
      parts.push(bucket.setupName.replace(/^Setup \d+:\s*/, ""));
    } else {
      parts.push("Macro Market Flow");
    }

    if (bucket.regimes !== "ALL" && Array.isArray(bucket.regimes)) {
      parts.push(bucket.regimes.map((r) => r.replace(/_/g, " ")).join("/"));
    }
    if (bucket.sessions !== "ALL" && Array.isArray(bucket.sessions)) {
      const sessNames = bucket.sessions.map((s) => {
        if (s === "europe_us_overlap") return "US/EU Overlap";
        if (s === "asia_open") return "Asian Session";
        if (s === "intraday_chop") return "London Open";
        if (s === "late_us_session") return "Late US";
        return s;
      });
      parts.push(sessNames.join("/"));
    }
    if (bucket.days !== "ALL" && Array.isArray(bucket.days)) {
      parts.push(bucket.days.map((d) => DAY_LABELS[d] || d).join("/"));
    }
    if (bucket.hoursUtc !== "ALL" && Array.isArray(bucket.hoursUtc)) {
      parts.push(`${bucket.hoursUtc.join("/")} UTC`);
    }

    const clusterName = parts.join(" • ");

    // Generate formal ConfluenceRule representation
    const ruleCandidate: ConfluenceRule = {
      id: `rule_opt_${bucket.key.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 48)}`,
      name: clusterName,
      setup_id: bucket.setupId,
      regimes: bucket.regimes,
      sessions: bucket.sessions,
      days: bucket.days,
      hours_utc: bucket.hoursUtc,
      discovery_trades: tradesCount,
      discovery_win_rate: winRate,
      validation_trades: tradesCount,
      validation_win_rate: winRate,
      verdict: verdict,
      is_enabled: true,
      risk_multiplier: riskMultiplier,
    };

    discoveredClusters.push({
      id: bucket.key,
      name: clusterName,
      setupId: bucket.setupId,
      setupName: bucket.setupName,
      regimes: bucket.regimes,
      sessions: bucket.sessions,
      days: bucket.days,
      hoursUtc: bucket.hoursUtc,
      tradesCount,
      winCount,
      lossCount,
      winRate,
      profitFactor,
      netPnlUsd,
      expectancyUsd,
      avgHoldDurationSeconds,
      confidenceScore,
      verdict,
      recommendedRiskMultiplier: riskMultiplier,
      ruleCandidate,
      isSelected: true,
    });
  }

  // Sort discovered clusters by Win Rate descending, then Profit Factor, then Trades count
  discoveredClusters.sort((a, b) => {
    if (b.winRate !== a.winRate) return b.winRate - a.winRate;
    if (b.profitFactor !== a.profitFactor) return b.profitFactor - a.profitFactor;
    return b.tradesCount - a.tradesCount;
  });

  // 5. Counterfactual Performance Comparison (Baseline vs Optimized Confluence Matrix)
  const baselineTrades = allTrades.length;
  const baselineWins = allTrades.filter((x) => x.netPnlUsd > 0).length;
  const baselineLosses = baselineTrades - baselineWins;
  const baselineWinRate = baselineTrades > 0 ? Number(((baselineWins / baselineTrades) * 100).toFixed(1)) : 0;
  const baselineNetPnlUsd = Number(allTrades.reduce((s, x) => s + x.netPnlUsd, 0).toFixed(2));
  const baselineGrossProfit = allTrades.filter((x) => x.grossPnlUsd > 0).reduce((s, x) => s + x.grossPnlUsd, 0);
  const baselineGrossLoss = Math.abs(allTrades.filter((x) => x.grossPnlUsd < 0).reduce((s, x) => s + x.grossPnlUsd, 0));
  const baselineProfitFactor = baselineGrossLoss > 0 ? Number((baselineGrossProfit / baselineGrossLoss).toFixed(2)) : baselineGrossProfit > 0 ? 99 : 0;

  // Simulate execution of only trades that match at least one discovered cluster rule
  const activeDiscoveredRules = discoveredClusters.map((c) => c.ruleCandidate);

  const isTradeAllowedByDiscoveredRules = (t: BacktestTrade): boolean => {
    if (activeDiscoveredRules.length === 0) return false;
    const day = getDayId(t);
    const win = getUtcWindow(t);
    const sessId = t.sessionId || "asia_open";
    const reg = t.marketRegime || MarketRegime.RANGE_BOUND;

    return activeDiscoveredRules.some((r) => {
      if (r.setup_id !== "all" && r.setup_id !== t.setupId) return false;
      if (r.regimes !== "ALL" && Array.isArray(r.regimes) && !r.regimes.includes(reg)) return false;
      if (r.sessions !== "ALL" && Array.isArray(r.sessions) && !r.sessions.includes(sessId)) return false;
      if (r.days !== "ALL" && Array.isArray(r.days) && !r.days.map((x) => x.toLowerCase()).includes(day)) return false;
      if (r.hours_utc !== "ALL" && Array.isArray(r.hours_utc) && !r.hours_utc.includes(win)) return false;
      if (r.validation_win_rate && r.validation_win_rate < minWinRate) return false;
      return true;
    });
  };

  const optimizedTradesList = allTrades.filter(isTradeAllowedByDiscoveredRules);
  const optimizedTrades = optimizedTradesList.length;
  const optimizedWins = optimizedTradesList.filter((x) => x.netPnlUsd > 0).length;
  const optimizedLosses = optimizedTrades - optimizedWins;
  const optimizedWinRate = optimizedTrades > 0 ? Number(((optimizedWins / optimizedTrades) * 100).toFixed(1)) : 0;
  const optimizedNetPnlUsd = Number(optimizedTradesList.reduce((s, x) => s + x.netPnlUsd, 0).toFixed(2));
  const optGrossProfit = optimizedTradesList.filter((x) => x.grossPnlUsd > 0).reduce((s, x) => s + x.grossPnlUsd, 0);
  const optGrossLoss = Math.abs(optimizedTradesList.filter((x) => x.grossPnlUsd < 0).reduce((s, x) => s + x.grossPnlUsd, 0));
  const optimizedProfitFactor = optGrossLoss > 0 ? Number((optGrossProfit / optGrossLoss).toFixed(2)) : optGrossProfit > 0 ? 99 : 0;

  // Drawdown estimations
  const calculateMaxDd = (trades: BacktestTrade[]): number => {
    let equity = 10000;
    let peak = 10000;
    let maxDd = 0;
    for (const t of trades) {
      equity += t.netPnlUsd;
      if (equity > peak) peak = equity;
      const dd = peak > 0 ? ((peak - equity) / peak) * 100 : 0;
      if (dd > maxDd) maxDd = dd;
    }
    return Number(maxDd.toFixed(1));
  };

  const baselineMaxDrawdownPercent = calculateMaxDd(allTrades);
  const optimizedMaxDrawdownPercent = calculateMaxDd(optimizedTradesList);

  const filteredOutLosses = Math.max(0, baselineLosses - optimizedLosses);
  const lossEliminationRate = baselineLosses > 0 ? Number(((filteredOutLosses / baselineLosses) * 100).toFixed(1)) : 0;
  const winRetentionRate = baselineWins > 0 ? Number(((optimizedWins / baselineWins) * 100).toFixed(1)) : 0;
  const winRateDelta = Number((optimizedWinRate - baselineWinRate).toFixed(1));
  const pnlDelta = Number((optimizedNetPnlUsd - baselineNetPnlUsd).toFixed(2));

  const comparison: ConfluenceOptimizationComparison = {
    baselineTrades,
    baselineWins,
    baselineLosses,
    baselineWinRate,
    baselineNetPnlUsd,
    baselineProfitFactor,
    baselineMaxDrawdownPercent,

    optimizedTrades,
    optimizedWins,
    optimizedLosses,
    optimizedWinRate,
    optimizedNetPnlUsd,
    optimizedProfitFactor,
    optimizedMaxDrawdownPercent,

    filteredOutLosses,
    lossEliminationRate,
    winRetentionRate,
    winRateDelta,
    pnlDelta,
  };

  return {
    generatedAt: new Date().toISOString(),
    daysAnalyzed: days,
    totalCandlesAnalyzed,
    totalRawTrades: baselineTrades,
    minWinRateThreshold: minWinRate,
    minTradesThreshold: minTrades,
    clustersCount: discoveredClusters.length,
    discoveredClusters,
    comparison,
    dimensionBreakdowns,
    recommendedMasterSettings: {
      enabled: true,
      strict_mode: true,
      min_validation_win_rate: minWinRate,
      recommendedRulesCount: discoveredClusters.length,
    },
  };
}
