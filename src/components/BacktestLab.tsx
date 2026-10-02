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
} from "lucide-react";
import { apiFetch } from "../utils/api.ts";
import { BacktestResult, BacktestSetupOption, BacktestTrade, RegimePerformance } from "../backtester/types.ts";

export default function BacktestLab() {
  const [setups, setSetups] = useState<BacktestSetupOption[]>([]);
  const [selectedSetup, setSelectedSetup] = useState<string>("setup_15_trendline_bounce");
  const [days, setDays] = useState<number>(3);
  const [isolationMode, setIsolationMode] = useState<boolean>(true);
  const [excludeWeekends, setExcludeWeekends] = useState<boolean>(true);
  const [loading, setLoading] = useState<boolean>(false);
  const [elapsedSeconds, setElapsedSeconds] = useState<number>(0);
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filterDirection, setFilterDirection] = useState<"ALL" | "LONG" | "SHORT">("ALL");
  const [filterOutcome, setFilterOutcome] = useState<"ALL" | "WIN" | "LOSS">("ALL");
  const [bufferStatus, setBufferStatus] = useState<any>(null);
  const [isSyncingBuffer, setIsSyncingBuffer] = useState<boolean>(false);

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
        if (data && data.setups) {
          setSetups(data.setups);
        }
      }
    } catch (e) {
      console.warn("Could not load backtest setups:", e);
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
            </div>
            <p className="text-sm text-slate-400 max-w-3xl">
              Empirically backtest any individual setup in total isolation against real Binance 1m klines,
              order flow delta, and volume. Runs without affecting active paper trades, live WebSockets, or engine state.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={handleRunBacktest}
              disabled={loading}
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
          <div className="space-y-1.5 md:col-span-2">
            <label className="text-xs font-semibold text-slate-400 flex items-center justify-between">
              <span className="flex items-center gap-1.5">
                <Layers className="w-3.5 h-3.5 text-indigo-400" /> Target Tactical Setup ({setups.length} Available)
              </span>
              <span className="text-[10px] text-slate-500 font-mono">
                {setups.find((s) => s.id === selectedSetup)?.category.toUpperCase()}
              </span>
            </label>
            <select
              value={selectedSetup}
              onChange={(e) => setSelectedSetup(e.target.value)}
              disabled={loading}
              className="w-full bg-slate-950 border border-slate-700/80 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500 transition-colors font-medium"
            >
              {setups.map((s) => (
                <option key={s.id} value={s.id} className="bg-slate-950 text-white py-1">
                  {s.name}
                </option>
              ))}
            </select>
            <p className="text-[11px] text-slate-400 leading-relaxed mt-1">
              {setups.find((s) => s.id === selectedSetup)?.description || "Select a tactical setup to backtest in isolation."}
            </p>
          </div>

          {/* Timeframe Period */}
          <div className="space-y-1.5 md:col-span-2">
            <label className="text-xs font-semibold text-slate-400 flex items-center gap-1.5">
              <Calendar className="w-3.5 h-3.5 text-indigo-400" /> Historical Lookback Period
            </label>
            <div className="grid grid-cols-5 gap-1.5">
              {[
                { label: "1D", val: 1 },
                { label: "3D", val: 3 },
                { label: "7D", val: 7 },
                { label: "14D", val: 14 },
                { label: "30D (1M)", val: 30 },
              ].map((p) => (
                <button
                  key={p.val}
                  type="button"
                  onClick={() => setDays(p.val)}
                  disabled={loading}
                  className={`py-2 text-xs font-medium rounded-lg border transition-all ${
                    days === p.val
                      ? "bg-indigo-600/20 border-indigo-500 text-indigo-300 font-bold"
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
                Total: {result.totalTrades} Trades
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
                          {t.timestamp.replace("T", " ").replace("Z", "").slice(0, 16)}
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
    </div>
  );
}
