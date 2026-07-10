/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from "react";
import { apiFetch } from "../utils/api.ts";
import { motion, AnimatePresence } from "motion/react";
import {
  Play,
  Settings,
  TrendingUp,
  Activity,
  History,
  CheckCircle2,
  AlertCircle,
  Percent,
  Sliders,
  DollarSign,
  Briefcase,
  Layers,
  ArrowRightLeft,
  ChevronLeft,
  ChevronRight,
  Sparkles,
} from "lucide-react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

interface BacktestPageProps {
  onRefresh: () => void;
  config: any;
}

export default function BacktestPage({ onRefresh, config }: BacktestPageProps) {
  // Backtest form state
  const [periodDays, setPeriodDays] = useState(7);
  const [regimeType, setRegimeType] = useState("MIXED");
  const [startingBalance, setStartingBalance] = useState(100000);
  const [riskPerTrade, setRiskPerTrade] = useState(0.5);
  const [stopLossAtr, setStopLossAtr] = useState(1.3);
  const [takeProfitRatio, setTakeProfitRatio] = useState(2.0);
  const [leverage, setLeverage] = useState(10);
  const [bypassedGates, setBypassedGates] = useState<string[]>([]);

  // Simulation running state
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [completed, setCompleted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Result state
  const [summary, setSummary] = useState<any>(null);
  const [trades, setTrades] = useState<any[]>([]);
  const [equityCurve, setEquityCurve] = useState<any[]>([]);
  const [simulationLogs, setSimulationLogs] = useState<string[]>([]);

  // UI view state
  const [activeSubTab, setActiveSubTab] = useState<"chart" | "trades" | "logs">("chart");
  const [tradePage, setTradePage] = useState(0);
  const tradesPerPage = 10;

  // Apply state
  const [applyingConfig, setApplyingConfig] = useState(false);
  const [appliedSuccess, setAppliedSuccess] = useState(false);

  const availableGates = [
    "CatBoost AI Prediction",
    "Market Regime Filter",
    "Trend Alignment & Strength (EMA/ADX)",
    "Relative Volume Confirmation",
    "Order Book Imbalance & Liquidity Depth Gate",
    "Sentiment Momentum Integration Gate",
    "Market Structure & Entry Confirmation Check",
    "Optimal Session Timing Window Check (IST)",
  ];

  const handleToggleGate = (gate: string) => {
    if (bypassedGates.includes(gate)) {
      setBypassedGates(bypassedGates.filter((g) => g !== gate));
    } else {
      setBypassedGates([...bypassedGates, gate]);
    }
  };

  const handleRunBacktest = async () => {
    setRunning(true);
    setCompleted(false);
    setProgress(10);
    setError(null);
    setSummary(null);

    // Simulate progress animation
    const progressInterval = setInterval(() => {
      setProgress((prev) => {
        if (prev >= 90) {
          clearInterval(progressInterval);
          return 90;
        }
        return prev + 15;
      });
    }, 300);

    try {
      const custom_config = {
        general: {
          ...config?.general,
          skipped_gates: bypassedGates,
        },
        risk_management: {
          ...config?.risk_management,
          risk_per_trade_pct: riskPerTrade,
          stop_loss_atr_multiplier: stopLossAtr,
          take_profit_ratio: takeProfitRatio,
          leverage: leverage,
        },
      };

      const res = await apiFetch("/api/trading/backtest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          period_days: periodDays,
          regime_type: regimeType,
          starting_balance: startingBalance,
          custom_config,
        }),
      });

      clearInterval(progressInterval);
      setProgress(100);

      if (res.ok) {
        const data = await res.json();
        setTimeout(() => {
          setSummary(data.summary);
          setTrades(data.trades);
          setEquityCurve(data.equityCurve);
          setSimulationLogs(data.logs);
          setRunning(false);
          setCompleted(true);
          setTradePage(0);
          onRefresh();
        }, 300);
      } else {
        const errText = await res.text();
        setError(errText || "Backtest failed. Please try again.");
        setRunning(false);
      }
    } catch (e: any) {
      clearInterval(progressInterval);
      setError(e.message || String(e));
      setRunning(false);
    }
  };

  const handleApplyConfig = async () => {
    setApplyingConfig(true);
    setAppliedSuccess(false);
    try {
      // Save risk settings to active config on the server
      const res = await apiFetch("/api/config/risk_management", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          risk_per_trade_pct: riskPerTrade,
          stop_loss_atr_multiplier: stopLossAtr,
          take_profit_ratio: takeProfitRatio,
          leverage: leverage,
        }),
      });

      // Save skipped gates to active config on the server
      const resGates = await apiFetch("/api/config/general", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          skipped_gates: bypassedGates,
        }),
      });

      if (res.ok && resGates.ok) {
        setAppliedSuccess(true);
        onRefresh();
        setTimeout(() => {
          setAppliedSuccess(false);
        }, 4000);
      } else {
        alert("Failed to hot deploy optimization parameters.");
      }
    } catch (e) {
      alert("Error hot deploying settings.");
    } finally {
      setApplyingConfig(false);
    }
  };

  const paginatedTrades = trades.slice(
    tradePage * tradesPerPage,
    (tradePage + 1) * tradesPerPage
  );

  const formatCurrency = (val: number) => {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).format(val);
  };

  return (
    <div className="space-y-8" id="backtester-view">
      {/* HEADER OVERVIEW */}
      <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4 border-b border-slate-200 pb-5">
        <div>
          <h2 className="text-xl font-bold text-slate-800 font-sans tracking-tight">AI Backtesting Simulator</h2>
          <p className="text-xs text-slate-400 font-mono uppercase tracking-wider mt-1">
            Walk-Forward PURGED Quant Tester &bull; Deterministic Strategy Verification
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono bg-indigo-50 border border-indigo-100 text-indigo-700 font-bold px-2.5 py-1 rounded-lg uppercase">
            Offline Safe Mode
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-8">
        {/* LEFT COLUMN: PARAMETER SETUP FORM */}
        <div className="xl:col-span-4 space-y-6">
          <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm space-y-6">
            <h3 className="text-xs font-bold text-slate-700 uppercase tracking-widest flex items-center gap-2">
              <Settings className="w-4 h-4 text-slate-400" />
              Simulator Constraints
            </h3>

            <div className="space-y-4">
              {/* Backtest Duration */}
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-slate-500">Backtest Duration</label>
                <select
                  value={periodDays}
                  onChange={(e) => setPeriodDays(parseInt(e.target.value, 10))}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 text-xs text-slate-800 outline-none focus:ring-1 focus:ring-indigo-500 font-sans cursor-pointer"
                >
                  <option value={1}>1 Day (1,440 Candlesticks)</option>
                  <option value={3}>3 Days (4,320 Candlesticks)</option>
                  <option value={7}>7 Days (10,080 Candlesticks)</option>
                  <option value={14}>14 Days (20,160 Candlesticks)</option>
                  <option value={30}>30 Days (43,200 Candlesticks)</option>
                </select>
              </div>

              {/* Market Regime */}
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-slate-500">Simulated Market Regime</label>
                <select
                  value={regimeType}
                  onChange={(e) => setRegimeType(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 text-xs text-slate-800 outline-none focus:ring-1 focus:ring-indigo-500 font-sans cursor-pointer"
                >
                  <option value="MIXED">Mixed (Full Cycle Transitions)</option>
                  <option value="STRONG_UPTREND">Strong Uptrend (Bullish Breakout Focus)</option>
                  <option value="STRONG_DOWNTREND">Strong Downtrend (Bearish Selloffs Focus)</option>
                  <option value="RANGE_BOUND">Ranging / Mean-Reverting</option>
                  <option value="HIGH_VOLATILITY">Extreme Volatility (Whiplash Test)</option>
                  <option value="LOW_VOLATILITY">Low Volatility (Tight Compression)</option>
                </select>
              </div>

              {/* Starting Capital */}
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-slate-500">Starting Balance (USDT)</label>
                <div className="relative">
                  <span className="absolute left-3 top-2.5 text-slate-400 text-xs">$</span>
                  <input
                    type="number"
                    value={startingBalance}
                    onChange={(e) => setStartingBalance(parseFloat(e.target.value) || 100000)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 pl-7 text-xs text-slate-800 outline-none focus:ring-1 focus:ring-indigo-500 font-mono"
                  />
                </div>
              </div>

              {/* Leverage */}
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-slate-500">Leverage Setting</label>
                  <select
                    value={leverage}
                    onChange={(e) => setLeverage(parseInt(e.target.value, 10))}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 text-xs text-slate-800 outline-none focus:ring-1 focus:ring-indigo-500 font-mono cursor-pointer"
                  >
                    <option value={5}>5x Leverage</option>
                    <option value={10}>10x Leverage</option>
                    <option value={20}>20x Leverage</option>
                    <option value={25}>25x Leverage</option>
                    <option value={50}>50x Leverage</option>
                  </select>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-slate-500">Risk Per Trade %</label>
                  <input
                    type="number"
                    step="0.1"
                    value={riskPerTrade}
                    onChange={(e) => setRiskPerTrade(parseFloat(e.target.value) || 0.5)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 text-xs text-slate-800 outline-none focus:ring-1 focus:ring-indigo-500 font-mono"
                  />
                </div>
              </div>

              {/* Stop Loss & Take Profit Settings */}
              <div className="grid grid-cols-2 gap-4 border-t border-slate-100 pt-3">
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-slate-500">SL (ATR Multiplier)</label>
                  <input
                    type="number"
                    step="0.1"
                    value={stopLossAtr}
                    onChange={(e) => setStopLossAtr(parseFloat(e.target.value) || 1.3)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 text-xs text-slate-800 outline-none focus:ring-1 focus:ring-indigo-500 font-mono"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-slate-500">TP (Risk Reward Ratio)</label>
                  <input
                    type="number"
                    step="0.1"
                    value={takeProfitRatio}
                    onChange={(e) => setTakeProfitRatio(parseFloat(e.target.value) || 2.0)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 text-xs text-slate-800 outline-none focus:ring-1 focus:ring-indigo-500 font-mono"
                  />
                </div>
              </div>
            </div>

            {/* Checkpoint Gates toggles */}
            <div className="border-t border-slate-100 pt-4 space-y-3">
              <div className="flex justify-between items-center">
                <label className="text-xs font-bold text-slate-700 uppercase tracking-wider">Gate Bypasses</label>
                <span className="text-[9px] font-mono bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded">Check to skip</span>
              </div>
              <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
                {availableGates.map((gate) => (
                  <label
                    key={gate}
                    className="flex items-start gap-2.5 p-2 rounded-lg hover:bg-slate-50 border border-slate-100 cursor-pointer text-left transition-colors"
                  >
                    <input
                      type="checkbox"
                      checked={bypassedGates.includes(gate)}
                      onChange={() => handleToggleGate(gate)}
                      className="rounded border-slate-300 bg-slate-50 text-indigo-600 focus:ring-0 mt-0.5"
                    />
                    <span className="text-[11px] text-slate-600 font-medium leading-normal">{gate}</span>
                  </label>
                ))}
              </div>
            </div>

            {/* Execute Button */}
            <div className="border-t border-slate-100 pt-4">
              <button
                disabled={running}
                onClick={handleRunBacktest}
                className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-semibold py-3 px-4 rounded-xl text-xs transition-all shadow-sm flex items-center justify-center gap-2 cursor-pointer disabled:bg-slate-300 disabled:cursor-not-allowed"
              >
                {running ? (
                  <>
                    <Activity className="w-4 h-4 animate-spin text-white" />
                    Simulating walk-forward ({progress}%)...
                  </>
                ) : (
                  <>
                    <Play className="w-4 h-4 text-indigo-200 fill-indigo-200" />
                    Start Deterministic Backtest
                  </>
                )}
              </button>
            </div>
          </div>
        </div>

        {/* RIGHT COLUMN: GRAPHS AND METRICS */}
        <div className="xl:col-span-8 space-y-6">
          {/* Default view when no simulation was run yet */}
          {!summary && !running && !error && (
            <div className="bg-white border border-slate-200 rounded-2xl p-12 text-center shadow-sm h-full flex flex-col justify-center items-center space-y-4">
              <div className="p-4 bg-indigo-50 text-indigo-500 rounded-full">
                <Sliders className="w-8 h-8" />
              </div>
              <div className="max-w-md">
                <h4 className="text-base font-bold text-slate-700 tracking-tight">Ready to Backtest</h4>
                <p className="text-xs text-slate-400 leading-relaxed mt-2">
                  Configure duration, leverage, ATR target variables, and run a high-fidelity mock-order backtest simulation. The bot will walk-forward candidate candles minute-by-minute evaluating your checkpoint configurations exactly.
                </p>
              </div>
            </div>
          )}

          {/* Running loader */}
          {running && (
            <div className="bg-white border border-slate-200 rounded-2xl p-12 text-center shadow-sm h-full flex flex-col justify-center items-center space-y-6">
              <div className="relative flex items-center justify-center">
                <Activity className="w-12 h-12 text-indigo-600 animate-pulse" />
              </div>
              <div className="max-w-md w-full space-y-2">
                <h4 className="text-base font-bold text-slate-700 tracking-tight">Executing Backtest Simulation...</h4>
                <p className="text-xs text-slate-400">Walking-forward {periodDays} days of 1-minute historical ticks in {regimeType} regime.</p>
                <div className="w-full bg-slate-100 rounded-full h-1.5 mt-4">
                  <div className="bg-indigo-600 h-1.5 rounded-full transition-all duration-300" style={{ width: `${progress}%` }} />
                </div>
              </div>
            </div>
          )}

          {/* Error display */}
          {error && (
            <div className="bg-white border border-slate-200 rounded-2xl p-8 shadow-sm h-full flex flex-col justify-center items-center text-center space-y-4">
              <div className="p-3 bg-rose-50 text-rose-600 rounded-full">
                <AlertCircle className="w-8 h-8" />
              </div>
              <h4 className="text-base font-bold text-slate-700">Simulation Failed</h4>
              <p className="text-xs text-rose-600 font-mono bg-rose-50/50 p-3 rounded-lg max-w-lg border border-rose-100">{error}</p>
              <button
                onClick={() => setError(null)}
                className="px-4 py-2 bg-slate-100 hover:bg-slate-200 rounded-lg text-xs font-medium cursor-pointer"
              >
                Clear Error
              </button>
            </div>
          )}

          {/* SIMULATION COMPLETED RESULT VIEW */}
          {summary && completed && (
            <div className="space-y-6">
              {/* KEY STATS ROW */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                {/* Net profit */}
                <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
                  <div className="text-[10px] font-mono text-slate-400 uppercase tracking-widest">Net Profit P&L</div>
                  <div className={`text-lg font-mono font-bold mt-1 ${summary.net_profit_usdt >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
                    {summary.net_profit_usdt >= 0 ? "+" : ""}{formatCurrency(summary.net_profit_usdt)}
                  </div>
                  <div className="text-[9px] text-slate-400 mt-0.5">
                    ({((summary.net_profit_usdt / summary.starting_balance) * 100).toFixed(2)}% return)
                  </div>
                </div>

                {/* Win Rate */}
                <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
                  <div className="text-[10px] font-mono text-slate-400 uppercase tracking-widest">Win Rate</div>
                  <div className="text-lg font-mono font-bold text-slate-800 mt-1">{summary.win_rate}%</div>
                  <div className="text-[9px] text-slate-400 mt-0.5">
                    {summary.wins} wins / {summary.losses} losses
                  </div>
                </div>

                {/* Profit Factor */}
                <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
                  <div className="text-[10px] font-mono text-slate-400 uppercase tracking-widest">Profit Factor</div>
                  <div className="text-lg font-mono font-bold text-indigo-600 mt-1">{summary.profit_factor}</div>
                  <div className="text-[9px] text-slate-400 mt-0.5">
                    Gross Wins / Gross Losses
                  </div>
                </div>

                {/* Max Drawdown */}
                <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
                  <div className="text-[10px] font-mono text-slate-400 uppercase tracking-widest">Max Drawdown</div>
                  <div className="text-lg font-mono font-bold text-rose-500 mt-1">
                    -{formatCurrency(summary.max_drawdown_usdt)}
                  </div>
                  <div className="text-[9px] text-slate-400 mt-0.5">
                    Peak-to-trough drop
                  </div>
                </div>
              </div>

              {/* SECONDARY MINI STATS ROW */}
              <div className="bg-white border border-slate-200 rounded-xl p-4 grid grid-cols-2 md:grid-cols-4 gap-4 shadow-sm">
                <div className="text-center md:border-r border-slate-100 last:border-none">
                  <span className="text-[9px] font-mono text-slate-400 uppercase block">Total Trades</span>
                  <span className="font-mono text-sm font-bold text-slate-700 block mt-0.5">{summary.total_trades}</span>
                </div>
                <div className="text-center md:border-r border-slate-100 last:border-none">
                  <span className="text-[9px] font-mono text-slate-400 uppercase block">Total Fees Paid</span>
                  <span className="font-mono text-sm font-bold text-slate-700 block mt-0.5">{formatCurrency(summary.fees_paid_usdt)}</span>
                </div>
                <div className="text-center md:border-r border-slate-100 last:border-none">
                  <span className="text-[9px] font-mono text-slate-400 uppercase block">Sharpe Ratio</span>
                  <span className="font-mono text-sm font-bold text-indigo-600 block mt-0.5">{summary.sharpe_ratio}</span>
                </div>
                <div className="text-center last:border-none">
                  <span className="text-[9px] font-mono text-slate-400 uppercase block">Ending Balance</span>
                  <span className="font-mono text-sm font-bold text-slate-700 block mt-0.5">{formatCurrency(summary.ending_balance)}</span>
                </div>
              </div>

              {/* GRAPH & HISTORIC TRADES PANEL CANVAS */}
              <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden">
                <div className="border-b border-slate-100 px-6 py-4 flex items-center justify-between">
                  <div className="flex gap-2 bg-slate-100 p-1 rounded-lg">
                    <button
                      onClick={() => setActiveSubTab("chart")}
                      className={`px-3 py-1.5 text-[11px] font-medium rounded-md cursor-pointer transition-colors ${
                        activeSubTab === "chart" ? "bg-white text-indigo-600 shadow-sm" : "text-slate-500 hover:text-slate-700"
                      }`}
                    >
                      Equity Curve
                    </button>
                    <button
                      onClick={() => setActiveSubTab("trades")}
                      className={`px-3 py-1.5 text-[11px] font-medium rounded-md cursor-pointer transition-colors ${
                        activeSubTab === "trades" ? "bg-white text-indigo-600 shadow-sm" : "text-slate-500 hover:text-slate-700"
                      }`}
                    >
                      Simulated Trades ({trades.length})
                    </button>
                    <button
                      onClick={() => setActiveSubTab("logs")}
                      className={`px-3 py-1.5 text-[11px] font-medium rounded-md cursor-pointer transition-colors ${
                        activeSubTab === "logs" ? "bg-white text-indigo-600 shadow-sm" : "text-slate-500 hover:text-slate-700"
                      }`}
                    >
                      Simulation Logs
                    </button>
                  </div>

                  {/* Hot Deploy Optimization Parameters Button */}
                  <div className="relative">
                    <button
                      disabled={applyingConfig}
                      onClick={handleApplyConfig}
                      className="bg-slate-900 hover:bg-slate-800 text-white text-[10px] font-mono uppercase tracking-wider px-3.5 py-1.8 rounded-lg flex items-center gap-1.5 cursor-pointer disabled:bg-slate-300 transition-all shadow-sm"
                    >
                      {applyingConfig ? (
                        "Hot deploying..."
                      ) : appliedSuccess ? (
                        <span className="flex items-center gap-1 text-emerald-400 font-bold">
                          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" /> HOT DEPLOYED!
                        </span>
                      ) : (
                        <>
                          <Sparkles className="w-3.5 h-3.5 text-amber-300" /> Apply optimization parameters
                        </>
                      )}
                    </button>
                  </div>
                </div>

                <div className="p-6">
                  {/* TAB 1: CHART */}
                  {activeSubTab === "chart" && (
                    <div className="space-y-4">
                      <div className="h-72 w-full">
                        <ResponsiveContainer width="100%" height="100%">
                          <AreaChart data={equityCurve}>
                            <defs>
                              <linearGradient id="backtestEquityGlow" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="5%" stopColor="#6366f1" stopOpacity={0.18} />
                                <stop offset="95%" stopColor="#6366f1" stopOpacity={0.0} />
                              </linearGradient>
                            </defs>
                            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                            <XAxis
                              dataKey="time"
                              tickLine={false}
                              axisLine={false}
                              stroke="#94a3b8"
                              fontSize={9}
                              tickMargin={6}
                            />
                            <YAxis
                              tickLine={false}
                              axisLine={false}
                              stroke="#94a3b8"
                              fontSize={9}
                              tickFormatter={(val) => `$${(val / 1000).toFixed(0)}k`}
                              domain={["dataMin - 1000", "dataMax + 1000"]}
                            />
                            <Tooltip
                              contentStyle={{
                                background: "#0f172a",
                                border: "none",
                                borderRadius: "8px",
                                padding: "8px 12px",
                              }}
                              labelStyle={{ fontSize: "10px", color: "#94a3b8", fontFamily: "monospace" }}
                              itemStyle={{ fontSize: "11px", color: "#38bdf8", fontWeight: "bold" }}
                              formatter={(value: any) => [`$${parseFloat(value).toFixed(2)} USDT`, "Portfolio Equity"]}
                            />
                            <Area
                              type="monotone"
                              dataKey="balance"
                              stroke="#6366f1"
                              strokeWidth={2}
                              fillOpacity={1}
                              fill="url(#backtestEquityGlow)"
                            />
                          </AreaChart>
                        </ResponsiveContainer>
                      </div>
                      <p className="text-[10px] text-slate-400 font-mono text-center">
                        Equity growth simulation showing net cumulative returns over {periodDays} days. High watermarks determine drawdowns.
                      </p>
                    </div>
                  )}

                  {/* TAB 2: TRADES */}
                  {activeSubTab === "trades" && (
                    <div className="space-y-4">
                      {trades.length === 0 ? (
                        <div className="text-center py-12 text-slate-400 text-xs">
                          No trades were opened during this backtest simulation. Try relaxing some gates.
                        </div>
                      ) : (
                        <div className="space-y-4">
                          <div className="overflow-x-auto">
                            <table className="w-full text-left border-collapse">
                              <thead>
                                <tr className="border-b border-slate-100 text-[10px] font-mono text-slate-400 uppercase tracking-widest bg-slate-50/50">
                                  <th className="py-2.5 px-3">Direction</th>
                                  <th className="py-2.5 px-3">Entry Price</th>
                                  <th className="py-2.5 px-3">Exit Price</th>
                                  <th className="py-2.5 px-3">Net PnL</th>
                                  <th className="py-2.5 px-3">Exit Reason</th>
                                  <th className="py-2.5 px-3">Hold Time</th>
                                  <th className="py-2.5 px-3">Date/Time</th>
                                </tr>
                              </thead>
                              <tbody className="text-xs text-slate-600 font-mono">
                                {paginatedTrades.map((t: any) => (
                                  <tr key={t.id} className="border-b border-slate-50 hover:bg-slate-50/60">
                                    <td className="py-2.5 px-3">
                                      <span
                                        className={`px-1.5 py-0.5 rounded font-bold text-[9px] uppercase ${
                                          t.direction === "LONG"
                                            ? "bg-emerald-50 text-emerald-700 border border-emerald-100"
                                            : "bg-rose-50 text-rose-700 border border-rose-100"
                                        }`}
                                      >
                                        {t.direction}
                                      </span>
                                    </td>
                                    <td className="py-2.5 px-3">${t.entry_price.toFixed(2)}</td>
                                    <td className="py-2.5 px-3">${t.exit_price ? t.exit_price.toFixed(2) : "N/A"}</td>
                                    <td className={`py-2.5 px-3 font-bold ${t.pnl_usdt >= 0 ? "text-emerald-600" : "text-rose-500"}`}>
                                      {t.pnl_usdt >= 0 ? "+" : ""}${t.pnl_usdt.toFixed(2)} ({t.pnl_pct >= 0 ? "+" : ""}{t.pnl_pct}%)
                                    </td>
                                    <td className="py-2.5 px-3 text-[10px] text-slate-500 font-sans">{t.exit_reason}</td>
                                    <td className="py-2.5 px-3 text-slate-500 font-sans">
                                      {Math.round(t.hold_duration_seconds / 60)} min
                                    </td>
                                    <td className="py-2.5 px-3 text-slate-400 text-[10px]">
                                      {t.entry_timestamp.replace("T", " ").slice(0, 16)}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>

                          {/* Pagination controls */}
                          {trades.length > tradesPerPage && (
                            <div className="flex items-center justify-between border-t border-slate-100 pt-3 text-[11px] text-slate-400 font-mono">
                              <div>
                                Showing {tradePage * tradesPerPage + 1} to{" "}
                                {Math.min((tradePage + 1) * tradesPerPage, trades.length)} of{" "}
                                {trades.length} simulated trades
                              </div>
                              <div className="flex items-center gap-1.5">
                                <button
                                  disabled={tradePage === 0}
                                  onClick={() => setTradePage(tradePage - 1)}
                                  className="p-1.5 rounded border border-slate-200 hover:bg-slate-50 disabled:opacity-40 disabled:hover:bg-transparent cursor-pointer"
                                >
                                  <ChevronLeft className="w-4 h-4" />
                                </button>
                                <span className="font-bold">Page {tradePage + 1}</span>
                                <button
                                  disabled={(tradePage + 1) * tradesPerPage >= trades.length}
                                  onClick={() => setTradePage(tradePage + 1)}
                                  className="p-1.5 rounded border border-slate-200 hover:bg-slate-50 disabled:opacity-40 disabled:hover:bg-transparent cursor-pointer"
                                >
                                  <ChevronRight className="w-4 h-4" />
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {/* TAB 3: LOGS */}
                  {activeSubTab === "logs" && (
                    <div className="space-y-2">
                      <div className="bg-slate-900 text-slate-300 p-4 rounded-xl font-mono text-[10px] leading-relaxed space-y-1.5 overflow-y-auto max-h-96 shadow-inner text-left">
                        {simulationLogs.map((log, lidx) => (
                          <div key={lidx} className="border-l-2 border-indigo-500 pl-2.5">
                            {log}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
