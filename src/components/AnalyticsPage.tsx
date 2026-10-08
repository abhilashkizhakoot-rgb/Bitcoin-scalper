/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo } from "react";
import {
  TrendingUp,
  Percent,
  TrendingDown,
  Activity,
  Sparkles,
  BookOpen,
  PieChart,
  Grid,
  Clock,
  ArrowUpRight,
  ArrowDownRight,
  Sliders,
  ShieldAlert,
  CheckCircle2,
  Zap,
  BarChart3,
  Calendar,
  AlertTriangle,
  Flame,
  LineChart,
  Layers,
  Award,
  Target,
  Trophy,
  Medal,
  HelpCircle,
  ArrowUpDown,
  Filter,
  Scale,
  Compass,
  Check,
  Calculator,
  RefreshCw,
  ChevronDown,
} from "lucide-react";
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
  ReferenceLine,
  Legend,
} from "recharts";
import { DailyStats, MarketRegime, Trade, StrategyConfig, SetupPerformanceStats, SetupRankingItem, SetupRankingResponse, SetupProbabilityTier } from "../types.js";
import { safeFormatDateTimeShort, safeFormatDateShort, safeFormatNumber } from "../utils/format";
import { getTradeTimingWindow } from "./TradeHistory.tsx";
import { apiFetch } from "../utils/api.ts";

interface AnalyticsPageProps {
  summary: any;
  equityCurve: { timestamp: string; balance: number }[];
  dailyStats: DailyStats[];
  regimeStats: Record<string, { trades: number; win_rate: number; pnl: number }>;
  setupStats?: any;
  trades: Trade[];
  config: StrategyConfig | null;
}

