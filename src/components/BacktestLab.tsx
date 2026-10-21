/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from "react";
import {
  FlaskConical,
  Play,
  RotateCcw,
  TrendingUp,
  TrendingDown,
  ShieldCheck,
  Clock,
  Layers,
  Activity,
  CheckCircle2,
  XCircle,
  Download,
  AlertTriangle,
  Info,
  Calendar,
  Zap,
  Trophy,
  Sparkles,
  ChevronRight,
  X,
  Grid,
  Search,
  RefreshCw,
  Target,
} from "lucide-react";
import { apiFetch } from "../utils/api.ts";
import {
  BacktestResult,
  BacktestSetupOption,
  BacktestTrade,
  RegimePerformance,
  SessionPerformance,
  WeekdayPerformance,
  BacktestRankResult,
  DEFAULT_AVAILABLE_SETUPS,
} from "../backtester/types.ts";

export default function BacktestLab({
  onNavigateToOptimizer,
}: {
  onNavigateToOptimizer?: () => void;
} = {}) {
  const [setups, setSetups] = useState<BacktestSetupOption[]>(DEFAULT_AVAILABLE_SETUPS);
  const [selectedSetup, setSelectedSetup] = useState<string>("all");
  const [days, setDays] = useState<number>(3);
  const [isolationMode, setIsolationMode] = useState<boolean>(true);
  const [excludeWeekends, setExcludeWeekends] = useState<boolean>(true);
  const [sessionFilter, setSessionFilter] = useState<string>("all");
  const [respectSessionMatrix, setRespectSessionMatrix] = useState<boolean>(true);
  const [respectUnifiedConfluence, setRespectUnifiedConfluence] = useState<boolean>(true);
  const [loading, setLoading] = useState<boolean>(false);
  const [elapsedSeconds, setElapsedSeconds] = useState<number>(0);
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filterDirection, setFilterDirection] = useState<"ALL" | "LONG" | "SHORT">("ALL");
  const [filterOutcome, setFilterOutcome] = useState<"ALL" | "WIN" | "LOSS">("ALL");
  const [filterWeekday, setFilterWeekday] = useState<string>("ALL");
  const [bufferStatus, setBufferStatus] = useState<any>(null);
  const [isSyncingBuffer, setIsSyncingBuffer] = useState<boolean>(false);
  const [rankResult, setRankResult] = useState<BacktestRankResult | null>(null);
  const [rankingLoading, setRankingLoading] = useState<boolean>(false);
  const [showRankModal, setShowRankModal] = useState<boolean>(false);
  const [showSetupModal, setShowSetupModal] = useState<boolean>(false);
  const [setupCategoryFilter, setSetupCategoryFilter] = useState<string>("ALL");
  const [setupSearchQuery, setSetupSearchQuery] = useState<string>("");

  useEffect(() => {
    loadSetups();
    loadBufferStatus();
    const interval = setInterval(loadBufferStatus, 15000);
    return () => clearInterval(interval);
  }, []);

  const loadBufferStatus = async () => {
    try {
      const res = await apiFetch("/api/backtest/buffer-status");
      if (res.ok) {
        const data = await res.json();
        setBufferStatus(data);
        if (data.excludeWeekends !== undefined) {
          setExcludeWeekends(data.excludeWeekends);
        }
      }
    } catch (e) {
      console.warn("Could not load buffer status:", e);
    }
  };

  const handleManualSync = async () => {
    setIsSyncingBuffer(true);
    try {
      const res = await apiFetch("/api/backtest/buffer-sync", { method: "POST" });
      if (res.ok) {
        const data = await res.json();
        if (data.status) setBufferStatus(data.status);
      }
    } catch (e) {
      console.warn("Failed to manually sync buffer:", e);
    } finally {
      setIsSyncingBuffer(false);
    }
  };

  const handleToggleWeekendExclusion = async () => {
    const nextVal = !excludeWeekends;
    setExcludeWeekends(nextVal);
    try {
      const res = await apiFetch("/api/backtest/toggle-weekend-exclusion", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ exclude: nextVal }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.status) setBufferStatus(data.status);
      }
    } catch (e) {
      console.warn("Error toggling weekend exclusion:", e);
    }
  };

  useEffect(() => {
    let timer: NodeJS.Timeout;
    if (loading) {
      setElapsedSeconds(0);
      timer = setInterval(() => {
        setElapsedSeconds((s) => s + 1);
      }, 1000);
    }
    return () => clearInterval(timer);
  }, [loading]);

  const loadSetups = async () => {
    try {
      const res = await apiFetch("/api/backtest/setups");
      if (res.ok) {
        const data = await res.json();
        if (data && Array.isArray(data.setups) && data.setups.length > 0) {
          setSetups(data.setups);
        }
      }
    } catch (e) {
      console.warn("Could not load backtest setups from API, retaining default catalog:", e);
    }
  };

  const handleRunBacktest = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch("/api/backtest/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          setupId: selectedSetup,
          days,
          symbol: "BTCUSDT",
          initialBalance: 10000,
          positionSizeBtc: 0.01,
          leverage: 20,
          simulateFees: true,
          isolationMode,
          excludeWeekends,
          sessionFilter,
          respectSessionMatrix,
          respectUnifiedConfluenceMatrix: respectUnifiedConfluence,
        }),
      });

      if (res.ok) {
        const data = await res.json();
        if (data && data.success && data.result) {
          setResult(data.result);
        } else {
          setError(data?.error || "Backtest failed to execute.");
        }
      } else {
        const errData = await res.json().catch(() => ({}));
        setError(errData?.error || `Server error: ${res.status}`);
      }
    } catch (err: any) {
      setError(err?.message || "Failed to communicate with backtest API.");
    } finally {
      setLoading(false);
    }
  };

  const handleRunRankAll = async () => {
    setRankingLoading(true);
    setError(null);
    try {
      const res = await apiFetch("/api/backtest/rank-all", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          days,
          symbol: "BTCUSDT",
          initialBalance: 10000,
          positionSizeBtc: 0.01,
          leverage: 20,
          simulateFees: true,
          isolationMode,
          excludeWeekends,
        }),
      });

      if (res.ok) {
        const data = await res.json();
        if (data && data.success && data.result) {
          setRankResult(data.result);
          setShowRankModal(true);
        } else {
          setError(data?.error || "Multi-setup ranking backtest failed.");
        }
      } else {
        const errData = await res.json().catch(() => ({}));
        setError(errData?.error || `Server error: ${res.status}`);
      }
    } catch (err: any) {
      setError(err?.message || "Failed to communicate with backtest ranking API.");
    } finally {
      setRankingLoading(false);
    }
  };

  const exportCsv = () => {
    if (!result || !result.trades || result.trades.length === 0) return;
    const headers = [
      "Timestamp (UTC)",
      "Direction",
      "Setup Triggered",
      "Entry Price ($)",
      "Exit Price ($)",
      "Target SL ($)",
      "Target TP ($)",
      "Entry ATR ($)",
      "Max Favorable Excursion ($)",
      "MFE (% ATR)",
      "Max Adverse Excursion ($)",
      "MAE (% ATR)",
      "Exit Reason",
      "Hold Duration (Sec)",
      "Fees ($)",
      "Net PnL ($)",
      "PnL (%)",
      "Market Regime",
      "Trading Session",
    ];

    const rows = result.trades.map((t) => [
      t.timestamp,
      t.direction,
      t.setupName,
      t.entryPrice.toFixed(2),
      t.exitPrice.toFixed(2),
      t.stopLoss.toFixed(2),
      t.takeProfit.toFixed(2),
      t.entryAtr.toFixed(2),
      t.maxFavorableExcursionUsd.toFixed(2),
      (t.maxFavorableExcursionAtr * 100).toFixed(1),
      t.maxAdverseExcursionUsd.toFixed(2),
      (t.maxAdverseExcursionAtr * 100).toFixed(1),
      t.exitReason,
      t.holdDurationSeconds,
      t.feesUsd.toFixed(4),
      t.netPnlUsd.toFixed(2),
      t.pnlPercent.toFixed(2),
      t.marketRegime,
      t.sessionName || "Normal Hours",
    ]);

    const csvContent =
      "data:text/csv;charset=utf-8," +
      [headers.join(","), ...rows.map((e) => e.join(","))].join("\n");
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute(
      "download",
      `backtest_${result.setupId}_${result.days}d_${new Date().toISOString().slice(0, 10)}.csv`
    );
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const filteredTrades = result
    ? result.trades.filter((t) => {
        if (filterDirection === "LONG" && t.direction !== "LONG") return false;
        if (filterDirection === "SHORT" && t.direction !== "SHORT") return false;
        if (filterOutcome === "WIN" && t.netPnlUsd <= 0) return false;
        if (filterOutcome === "LOSS" && t.netPnlUsd > 0) return false;
        if (filterWeekday !== "ALL") {
          const tDay = (t.dayId || "").toLowerCase();
          if (tDay !== filterWeekday.toLowerCase()) {
            const d = new Date(t.entryTimestampMs || Date.parse(t.timestamp));
            const utcMs = d.getTime() + d.getTimezoneOffset() * 60000;
            const istDate = new Date(utcMs + 5.5 * 3600000);
            const dayNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
            if (dayNames[istDate.getDay()] !== filterWeekday.toLowerCase()) return false;
          }
        }
        return true;
      })
    : [];

  return (
    <div className="space-y-6">
      {/* Header Banner */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-6 shadow-xl relative overflow-hidden backdrop-blur-md">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <span className="p-2 rounded-lg bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
                <FlaskConical className="w-5 h-5" />
              </span>
              <h1 className="text-xl font-bold text-white tracking-tight">
                Isolated Setup Backtest Lab
              </h1>
              <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 flex items-center gap-1">
                <ShieldCheck className="w-3.5 h-3.5" /> 100% De-coupled from Live Engine
              </span>
              <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 flex items-center gap-1">
                <ShieldCheck className="w-3.5 h-3.5" /> Dynamic Regime Gating Matrix: STRICT
              </span>
            </div>
            <p className="text-sm text-slate-400 max-w-3xl">
              Empirically backtest any individual setup in total isolation against real Binance 1m klines,
              order flow delta, and volume. Runs without affecting active paper trades, live WebSockets, or engine state.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={handleRunRankAll}
              disabled={rankingLoading || loading}
              className={`px-4 py-2.5 rounded-lg text-sm font-semibold flex items-center gap-2 transition-all shadow-lg ${
                rankingLoading
                  ? "bg-slate-800 text-slate-400 cursor-not-allowed border border-slate-700"
                  : "bg-gradient-to-r from-amber-600 to-amber-500 hover:from-amber-500 hover:to-amber-400 text-slate-950 font-bold shadow-amber-600/20 hover:scale-[1.02] active:scale-[0.98]"
              }`}
            >
              {rankingLoading ? (
                <>
                  <RotateCcw className="w-4 h-4 animate-spin text-amber-950" />
                  Ranking All Setups...
                </>
              ) : (
                <>
                  <Trophy className="w-4 h-4 text-slate-950" />
                  Rank All Setups by Win Rate
                </>
              )}
            </button>

            {onNavigateToOptimizer && (
              <button
                type="button"
                onClick={onNavigateToOptimizer}
                className="px-4 py-2.5 rounded-lg text-sm font-semibold flex items-center gap-2 bg-gradient-to-r from-emerald-600 to-teal-500 hover:from-emerald-500 hover:to-teal-400 text-white shadow-lg shadow-emerald-950/20 transition-all hover:scale-[1.02] active:scale-[0.98] cursor-pointer"
              >
                <Target className="w-4 h-4" /> Find WR &gt; 60% Matrix
              </button>
            )}

            <button
              onClick={handleRunBacktest}
              disabled={loading || rankingLoading}
              className={`px-5 py-2.5 rounded-lg text-sm font-semibold flex items-center gap-2 transition-all shadow-lg ${
                loading
                  ? "bg-slate-800 text-slate-400 cursor-not-allowed border border-slate-700"
                  : "bg-indigo-600 hover:bg-indigo-500 text-white shadow-indigo-600/30 hover:scale-[1.02] active:scale-[0.98]"
              }`}
            >
              {loading ? (
                <>
                  <RotateCcw className="w-4 h-4 animate-spin text-indigo-400" />
                  Running Simulation ({elapsedSeconds}s)...
                </>
              ) : (
                <>
                  <Play className="w-4 h-4 fill-white" />
                  Run Isolated Backtest
                </>
              )}
            </button>
          </div>
        </div>

        {/* 7-Day Continuous Rolling Buffer Status Card */}
        <div className="mt-5 p-4 rounded-xl bg-slate-950/70 border border-slate-800/90 shadow-inner flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
          <div className="flex items-start md:items-center gap-3">
            <div className="p-2 rounded-lg bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 shrink-0 mt-0.5 md:mt-0">
              <Activity className="w-4 h-4 animate-pulse" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold text-white uppercase tracking-wider">
                  Binance 30-Day Rolling Historical Buffer
                </span>
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
                </span>
                <span className="text-[10px] font-mono text-emerald-400 font-semibold">
                  STREAMING & SYNCED
                </span>
              </div>
              <div className="text-xs text-slate-400 mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                <span>
                  Buffered:{" "}
                  <strong className="text-white font-mono">
                    {bufferStatus?.totalCandles ? bufferStatus.totalCandles.toLocaleString() : "43,200"}
                  </strong>{" "}
                  1m candles ({bufferStatus?.weekdaysCovered || "30.0"} weekdays)
                </span>
                <span className="text-slate-600">•</span>
                <span>
                  Memory Footprint:{" "}
                  <strong className="text-emerald-400 font-mono">
                    ~{bufferStatus?.memoryUsageMb || "6.2"} MB RAM
                  </strong>{" "}
                  (Zero Engine Load)
                </span>
                <span className="text-slate-600">•</span>
                <span>
                  Coverage:{" "}
                  <span className="font-mono text-slate-300">
                    {bufferStatus?.oldestCandleTime
                      ? bufferStatus.oldestCandleTime.slice(0, 10)
                      : "Past 30+ Days"}{" "}
                    to{" "}
                    {bufferStatus?.newestCandleTime
                      ? bufferStatus.newestCandleTime.slice(0, 16).replace("T", " ") + " UTC"
                      : "Now"}
                  </span>
                </span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 self-end md:self-auto">
            {/* Weekend Exclusion Toggle */}
            <button
              onClick={handleToggleWeekendExclusion}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium border flex items-center gap-1.5 transition-all cursor-pointer ${
                excludeWeekends
                  ? "bg-indigo-950/40 border-indigo-500/50 text-indigo-300 hover:bg-indigo-900/40"
                  : "bg-slate-900 border-slate-700 text-slate-400 hover:text-white"
              }`}
              title="Excludes Saturday 00:00 UTC to Sunday 23:59 UTC"
            >
              <span className={`w-2 h-2 rounded-full ${excludeWeekends ? "bg-indigo-400" : "bg-slate-500"}`} />
              Exclude Weekends: <strong className="font-bold">{excludeWeekends ? "ON" : "OFF"}</strong>
            </button>

            {/* Manual Sync Button */}
            <button
              onClick={handleManualSync}
              disabled={isSyncingBuffer}
              className="p-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-slate-300 border border-slate-700 text-xs flex items-center gap-1 transition-colors cursor-pointer"
              title="Sync latest 1m Binance candles to buffer"
            >
              <RotateCcw className={`w-3.5 h-3.5 ${isSyncingBuffer ? "animate-spin text-indigo-400" : ""}`} />
            </button>
          </div>
        </div>

        {/* Configuration Bar */}
        <div className="mt-6 pt-5 border-t border-slate-800/80 grid grid-cols-1 md:grid-cols-4 gap-4">
          {/* Target Setup */}
          <div className="space-y-2 md:col-span-2">
            <div className="flex items-center justify-between">
              <label className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
                <Layers className="w-3.5 h-3.5 text-indigo-400" />
                <span>Target Tactical Setup</span>
                <span className="px-1.5 py-0.5 rounded text-[10px] font-mono font-bold bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
                  {setups.length} Available
                </span>
              </label>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setShowSetupModal(true)}
                  className="inline-flex items-center gap-1 text-[11px] font-mono text-indigo-400 hover:text-indigo-300 bg-indigo-950/40 hover:bg-indigo-900/50 border border-indigo-500/40 rounded px-2 py-0.5 transition-colors cursor-pointer"
                  title="Browse full catalog of tactical setups"
                >
                  <Grid className="w-3 h-3" />
                  <span>Browse Catalog</span>
                </button>
                <button
                  type="button"
                  onClick={loadSetups}
                  className="p-1 rounded text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors cursor-pointer"
                  title="Refresh setups from engine"
                >
                  <RefreshCw className="w-3 h-3" />
                </button>
              </div>
            </div>

            {/* Quick Selection Dropdown with optgroups */}
            <select
              value={selectedSetup}
              onChange={(e) => setSelectedSetup(e.target.value)}
              disabled={loading}
              className="w-full bg-slate-950 border border-slate-700/80 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500 transition-colors font-medium cursor-pointer"
            >
              <optgroup label="Collective / Global Multi-Regime" className="bg-slate-900 text-slate-400 font-mono text-xs">
                {setups.filter((s) => s.id === "all").map((s) => (
                  <option key={s.id} value={s.id} className="bg-slate-950 text-indigo-300 font-bold py-1">
                    🌟 {s.name}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Trend Continuation Setups" className="bg-slate-900 text-slate-400 font-mono text-xs">
                {setups.filter((s) => s.category === "trend" && s.id !== "all").map((s) => (
                  <option key={s.id} value={s.id} className="bg-slate-950 text-white py-1">
                    📈 {s.name}
                  </option>
                ))}
              </optgroup>
              <optgroup label="SMC & Liquidity Sweep Reversals" className="bg-slate-900 text-slate-400 font-mono text-xs">
                {setups.filter((s) => s.category === "reversal").map((s) => (
                  <option key={s.id} value={s.id} className="bg-slate-950 text-white py-1">
                    🎯 {s.name}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Order Flow & Microstructure" className="bg-slate-900 text-slate-400 font-mono text-xs">
                {setups.filter((s) => s.category === "orderflow").map((s) => (
                  <option key={s.id} value={s.id} className="bg-slate-950 text-white py-1">
                    ⚡ {s.name}
                  </option>
                ))}
              </optgroup>
            </select>

            {/* Active Setup Description Pill */}
            {(() => {
              const current = setups.find((s) => s.id === selectedSetup) || setups[0];
              if (!current) return null;
              return (
                <div className="p-2 rounded-lg bg-slate-950/70 border border-slate-800 text-[11px] text-slate-300 leading-relaxed flex items-start gap-2">
                  <span className="px-1.5 py-0.5 rounded text-[9px] font-mono font-bold uppercase shrink-0 bg-slate-800 text-slate-300 border border-slate-700 mt-0.5">
                    {current.category}
                  </span>
                  <div className="flex-1">
                    <strong className="text-white font-medium">{current.name}: </strong>
                    <span className="text-slate-400">{current.description}</span>
                  </div>
                </div>
              );
            })()}

            {/* Quick Horizontal Chips for Fast Switching */}
            <div className="flex items-center gap-1.5 overflow-x-auto pb-1 pt-0.5 no-scrollbar">
              <span className="text-[10px] font-mono text-slate-500 uppercase shrink-0">Quick:</span>
              {[
                { id: "all", label: "All Combined" },
                { id: "setup_1_pullback_retest", label: "Setup 1" },
                { id: "setup_2_dynamic_ema_pushback", label: "Setup 2" },
                { id: "setup_3_liquidity_sweep", label: "Setup 3" },
                { id: "setup_4_fvg_retest", label: "Setup 4" },
                { id: "setup_12_cvd_absorption", label: "Setup 12" },
                { id: "setup_15_trendline_bounce", label: "Setup 15" },
              ].map((chip) => (
                <button
                  key={chip.id}
                  type="button"
                  onClick={() => setSelectedSetup(chip.id)}
                  className={`px-2 py-0.5 rounded text-[10px] font-mono whitespace-nowrap transition-colors cursor-pointer border ${
                    selectedSetup === chip.id
                      ? "bg-indigo-600/30 border-indigo-400 text-indigo-200 font-bold"
                      : "bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200 hover:border-slate-700"
                  }`}
                >
                  {chip.label}
                </button>
              ))}
            </div>
          </div>

          {/* Timeframe Period */}
          <div className="space-y-1.5 md:col-span-2">
            <div className="flex items-center justify-between">
              <label className="text-xs font-semibold text-slate-400 flex items-center gap-1.5">
                <Calendar className="w-3.5 h-3.5 text-indigo-400" /> Historical Lookback Period
              </label>
              <span className="text-[10px] font-mono text-indigo-400">
                Up to 6 Months (180 Days)
              </span>
            </div>
            <div className="grid grid-cols-4 sm:grid-cols-7 gap-1.5">
              {[
                { label: "1D", val: 1 },
                { label: "3D", val: 3 },
                { label: "7D", val: 7 },
                { label: "14D", val: 14 },
                { label: "30D (1M)", val: 30 },
                { label: "90D (3M)", val: 90 },
                { label: "180D (6M)", val: 180 },
              ].map((p) => (
                <button
                  key={p.val}
                  type="button"
                  onClick={() => setDays(p.val)}
                  disabled={loading}
                  className={`py-2 text-xs font-medium rounded-lg border transition-all ${
                    days === p.val
                      ? "bg-indigo-600/20 border-indigo-500 text-indigo-300 font-bold shadow-xs"
                      : "bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200"
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          {/* Setup Isolation Mode */}
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-slate-400 flex items-center gap-1.5">
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" /> Isolation Constraint
            </label>
            <div
              onClick={() => !loading && setIsolationMode(!isolationMode)}
              className={`flex items-center justify-between p-2 rounded-lg border cursor-pointer select-none transition-all ${
                isolationMode
                  ? "bg-emerald-950/20 border-emerald-600/40 text-emerald-300"
                  : "bg-slate-950 border-slate-800 text-slate-400"
              }`}
            >
              <span className="text-xs font-medium">Single Setup Isolation</span>
              <span
                className={`w-4 h-4 rounded-full border flex items-center justify-center text-[10px] ${
                  isolationMode
                    ? "bg-emerald-500 border-emerald-400 text-black font-bold"
                    : "border-slate-600"
                }`}
              >
                {isolationMode && "✓"}
              </span>
            </div>
          </div>

          {/* Sizing & Friction Parameters */}
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-slate-400 flex items-center gap-1.5">
              <Zap className="w-3.5 h-3.5 text-amber-400" /> Position & Friction
            </label>
            <div className="bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-300 flex items-center justify-between">
              <span>0.01 BTC @ 20x Lev</span>
              <span className="text-slate-400 font-mono">0.05% Taker Fee</span>
            </div>
          </div>

          {/* Trading Session Window Filter */}
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-slate-400 flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5 text-indigo-400" /> Trading Session Filter
            </label>
            <select
              value={sessionFilter}
              onChange={(e) => setSessionFilter(e.target.value)}
              disabled={loading}
              className="w-full bg-slate-950 border border-slate-700/80 rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-indigo-500 transition-colors font-medium cursor-pointer"
            >
              <option value="all">All Sessions (Global 24/7)</option>
              <option value="asia_open">🌅 Asia Open Front-run (05:00 - 09:30 IST)</option>
              <option value="intraday_chop">☕ Intra-day Chop (09:30 - 18:30 IST)</option>
              <option value="europe_us_overlap">🗽 US / Europe Overlap (18:30 - 22:30 IST)</option>
              <option value="late_us_session">🌙 Late US Session (22:30 - 01:30 IST)</option>
              <option value="dead_liquidity">💤 Dead Liquidity (01:30 - 05:00 IST)</option>
              <option value="weekends">🏖️ Weekends (Sat/Sun IST)</option>
            </select>
          </div>

          {/* Session Matrix Gating Toggle */}
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-slate-400 flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5 text-emerald-400" /> Session Matrix Gating
            </label>
            <div
              onClick={() => !loading && setRespectSessionMatrix(!respectSessionMatrix)}
              className={`flex items-center justify-between p-2 rounded-lg border cursor-pointer select-none transition-all ${
                respectSessionMatrix
                  ? "bg-emerald-950/20 border-emerald-600/40 text-emerald-300"
                  : "bg-slate-950 border-slate-800 text-slate-400"
              }`}
            >
              <span className="text-xs font-medium">Respect Session x Setup Matrix</span>
              <span
                className={`w-4 h-4 rounded-full border flex items-center justify-center text-[10px] ${
                  respectSessionMatrix
                    ? "bg-emerald-500 border-emerald-400 text-black font-bold"
                    : "border-slate-600"
                }`}
              >
                {respectSessionMatrix && "✓"}
              </span>
            </div>
          </div>

          {/* Unified Confluence Matrix Gating Toggle */}
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-slate-400 flex items-center gap-1.5">
              <Zap className="w-3.5 h-3.5 text-indigo-400" /> Unified Confluence Matrix
            </label>
            <div
              onClick={() => !loading && setRespectUnifiedConfluence(!respectUnifiedConfluence)}
              className={`flex items-center justify-between p-2 rounded-lg border cursor-pointer select-none transition-all ${
                respectUnifiedConfluence
                  ? "bg-indigo-950/20 border-indigo-600/40 text-indigo-300"
                  : "bg-slate-950 border-slate-800 text-slate-400"
              }`}
            >
              <div className="flex flex-col">
                <span className="text-xs font-medium">Enforce Confluence Matrix</span>
                <span className="text-[10px] text-slate-500">25 Empirical Validated Clusters</span>
              </div>
              <span
                className={`w-4 h-4 rounded-full border flex items-center justify-center text-[10px] ${
                  respectUnifiedConfluence
                    ? "bg-indigo-500 border-indigo-400 text-white font-bold"
                    : "border-slate-600"
                }`}
              >
                {respectUnifiedConfluence && "✓"}
              </span>
            </div>
          </div>
        </div>

        {error && (
          <div className="mt-4 p-3 bg-rose-500/10 border border-rose-500/20 rounded-lg text-rose-400 text-xs flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}
      </div>

      {/* Results View */}
      {result && (
        <div className="space-y-6">
          {/* Key Metrics Grid */}
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
            {/* Win Rate */}
            <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-4">
              <span className="text-xs text-slate-400 font-medium block">Win Rate</span>
              <div className="text-2xl font-black text-white mt-1 flex items-baseline gap-1.5">
                <span
                  className={
                    result.winRate >= 50
                      ? "text-emerald-400"
                      : result.winRate >= 40
                      ? "text-amber-400"
                      : "text-rose-400"
                  }
                >
                  {result.winRate}%
                </span>
                <span className="text-xs text-slate-500 font-normal">
                  ({result.winningTrades}W / {result.losingTrades}L)
                </span>
              </div>
              <span className="text-[11px] text-slate-500 mt-1 block">
                Total: {result.totalTrades} Trades {result.gatedSignalsCount ? `(${result.gatedSignalsCount} Gated)` : ""}
              </span>
            </div>

            {/* Net P&L */}
            <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-4">
              <span className="text-xs text-slate-400 font-medium block">Net P&L</span>
              <div
                className={`text-2xl font-black mt-1 ${
                  result.netPnlUsd >= 0 ? "text-emerald-400" : "text-rose-400"
                }`}
              >
                {result.netPnlUsd >= 0 ? "+" : ""}${result.netPnlUsd.toFixed(2)}
              </div>
              <span className="text-[11px] text-slate-500 mt-1 block">
                Return: {result.netPnlPercent >= 0 ? "+" : ""}
                {result.netPnlPercent.toFixed(2)}%
              </span>
            </div>

            {/* Profit Factor */}
            <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-4">
              <span className="text-xs text-slate-400 font-medium block">Profit Factor</span>
              <div
                className={`text-2xl font-black mt-1 ${
                  result.profitFactor >= 1.5
                    ? "text-emerald-400"
                    : result.profitFactor >= 1.0
                    ? "text-amber-400"
                    : "text-rose-400"
                }`}
              >
                {result.profitFactor >= 99 ? "∞" : result.profitFactor.toFixed(2)}
              </div>
              <span className="text-[11px] text-slate-500 mt-1 block">
                Exp: ${result.expectancyUsd.toFixed(2)}/trade
              </span>
            </div>

            {/* Max Drawdown */}
            <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-4">
              <span className="text-xs text-slate-400 font-medium block">Max Drawdown</span>
              <div className="text-2xl font-black text-rose-400 mt-1">
                -{result.maxDrawdownPercent.toFixed(2)}%
              </div>
              <span className="text-[11px] text-slate-500 mt-1 block">
                -${result.maxDrawdownUsd.toFixed(2)} peak-to-trough
              </span>
            </div>

            {/* Favorable Move (MFE) */}
            <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-4">
              <span className="text-xs text-slate-400 font-medium block">Avg MFE</span>
              <div className="text-2xl font-black text-indigo-400 mt-1">
                +{result.averageMfeAtr.toFixed(2)}x
              </div>
              <span className="text-[11px] text-slate-500 mt-1 block">
                Avg Favorable: +${result.averageMfeUsd.toFixed(1)}
              </span>
            </div>

            {/* Hold Time */}
            <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-4">
              <span className="text-xs text-slate-400 font-medium block">Avg Duration</span>
              <div className="text-2xl font-black text-white mt-1">
                {(result.averageHoldDurationSeconds / 60).toFixed(1)}m
              </div>
              <span className="text-[11px] text-slate-500 mt-1 block">
                Fees: ${result.totalFeesUsd.toFixed(2)}
              </span>
            </div>
          </div>

          {/* Weekday-Specific Win Rate & Performance Hub */}
          {(() => {
            const WEEKDAYS_ORDER = [
              { id: "monday", name: "Monday", short: "Mon" },
              { id: "tuesday", name: "Tuesday", short: "Tue" },
              { id: "wednesday", name: "Wednesday", short: "Wed" },
              { id: "thursday", name: "Thursday", short: "Thu" },
              { id: "friday", name: "Friday", short: "Fri" },
              { id: "saturday", name: "Saturday", short: "Sat" },
              { id: "sunday", name: "Sunday", short: "Sun" },
            ];

            const weekdayMap: Record<string, WeekdayPerformance> = result.weekdayBreakdown || (() => {
              const map: Record<string, WeekdayPerformance> = {};
              for (const day of WEEKDAYS_ORDER) {
                const dTrades = (result.trades || []).filter((t) => {
                  if (t.dayId) return t.dayId.toLowerCase() === day.id;
                  const d = new Date(t.entryTimestampMs || Date.parse(t.timestamp));
                  const utcMs = d.getTime() + d.getTimezoneOffset() * 60000;
                  const istDate = new Date(utcMs + 5.5 * 3600000);
                  const dayNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
                  return dayNames[istDate.getDay()] === day.id;
                });
                const dWins = dTrades.filter((t) => t.netPnlUsd > 0).length;
                const dLosses = dTrades.filter((t) => t.netPnlUsd <= 0).length;
                const dGrossProfit = dTrades.filter((t) => t.grossPnlUsd > 0).reduce((s, t) => s + t.grossPnlUsd, 0);
                const dGrossLoss = Math.abs(dTrades.filter((t) => t.grossPnlUsd < 0).reduce((s, t) => s + t.grossPnlUsd, 0));
                const dNetPnl = dTrades.reduce((s, t) => s + t.netPnlUsd, 0);
                const dAvgHold = dTrades.length > 0 ? dTrades.reduce((s, t) => s + t.holdDurationSeconds, 0) / dTrades.length : 0;
                map[day.id] = {
                  dayId: day.id,
                  dayName: day.name,
                  tradesCount: dTrades.length,
                  winCount: dWins,
                  lossCount: dLosses,
                  winRate: dTrades.length > 0 ? Number(((dWins / dTrades.length) * 100).toFixed(1)) : 0,
                  netPnlUsd: Number(dNetPnl.toFixed(2)),
                  profitFactor: dGrossLoss > 0 ? Number((dGrossProfit / dGrossLoss).toFixed(2)) : dGrossProfit > 0 ? 99 : 0,
                  averageHoldDurationSeconds: Math.round(dAvgHold),
                };
              }
              return map;
            })();

            const activeDays = WEEKDAYS_ORDER.map((d) => weekdayMap[d.id]).filter(Boolean);
            const daysWithTrades = activeDays.filter((d) => d.tradesCount > 0);
            const bestWinRateDay = daysWithTrades.length > 0
              ? [...daysWithTrades].sort((a, b) => b.winRate - a.winRate || b.tradesCount - a.tradesCount)[0]
              : null;
            const mostProfitableDay = daysWithTrades.length > 0
              ? [...daysWithTrades].sort((a, b) => b.netPnlUsd - a.netPnlUsd)[0]
              : null;

            return (
              <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-5 shadow-xl space-y-4">
                <div className="flex flex-col md:flex-row md:items-center justify-between pb-3 border-b border-slate-800 gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <Calendar className="w-4 h-4 text-indigo-400" />
                      <h3 className="text-sm font-bold text-white uppercase tracking-wider font-sans">
                        Weekday-Specific Win Rate &amp; Performance Matrix
                      </h3>
                      <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
                        Monday – Sunday
                      </span>
                    </div>
                    <p className="text-xs text-slate-400 mt-1">
                      Empirical statistical distribution across calendar days. Uncovers high-conviction momentum windows versus low-liquidity chop days. Click any day to filter trade logs.
                    </p>
                  </div>

                  {/* Highlights */}
                  <div className="flex items-center gap-2 flex-wrap text-xs">
                    {bestWinRateDay && bestWinRateDay.tradesCount > 0 && (
                      <span className="px-2.5 py-1 rounded-lg bg-emerald-950/40 border border-emerald-500/30 text-emerald-300 font-mono flex items-center gap-1.5 shadow-2xs">
                        <span>🏆 Best Win Rate:</span>
                        <strong className="font-bold text-white">{bestWinRateDay.dayName} ({bestWinRateDay.winRate.toFixed(1)}%)</strong>
                      </span>
                    )}
                    {mostProfitableDay && mostProfitableDay.tradesCount > 0 && mostProfitableDay.netPnlUsd > 0 && (
                      <span className="px-2.5 py-1 rounded-lg bg-indigo-950/40 border border-indigo-500/30 text-indigo-300 font-mono flex items-center gap-1.5 shadow-2xs">
                        <span>💰 Top PnL:</span>
                        <strong className="font-bold text-white">{mostProfitableDay.dayName} (+${mostProfitableDay.netPnlUsd.toFixed(2)})</strong>
                      </span>
                    )}
                    {filterWeekday !== "ALL" && (
                      <button
                        onClick={() => setFilterWeekday("ALL")}
                        className="px-2 py-1 rounded text-xs font-mono text-slate-400 hover:text-white bg-slate-800 border border-slate-700 cursor-pointer"
                      >
                        Reset Filter ({filterWeekday})
                      </button>
                    )}
                  </div>
                </div>

                {/* Weekday Cards Strip (7 days) */}
                <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
                  {WEEKDAYS_ORDER.map((day) => {
                    const stats = weekdayMap[day.id] || {
                      dayId: day.id,
                      dayName: day.name,
                      tradesCount: 0,
                      winCount: 0,
                      lossCount: 0,
                      winRate: 0,
                      netPnlUsd: 0,
                      profitFactor: 0,
                    };
                    const isSelected = filterWeekday.toLowerCase() === day.id;

                    const wrColor =
                      stats.tradesCount === 0
                        ? "text-slate-500"
                        : stats.winRate >= 70
                        ? "text-emerald-400"
                        : stats.winRate >= 50
                        ? "text-sky-400"
                        : "text-amber-400";

                    const barColor =
                      stats.tradesCount === 0
                        ? "bg-slate-800"
                        : stats.winRate >= 70
                        ? "bg-emerald-500"
                        : stats.winRate >= 50
                        ? "bg-sky-500"
                        : "bg-amber-500";

                    return (
                      <div
                        key={day.id}
                        onClick={() => setFilterWeekday(isSelected ? "ALL" : day.id)}
                        className={`p-3 rounded-xl border transition-all cursor-pointer select-none flex flex-col justify-between ${
                          isSelected
                            ? "bg-indigo-950/40 border-indigo-500 shadow-md ring-1 ring-indigo-500"
                            : "bg-slate-950/60 border-slate-800/80 hover:border-slate-700 hover:bg-slate-900/60"
                        }`}
                      >
                        <div>
                          <div className="flex items-center justify-between mb-1.5">
                            <span className="text-xs font-bold font-sans text-slate-300">
                              {day.name}
                            </span>
                            <span className="text-[10px] font-mono text-slate-500">
                              {stats.tradesCount}T
                            </span>
                          </div>

                          <div className="flex items-baseline justify-between mt-1">
                            <span className={`text-xl font-mono font-extrabold tabular-nums ${wrColor}`}>
                              {stats.tradesCount > 0 ? `${stats.winRate.toFixed(1)}%` : "—"}
                            </span>
                            {stats.tradesCount > 0 && (
                              <span className="text-[10px] font-mono text-slate-400">
                                {stats.winCount}W / {stats.lossCount}L
                              </span>
                            )}
                          </div>

                          {/* Progress bar */}
                          <div className="w-full bg-slate-800 rounded-full h-1.5 mt-2 overflow-hidden">
                            <div
                              className={`h-1.5 rounded-full transition-all duration-300 ${barColor}`}
                              style={{ width: `${Math.min(100, Math.max(0, stats.winRate))}%` }}
                            />
                          </div>
                        </div>

                        <div className="mt-3 pt-2 border-t border-slate-800/60 flex items-center justify-between text-[11px] font-mono">
                          <span className="text-slate-500">P&amp;L:</span>
                          <span
                            className={`font-bold ${
                              stats.netPnlUsd > 0
                                ? "text-emerald-400"
                                : stats.netPnlUsd < 0
                                ? "text-rose-400"
                                : "text-slate-500"
                            }`}
                          >
                            {stats.tradesCount > 0
                              ? `${stats.netPnlUsd >= 0 ? "+" : ""}$${stats.netPnlUsd.toFixed(1)}`
                              : "$0.0"}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })()}

          {/* Regime & Session Breakdown Grid */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Regime Breakdown */}
            <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-5 shadow-lg">
              <h3 className="text-sm font-bold text-white mb-3 flex items-center gap-2">
                <Activity className="w-4 h-4 text-indigo-400" /> Performance Breakdown by Market Regime
              </h3>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-slate-800 text-slate-400 font-semibold">
                      <th className="pb-2">Regime</th>
                      <th className="pb-2">Trades</th>
                      <th className="pb-2">Win Rate</th>
                      <th className="pb-2">Profit Factor</th>
                      <th className="pb-2 text-right">Net P&L ($)</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60 font-mono text-slate-300">
                    {Object.values(result.regimeBreakdown).map((reg: RegimePerformance) => (
                      <tr key={reg.regime} className="hover:bg-slate-800/20">
                        <td className="py-2.5 font-sans font-medium text-white flex items-center gap-1.5">
                          <span className="w-2 h-2 rounded-full bg-slate-500" />
                          {reg.regime}
                        </td>
                        <td className="py-2.5">{reg.tradesCount}</td>
                        <td className="py-2.5 font-bold">
                          <span
                            className={
                              reg.winRate >= 50
                                ? "text-emerald-400"
                                : reg.winRate > 0
                                ? "text-amber-400"
                                : "text-slate-500"
                            }
                          >
                            {reg.winRate.toFixed(1)}%
                          </span>{" "}
                          <span className="text-slate-500 font-normal">
                            ({reg.winCount}W / {reg.lossCount}L)
                          </span>
                        </td>
                        <td className="py-2.5">
                          {reg.profitFactor >= 99 ? "∞" : reg.profitFactor.toFixed(2)}
                        </td>
                        <td
                          className={`py-2.5 text-right font-bold ${
                            reg.netPnlUsd > 0
                              ? "text-emerald-400"
                              : reg.netPnlUsd < 0
                              ? "text-rose-400"
                              : "text-slate-500"
                          }`}
                        >
                          {reg.netPnlUsd >= 0 ? "+" : ""}${reg.netPnlUsd.toFixed(2)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Session Breakdown */}
            <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-5 shadow-lg">
              <h3 className="text-sm font-bold text-white mb-3 flex items-center gap-2">
                <Clock className="w-4 h-4 text-emerald-400" /> Performance Breakdown by Trading Session
              </h3>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-slate-800 text-slate-400 font-semibold">
                      <th className="pb-2">Session</th>
                      <th className="pb-2">Trades</th>
                      <th className="pb-2">Win Rate</th>
                      <th className="pb-2">Profit Factor</th>
                      <th className="pb-2 text-right">Net P&L ($)</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60 font-mono text-slate-300">
                    {result.sessionBreakdown && Object.values(result.sessionBreakdown).map((sess: SessionPerformance) => {
                      const icons: Record<string, string> = {
                        asia_open: "🌅",
                        intraday_chop: "☕",
                        europe_us_overlap: "🗽",
                        late_us_session: "🌙",
                        dead_liquidity: "💤",
                        weekends: "🏖️",
                      };
                      return (
                        <tr key={sess.sessionId} className="hover:bg-slate-800/20">
                          <td className="py-2.5 font-sans font-medium text-white flex items-center gap-1.5">
                            <span>{icons[sess.sessionId] || "⏰"}</span>
                            <span>{sess.sessionName}</span>
                          </td>
                          <td className="py-2.5">{sess.tradesCount}</td>
                          <td className="py-2.5 font-bold">
                            <span
                              className={
                                sess.winRate >= 50
                                  ? "text-emerald-400"
                                  : sess.winRate > 0
                                  ? "text-amber-400"
                                  : "text-slate-500"
                              }
                            >
                              {sess.winRate.toFixed(1)}%
                            </span>{" "}
                            <span className="text-slate-500 font-normal">
                              ({sess.winCount}W / {sess.lossCount}L)
                            </span>
                          </td>
                          <td className="py-2.5">
                            {sess.profitFactor >= 99 ? "∞" : sess.profitFactor.toFixed(2)}
                          </td>
                          <td
                            className={`py-2.5 text-right font-bold ${
                              sess.netPnlUsd > 0
                                ? "text-emerald-400"
                                : sess.netPnlUsd < 0
                                ? "text-rose-400"
                                : "text-slate-500"
                            }`}
                          >
                            {sess.netPnlUsd >= 0 ? "+" : ""}${sess.netPnlUsd.toFixed(2)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {/* Trade History Table */}
          <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-5 shadow-lg space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-bold text-white flex items-center gap-2">
                  <Clock className="w-4 h-4 text-indigo-400" /> Simulated Trade History (
                  {filteredTrades.length} of {result.totalTrades})
                </h3>
              </div>

              {/* Filters & Export */}
              <div className="flex items-center gap-2 flex-wrap">
                {/* Direction Filter */}
                <div className="flex items-center bg-slate-950 border border-slate-800 rounded-lg p-0.5 text-xs">
                  {(["ALL", "LONG", "SHORT"] as const).map((dir) => (
                    <button
                      key={dir}
                      onClick={() => setFilterDirection(dir)}
                      className={`px-2.5 py-1 rounded font-medium transition-colors ${
                        filterDirection === dir
                          ? "bg-slate-800 text-white"
                          : "text-slate-400 hover:text-slate-200"
                      }`}
                    >
                      {dir}
                    </button>
                  ))}
                </div>

                {/* Outcome Filter */}
                <div className="flex items-center bg-slate-950 border border-slate-800 rounded-lg p-0.5 text-xs">
                  {(["ALL", "WIN", "LOSS"] as const).map((out) => (
                    <button
                      key={out}
                      onClick={() => setFilterOutcome(out)}
                      className={`px-2.5 py-1 rounded font-medium transition-colors ${
                        filterOutcome === out
                          ? "bg-slate-800 text-white"
                          : "text-slate-400 hover:text-slate-200"
                      }`}
                    >
                      {out}
                    </button>
                  ))}
                </div>

                {/* Weekday Filter */}
                <div className="flex items-center bg-slate-950 border border-slate-800 rounded-lg p-0.5 text-xs">
                  {(["ALL", "mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const).map((day) => {
                    const label = day === "ALL" ? "All Days" : day.charAt(0).toUpperCase() + day.slice(1);
                    return (
                      <button
                        key={day}
                        onClick={() => setFilterWeekday(day === "ALL" ? "ALL" : day)}
                        className={`px-2 py-1 rounded font-medium transition-colors text-[11px] whitespace-nowrap ${
                          filterWeekday.toLowerCase() === day.toLowerCase()
                            ? "bg-indigo-600 text-white font-bold"
                            : "text-slate-400 hover:text-slate-200"
                        }`}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>

                {/* CSV Download */}
                <button
                  onClick={exportCsv}
                  className="px-3 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg text-xs font-medium flex items-center gap-1.5 transition-colors border border-slate-700"
                >
                  <Download className="w-3.5 h-3.5" /> Export CSV
                </button>
              </div>
            </div>

            {filteredTrades.length === 0 ? (
              <div className="text-center py-10 text-slate-500 text-sm">
                No trades match the selected filters.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-slate-800 text-slate-400 font-semibold">
                      <th className="pb-2.5">Time (UTC)</th>
                      <th className="pb-2.5">Session</th>
                      <th className="pb-2.5">Direction</th>
                      <th className="pb-2.5">Entry ($)</th>
                      <th className="pb-2.5">Exit ($)</th>
                      <th className="pb-2.5">Target SL / TP</th>
                      <th className="pb-2.5">MFE / MAE</th>
                      <th className="pb-2.5">Duration</th>
                      <th className="pb-2.5">Exit Trigger</th>
                      <th className="pb-2.5 text-right">Net P&L</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60 font-mono text-slate-300">
                    {filteredTrades.map((t) => (
                      <tr key={t.id} className="hover:bg-slate-800/30 transition-colors">
                        <td className="py-2.5 text-slate-400 font-sans">
                          <div className="flex items-center gap-1.5">
                            <span className="px-1.5 py-0.5 rounded text-[10px] font-mono font-semibold bg-slate-800 text-indigo-300 border border-slate-700/60 uppercase">
                              {t.dayName ? t.dayName.slice(0, 3) : "Day"}
                            </span>
                            <span>{t.timestamp.replace("T", " ").replace("Z", "").slice(0, 16)}</span>
                          </div>
                        </td>
                        <td className="py-2.5">
                          <span className="px-2 py-0.5 rounded text-[10px] font-mono font-medium bg-slate-800 text-slate-300 border border-slate-700/60 flex items-center gap-1 w-fit whitespace-nowrap">
                            <span>{t.sessionId === "asia_open" ? "🌅" : t.sessionId === "intraday_chop" ? "☕" : t.sessionId === "europe_us_overlap" ? "🗽" : t.sessionId === "late_us_session" ? "🌙" : t.sessionId === "dead_liquidity" ? "💤" : t.sessionId === "weekends" ? "🏖️" : "⏰"}</span>
                            <span>{t.sessionName || t.sessionId || "Normal"}</span>
                          </span>
                          {t.confluenceRuleName && (
                            <span className="block mt-1 text-[9px] font-mono text-indigo-300 bg-indigo-950/60 border border-indigo-700/40 px-1.5 py-0.5 rounded truncate max-w-[170px]" title={t.confluenceRuleName}>
                              ⚡ {t.confluenceRuleName}
                            </span>
                          )}
                        </td>
                        <td className="py-2.5">
                          <span
                            className={`px-2 py-0.5 rounded text-[11px] font-bold ${
                              t.direction === "LONG"
                                ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                                : "bg-rose-500/10 text-rose-400 border border-rose-500/20"
                            }`}
                          >
                            {t.direction}
                          </span>
                        </td>
                        <td className="py-2.5 text-white">${t.entryPrice.toFixed(2)}</td>
                        <td className="py-2.5 text-white">${t.exitPrice.toFixed(2)}</td>
                        <td className="py-2.5 text-slate-400 text-[11px]">
                          SL: ${t.stopLoss.toFixed(1)} | TP: ${t.takeProfit.toFixed(1)}
                        </td>
                        <td className="py-2.5">
                          <span className="text-emerald-400 font-semibold">
                            +{t.maxFavorableExcursionAtr.toFixed(1)}x
                          </span>{" "}
                          /{" "}
                          <span className="text-rose-400 font-semibold">
                            -{t.maxAdverseExcursionAtr.toFixed(1)}x
                          </span>
                        </td>
                        <td className="py-2.5 text-slate-400">
                          {Math.round(t.holdDurationSeconds / 60)}m
                        </td>
                        <td className="py-2.5">
                          <span
                            className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                              t.exitReason === "TAKE_PROFIT"
                                ? "bg-emerald-500/20 text-emerald-300"
                                : t.exitReason === "STOP_LOSS"
                                ? "bg-rose-500/20 text-rose-300"
                                : "bg-slate-700 text-slate-300"
                            }`}
                          >
                            {t.exitReason}
                          </span>
                        </td>
                        <td
                          className={`py-2.5 text-right font-bold text-sm ${
                            t.netPnlUsd > 0 ? "text-emerald-400" : "text-rose-400"
                          }`}
                        >
                          {t.netPnlUsd >= 0 ? "+" : ""}${t.netPnlUsd.toFixed(2)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
      {/* Multi-Setup Win Rate Ranking Modal */}
      {showRankModal && rankResult && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-md">
          <div className="bg-slate-900 border border-slate-700/80 rounded-2xl max-w-4xl w-full max-h-[90vh] flex flex-col shadow-2xl overflow-hidden animate-in fade-in duration-200">
            {/* Modal Header */}
            <div className="p-6 border-b border-slate-800 flex items-center justify-between bg-slate-900/90">
              <div className="flex items-center gap-3">
                <div className="p-2.5 rounded-xl bg-amber-500/10 text-amber-400 border border-amber-500/20">
                  <Trophy className="w-6 h-6" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="text-lg font-bold text-white">Strategy Setups Ranked by Win Rate</h3>
                    <span className="px-2 py-0.5 rounded-full text-xs font-mono font-bold bg-amber-500/10 text-amber-400 border border-amber-500/20">
                      High Probability Ranking
                    </span>
                  </div>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Evaluated across {(rankResult.candlesEvaluated ?? rankResult.totalCandlesAnalyzed ?? 0).toLocaleString()} Binance 1m candles ({rankResult.days ?? days}d period) in total isolation.
                  </p>
                </div>
              </div>
              <button
                onClick={() => setShowRankModal(false)}
                className="p-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-6 overflow-y-auto space-y-6">
              {/* Top 3 Podium Highlights */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                {(rankResult.rankings || []).slice(0, 3).map((s, idx) => {
                  const wins = s.wins ?? s.winningTrades ?? 0;
                  const losses = s.losses ?? s.losingTrades ?? 0;
                  const netPnl = s.netPnl ?? s.netPnlUsd ?? 0;

                  return (
                    <div
                      key={s.setupId}
                      className={`p-4 rounded-xl border relative ${
                        idx === 0
                          ? "bg-amber-950/20 border-amber-500/40 text-amber-200"
                          : idx === 1
                          ? "bg-slate-800/60 border-slate-600 text-slate-200"
                          : "bg-orange-950/20 border-orange-500/40 text-orange-200"
                      }`}
                    >
                      <div className="flex items-center justify-between text-xs font-mono">
                        <span className="font-bold">
                          {idx === 0 ? "🥇 Rank #1 Gold" : idx === 1 ? "🥈 Rank #2 Silver" : "🥉 Rank #3 Bronze"}
                        </span>
                        <span className="text-[10px] uppercase font-semibold text-slate-400">{s.category}</span>
                      </div>
                      <div className="font-bold text-white text-sm mt-1.5 truncate" title={s.setupName}>
                        {s.setupName}
                      </div>
                      <div className="flex items-baseline gap-2 mt-2">
                        <span className="text-2xl font-black font-sans text-white">{(s.winRate ?? 0).toFixed(1)}%</span>
                        <span className="text-xs text-slate-400 font-mono">({wins}W / {losses}L)</span>
                      </div>
                      <div className="mt-2 pt-2 border-t border-slate-700/50 flex items-center justify-between text-xs font-mono">
                        <span className="text-slate-400">P&L:</span>
                        <span className={`font-bold ${netPnl >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                          {netPnl >= 0 ? "+" : ""}${netPnl.toFixed(2)}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Complete Ranked Table */}
              <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-950/50">
                <table className="w-full text-left text-xs border-collapse">
                  <thead>
                    <tr className="border-b border-slate-800 bg-slate-900/60 text-slate-400 font-mono text-[10px] uppercase">
                      <th className="py-2.5 px-3 text-center">Rank</th>
                      <th className="py-2.5 px-3">Setup Name</th>
                      <th className="py-2.5 px-3 text-center">Category</th>
                      <th className="py-2.5 px-3 text-center">Win Rate %</th>
                      <th className="py-2.5 px-3 text-center">W / L (Trades)</th>
                      <th className="py-2.5 px-3 text-center">Profit Factor</th>
                      <th className="py-2.5 px-3 text-right">Net P&L (USD)</th>
                      <th className="py-2.5 px-3 text-center">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/80 font-mono">
                    {(rankResult.rankings || []).map((s) => {
                      const wins = s.wins ?? s.winningTrades ?? 0;
                      const losses = s.losses ?? s.losingTrades ?? 0;
                      const netPnl = s.netPnl ?? s.netPnlUsd ?? 0;
                      const totalTrades = s.totalTrades ?? (wins + losses);
                      const pf = s.profitFactor ?? 1;

                      return (
                        <tr key={s.setupId} className="hover:bg-slate-800/40 transition-colors">
                          <td className="py-3 px-3 text-center">
                            <span className={`inline-flex items-center justify-center px-2 py-0.5 rounded-full text-xs font-bold ${
                              s.rank === 1
                                ? "bg-amber-500/20 text-amber-300 border border-amber-500/30"
                                : s.rank === 2
                                ? "bg-slate-700 text-slate-200"
                                : s.rank === 3
                                ? "bg-orange-500/20 text-orange-300 border border-orange-500/30"
                                : "text-slate-400"
                            }`}>
                              #{s.rank}
                            </span>
                          </td>
                          <td className="py-3 px-3 font-sans font-bold text-white text-xs">
                            {s.setupName}
                          </td>
                          <td className="py-3 px-3 text-center text-slate-400 text-[11px]">
                            {s.category}
                          </td>
                          <td className="py-3 px-3 text-center">
                            <span className={`font-black text-xs ${
                              (s.winRate ?? 0) >= 70
                                ? "text-emerald-400"
                                : (s.winRate ?? 0) >= 55
                                ? "text-indigo-400"
                                : (s.winRate ?? 0) >= 45
                                ? "text-amber-400"
                                : "text-rose-400"
                            }`}>
                              {(s.winRate ?? 0).toFixed(1)}%
                            </span>
                          </td>
                          <td className="py-3 px-3 text-center text-slate-300">
                            <span className="text-emerald-400 font-bold">{wins}W</span>
                            <span className="text-slate-500 mx-1">/</span>
                            <span className="text-rose-400 font-bold">{losses}L</span>
                            <span className="text-slate-500 ml-1 text-[10px]">({totalTrades})</span>
                          </td>
                          <td className="py-3 px-3 text-center text-slate-300 font-semibold">
                            {pf >= 99 ? "∞" : `${pf.toFixed(2)}x`}
                          </td>
                          <td className={`py-3 px-3 text-right font-bold ${
                            netPnl >= 0 ? "text-emerald-400" : "text-rose-400"
                          }`}>
                            {netPnl >= 0 ? "+" : ""}${netPnl.toFixed(2)}
                          </td>
                          <td className="py-3 px-3 text-center">
                            <button
                              onClick={() => {
                                setSelectedSetup(s.setupId);
                                setShowRankModal(false);
                              }}
                              className="px-2.5 py-1 rounded bg-indigo-600/20 hover:bg-indigo-600 text-indigo-300 hover:text-white border border-indigo-500/30 text-[11px] font-sans font-medium transition-all cursor-pointer"
                            >
                              Inspect Single
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Modal Footer */}
            <div className="p-4 border-t border-slate-800 bg-slate-900/90 flex items-center justify-between">
              <span className="text-xs text-slate-400">
                Sorted by empirical win rate probability descending.
              </span>
              <button
                onClick={() => setShowRankModal(false)}
                className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-white text-xs font-semibold transition-colors cursor-pointer"
              >
                Close Leaderboard
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Tactical Setups Catalog Modal */}
      {showSetupModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-md">
          <div className="bg-slate-900 border border-slate-700/80 rounded-2xl max-w-4xl w-full max-h-[90vh] flex flex-col shadow-2xl overflow-hidden animate-in fade-in duration-200">
            {/* Modal Header */}
            <div className="p-5 border-b border-slate-800 flex items-center justify-between bg-slate-900/90">
              <div className="flex items-center gap-3">
                <div className="p-2.5 rounded-xl bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
                  <Layers className="w-6 h-6" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="text-base font-bold text-white">Tactical Strategy Setups Catalog</h3>
                    <span className="px-2 py-0.5 rounded-full text-xs font-mono font-bold bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
                      {setups.length} Setups Available
                    </span>
                  </div>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Select any tactical setup to backtest in strict isolation or run all core setups combined.
                  </p>
                </div>
              </div>
              <button
                onClick={() => setShowSetupModal(false)}
                className="p-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Filter Bar */}
            <div className="px-5 py-3 border-b border-slate-800 bg-slate-950/40 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-1.5 overflow-x-auto">
                {[
                  { id: "ALL", label: `All (${setups.length})` },
                  { id: "trend", label: `Trend (${setups.filter((s) => s.category === "trend").length})` },
                  { id: "reversal", label: `Reversal & SMC (${setups.filter((s) => s.category === "reversal").length})` },
                  { id: "orderflow", label: `Order Flow (${setups.filter((s) => s.category === "orderflow").length})` },
                ].map((cat) => (
                  <button
                    key={cat.id}
                    type="button"
                    onClick={() => setSetupCategoryFilter(cat.id)}
                    className={`px-3 py-1 rounded-lg text-xs font-mono transition-colors cursor-pointer border ${
                      setupCategoryFilter === cat.id
                        ? "bg-indigo-600 text-white font-bold border-indigo-500"
                        : "bg-slate-900 text-slate-400 border-slate-800 hover:text-white"
                    }`}
                  >
                    {cat.label}
                  </button>
                ))}
              </div>

              <div className="relative">
                <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  placeholder="Filter setups..."
                  value={setupSearchQuery}
                  onChange={(e) => setSetupSearchQuery(e.target.value)}
                  className="bg-slate-950 border border-slate-800 rounded-lg pl-8 pr-3 py-1 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500"
                />
              </div>
            </div>

            {/* Modal Body: Cards Grid */}
            <div className="p-5 overflow-y-auto max-h-[60vh] grid grid-cols-1 md:grid-cols-2 gap-3">
              {setups
                .filter((s) => setupCategoryFilter === "ALL" || s.category === setupCategoryFilter)
                .filter(
                  (s) =>
                    !setupSearchQuery ||
                    s.name.toLowerCase().includes(setupSearchQuery.toLowerCase()) ||
                    s.description.toLowerCase().includes(setupSearchQuery.toLowerCase()) ||
                    s.id.toLowerCase().includes(setupSearchQuery.toLowerCase())
                )
                .map((s) => {
                  const isCurrent = selectedSetup === s.id;
                  return (
                    <div
                      key={s.id}
                      onClick={() => {
                        setSelectedSetup(s.id);
                        setShowSetupModal(false);
                      }}
                      className={`p-4 rounded-xl border transition-all cursor-pointer flex flex-col justify-between ${
                        isCurrent
                          ? "bg-indigo-950/40 border-indigo-500 shadow-md ring-1 ring-indigo-500/50"
                          : "bg-slate-950/60 border-slate-800 hover:border-slate-700 hover:bg-slate-900/60"
                      }`}
                    >
                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-sans font-bold text-sm text-white flex items-center gap-1.5">
                            {s.id === "all" ? "🌟" : "⚡"} {s.name}
                          </span>
                          <span className="px-2 py-0.5 rounded text-[9px] font-mono font-bold uppercase bg-slate-800 text-slate-300 border border-slate-700">
                            {s.category}
                          </span>
                        </div>
                        <p className="text-xs text-slate-400 leading-relaxed font-sans">
                          {s.description}
                        </p>
                      </div>

                      <div className="mt-4 pt-3 border-t border-slate-800/80 flex items-center justify-between">
                        <span className="text-[10px] font-mono text-slate-500">ID: {s.id}</span>
                        <button
                          type="button"
                          className={`px-3 py-1 rounded-lg text-xs font-mono font-bold transition-colors ${
                            isCurrent
                              ? "bg-emerald-500 text-black"
                              : "bg-indigo-600 hover:bg-indigo-500 text-white"
                          }`}
                        >
                          {isCurrent ? "✓ Active Selection" : "Select Setup"}
                        </button>
                      </div>
                    </div>
                  );
                })}
            </div>

            {/* Modal Footer */}
            <div className="p-4 border-t border-slate-800 bg-slate-900/90 flex items-center justify-between">
              <span className="text-xs text-slate-400 font-mono">
                Active Selection:{" "}
                <strong className="text-white">
                  {setups.find((s) => s.id === selectedSetup)?.name || selectedSetup}
                </strong>
              </span>
              <button
                onClick={() => setShowSetupModal(false)}
                className="px-4 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold transition-colors cursor-pointer"
              >
                Close Catalog
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
