/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from "react";
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
  LineChart
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
} from "recharts";
import { DailyStats, MarketRegime, Trade, StrategyConfig } from "../types.js";
import { safeFormatDateTimeShort, safeFormatDateShort, safeFormatNumber } from "../utils/format";
import { getTradeTimingWindow } from "./TradeHistory.tsx";

interface AnalyticsPageProps {
  summary: any;
  equityCurve: { timestamp: string; balance: number }[];
  dailyStats: DailyStats[];
  regimeStats: Record<string, { trades: number; win_rate: number; pnl: number }>;
  trades: Trade[];
  config: StrategyConfig | null;
}

export default function AnalyticsPage({
  summary,
  equityCurve,
  dailyStats,
  regimeStats,
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
            <ResponsiveContainer width="100%" height="100%">
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
                <Area type="monotone" dataKey="balance" stroke="#4f46e5" strokeWidth={2} fillOpacity={1} fill="url(#colorBalance)" />
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
            <ResponsiveContainer width="100%" height="100%">
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
                <Bar dataKey="net_profit_usdt">
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