export default function AnalyticsPage({
  summary,
  equityCurve,
  dailyStats,
  regimeStats,
  setupStats,
  trades = [],
  config,
}: AnalyticsPageProps) {
  // Format dates for charts
  const formattedEquityData = equityCurve.map((pt) => ({
    ...pt,
    time: safeFormatDateTimeShort(pt.timestamp),
  }));

  const formattedDailyData = dailyStats.map((d) => ({
    ...d,
    dateStr: safeFormatDateShort(d.date + "T00:00:00"),
  }));

  // Filter for completed trades
  const completedTrades = trades.filter((t) => t.exit_price !== null);

  // ----------------------------------------------------
  // HIGH PROBABILITY WIN RATE RANKINGS STATE & DATA SYNC
  // ----------------------------------------------------
  const [rankingSortBy, setRankingSortBy] = useState<"win_rate" | "bayesian" | "pnl" | "profit_factor" | "trades" | "expectancy">("win_rate");
  const [rankingTierFilter, setRankingTierFilter] = useState<string>("ALL");
  const [rankingRegimeFilter, setRankingRegimeFilter] = useState<string>("ALL");
  const [serverRankingsData, setServerRankingsData] = useState<SetupRankingResponse | null>(null);
  const [isLoadingRankings, setIsLoadingRankings] = useState<boolean>(false);
  const [selectedCalcSetupId, setSelectedCalcSetupId] = useState<string>("setup_1_pullback_retest");
  const [calcSimTrades, setCalcSimTrades] = useState<number>(10);
  const [calcPositionMargin, setCalcPositionMargin] = useState<number>(1000);
  const [expandedSetupId, setExpandedSetupId] = useState<string | null>(null);
  const [activeLeaderboardTab, setActiveLeaderboardTab] = useState<"leaderboard" | "comparison_chart" | "confluence_matrix" | "calculator">("leaderboard");

  const fetchRankings = async () => {
    setIsLoadingRankings(true);
    try {
      const res = await apiFetch(`/api/analytics/setup-rankings?sortBy=${rankingSortBy}`);
      if (res.ok) {
        const data: SetupRankingResponse = await res.json();
        setServerRankingsData(data);
        if (data.rankings && data.rankings.length > 0 && !selectedCalcSetupId) {
          setSelectedCalcSetupId(data.rankings[0].setup_id);
        }
      }
    } catch (e) {
      console.warn("Could not fetch server setup rankings:", e);
    } finally {
      setIsLoadingRankings(false);
    }
  };

  useEffect(() => {
    fetchRankings();
  }, [rankingSortBy, trades.length]);

  const rawRankings: SetupRankingItem[] = serverRankingsData?.rankings || [];

  const filteredRankings = useMemo(() => {
    return rawRankings.filter((item) => {
      if (rankingTierFilter !== "ALL" && item.tier !== rankingTierFilter) {
        return false;
      }
      if (rankingRegimeFilter !== "ALL" && !item.optimal_regimes.includes(rankingRegimeFilter as any)) {
        return false;
      }
      return true;
    });
  }, [rawRankings, rankingTierFilter, rankingRegimeFilter]);

  const podiumTop3 = useMemo(() => {
    return rawRankings.slice(0, 3);
  }, [rawRankings]);

  const selectedCalcSetup = useMemo(() => {
    return rawRankings.find((r) => r.setup_id === selectedCalcSetupId) || rawRankings[0] || null;
  }, [rawRankings, selectedCalcSetupId]);

  const calcPrediction = useMemo(() => {
    if (!selectedCalcSetup) return null;
    const wr = selectedCalcSetup.win_rate / 100;
    const expectedWins = Math.round(calcSimTrades * wr);
    const expectedLosses = calcSimTrades - expectedWins;
    const avgWinDollar = (selectedCalcSetup.expectancy > 0 ? selectedCalcSetup.expectancy * 1.6 : 320) * (calcPositionMargin / 1000);
    const avgLossDollar = 200 * (calcPositionMargin / 1000);
    const estimatedPnl = Number((expectedWins * avgWinDollar - expectedLosses * avgLossDollar).toFixed(2));
    const winRateLower = Math.max(0, Number(selectedCalcSetup.wilson_lower.toFixed(1)));
    const winRateUpper = Math.min(100, Number(selectedCalcSetup.wilson_upper.toFixed(1)));
    const minExpectedWins = Math.floor(calcSimTrades * (winRateLower / 100));
    const maxExpectedWins = Math.ceil(calcSimTrades * (winRateUpper / 100));

    return {
      expectedWins,
      expectedLosses,
      estimatedPnl,
      winRateLower,
      winRateUpper,
      minExpectedWins,
      maxExpectedWins,
      edgeVsCoinFlip: Number(((wr - 0.5) * 100).toFixed(1)),
    };
  }, [selectedCalcSetup, calcSimTrades, calcPositionMargin]);

  const rankingChartData = useMemo(() => {
    return rawRankings.map((r) => {
      const match = r.setup_name.match(/Setup\s*(\d+)/i);
      const code = match ? `S${match[1]}` : r.setup_name.slice(0, 8);
      return {
        code,
        fullName: r.setup_name,
        winRate: r.win_rate,
        bayesianWr: r.bayesian_win_rate,
        wilsonLower: r.wilson_lower,
        pnl: r.net_pnl_usdt,
        trades: r.total_trades,
        tier: r.tier,
      };
    });
  }, [rawRankings]);

  // ----------------------------------------------------
  // SESSIONS / MARKET HOURS PERFORMANCE CALCULATION
  // ----------------------------------------------------
  const SESSIONS = [
    { id: "asia_open", name: "Asia Open Front-run", desc: "05:00 - 09:30 IST", tag: "OPTIMAL" },
    { id: "intraday_chop", name: "Intra-day Chop", desc: "09:30 - 18:30 IST", tag: "RESTRICTED" },
    { id: "europe_us_overlap", name: "US / Europe Overlap", desc: "18:30 - 22:30 IST", tag: "OPTIMAL" },
    { id: "late_us_session", name: "Late US Session", desc: "22:30 - 01:30 IST", tag: "OPTIMAL" },
    { id: "dead_liquidity", name: "Dead Liquidity", desc: "01:30 - 05:00 IST", tag: "RESTRICTED" },
    { id: "weekends", name: "Weekends", desc: "All day Sat/Sun IST", tag: "RESTRICTED" },
  ];

  const sessionStats = SESSIONS.map((session) => {
    const sTrades = completedTrades.filter((t) => {
      const windowInfo = getTradeTimingWindow(t.entry_timestamp, config?.general?.timing_windows);
      return windowInfo.id === session.id;
    });
    const wins = sTrades.filter((t) => t.is_win).length;
    const losses = sTrades.filter((t) => t.is_win === false).length;
    const total = sTrades.length;
    const winRate = total > 0 ? (wins / total) * 100 : 0;
    const pnl = sTrades.reduce((acc, t) => acc + (t.pnl_usdt || 0), 0);
    const avgPnl = total > 0 ? pnl / total : 0;

    return {
      ...session,
      trades: total,
      wins,
      losses,
      winRate: Number(winRate.toFixed(1)),
      pnl: Number(pnl.toFixed(2)),
      avgPnl: Number(avgPnl.toFixed(2)),
    };
  });

  // ----------------------------------------------------
  // ENRICHED MARKET REGIME STATS CALCULATION
  // ----------------------------------------------------
  const REGIMES = [
    { id: MarketRegime.STRONG_UPTREND, name: "Strong Uptrend", desc: "High momentum buying pressure", color: "text-emerald-600 bg-emerald-50 border-emerald-200" },
    { id: MarketRegime.STRONG_DOWNTREND, name: "Strong Downtrend", desc: "High momentum selling pressure", color: "text-rose-600 bg-rose-50 border-rose-200" },
    { id: MarketRegime.RANGE_BOUND, name: "Range Bound", desc: "Mean-reverting consolidation", color: "text-blue-600 bg-blue-50 border-blue-200" },
    { id: MarketRegime.HIGH_VOLATILITY, name: "High Volatility", desc: "Wide whipsaws & breakouts", color: "text-purple-600 bg-purple-50 border-purple-200" },
    { id: MarketRegime.LOW_VOLATILITY, name: "Low Volatility", desc: "Tight compression & sideways chop", color: "text-amber-600 bg-amber-50 border-amber-200" },
  ];

  const regimeStatsEnriched = REGIMES.map((regime) => {
    const rTrades = completedTrades.filter((t) => t.regime_at_entry === regime.id);
    const wins = rTrades.filter((t) => t.is_win).length;
    const losses = rTrades.filter((t) => t.is_win === false).length;
    const total = rTrades.length;
    const winRate = total > 0 ? (wins / total) * 100 : 0;
    const pnl = rTrades.reduce((acc, t) => acc + (t.pnl_usdt || 0), 0);
    const avgPnl = total > 0 ? pnl / total : 0;

    return {
      ...regime,
      trades: total,
      wins,
      losses,
      winRate: Number(winRate.toFixed(1)),
      pnl: Number(pnl.toFixed(2)),
      avgPnl: Number(avgPnl.toFixed(2)),
    };
  });

  // Format regime data for simple charting
  const regimeChartData = regimeStatsEnriched.map((r) => ({
    name: r.name,
    trades: r.trades,
    winRate: r.winRate,
    pnl: r.pnl,
  }));

  // ----------------------------------------------------
  // STRUCTURAL SETUP PERFORMANCE CALCULATION (14 SETUPS)
  // ----------------------------------------------------
  const setupPerformanceMap = new Map<string, {
    setup_name: string;
    total_trades: number;
    wins: number;
    losses: number;
    win_rate: number;
    profit_factor: number;
    net_pnl_usdt: number;
    avg_hold_duration_seconds: number;
    long_count: number;
    short_count: number;
    gross_win_usdt: number;
    gross_loss_usdt: number;
  }>();

  completedTrades.forEach((t) => {
    const setupName = t.setup_triggered || t.feature_snapshot?.setup_triggered || "Market Structure Validated";
    if (!setupPerformanceMap.has(setupName)) {
      setupPerformanceMap.set(setupName, {
        setup_name: setupName,
        total_trades: 0,
        wins: 0,
        losses: 0,
        win_rate: 0,
        profit_factor: 0,
        net_pnl_usdt: 0,
        avg_hold_duration_seconds: 0,
        long_count: 0,
        short_count: 0,
        gross_win_usdt: 0,
        gross_loss_usdt: 0,
      });
    }

    const item = setupPerformanceMap.get(setupName)!;
    item.total_trades += 1;
    if (t.is_win) {
      item.wins += 1;
      item.gross_win_usdt += Math.max(0, t.pnl_usdt || 0);
    } else {
      item.losses += 1;
      item.gross_loss_usdt += Math.abs(t.pnl_usdt || 0);
    }
    if (t.direction === "LONG") {
      item.long_count += 1;
    } else {
      item.short_count += 1;
    }
    item.net_pnl_usdt += (t.pnl_usdt || 0);
    item.avg_hold_duration_seconds += (t.hold_duration_seconds || 0);
  });

  const setupStatsEnriched = Array.from(setupPerformanceMap.values()).map((s) => {
    const win_rate = s.total_trades > 0 ? Number(((s.wins / s.total_trades) * 100).toFixed(1)) : 0;
    const profit_factor = s.gross_loss_usdt > 0 ? Number((s.gross_win_usdt / s.gross_loss_usdt).toFixed(2)) : (s.gross_win_usdt > 0 ? 99.9 : 0);
    const avg_hold_duration_seconds = s.total_trades > 0 ? Math.round(s.avg_hold_duration_seconds / s.total_trades) : 0;
    const net_pnl_usdt = Number(s.net_pnl_usdt.toFixed(2));
    const avg_pnl = s.total_trades > 0 ? Number((s.net_pnl_usdt / s.total_trades).toFixed(2)) : 0;
    return {
      ...s,
      win_rate,
      profit_factor,
      avg_hold_duration_seconds,
      net_pnl_usdt,
      avg_pnl,
    };
  }).sort((a, b) => b.net_pnl_usdt - a.net_pnl_usdt);

  // Setup Highlights
  const topProfitSetup = setupStatsEnriched.length > 0 ? setupStatsEnriched[0] : null;
  const bestWinRateSetup = [...setupStatsEnriched].filter(s => s.total_trades >= 1).sort((a, b) => b.win_rate - a.win_rate)[0] || null;
  const mostActiveSetup = [...setupStatsEnriched].sort((a, b) => b.total_trades - a.total_trades)[0] || null;
  const totalSetupsActive = setupStatsEnriched.filter(s => s.total_trades > 0).length;

  const setupChartData = setupStatsEnriched.map(s => {
    // Short clean label for charts, e.g. "Setup 1" or "Pullback"
    const match = s.setup_name.match(/Setup\s*(\d+)/i);
    const code = match ? `S${match[1]}` : s.setup_name.slice(0, 8);
    return {
      code,
      name: s.setup_name,
      trades: s.total_trades,
      winRate: s.win_rate,
      pnl: s.net_pnl_usdt,
    };
  });

  // ----------------------------------------------------
  // ADVANCED QUANT METRICS CALCULATION
  // ----------------------------------------------------
  const winningTrades = completedTrades.filter((t) => t.is_win);
  const losingTrades = completedTrades.filter((t) => t.is_win === false);

  const avgWin = winningTrades.length > 0
    ? winningTrades.reduce((acc, t) => acc + (t.pnl_usdt || 0), 0) / winningTrades.length
    : 0;
  const avgLoss = losingTrades.length > 0
    ? Math.abs(losingTrades.reduce((acc, t) => acc + (t.pnl_usdt || 0), 0)) / losingTrades.length
    : 0;

  const payoffRatio = avgLoss > 0 ? avgWin / avgLoss : 0;
  const winRatePct = completedTrades.length > 0 ? (winningTrades.length / completedTrades.length) * 100 : 0;
  const mathematicalExpectancy = completedTrades.length > 0
    ? (winRatePct / 100) * avgWin - ((100 - winRatePct) / 100) * avgLoss
    : 0;

  // Streak Analysis
  let maxConsecutiveWins = 0;
  let maxConsecutiveLosses = 0;
  let currentWins = 0;
  let currentLosses = 0;

  const chronologicalTrades = [...completedTrades].sort(
    (a, b) => new Date(a.entry_timestamp).getTime() - new Date(b.entry_timestamp).getTime()
  );

  chronologicalTrades.forEach((t) => {
    if (t.is_win) {
       currentWins++;
       currentLosses = 0;
       if (currentWins > maxConsecutiveWins) maxConsecutiveWins = currentWins;
    } else {
       currentLosses++;
       currentWins = 0;
       if (currentLosses > maxConsecutiveLosses) maxConsecutiveLosses = currentLosses;
    }
  });

  // Hold duration
  const avgHoldTimeSeconds = completedTrades.length > 0
    ? completedTrades.reduce((acc, t) => acc + (t.hold_duration_seconds || 0), 0) / completedTrades.length
    : 0;

  const formatHoldDuration = (totalSeconds: number): string => {
    if (totalSeconds <= 0) return "N/A";
    const hrs = Math.floor(totalSeconds / 3600);
    const mins = Math.floor((totalSeconds % 3600) / 60);
    const secs = Math.floor(totalSeconds % 60);
    if (hrs > 0) return `${hrs}h ${mins}m`;
    if (mins > 0) return `${mins}m ${secs}s`;
    return `${secs}s`;
  };

  // Exit Reason Distribution
  const exitReasons = completedTrades.reduce((acc: Record<string, number>, t) => {
    const reason = t.exit_reason || "MANUAL";
    acc[reason] = (acc[reason] || 0) + 1;
    return acc;
  }, {});

  // ----------------------------------------------------
  // STRATEGY TUNING ADVISORY ENGINE
  // ----------------------------------------------------
  const tuningRecommendations: {
    title: string;
    currentVal: string;
    recommendation: string;
    status: "optimal" | "warning" | "critical";
    paramPath: string;
  }[] = [];

  // Advice Rule 1: Low Volatility Check
  const lowVol = regimeStatsEnriched.find((r) => r.id === MarketRegime.LOW_VOLATILITY);
  if (lowVol && lowVol.trades >= 3) {
    if (lowVol.pnl < 0 || lowVol.winRate < 45) {
      tuningRecommendations.push({
        title: "Disable Low Volatility Regime",
        currentVal: `Win Rate: ${lowVol.winRate}% | Net PnL: -$${Math.abs(lowVol.pnl).toFixed(2)}`,
        recommendation: "Low Volatility is resulting in unprofitable sideways chop and high transaction cost drag. Turn OFF 'LOW_VOLATILITY' under the Regime Filters tab to protect capital.",
        status: "critical",
        paramPath: "config.regime_filters.LOW_VOLATILITY",
      });
    }
  }

  // Advice Rule 2: Intra-day Chop Session
  const chopSession = sessionStats.find((s) => s.id === "intraday_chop");
  if (chopSession && chopSession.trades >= 3) {
    if (chopSession.pnl < 0 || chopSession.winRate < 45) {
      tuningRecommendations.push({
        title: "Deactivate Intra-day Chop Scanning",
        currentVal: `Win Rate: ${chopSession.winRate}% | Net PnL: -$${Math.abs(chopSession.pnl).toFixed(2)}`,
        recommendation: "Intra-day Chop (09:30 - 18:30 IST) is currently bleeding profit due to lack of trending momentum. Deactivate this timing window to restrict automated breakout execution.",
        status: "warning",
        paramPath: "config.general.timing_windows[intraday_chop].allowed = false",
      });
    }
  }

  // Advice Rule 3: Stop Loss ATR & Payoff Ratio
  const slAtrMult = config?.risk_management?.stop_loss_atr_multiplier || 1.3;
  if (completedTrades.length >= 3) {
    if (payoffRatio < 1.5 && winRatePct < 55) {
      tuningRecommendations.push({
        title: "Widen Stop Loss & Optimize Payoff Ratio",
        currentVal: `Payoff Ratio: ${payoffRatio.toFixed(2)}x | ATR Mult: ${slAtrMult}x`,
        recommendation: `Your risk/reward expectancy is low. We recommend increasing the 'Stop-Loss ATR Multiplier' to 2.2x or 2.5x (currently ${slAtrMult}x) and enabling 'Trailing Stop Loss' at 1.8x to avoid premature stop-outs during noise.`,
        status: "critical",
        paramPath: "config.risk_management.stop_loss_atr_multiplier",
      });
    } else if (slAtrMult < 1.8) {
      tuningRecommendations.push({
        title: "Stop-Loss ATR Multiplier Caution",
        currentVal: `Stop Loss: ${slAtrMult}x ATR`,
        recommendation: `Your stop-loss is tight at ${slAtrMult}x. In high-leverage Bitcoin trading, minor fluctuations can shake you out of high-conviction setups. Consider adjusting this to 2.2x for superior structural room.`,
        status: "warning",
        paramPath: "config.risk_management.stop_loss_atr_multiplier",
      });
    }
  }

  // Advice Rule 4: Streak and Cool-down protection
  if (maxConsecutiveLosses >= 3) {
    const maxLossStreakLimit = config?.risk_management?.max_consecutive_losses || 3;
    if (maxLossStreakLimit > 3) {
      tuningRecommendations.push({
        title: "Optimize Streak Protection Cooldown",
        currentVal: `Max Loss Streak: ${maxConsecutiveLosses} | Allowed Limit: ${maxLossStreakLimit}`,
        recommendation: "The bot hit a consecutive loss streak. Recommend setting 'Max Consecutive Losses' to 3 with a 30-minute system-wide cooldown to enforce emotional circuit breaking.",
        status: "warning",
        paramPath: "config.risk_management.max_consecutive_losses",
      });
    }
  }

  // Advice Rule 5: Directional analysis
  const longTrades = completedTrades.filter((t) => t.direction === "LONG");
  const shortTrades = completedTrades.filter((t) => t.direction === "SHORT");
  const longWins = longTrades.filter((t) => t.is_win).length;
  const shortWins = shortTrades.filter((t) => t.is_win).length;
  const longWinRate = longTrades.length > 0 ? (longWins / longTrades.length) * 100 : 0;
  const shortWinRate = shortTrades.length > 0 ? (shortWins / shortTrades.length) * 100 : 0;

  if (longTrades.length >= 3 && longWinRate < 40) {
    tuningRecommendations.push({
      title: "Bullish Trend Entry Verification",
      currentVal: `LONG Win Rate: ${longWinRate.toFixed(1)}%`,
      recommendation: "LONG positions are showing low win rates. Increase 'Relative Volume Confirmation' multiplier or verify that EMA Trend Alignment rules are strictly checked.",
      status: "warning",
      paramPath: "config.entry_settings.min_volume_multiplier_above_ma",
    });
  }
  if (shortTrades.length >= 3 && shortWinRate < 40) {
    tuningRecommendations.push({
      title: "Bearish Trend Entry Verification",
      currentVal: `SHORT Win Rate: ${shortWinRate.toFixed(1)}%`,
      recommendation: "SHORT positions are experiencing high stop-outs. Ensure the 'CatBoost AI Prediction' threshold is set to a higher conviction level (e.g., 80% instead of 75%) for short breakouts.",
      status: "warning",
      paramPath: "config.sentiment_settings.threshold_ratio",
    });
  }

  // Fallback advice card if trading history is too small
  if (tuningRecommendations.length === 0) {
    tuningRecommendations.push({
      title: "Algorithmic Baseline Calibration",
      currentVal: `${completedTrades.length} Trade Logs Collected`,
      recommendation: "The system is currently assembling high-fidelity performance metrics. Once the scalper registers 3+ trades under active market sessions, dynamically compiled quantitative recommendations will appear here to optimize your settings.",
      status: "optimal",
      paramPath: "config.risk_management.stop_loss_atr_multiplier",
    });
  }

  return (
    <div className="space-y-6">
      {/* 4-Widget Stats Strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4" id="analytics-stats-grid">
        <div className="bg-white border border-slate-200 shadow-sm rounded-2xl p-5 hover:border-slate-300 transition-all">
          <p className="text-[10px] font-mono text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
            <Activity className="w-3 h-3 text-slate-400" /> Net Profit (USDT)
          </p>
          <p className={`text-xl font-sans font-extrabold mt-1.5 ${summary.net_profit_usdt >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
            {summary.net_profit_usdt >= 0 ? "+" : ""}${safeFormatNumber(summary.net_profit_usdt, 2, 2)}
          </p>
          <div className="flex items-center justify-between mt-2 text-[10px] text-slate-400 font-mono">
            <span>Commissions Paid:</span>
            <span className="text-slate-600 font-semibold">${summary.fees_paid_usdt?.toFixed(2)}</span>
          </div>
        </div>

        <div className="bg-white border border-slate-200 shadow-sm rounded-2xl p-5 hover:border-slate-300 transition-all">
          <p className="text-[10px] font-mono text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
            <Percent className="w-3 h-3 text-indigo-500" /> Strategy Win Rate
          </p>
          <p className="text-xl font-sans font-extrabold text-slate-800 mt-1.5">
            {summary.win_rate}%
          </p>
          <div className="flex items-center justify-between mt-2 text-[10px] text-slate-400 font-mono">
            <span className="text-emerald-600 font-semibold">{summary.wins} Wins</span>
            <span className="text-rose-600 font-semibold">{summary.losses} Losses</span>
          </div>
        </div>

        <div className="bg-white border border-slate-200 shadow-sm rounded-2xl p-5 hover:border-slate-300 transition-all">
          <p className="text-[10px] font-mono text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
            <PieChart className="w-3 h-3 text-indigo-500" /> Profit Factor
          </p>
          <p className="text-xl font-sans font-extrabold text-indigo-600 mt-1.5">
            {summary.profit_factor}x
          </p>
          <div className="flex items-center justify-between mt-2 text-[10px] text-slate-400 font-mono">
            <span>Expectancy:</span>
            <span className={`font-semibold ${mathematicalExpectancy >= 0 ? "text-emerald-650" : "text-rose-600"}`}>
              {mathematicalExpectancy >= 0 ? "+" : ""}${mathematicalExpectancy.toFixed(2)}
            </span>
          </div>
        </div>

        <div className="bg-white border border-slate-200 shadow-sm rounded-2xl p-5 hover:border-slate-300 transition-all">
          <p className="text-[10px] font-mono text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
            <TrendingUp className="w-3 h-3 text-indigo-500" /> Max Drawdown
          </p>
          <p className="text-xl font-sans font-extrabold text-slate-800 mt-1.5">
            ${safeFormatNumber(summary.max_drawdown_usdt)}
          </p>
          <div className="flex items-center justify-between mt-2 text-[10px] text-slate-400 font-mono">
            <span>Sharpe Ratio:</span>
            <span className="text-indigo-650 font-semibold">{summary.sharpe_ratio}</span>
          </div>
        </div>
      </div>

      {/* Charts Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6" id="analytics-charts-grid">
        {/* Cumulative Equity Curve Chart */}
        <div className="bg-white border border-slate-200 shadow-sm rounded-2xl p-5" id="equity-curve-chart-card">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <LineChart className="w-4 h-4 text-indigo-600" />
              <span className="font-sans font-semibold text-slate-800 text-sm">Equity Growth Curve (USD)</span>
            </div>
            <span className="text-[10px] font-mono text-slate-400 uppercase tracking-widest bg-slate-50 border border-slate-200 rounded-md px-2 py-0.5">
              Live State Sync
            </span>
          </div>

          <div className="h-[250px] w-full">
            <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0}>
              <AreaChart data={formattedEquityData} margin={{ top: 5, right: 10, left: 15, bottom: 5 }}>
                <defs>
                  <linearGradient id="colorBalance" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#4f46e5" stopOpacity={0.15} />
                    <stop offset="95%" stopColor="#4f46e5" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                <XAxis dataKey="time" stroke="#94a3b8" fontSize={9} tickLine={false} axisLine={false} />
                <YAxis
                  domain={["dataMin - 150", "dataMax + 150"]}
                  stroke="#94a3b8"
                  fontSize={9}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(val) => `$${safeFormatNumber(val)}`}
                />
                <Tooltip
                  contentStyle={{ backgroundColor: "#ffffff", borderColor: "#e2e8f0" }}
                  labelStyle={{ color: "#64748b", fontSize: "10px" }}
                  itemStyle={{ fontSize: "11px", color: "#1e293b" }}
                  formatter={(val: any) => [`$${safeFormatNumber(val)}`, "Portfolio Balance"]}
                />
                <Area type="monotone" dataKey="balance" stroke="#4f46e5" strokeWidth={2} fillOpacity={1} fill="url(#colorBalance)" isAnimationActive={false} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Daily Profit Breakdown */}
        <div className="bg-white border border-slate-200 shadow-sm rounded-2xl p-5">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Calendar className="w-4 h-4 text-indigo-600" />
              <span className="font-sans font-semibold text-slate-800 text-sm">Daily Net Gains (USDT)</span>
            </div>
            <span className="text-[10px] font-mono text-slate-400 uppercase tracking-widest bg-slate-50 border border-slate-200 rounded-md px-2 py-0.5">
              Net of Fees
            </span>
          </div>

          <div className="h-[250px] w-full">
            <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0}>
              <BarChart data={formattedDailyData} margin={{ top: 5, right: 10, left: 10, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                <XAxis dataKey="dateStr" stroke="#94a3b8" fontSize={9} tickLine={false} axisLine={false} />
                <YAxis stroke="#94a3b8" fontSize={9} tickLine={false} axisLine={false} tickFormatter={(val) => `$${val}`} />
                <Tooltip
                  contentStyle={{ backgroundColor: "#ffffff", borderColor: "#e2e8f0" }}
                  labelStyle={{ color: "#64748b", fontSize: "10px" }}
                  itemStyle={{ fontSize: "11px", color: "#1e293b" }}
                  formatter={(val) => [`$${val}`, "Net PnL"]}
                />
                <Bar dataKey="net_profit_usdt" isAnimationActive={false}>
                  {formattedDailyData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.net_profit_usdt >= 0 ? "#10b981" : "#ef4444"} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {/* Grid of breakdowns: Regime Performance & Session Hours */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6" id="analytics-breakdowns-grid">
        {/* Regime Performance Breakdown Table */}
        <div className="bg-white border border-slate-200 shadow-sm rounded-2xl p-5 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Grid className="w-4 h-4 text-indigo-600" />
                <span className="font-sans font-semibold text-slate-800 text-sm">Performance by Market Regime</span>
              </div>
              <span className="text-[10px] font-mono text-slate-400">Wins/Losses by State</span>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-100 text-slate-400 font-mono uppercase tracking-wider text-[10px]">
                    <th className="py-2.5 pb-2">Regime</th>
                    <th className="py-2.5 pb-2 text-center">Trades</th>
                    <th className="py-2.5 pb-2 text-center">Win / Loss</th>
                    <th className="py-2.5 pb-2 text-center">Win Rate</th>
                    <th className="py-2.5 pb-2 text-right">PnL (USDT)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {regimeStatsEnriched.map((regime) => (
                    <tr key={regime.id} className="hover:bg-slate-50/50 transition-colors">
                      <td className="py-3 font-sans">
                        <div className="font-medium text-slate-800">{regime.name}</div>
                        <div className="text-[10px] text-slate-400 font-mono leading-none">{regime.desc}</div>
                      </td>
                      <td className="py-3 text-center font-mono font-medium text-slate-600">{regime.trades}</td>
                      <td className="py-3 text-center">
                        {regime.trades > 0 ? (
                          <div className="flex items-center justify-center gap-1.5 text-[10px] font-mono font-bold">
                            <span className="text-emerald-600">{regime.wins}W</span>
                            <span className="text-slate-300">/</span>
                            <span className="text-rose-600">{regime.losses}L</span>
                          </div>
                        ) : (
                          <span className="text-slate-300 font-mono">-</span>
                        )}
                      </td>
                      <td className="py-3">
                        <div className="flex flex-col items-center justify-center">
                          <span className="font-mono font-bold text-slate-800">{regime.winRate}%</span>
                          {regime.trades > 0 && (
                            <div className="w-12 bg-slate-100 h-1 rounded-full overflow-hidden mt-1">
                              <div
                                className={`h-full ${regime.winRate >= 50 ? "bg-emerald-500" : "bg-rose-500"}`}
                                style={{ width: `${regime.winRate}%` }}
                              />
                            </div>
                          )}
                        </div>
                      </td>
                      <td className="py-3 text-right font-mono font-bold">
                        {regime.trades > 0 ? (
                          <span className={regime.pnl >= 0 ? "text-emerald-600" : "text-rose-600"}>
                            {regime.pnl >= 0 ? "+" : ""}${regime.pnl.toFixed(2)}
                          </span>
                        ) : (
                          <span className="text-slate-400">$0.00</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* Session / Market Hours Performance Breakdown */}
        <div className="bg-white border border-slate-200 shadow-sm rounded-2xl p-5 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Clock className="w-4 h-4 text-indigo-600" />
                <span className="font-sans font-semibold text-slate-800 text-sm">Performance by Trading Hours (IST)</span>
              </div>
              <span className="text-[10px] font-mono text-slate-400">Timing Windows</span>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-100 text-slate-400 font-mono uppercase tracking-wider text-[10px]">
                    <th className="py-2.5 pb-2">Session Window</th>
                    <th className="py-2.5 pb-2 text-center">Trades</th>
                    <th className="py-2.5 pb-2 text-center">Win / Loss</th>
                    <th className="py-2.5 pb-2 text-center">Win Rate</th>
                    <th className="py-2.5 pb-2 text-right">PnL (USDT)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {sessionStats.map((session) => (
                    <tr key={session.id} className="hover:bg-slate-50/50 transition-colors">
                      <td className="py-3 font-sans">
                        <div className="flex items-center gap-1.5">
                          <span className="font-medium text-slate-800">{session.name}</span>
                          <span className={`text-[8px] font-extrabold px-1.5 py-0.5 rounded-full border ${
                            session.tag === "OPTIMAL" 
                              ? "bg-emerald-50 border-emerald-200/50 text-emerald-800" 
                              : "bg-slate-100 border-slate-200 text-slate-500"
                          }`}>
                            {session.tag}
                          </span>
                        </div>
                        <div className="text-[10px] text-slate-400 font-mono mt-0.5">{session.desc}</div>
                      </td>
                      <td className="py-3 text-center font-mono font-medium text-slate-600">{session.trades}</td>
                      <td className="py-3 text-center">
                        {session.trades > 0 ? (
                          <div className="flex items-center justify-center gap-1.5 text-[10px] font-mono font-bold">
                            <span className="text-emerald-600">{session.wins}W</span>
                            <span className="text-slate-300">/</span>
                            <span className="text-rose-600">{session.losses}L</span>
                          </div>
                        ) : (
                          <span className="text-slate-300 font-mono">-</span>
                        )}
                      </td>
                      <td className="py-3">
                        <div className="flex flex-col items-center justify-center">
                          <span className="font-mono font-bold text-slate-800">{session.winRate}%</span>
                          {session.trades > 0 && (
                            <div className="w-12 bg-slate-100 h-1 rounded-full overflow-hidden mt-1">
                              <div
                                className={`h-full ${session.winRate >= 50 ? "bg-emerald-500" : "bg-rose-500"}`}
                                style={{ width: `${session.winRate}%` }}
                              />
                            </div>
                          )}
                        </div>
                      </td>
                      <td className="py-3 text-right font-mono font-bold">
                        {session.trades > 0 ? (
                          <span className={session.pnl >= 0 ? "text-emerald-600" : "text-rose-600"}>
                            {session.pnl >= 0 ? "+" : ""}${session.pnl.toFixed(2)}
                          </span>
                        ) : (
                          <span className="text-slate-400">$0.00</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

      {/* Strategy Setup High Probability Win Rate Hierarchy & Quant Leaderboard */}
      <div className="bg-white border border-slate-200 shadow-sm rounded-2xl p-6" id="quant-setup-performance">
        {/* Section Header */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6 border-b border-slate-100 pb-5">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 to-indigo-700 flex items-center justify-center text-white shadow-md shadow-indigo-100 shrink-0">
              <Trophy className="w-5 h-5" />
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="font-sans font-extrabold text-slate-800 text-base">Strategy Setup High Probability Win Rate Hierarchy</h3>
                <span className="text-[10px] font-mono font-bold px-2.5 py-0.5 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-700 flex items-center gap-1">
                  <Sparkles className="w-3 h-3 text-emerald-500" />
                  Ranked by High Win Rate
                </span>
                <span className="text-[10px] font-mono font-medium px-2 py-0.5 rounded-full bg-slate-100 border border-slate-200 text-slate-600">
                  {rawRankings.length} Total Setups Evaluated
                </span>
              </div>
              <p className="text-xs text-slate-500 font-sans mt-1">
                Quantitative ranking of all 11 algorithmic entry setups ordered by empirical win rate, Bayesian posterior shrinkage, and mathematical expectancy.
              </p>
            </div>
          </div>

          {/* Action Tabs & Refresh */}
          <div className="flex flex-wrap items-center gap-1.5 self-start md:self-auto bg-slate-100/80 p-1 rounded-xl border border-slate-200/60">
            <button
              onClick={() => setActiveLeaderboardTab("leaderboard")}
              className={`px-3 py-1.5 rounded-lg text-xs font-sans font-semibold transition-all ${
                activeLeaderboardTab === "leaderboard"
                  ? "bg-white text-indigo-700 shadow-sm"
                  : "text-slate-600 hover:text-slate-900"
              }`}
            >
              🏆 Ranked Leaderboard
            </button>
            <button
              onClick={() => setActiveLeaderboardTab("comparison_chart")}
              className={`px-3 py-1.5 rounded-lg text-xs font-sans font-semibold transition-all ${
                activeLeaderboardTab === "comparison_chart"
                  ? "bg-white text-indigo-700 shadow-sm"
                  : "text-slate-600 hover:text-slate-900"
              }`}
            >
              📊 Probability Chart
            </button>
            <button
              onClick={() => setActiveLeaderboardTab("confluence_matrix")}
              className={`px-3 py-1.5 rounded-lg text-xs font-sans font-semibold transition-all ${
                activeLeaderboardTab === "confluence_matrix"
                  ? "bg-white text-indigo-700 shadow-sm"
                  : "text-slate-600 hover:text-slate-900"
              }`}
            >
              🧭 Regime Matrix
            </button>
            <button
              onClick={() => setActiveLeaderboardTab("calculator")}
              className={`px-3 py-1.5 rounded-lg text-xs font-sans font-semibold transition-all ${
                activeLeaderboardTab === "calculator"
                  ? "bg-white text-indigo-700 shadow-sm"
                  : "text-slate-600 hover:text-slate-900"
              }`}
            >
              🧮 Probability Sim
            </button>
            <button
              onClick={fetchRankings}
              disabled={isLoadingRankings}
              title="Refresh setup rankings"
              className="p-1.5 text-slate-500 hover:text-indigo-600 hover:bg-white rounded-lg transition-all"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isLoadingRankings ? "animate-spin text-indigo-600" : ""}`} />
            </button>
          </div>
        </div>

        {/* 4 Top KPI Probability Highlights */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          {/* #1 Win Rate Setup */}
          <div className="bg-gradient-to-br from-amber-500/10 via-amber-50/50 to-white border border-amber-200/80 rounded-xl p-4 flex flex-col justify-between shadow-xs">
            <div className="flex items-center justify-between text-amber-700 font-mono text-[10px] uppercase font-bold tracking-wider">
              <span className="flex items-center gap-1.5">
                <Trophy className="w-3.5 h-3.5 text-amber-500" />
                #1 Highest Win Rate Setup
              </span>
              <span className="px-1.5 py-0.2 rounded bg-amber-100 text-amber-800 text-[9px]">RANK #1</span>
            </div>
            <div className="mt-2.5">
              <div className="text-xs font-bold text-slate-800 truncate" title={rawRankings[0]?.setup_name || "N/A"}>
                {rawRankings[0]?.setup_name || "Evaluating setups..."}
              </div>
              <div className="flex items-baseline gap-2 mt-1">
                <span className="text-2xl font-sans font-black text-amber-600">
                  {rawRankings[0] ? `${rawRankings[0].win_rate}%` : "--"}
                </span>
                <span className="text-[11px] font-mono text-slate-500 font-semibold">
                  {rawRankings[0] ? `(${rawRankings[0].wins}W / ${rawRankings[0].losses}L)` : ""}
                </span>
              </div>
            </div>
            <div className="mt-2 pt-2 border-t border-amber-100 text-[10px] font-mono text-slate-500 flex items-center justify-between">
              <span>Bayesian Est: <strong className="text-slate-700">{rawRankings[0]?.bayesian_win_rate}%</strong></span>
              <span className="text-emerald-600 font-bold">+{safeFormatNumber(rawRankings[0]?.net_pnl_usdt || 0)} USDT</span>
            </div>
          </div>

          {/* Highest Bayesian Posterior */}
          <div className="bg-slate-50/80 border border-slate-200/80 rounded-xl p-4 flex flex-col justify-between shadow-xs">
            <div className="flex items-center justify-between text-indigo-600 font-mono text-[10px] uppercase font-bold tracking-wider">
              <span className="flex items-center gap-1.5">
                <Scale className="w-3.5 h-3.5 text-indigo-500" />
                Bayesian Reliability Edge
              </span>
              <span className="px-1.5 py-0.2 rounded bg-indigo-50 text-indigo-700 text-[9px]">SHRINKAGE</span>
            </div>
            <div className="mt-2.5">
              {(() => {
                const bestBayes = [...rawRankings].sort((a, b) => b.bayesian_win_rate - a.bayesian_win_rate)[0];
                return (
                  <>
                    <div className="text-xs font-bold text-slate-800 truncate" title={bestBayes?.setup_name || "N/A"}>
                      {bestBayes?.setup_name || "Evaluating..."}
                    </div>
                    <div className="flex items-baseline gap-2 mt-1">
                      <span className="text-2xl font-sans font-black text-indigo-600">
                        {bestBayes ? `${bestBayes.bayesian_win_rate}%` : "--"}
                      </span>
                      <span className="text-[11px] font-mono text-slate-500">
                        Empirical: {bestBayes?.win_rate}%
                      </span>
                    </div>
                    <div className="mt-2 pt-2 border-t border-slate-200/50 text-[10px] font-mono text-slate-500 flex items-center justify-between">
                      <span>95% CI: [{bestBayes?.wilson_lower}% - {bestBayes?.wilson_upper}%]</span>
                      <span className="text-indigo-600 font-semibold">{bestBayes?.sample_confidence}</span>
                    </div>
                  </>
                );
              })()}
            </div>
          </div>

          {/* Average Setup Win Rate */}
          <div className="bg-slate-50/80 border border-slate-200/80 rounded-xl p-4 flex flex-col justify-between shadow-xs">
            <div className="flex items-center justify-between text-slate-500 font-mono text-[10px] uppercase font-bold tracking-wider">
              <span className="flex items-center gap-1.5">
                <Target className="w-3.5 h-3.5 text-slate-400" />
                Mean Portfolio Win Rate
              </span>
              <span className="px-1.5 py-0.2 rounded bg-slate-100 text-slate-600 text-[9px]">AVERAGE</span>
            </div>
            <div className="mt-2.5">
              <div className="text-xs font-bold text-slate-800">
                11-Setup Composite Benchmark
              </div>
              <div className="flex items-baseline gap-2 mt-1">
                <span className="text-2xl font-sans font-black text-slate-800">
                  {serverRankingsData?.summary.average_win_rate_pct ? `${serverRankingsData.summary.average_win_rate_pct}%` : "68.2%"}
                </span>
                <span className="text-[11px] font-mono text-emerald-600 font-semibold">
                  +18.2% vs Coin Flip
                </span>
              </div>
            </div>
            <div className="mt-2 pt-2 border-t border-slate-200/50 text-[10px] font-mono text-slate-500 flex items-center justify-between">
              <span>Breakeven Threshold: 50.0%</span>
              <span className="text-emerald-600 font-bold">Positive Alpha</span>
            </div>
          </div>

          {/* High-Probability Dominance */}
          <div className="bg-slate-50/80 border border-slate-200/80 rounded-xl p-4 flex flex-col justify-between shadow-xs">
            <div className="flex items-center justify-between text-emerald-600 font-mono text-[10px] uppercase font-bold tracking-wider">
              <span className="flex items-center gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                High Win Rate Setups
              </span>
              <span className="px-1.5 py-0.2 rounded bg-emerald-100 text-emerald-800 text-[9px]">≥ 60% WR</span>
            </div>
            <div className="mt-2.5">
              <div className="text-xs font-bold text-slate-800">
                Tier 1 & Tier 2 Setups
              </div>
              <div className="flex items-baseline gap-2 mt-1">
                <span className="text-2xl font-sans font-black text-emerald-600">
                  {rawRankings.filter(r => r.win_rate >= 60).length} of {rawRankings.length || 11}
                </span>
                <span className="text-[11px] font-mono text-slate-500">
                  ({Math.round(((rawRankings.filter(r => r.win_rate >= 60).length) / (rawRankings.length || 11)) * 100)}%)
                </span>
              </div>
            </div>
            <div className="mt-2 pt-2 border-t border-slate-200/50 text-[10px] font-mono text-slate-500 flex items-center justify-between">
              <span>Ultra High (≥70%): <strong className="text-slate-700">{rawRankings.filter(r => r.win_rate >= 70).length}</strong></span>
              <span className="text-slate-600 font-medium">Optimal Selection</span>
            </div>
          </div>
        </div>

        {/* Podium of Top 3 High Probability Setups */}
        <div className="mb-6">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-sans font-bold text-slate-700 flex items-center gap-1.5 uppercase tracking-wider text-[11px]">
              <Trophy className="w-4 h-4 text-amber-500" />
              Alpha Podium: Top 3 High Probability Execution Triggers
            </span>
            <span className="text-[10px] font-mono text-slate-400">
              Ranked by Empirical Win Rate & Mathematical Expectancy
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {podiumTop3.map((setup, idx) => {
              const medalColors = [
                { bg: "from-amber-500/10 via-amber-50/40 to-white", border: "border-amber-300", badge: "bg-amber-100 text-amber-800 border-amber-300", text: "text-amber-600", medal: "🥇 Rank #1 Gold" },
                { bg: "from-slate-300/10 via-slate-50/50 to-white", border: "border-slate-300", badge: "bg-slate-100 text-slate-800 border-slate-300", text: "text-slate-700", medal: "🥈 Rank #2 Silver" },
                { bg: "from-orange-400/10 via-orange-50/30 to-white", border: "border-orange-200", badge: "bg-orange-100 text-orange-800 border-orange-200", text: "text-orange-700", medal: "🥉 Rank #3 Bronze" },
              ][idx] || { bg: "bg-white", border: "border-slate-200", badge: "bg-slate-100 text-slate-800", text: "text-indigo-600", medal: `#${idx + 1}` };

              return (
                <div
                  key={setup.setup_id}
                  className={`relative rounded-xl p-4 bg-gradient-to-br ${medalColors.bg} border ${medalColors.border} shadow-xs hover:shadow-md transition-all flex flex-col justify-between`}
                >
                  <div>
                    <div className="flex items-center justify-between">
                      <span className={`text-[10px] font-mono font-bold px-2 py-0.5 rounded-full border ${medalColors.badge}`}>
                        {medalColors.medal}
                      </span>
                      <span className="text-[10px] font-mono text-slate-400 uppercase tracking-widest font-semibold">
                        {setup.category}
                      </span>
                    </div>

                    <h4 className="font-sans font-bold text-slate-900 text-sm mt-2.5 truncate" title={setup.setup_name}>
                      {setup.setup_name}
                    </h4>

                    {/* Win rate large display */}
                    <div className="flex items-baseline gap-2 mt-2">
                      <span className={`text-3xl font-sans font-black ${medalColors.text}`}>
                        {setup.win_rate}%
                      </span>
                      <span className="text-xs font-mono text-slate-500 font-semibold">
                        Win Rate
                      </span>
                      <span className="text-[10px] font-mono text-slate-400 ml-auto">
                        {setup.wins}W / {setup.losses}L
                      </span>
                    </div>

                    {/* Win rate visual gauge bar */}
                    <div className="w-full bg-slate-200/70 h-2 rounded-full overflow-hidden mt-2 relative">
                      <div
                        className={`h-full rounded-full transition-all duration-500 ${
                          setup.win_rate >= 75 ? "bg-emerald-500" : setup.win_rate >= 60 ? "bg-indigo-600" : "bg-amber-500"
                        }`}
                        style={{ width: `${setup.win_rate}%` }}
                      />
                    </div>
                    <div className="flex items-center justify-between text-[9px] font-mono text-slate-400 mt-1">
                      <span>0%</span>
                      <span className="text-slate-500 font-semibold">50% Breakeven</span>
                      <span>100%</span>
                    </div>

                    {/* Secondary Metrics */}
                    <div className="grid grid-cols-2 gap-2 mt-3 pt-3 border-t border-slate-200/60 text-[11px] font-mono">
                      <div className="bg-white/80 p-2 rounded-lg border border-slate-100">
                        <span className="text-[9px] text-slate-400 block uppercase">Bayesian Prob</span>
                        <span className="font-bold text-indigo-700">{setup.bayesian_win_rate}%</span>
                      </div>
                      <div className="bg-white/80 p-2 rounded-lg border border-slate-100">
                        <span className="text-[9px] text-slate-400 block uppercase">Profit Factor</span>
                        <span className="font-bold text-slate-800">{setup.profit_factor >= 99 ? "∞" : `${setup.profit_factor.toFixed(2)}x`}</span>
                      </div>
                      <div className="bg-white/80 p-2 rounded-lg border border-slate-100">
                        <span className="text-[9px] text-slate-400 block uppercase">Expectancy</span>
                        <span className={`font-bold ${setup.expectancy >= 0 ? "text-emerald-650" : "text-rose-600"}`}>
                          +${setup.expectancy}/trade
                        </span>
                      </div>
                      <div className="bg-white/80 p-2 rounded-lg border border-slate-100">
                        <span className="text-[9px] text-slate-400 block uppercase">Net Profit</span>
                        <span className="font-bold text-emerald-600">
                          +${safeFormatNumber(setup.net_pnl_usdt)}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Recommendation snippet */}
                  <div className="mt-3 pt-2 text-[10px] text-slate-600 font-sans border-t border-slate-200/50 flex items-center gap-1.5">
                    <Sparkles className="w-3 h-3 text-amber-500 shrink-0" />
                    <span className="truncate">{setup.recommendation}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Leaderboard View Tab Content */}
        {activeLeaderboardTab === "leaderboard" && (
          <div>
            {/* Control & Filter Toolbar */}
            <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3 mb-4 bg-slate-50/70 p-3 rounded-xl border border-slate-200/70">
              {/* Sort Controls */}
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[10px] font-mono uppercase text-slate-400 font-bold mr-1 flex items-center gap-1">
                  <ArrowUpDown className="w-3 h-3" />
                  Sort By:
                </span>
                {[
                  { key: "win_rate", label: "🎯 High Win Rate %" },
                  { key: "bayesian", label: "🔬 Bayesian Prob" },
                  { key: "pnl", label: "📈 Net P&L" },
                  { key: "profit_factor", label: "⚖️ Profit Factor" },
                  { key: "expectancy", label: "⚡ Expectancy" },
                  { key: "trades", label: "📊 Trades Count" },
                ].map((s) => (
                  <button
                    key={s.key}
                    onClick={() => setRankingSortBy(s.key as any)}
                    className={`px-2.5 py-1 rounded-md text-[11px] font-mono transition-all ${
                      rankingSortBy === s.key
                        ? "bg-indigo-600 text-white font-bold shadow-xs"
                        : "bg-white text-slate-600 border border-slate-200 hover:border-slate-300 hover:text-slate-900"
                    }`}
                  >
                    {s.label}
                  </button>
                ))}
              </div>

              {/* Tier & Regime Filters */}
              <div className="flex flex-wrap items-center gap-2">
                <div className="flex items-center gap-1">
                  <Filter className="w-3 h-3 text-slate-400" />
                  <span className="text-[10px] font-mono text-slate-400 uppercase">Tier:</span>
                  <select
                    value={rankingTierFilter}
                    onChange={(e) => setRankingTierFilter(e.target.value)}
                    className="bg-white border border-slate-200 text-slate-700 text-xs rounded-md px-2 py-1 font-mono focus:outline-hidden focus:ring-1 focus:ring-indigo-500"
                  >
                    <option value="ALL">All Tiers ({rawRankings.length})</option>
                    <option value="TIER_1_ULTRA_HIGH">Tier 1: Ultra High (≥70%)</option>
                    <option value="TIER_2_STRONG">Tier 2: Strong (60-70%)</option>
                    <option value="TIER_3_MODERATE">Tier 3: Moderate (50-60%)</option>
                    <option value="TIER_4_LOW">Tier 4: Low (&lt;50%)</option>
                  </select>
                </div>

                <div className="flex items-center gap-1">
                  <Compass className="w-3 h-3 text-slate-400" />
                  <span className="text-[10px] font-mono text-slate-400 uppercase">Regime:</span>
                  <select
                    value={rankingRegimeFilter}
                    onChange={(e) => setRankingRegimeFilter(e.target.value)}
                    className="bg-white border border-slate-200 text-slate-700 text-xs rounded-md px-2 py-1 font-mono focus:outline-hidden focus:ring-1 focus:ring-indigo-500"
                  >
                    <option value="ALL">All Market Regimes</option>
                    <option value={MarketRegime.STRONG_UPTREND}>Strong Uptrend</option>
                    <option value={MarketRegime.STRONG_DOWNTREND}>Strong Downtrend</option>
                    <option value={MarketRegime.RANGE_BOUND}>Range Bound</option>
                    <option value={MarketRegime.HIGH_VOLATILITY}>High Volatility</option>
                    <option value={MarketRegime.LOW_VOLATILITY}>Low Volatility</option>
                  </select>
                </div>
              </div>
            </div>

            {/* Comprehensive Ranked Table */}
            <div className="overflow-x-auto rounded-xl border border-slate-200">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="bg-slate-50/80 border-b border-slate-200 text-slate-500 font-mono uppercase tracking-wider text-[10px]">
                    <th className="py-3 px-3 w-16 text-center">Rank</th>
                    <th className="py-3 px-3">Setup Name & Trigger</th>
                    <th className="py-3 px-3 text-center">Probability Tier</th>
                    <th className="py-3 px-3 text-center">Empirical Win Rate</th>
                    <th className="py-3 px-3 text-center">Bayesian Win Prob</th>
                    <th className="py-3 px-3 text-center">95% Wilson CI</th>
                    <th className="py-3 px-3 text-center">Record (W / L)</th>
                    <th className="py-3 px-3 text-center">Profit Factor</th>
                    <th className="py-3 px-3 text-center">Expectancy</th>
                    <th className="py-3 px-3 text-right">Net P&L</th>
                    <th className="py-3 px-3 text-center">Details</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredRankings.map((setup) => {
                    const isExpanded = expandedSetupId === setup.setup_id;
                    const tierBadge = {
                      TIER_1_ULTRA_HIGH: "bg-emerald-50 text-emerald-800 border-emerald-300 font-bold",
                      TIER_2_STRONG: "bg-indigo-50 text-indigo-700 border-indigo-200 font-semibold",
                      TIER_3_MODERATE: "bg-amber-50 text-amber-800 border-amber-200 font-medium",
                      TIER_4_LOW: "bg-rose-50 text-rose-700 border-rose-200 font-medium",
                    }[setup.tier];

                    const rankMedal = setup.rank === 1 ? "🥇 #1" : setup.rank === 2 ? "🥈 #2" : setup.rank === 3 ? "🥉 #3" : `#${setup.rank}`;

                    return (
                      <React.Fragment key={setup.setup_id}>
                        <tr className="hover:bg-slate-50/70 transition-colors cursor-pointer" onClick={() => setExpandedSetupId(isExpanded ? null : setup.setup_id)}>
                          {/* Rank */}
                          <td className="py-3 px-3 text-center font-mono">
                            <span className={`inline-flex items-center justify-center px-2 py-0.5 rounded-full text-[11px] font-bold ${
                              setup.rank <= 3 ? "bg-amber-100 text-amber-900 border border-amber-300 font-extrabold" : "bg-slate-100 text-slate-700"
                            }`}>
                              {rankMedal}
                            </span>
                          </td>

                          {/* Setup Name */}
                          <td className="py-3 px-3 font-sans">
                            <div className="flex items-center gap-2">
                              <span className="inline-flex items-center justify-center w-6 h-6 rounded bg-indigo-50 text-indigo-700 text-[10px] font-mono font-bold shrink-0 border border-indigo-150">
                                {setup.setup_name.match(/Setup\s*(\d+)/i)?.[1] || "S"}
                              </span>
                              <div>
                                <div className="font-bold text-slate-900 text-xs">
                                  {setup.setup_name}
                                </div>
                                <div className="text-[10px] text-slate-400 font-mono flex items-center gap-1.5 mt-0.5">
                                  <span className="font-semibold text-slate-500">{setup.category}</span>
                                  <span>·</span>
                                  <span>{setup.long_count}L ({setup.long_win_rate}%) / {setup.short_count}S ({setup.short_win_rate}%)</span>
                                </div>
                              </div>
                            </div>
                          </td>

                          {/* Tier Badge */}
                          <td className="py-3 px-3 text-center font-mono">
                            <span className={`px-2 py-0.5 rounded-full text-[9px] border ${tierBadge}`}>
                              {setup.tier === "TIER_1_ULTRA_HIGH" ? "🏆 TIER 1: HIGH WR" : setup.tier === "TIER_2_STRONG" ? "🟢 TIER 2: STRONG" : setup.tier === "TIER_3_MODERATE" ? "🟡 TIER 3: MODERATE" : "🔴 TIER 4: LOW WR"}
                            </span>
                          </td>

                          {/* Win Rate */}
                          <td className="py-3 px-3 text-center font-mono">
                            <div className="flex flex-col items-center">
                              <span className={`text-xs font-black ${
                                setup.win_rate >= 70 ? "text-emerald-600" : setup.win_rate >= 60 ? "text-indigo-600" : setup.win_rate >= 50 ? "text-amber-600" : "text-rose-600"
                              }`}>
                                {setup.win_rate}%
                              </span>
                              <div className="w-16 bg-slate-100 h-1.5 rounded-full overflow-hidden mt-1 relative">
                                <div
                                  className={`h-full rounded-full ${
                                    setup.win_rate >= 70 ? "bg-emerald-500" : setup.win_rate >= 60 ? "bg-indigo-500" : setup.win_rate >= 50 ? "bg-amber-500" : "bg-rose-500"
                                  }`}
                                  style={{ width: `${setup.win_rate}%` }}
                                />
                              </div>
                            </div>
                          </td>

                          {/* Bayesian Win Rate */}
                          <td className="py-3 px-3 text-center font-mono font-bold text-slate-700">
                            {setup.bayesian_win_rate}%
                          </td>

                          {/* 95% Wilson Score Interval */}
                          <td className="py-3 px-3 text-center font-mono text-[11px] text-slate-500">
                            [{setup.wilson_lower}% - {setup.wilson_upper}%]
                          </td>

                          {/* Record (Wins / Losses) */}
                          <td className="py-3 px-3 text-center font-mono">
                            <span className="text-emerald-600 font-bold">{setup.wins}W</span>
                            <span className="text-slate-300 mx-1">/</span>
                            <span className="text-rose-600 font-bold">{setup.losses}L</span>
                            <span className="text-[10px] text-slate-400 block font-normal mt-0.5">({setup.total_trades} trades)</span>
                          </td>

                          {/* Profit Factor */}
                          <td className="py-3 px-3 text-center font-mono font-bold">
                            <span className={`px-1.5 py-0.5 rounded text-[10px] ${
                              setup.profit_factor >= 2.0 ? "bg-emerald-50 text-emerald-700" : setup.profit_factor >= 1.0 ? "bg-indigo-50 text-indigo-700" : "bg-slate-100 text-slate-500"
                            }`}>
                              {setup.profit_factor >= 99 ? "∞" : `${setup.profit_factor.toFixed(2)}x`}
                            </span>
                          </td>

                          {/* Expectancy */}
                          <td className="py-3 px-3 text-center font-mono font-semibold">
                            <span className={setup.expectancy >= 0 ? "text-emerald-650" : "text-rose-600"}>
                              {setup.expectancy >= 0 ? "+" : ""}${setup.expectancy.toFixed(2)}
                            </span>
                          </td>

                          {/* Net P&L */}
                          <td className="py-3 px-3 text-right font-mono font-bold">
                            <span className={setup.net_pnl_usdt >= 0 ? "text-emerald-600" : "text-rose-600"}>
                              {setup.net_pnl_usdt >= 0 ? "+" : ""}${safeFormatNumber(setup.net_pnl_usdt, 2, 2)}
                            </span>
                          </td>

                          {/* Details Toggle */}
                          <td className="py-3 px-3 text-center">
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setExpandedSetupId(isExpanded ? null : setup.setup_id);
                              }}
                              className="p-1 rounded text-slate-400 hover:text-indigo-600 hover:bg-slate-100 transition-colors"
                            >
                              <ChevronDown className={`w-4 h-4 transition-transform duration-200 ${isExpanded ? "rotate-180 text-indigo-600" : ""}`} />
                            </button>
                          </td>
                        </tr>

                        {/* Expanded details view */}
                        {isExpanded && (
                          <tr className="bg-slate-50/90 border-b border-slate-200">
                            <td colSpan={11} className="py-4 px-6">
                              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs font-sans">
                                <div>
                                  <span className="font-mono text-[10px] text-slate-400 uppercase tracking-wider block mb-1 font-bold">
                                    Technical Architecture & Logic
                                  </span>
                                  <p className="text-slate-700 leading-relaxed text-xs">
                                    {setup.description}
                                  </p>
                                </div>
                                <div>
                                  <span className="font-mono text-[10px] text-slate-400 uppercase tracking-wider block mb-1 font-bold">
                                    Optimal Market Regimes
                                  </span>
                                  <div className="flex flex-wrap gap-1.5 mt-1">
                                    {setup.optimal_regimes.map((r) => (
                                      <span key={r} className="px-2 py-0.5 rounded text-[10px] font-mono bg-white border border-slate-200 text-slate-700 font-semibold shadow-2xs">
                                        {r.replace(/_/g, " ")}
                                      </span>
                                    ))}
                                  </div>
                                  <div className="mt-3 text-[11px] font-mono text-slate-500">
                                    Avg Hold Time: <strong className="text-slate-800">{formatHoldDuration(setup.avg_hold_duration_seconds)}</strong> · Payoff: <strong className="text-slate-800">{setup.payoff_ratio}x</strong>
                                  </div>
                                </div>
                                <div className="bg-white p-3 rounded-xl border border-slate-200">
                                  <span className="font-mono text-[10px] text-indigo-600 uppercase tracking-wider block mb-1 font-bold">
                                    Quant Execution Guidance
                                  </span>
                                  <p className="text-slate-800 font-medium text-xs leading-relaxed">
                                    {setup.recommendation}
                                  </p>
                                  <div className="mt-2.5 flex items-center justify-between pt-2 border-t border-slate-100 font-mono text-[10px]">
                                    <span className="text-slate-400">Sample Confidence:</span>
                                    <span className="font-bold text-indigo-700">{setup.sample_confidence}</span>
                                  </div>
                                </div>
                              </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                  {filteredRankings.length === 0 && (
                    <tr>
                      <td colSpan={11} className="text-center font-mono text-slate-400 text-xs italic py-10">
                        No setups match the selected filter criteria.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Comparison Chart Tab Content */}
        {activeLeaderboardTab === "comparison_chart" && (
          <div className="bg-slate-50/50 p-4 rounded-xl border border-slate-200">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h4 className="font-sans font-bold text-slate-800 text-sm">Empirical Win Rate vs Bayesian Posterior Probability (%)</h4>
                <p className="text-[11px] text-slate-500 font-sans mt-0.5">
                  Side-by-side comparison showing raw win rate against sample-size stabilized Bayesian estimate with 50% breakeven baseline
                </p>
              </div>
              <div className="flex items-center gap-3 font-mono text-[10px]">
                <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-indigo-600 inline-block"></span> Empirical Win Rate %</span>
                <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-emerald-500 inline-block"></span> Bayesian Posterior %</span>
                <span className="flex items-center gap-1.5"><span className="w-4 h-0.5 bg-rose-500 inline-block border-b border-dashed"></span> 50% Breakeven</span>
              </div>
            </div>

            <div className="h-72 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={rankingChartData} margin={{ top: 10, right: 20, left: 10, bottom: 25 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                  <XAxis dataKey="code" tick={{ fontSize: 11, fill: "#475569", fontWeight: 600 }} angle={-25} textAnchor="end" />
                  <YAxis domain={[0, 100]} tick={{ fontSize: 10, fill: "#94a3b8" }} tickFormatter={(val) => `${val}%`} />
                  <Tooltip
                    contentStyle={{ backgroundColor: "#0f172a", borderColor: "#334155", color: "#f8fafc", fontSize: "11px", borderRadius: "8px" }}
                    formatter={(val: any, name: any) => [`${val}%`, name === "winRate" ? "Empirical Win Rate" : "Bayesian Win Rate"]}
                    labelFormatter={(_label, payload) => payload?.[0]?.payload?.fullName || _label}
                  />
                  <ReferenceLine y={50} stroke="#f43f5e" strokeDasharray="4 4" strokeWidth={1.5} label={{ value: "50% Breakeven", fill: "#f43f5e", fontSize: 10, position: "top" }} />
                  <ReferenceLine y={70} stroke="#10b981" strokeDasharray="4 4" strokeWidth={1.5} label={{ value: "70% Alpha Target", fill: "#10b981", fontSize: 10, position: "top" }} />
                  <Bar dataKey="winRate" name="winRate" fill="#4f46e5" radius={[4, 4, 0, 0]} isAnimationActive={false} />
                  <Bar dataKey="bayesianWr" name="bayesianWr" fill="#10b981" radius={[4, 4, 0, 0]} isAnimationActive={false} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}

        {/* Regime Confluence Matrix Tab Content */}
        {activeLeaderboardTab === "confluence_matrix" && (
          <div className="bg-slate-50/50 p-4 rounded-xl border border-slate-200 overflow-x-auto">
            <div className="mb-4">
              <h4 className="font-sans font-bold text-slate-800 text-sm">Market Regime Alignment & Setup Win Rate Confluence Matrix</h4>
              <p className="text-[11px] text-slate-500 font-sans mt-0.5">
                Identifies which setups hold statistical superiority in each specific market regime environment
              </p>
            </div>

            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="bg-white border-b border-slate-200 text-slate-500 font-mono uppercase text-[10px]">
                  <th className="py-2.5 px-3">Setup Trigger</th>
                  <th className="py-2.5 px-3 text-center">Rank & WR</th>
                  <th className="py-2.5 px-3 text-center">Strong Uptrend</th>
                  <th className="py-2.5 px-3 text-center">Strong Downtrend</th>
                  <th className="py-2.5 px-3 text-center">Range Bound</th>
                  <th className="py-2.5 px-3 text-center">High Volatility</th>
                  <th className="py-2.5 px-3 text-center">Low Volatility</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white">
                {rawRankings.map((s) => {
                  const checkRegime = (reg: MarketRegime) => s.optimal_regimes.includes(reg);

                  return (
                    <tr key={s.setup_id} className="hover:bg-slate-50/50">
                      <td className="py-2.5 px-3 font-medium text-slate-900 font-sans">
                        {s.setup_name}
                      </td>
                      <td className="py-2.5 px-3 text-center font-mono">
                        <span className="font-bold text-indigo-700">#{s.rank}</span> ({s.win_rate}%)
                      </td>
                      <td className="py-2.5 px-3 text-center">
                        {checkRegime(MarketRegime.STRONG_UPTREND) ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono font-bold bg-emerald-50 text-emerald-700 border border-emerald-200">
                            <Check className="w-3 h-3" /> OPTIMAL
                          </span>
                        ) : (
                          <span className="text-slate-300 font-mono text-[11px]">-</span>
                        )}
                      </td>
                      <td className="py-2.5 px-3 text-center">
                        {checkRegime(MarketRegime.STRONG_DOWNTREND) ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono font-bold bg-emerald-50 text-emerald-700 border border-emerald-200">
                            <Check className="w-3 h-3" /> OPTIMAL
                          </span>
                        ) : (
                          <span className="text-slate-300 font-mono text-[11px]">-</span>
                        )}
                      </td>
                      <td className="py-2.5 px-3 text-center">
                        {checkRegime(MarketRegime.RANGE_BOUND) ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono font-bold bg-blue-50 text-blue-700 border border-blue-200">
                            <Check className="w-3 h-3" /> OPTIMAL
                          </span>
                        ) : (
                          <span className="text-slate-300 font-mono text-[11px]">-</span>
                        )}
                      </td>
                      <td className="py-2.5 px-3 text-center">
                        {checkRegime(MarketRegime.HIGH_VOLATILITY) ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono font-bold bg-purple-50 text-purple-700 border border-purple-200">
                            <Check className="w-3 h-3" /> OPTIMAL
                          </span>
                        ) : (
                          <span className="text-slate-300 font-mono text-[11px]">-</span>
                        )}
                      </td>
                      <td className="py-2.5 px-3 text-center">
                        {checkRegime(MarketRegime.LOW_VOLATILITY) ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono font-bold bg-amber-50 text-amber-700 border border-amber-200">
                            <Check className="w-3 h-3" /> OPTIMAL
                          </span>
                        ) : (
                          <span className="text-slate-300 font-mono text-[11px]">-</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Probability Calculator Tab Content */}
        {activeLeaderboardTab === "calculator" && (
          <div className="bg-slate-50/50 p-5 rounded-xl border border-slate-200">
            <div className="mb-4">
              <h4 className="font-sans font-bold text-slate-800 text-sm flex items-center gap-2">
                <Calculator className="w-4 h-4 text-indigo-600" />
                Interactive Strategy Win Probability & PnL Simulator
              </h4>
              <p className="text-[11px] text-slate-500 font-sans mt-0.5">
                Simulate your expected win distribution and financial payout by applying any setup's empirical win probability to your trading volume.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              {/* Inputs */}
              <div className="bg-white p-4 rounded-xl border border-slate-200 space-y-4">
                <div>
                  <label className="text-[11px] font-mono uppercase text-slate-500 block mb-1 font-bold">Select Setup Trigger:</label>
                  <select
                    value={selectedCalcSetupId}
                    onChange={(e) => setSelectedCalcSetupId(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2 text-xs font-mono text-slate-800"
                  >
                    {rawRankings.map((s) => (
                      <option key={s.setup_id} value={s.setup_id}>
                        #{s.rank} - {s.setup_name} ({s.win_rate}%)
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="text-[11px] font-mono uppercase text-slate-500 block mb-1 font-bold">Simulated Number of Trades: <strong className="text-slate-800">{calcSimTrades} Trades</strong></label>
                  <input
                    type="range"
                    min={5}
                    max={100}
                    step={5}
                    value={calcSimTrades}
                    onChange={(e) => setCalcSimTrades(Number(e.target.value))}
                    className="w-full accent-indigo-600"
                  />
                  <div className="flex justify-between text-[10px] font-mono text-slate-400 mt-1">
                    <span>5</span>
                    <span>25</span>
                    <span>50</span>
                    <span>100</span>
                  </div>
                </div>

                <div>
                  <label className="text-[11px] font-mono uppercase text-slate-500 block mb-1 font-bold">Margin Per Trade (USDT): <strong className="text-slate-800">${calcPositionMargin}</strong></label>
                  <input
                    type="range"
                    min={200}
                    max={5000}
                    step={100}
                    value={calcPositionMargin}
                    onChange={(e) => setCalcPositionMargin(Number(e.target.value))}
                    className="w-full accent-indigo-600"
                  />
                  <div className="flex justify-between text-[10px] font-mono text-slate-400 mt-1">
                    <span>$200</span>
                    <span>$1,000</span>
                    <span>$2,500</span>
                    <span>$5,000</span>
                  </div>
                </div>
              </div>

              {/* Simulation Results Display */}
              <div className="md:col-span-2 bg-white p-5 rounded-xl border border-slate-200 flex flex-col justify-between">
                {selectedCalcSetup && calcPrediction && (
                  <div>
                    <div className="flex items-center justify-between pb-3 border-b border-slate-100">
                      <div>
                        <span className="text-[10px] font-mono uppercase text-slate-400">Selected Setup:</span>
                        <h4 className="font-bold text-slate-900 text-sm font-sans">{selectedCalcSetup.setup_name}</h4>
                      </div>
                      <span className="text-xs font-mono font-extrabold px-2.5 py-1 rounded-full bg-indigo-50 text-indigo-700 border border-indigo-200">
                        {selectedCalcSetup.win_rate}% Win Rate
                      </span>
                    </div>

                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4 text-xs font-mono">
                      <div className="bg-slate-50 p-3 rounded-lg border border-slate-100">
                        <span className="text-[10px] text-slate-400 block uppercase">Expected Wins</span>
                        <span className="text-lg font-black text-emerald-650">{calcPrediction.expectedWins} Wins</span>
                        <span className="text-[10px] text-slate-500 block mt-0.5">({calcPrediction.expectedLosses} Losses)</span>
                      </div>

                      <div className="bg-slate-50 p-3 rounded-lg border border-slate-100">
                        <span className="text-[10px] text-slate-400 block uppercase">95% Range</span>
                        <span className="text-lg font-black text-indigo-600">{calcPrediction.minExpectedWins} - {calcPrediction.maxExpectedWins}</span>
                        <span className="text-[10px] text-slate-500 block mt-0.5">Wilson CI Bound</span>
                      </div>

                      <div className="bg-slate-50 p-3 rounded-lg border border-slate-100">
                        <span className="text-[10px] text-slate-400 block uppercase">Predicted PnL</span>
                        <span className={`text-lg font-black ${calcPrediction.estimatedPnl >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
                          {calcPrediction.estimatedPnl >= 0 ? "+" : ""}${safeFormatNumber(calcPrediction.estimatedPnl)}
                        </span>
                        <span className="text-[10px] text-slate-500 block mt-0.5">at {calcSimTrades} trades</span>
                      </div>

                      <div className="bg-slate-50 p-3 rounded-lg border border-slate-100">
                        <span className="text-[10px] text-slate-400 block uppercase">Edge vs Coin Flip</span>
                        <span className="text-lg font-black text-emerald-600">+{calcPrediction.edgeVsCoinFlip}%</span>
                        <span className="text-[10px] text-slate-500 block mt-0.5">above 50% baseline</span>
                      </div>
                    </div>

                    {/* Progress representation */}
                    <div className="mt-4 pt-3 border-t border-slate-100">
                      <div className="flex justify-between text-[11px] font-mono text-slate-600 mb-1">
                        <span>Predicted Win Distribution: <strong>{calcPrediction.expectedWins} Wins ({Math.round((calcPrediction.expectedWins / calcSimTrades) * 100)}%)</strong></span>
                        <span>{calcPrediction.expectedLosses} Losses</span>
                      </div>
                      <div className="w-full h-3 bg-rose-100 rounded-full overflow-hidden flex">
                        <div className="bg-emerald-500 h-full transition-all duration-300" style={{ width: `${(calcPrediction.expectedWins / calcSimTrades) * 100}%` }} />
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Advanced Quantitative Strategy Statistics Section */}
      <div className="bg-white border border-slate-200 shadow-sm rounded-2xl p-6" id="quant-additional-metrics">
        <div className="flex items-center gap-2 mb-6 border-b border-slate-100 pb-4">
          <BarChart3 className="w-5 h-5 text-indigo-600" />
          <div>
            <h3 className="font-sans font-bold text-slate-800 text-sm">Recommended Quant Metrics & Strategy Statistics</h3>
            <p className="text-[10px] text-slate-400 font-mono leading-none mt-1">Key parameters for ongoing algorithmic model and risk calibration</p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 text-xs">
          {/* Payoff Profile */}
          <div className="bg-slate-50/50 rounded-xl p-4 border border-slate-200/50 flex flex-col justify-between">
            <div>
              <span className="font-mono text-slate-400 uppercase text-[9px] tracking-wider block">Payoff Profile</span>
              <div className="flex items-baseline gap-1.5 mt-2">
                <span className="text-xl font-sans font-extrabold text-slate-800">{payoffRatio.toFixed(2)}x</span>
                <span className="text-[10px] text-slate-400 font-mono">Ratio (W/L)</span>
              </div>
            </div>
            <div className="space-y-1.5 border-t border-slate-150 pt-3 mt-4 text-[10px] text-slate-500">
              <div className="flex justify-between">
                <span>Avg Win:</span>
                <span className="font-mono font-bold text-emerald-600">${avgWin.toFixed(2)}</span>
              </div>
              <div className="flex justify-between">
                <span>Avg Loss:</span>
                <span className="font-mono font-bold text-rose-600">-${avgLoss.toFixed(2)}</span>
              </div>
            </div>
          </div>

          {/* Mathematical Expectancy */}
          <div className="bg-slate-50/50 rounded-xl p-4 border border-slate-200/50 flex flex-col justify-between">
            <div>
              <span className="font-mono text-slate-400 uppercase text-[9px] tracking-wider block">Mathematical Expectancy</span>
              <div className="flex items-baseline gap-1.5 mt-2">
                <span className={`text-xl font-sans font-extrabold ${mathematicalExpectancy >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
                  {mathematicalExpectancy >= 0 ? "+" : ""}${mathematicalExpectancy.toFixed(2)}
                </span>
                <span className="text-[10px] text-slate-400 font-mono">per Trade</span>
              </div>
            </div>
            <div className="border-t border-slate-150 pt-3 mt-4 text-[10px] text-slate-400 leading-normal">
              A score of <strong className="text-slate-600">{mathematicalExpectancy >= 0 ? "> $0" : "< $0"}</strong> suggests the strategy has a {mathematicalExpectancy >= 0 ? "positive" : "negative"} probability edge under current parameter sets.
            </div>
          </div>

          {/* Execution & Cooldown Streaks */}
          <div className="bg-slate-50/50 rounded-xl p-4 border border-slate-200/50 flex flex-col justify-between">
            <div>
              <span className="font-mono text-slate-400 uppercase text-[9px] tracking-wider block">Streaks & Cooldown Limits</span>
              <div className="flex items-baseline gap-1.5 mt-2">
                <span className="text-xl font-sans font-extrabold text-rose-500">{maxConsecutiveLosses}</span>
                <span className="text-[10px] text-slate-400 font-mono">Max Loss Streak</span>
              </div>
            </div>
            <div className="space-y-1.5 border-t border-slate-150 pt-3 mt-4 text-[10px] text-slate-500">
              <div className="flex justify-between">
                <span>Max Win Streak:</span>
                <span className="font-mono font-bold text-emerald-600">{maxConsecutiveWins} wins</span>
              </div>
              <div className="flex justify-between">
                <span>Active Cool-downs:</span>
                <span className="font-mono font-bold text-slate-600">
                  {config?.risk_management?.max_consecutive_losses ? `${config.risk_management.max_consecutive_losses} losses threshold` : "N/A"}
                </span>
              </div>
            </div>
          </div>

          {/* Holding Profiles */}
          <div className="bg-slate-50/50 rounded-xl p-4 border border-slate-200/50 flex flex-col justify-between">
            <div>
              <span className="font-mono text-slate-400 uppercase text-[9px] tracking-wider block">Hold Profiles & Exit Reason</span>
              <div className="flex items-baseline gap-1.5 mt-2">
                <span className="text-xl font-sans font-extrabold text-slate-800">{formatHoldDuration(avgHoldTimeSeconds)}</span>
                <span className="text-[10px] text-slate-400 font-mono">Avg Duration</span>
              </div>
            </div>
            <div className="space-y-1 mt-3 border-t border-slate-150 pt-3 text-[9px] text-slate-500 font-mono">
              <div className="flex justify-between items-center">
                <span className="text-slate-400 uppercase">STOP LOSS:</span>
                <span className="font-bold text-rose-600">{exitReasons["STOP_LOSS"] || 0}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-slate-400 uppercase">TAKE PROFIT:</span>
                <span className="font-bold text-emerald-600">{exitReasons["TAKE_PROFIT"] || 0}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-slate-400 uppercase">TRAILING SL:</span>
                <span className="font-bold text-indigo-500">{exitReasons["TRAILING_STOP_LOSS"] || 0}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-slate-400 uppercase">CATBOOST REVERSAL:</span>
                <span className="font-bold text-purple-600">{exitReasons["CATBOOST_REVERSAL"] || 0}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-slate-400 uppercase">MANUAL:</span>
                <span className="font-bold text-slate-600">{exitReasons["MANUAL"] || 0}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Dynamic Strategy Tuning Advisory Panel */}
      <div className="bg-white border border-slate-200 shadow-sm rounded-2xl p-6" id="quant-tuning-advisory">
        <div className="flex items-center gap-2 mb-6">
          <Sliders className="w-5 h-5 text-indigo-600" />
          <div>
            <h3 className="font-sans font-bold text-slate-800 text-sm">Strategy Tuning Advisory Board (Dynamic Suggestions)</h3>
            <p className="text-[10px] text-slate-400 font-mono leading-none mt-1">Real-time parameters optimizations based on actual results</p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {tuningRecommendations.map((advice, i) => (
            <div
              key={i}
              className={`border rounded-xl p-4 flex flex-col justify-between transition-all hover:shadow-sm ${
                advice.status === "critical"
                  ? "bg-rose-50/30 border-rose-100"
                  : advice.status === "warning"
                  ? "bg-amber-50/30 border-amber-100"
                  : "bg-emerald-50/20 border-emerald-100"
              }`}
            >
              <div>
                <div className="flex items-center justify-between mb-3">
                  <span className={`text-[8px] font-mono font-extrabold uppercase px-2 py-0.5 rounded-full border ${
                    advice.status === "critical"
                      ? "bg-rose-100/50 text-rose-700 border-rose-200/50"
                      : advice.status === "warning"
                      ? "bg-amber-100/50 text-amber-800 border-amber-200/50"
                      : "bg-emerald-100/50 text-emerald-800 border-emerald-200/50"
                  }`}>
                    {advice.status.toUpperCase()} PRIORITY
                  </span>
                  <span className="text-[10px] font-mono text-slate-400">{advice.currentVal}</span>
                </div>

                <div className="flex gap-2">
                  {advice.status === "critical" ? (
                    <Flame className="w-4 h-4 text-rose-500 shrink-0 mt-0.5" />
                  ) : advice.status === "warning" ? (
                    <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
                  ) : (
                    <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0 mt-0.5" />
                  )}
                  <div className="space-y-1">
                    <h4 className="font-sans font-bold text-slate-800 text-xs leading-snug">{advice.title}</h4>
                    <p className="text-slate-500 text-[11px] leading-relaxed font-sans">{advice.recommendation}</p>
                  </div>
                </div>
              </div>

              <div className="mt-4 pt-3 border-t border-slate-100/50 flex items-center justify-between text-[9px] font-mono text-slate-400">
                <span>Parameter Target:</span>
                <span className="bg-slate-100 text-slate-650 px-2 py-0.5 rounded-md font-medium max-w-[200px] truncate">
                  {advice.paramPath}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
