/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from "react";
import { apiFetch } from "../utils/api.ts";
import {
  TrendingUp,
  TrendingDown,
  Calendar,
  Layers,
  ChevronDown,
  ChevronUp,
  Activity,
  DollarSign,
  Filter,
  Trash2,
  AlertTriangle,
  RefreshCw,
  Clock,
} from "lucide-react";
import { Trade, TradeDirection, ExitReason, MarketRegime, StrategyConfig, TimingWindow } from "../types.js";
import { safeFormatTime, safeFormatDate, safeFormatNumber } from "../utils/format";

const FALLBACK_TIMING_WINDOWS: TimingWindow[] = [
  {
    id: "asia_open",
    name: "Asia Open Front-run",
    start_time: "05:00",
    end_time: "09:30",
    allowed: true,
    description: "Optimal morning momentum. High probability trend capture session.",
  },
  {
    id: "intraday_chop",
    name: "Intra-day Chop",
    start_time: "09:30",
    end_time: "18:30",
    allowed: false,
    description: "Avoid period. High noise, low momentum, and sideways chop.",
  },
  {
    id: "europe_us_overlap",
    name: "US / Europe Overlap",
    start_time: "18:30",
    end_time: "22:30",
    allowed: true,
    description: "Best Window. Peak liquidity, volume, and lowest spreads with high institutional action.",
  },
  {
    id: "late_us_session",
    name: "Late US Session",
    start_time: "22:30",
    end_time: "01:30",
    allowed: true,
    description: "Active derivatives positioning. Ideal session for momentum breakouts.",
  },
  {
    id: "dead_liquidity",
    name: "Dead Liquidity",
    start_time: "01:30",
    end_time: "05:00",
    allowed: false,
    description: "Strict Avoid period. Extremely thin orderbooks and high slippage risk.",
  },
  {
    id: "weekends",
    name: "Weekends",
    start_time: "00:00",
    end_time: "23:59",
    allowed: false,
    description: "Volume drops significantly on weekends, increasing the risk of sharp liquidations and false trends.",
  },
];

const parseTimeToMinutes = (timeStr: string): number => {
  const parts = timeStr.split(":");
  if (parts.length !== 2) return 0;
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  return (isNaN(h) || isNaN(m)) ? 0 : h * 60 + m;
};

const isTimeInWindow = (minutes: number, startStr: string, endStr: string): boolean => {
  const start = parseTimeToMinutes(startStr);
  const end = parseTimeToMinutes(endStr);
  if (start === end) return false;
  if (start < end) {
    return minutes >= start && minutes < end;
  } else {
    // Crosses midnight (e.g. 22:30 to 01:30)
    return minutes >= start || minutes < end;
  }
};

export function getTradeTimingWindow(entryTimestampStr: string, customWindows?: TimingWindow[]): { id: string; name: string; is_weekend: boolean; allowed: boolean } {
  const windows = customWindows && customWindows.length > 0 ? customWindows : FALLBACK_TIMING_WINDOWS;
  
  const d = new Date(entryTimestampStr);
  if (isNaN(d.getTime())) {
    return { id: "unknown", name: "Unknown Window", is_weekend: false, allowed: true };
  }
  
  const utcMs = d.getTime() + d.getTimezoneOffset() * 60000;
  const istOffset = 5.5 * 3600000;
  const istDate = new Date(utcMs + istOffset);

  const hour = istDate.getHours();
  const minute = istDate.getMinutes();
  const day = istDate.getDay(); // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
  const minutesOfDay = hour * 60 + minute;

  // 1. Weekend check (Saturday after 1:30 AM IST & all of Sunday IST)
  let isWeekendNow = false;
  if (day === 0) {
    isWeekendNow = true;
  } else if (day === 6) {
    if (minutesOfDay > 90) {
      isWeekendNow = true;
    }
  }

  const weekendWindow = windows.find((w) => w.id === "weekends");
  if (isWeekendNow) {
    return {
      id: "weekends",
      name: weekendWindow?.name || "Weekends",
      is_weekend: true,
      allowed: weekendWindow ? weekendWindow.allowed : false,
    };
  }

  // 2. Session match check
  const matchingWindow = windows.find(
    (w) => w.id !== "weekends" && isTimeInWindow(minutesOfDay, w.start_time, w.end_time)
  );

  if (matchingWindow) {
    return {
      id: matchingWindow.id,
      name: matchingWindow.name,
      is_weekend: false,
      allowed: matchingWindow.allowed,
    };
  }

  return {
    id: "normal_hours",
    name: "Normal Hours (Non-Optimal)",
    is_weekend: false,
    allowed: true,
  };
}

interface TradeHistoryProps {
  trades: Trade[];
  isPaperMode?: boolean;
  onRefresh?: () => void;
  config?: StrategyConfig | null;
}

export default function TradeHistory({ trades, isPaperMode = true, onRefresh, config }: TradeHistoryProps) {
  const [selectedTradeId, setSelectedTradeId] = useState<string | null>(null);
  const [directionFilter, setDirectionFilter] = useState<"ALL" | "LONG" | "SHORT">("ALL");
  const [winFilter, setWinFilter] = useState<"ALL" | "WINS" | "LOSSES">("ALL");
  const [reasonFilter, setReasonFilter] = useState<"ALL" | ExitReason>("ALL");
  const [windowFilter, setWindowFilter] = useState<string>("ALL");
  const [regimeFilter, setRegimeFilter] = useState<string>("ALL");
  const [showTargetsInTable, setShowTargetsInTable] = useState<boolean>(false);
  const [showAtrInTable, setShowAtrInTable] = useState<boolean>(false);

  // Clear modal states
  const [showClearModal, setShowClearModal] = useState(false);
  const [clearMode, setClearMode] = useState<"live" | "paper" | "both">(isPaperMode ? "paper" : "live");
  const [isClearing, setIsClearing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const handleClearSubmit = async () => {
    setIsClearing(true);
    setMessage(null);
    try {
      const response = await apiFetch("/api/trading/clear-history", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: clearMode }),
      });
      if (response.ok) {
        const result = await response.json();
        setMessage(result.message || "History cleared successfully.");
        if (onRefresh) {
          onRefresh();
        }
        setTimeout(() => {
          setShowClearModal(false);
          setMessage(null);
        }, 1500);
      } else {
        const errorData = await response.json();
        setMessage(`Error: ${errorData.message || "Failed to clear history."}`);
      }
    } catch (err: any) {
      setMessage(`Error: ${err.message || "Network error."}`);
    } finally {
      setIsClearing(false);
    }
  };

  const toggleSelectTrade = (id: string) => {
    setSelectedTradeId(selectedTradeId === id ? null : id);
  };

  // Group statistics by window
  const windowsList = config?.general?.timing_windows || FALLBACK_TIMING_WINDOWS;
  const windowStats = windowsList.reduce((acc: any, win: any) => {
    acc[win.id] = {
      id: win.id,
      name: win.name,
      allowed: win.allowed,
      start_time: win.start_time,
      end_time: win.end_time,
      count: 0,
      wins: 0,
      pnl: 0,
    };
    return acc;
  }, {
    normal_hours: {
      id: "normal_hours",
      name: "Normal Hours (Non-Optimal)",
      allowed: true,
      start_time: "N/A",
      end_time: "N/A",
      count: 0,
      wins: 0,
      pnl: 0,
    }
  } as any);

  trades.forEach((t) => {
    const info = getTradeTimingWindow(t.entry_timestamp, windowsList);
    if (windowStats[info.id]) {
      windowStats[info.id].count += 1;
      if (t.is_win) {
        windowStats[info.id].wins += 1;
      }
      if (t.pnl_usdt) {
        windowStats[info.id].pnl += t.pnl_usdt;
      }
    }
  });

  // Apply filters
  const filteredTrades = trades.filter((t) => {
    if (directionFilter !== "ALL" && t.direction !== directionFilter) return false;
    if (winFilter === "WINS" && !t.is_win) return false;
    if (winFilter === "LOSSES" && t.is_win) return false;
    if (reasonFilter !== "ALL" && t.exit_reason !== reasonFilter) return false;
    if (windowFilter !== "ALL") {
      const info = getTradeTimingWindow(t.entry_timestamp, windowsList);
      if (info.id !== windowFilter) return false;
    }
    if (regimeFilter !== "ALL" && t.regime_at_entry !== regimeFilter) return false;
    return true;
  });

  const getReasonBadgeClass = (reason: ExitReason | null) => {
    switch (reason) {
      case ExitReason.TAKE_PROFIT:
        return "bg-emerald-50 border-emerald-200 text-emerald-700";
      case ExitReason.STOP_LOSS:
        return "bg-rose-50 border-rose-200 text-rose-700";
      case ExitReason.TIME_LIMIT_29MIN:
        return "bg-indigo-50 border-indigo-200 text-indigo-700";
      case ExitReason.SENTIMENT_REVERSAL:
        return "bg-amber-50 border-amber-200 text-amber-700";
      case ExitReason.MANUAL_EXIT:
        return "bg-slate-150 border-slate-250 text-slate-700";
      default:
        return "bg-slate-50 border-slate-200 text-slate-500";
    }
  };

  return (
    <div className="space-y-6">
      {/* Timing Window Performance Breakdown */}
      <div className="bg-slate-50/50 border border-slate-200/60 rounded-2xl p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Clock className="w-4.5 h-4.5 text-indigo-600" />
            <h3 className="font-sans font-bold text-xs text-slate-800 uppercase tracking-wider">
              IST Scalper Session Performance Breakdown
            </h3>
          </div>
          <span className="text-[10px] text-slate-400 font-mono">Based on UTC trade logs parsed into IST (Click a session card to filter)</span>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          {Object.values(windowStats).map((win: any) => {
            const winRate = win.count > 0 ? (win.wins / win.count) * 100 : 0;
            const pnlValue = win.pnl;
            const isPnlPositive = pnlValue >= 0;

            return (
              <div
                key={win.id}
                onClick={() => setWindowFilter(windowFilter === win.id ? "ALL" : win.id)}
                className={`group border rounded-xl p-3 bg-white hover:border-indigo-400 cursor-pointer transition-all duration-150 ${
                  windowFilter === win.id
                    ? "ring-2 ring-indigo-500/10 border-indigo-500 shadow-sm"
                    : "border-slate-100/80 shadow-sm"
                }`}
              >
                <div className="flex items-center justify-between gap-1">
                  <span className="text-[10px] font-bold text-slate-750 truncate block group-hover:text-indigo-600 transition-colors">
                    {win.name.replace(" Session", "").replace(" Overlap", "")}
                  </span>
                  <span
                    className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                      win.allowed ? "bg-emerald-500" : "bg-rose-400"
                    }`}
                    title={win.allowed ? "Allowed window" : "Restricted window"}
                  />
                </div>
                
                <span className="text-[9px] font-mono text-slate-400 block mt-0.5">
                  {win.start_time === "N/A" ? "Other hours" : `${win.start_time} - ${win.end_time}`}
                </span>

                <div className="mt-1.5 pt-1.5 border-t border-slate-100/50 grid grid-cols-2 gap-1 text-center">
                  <div>
                    <span className="text-[9px] text-slate-400 block uppercase font-mono">Trades</span>
                    <span className="text-xs font-semibold text-slate-750 font-mono">{win.count}</span>
                  </div>
                  <div>
                    <span className="text-[9px] text-slate-400 block uppercase font-mono">Win %</span>
                    <span className="text-xs font-semibold text-slate-750 font-mono">
                      {win.count > 0 ? `${winRate.toFixed(0)}%` : "—"}
                    </span>
                  </div>
                </div>

                <div className="mt-1.5 text-center bg-slate-50/50 p-1 rounded-md border border-slate-100/20">
                  <span className="text-[8px] text-slate-400 uppercase font-mono block leading-none">Net P&L</span>
                  <span className={`text-[11px] font-bold font-mono ${
                    win.count === 0 ? "text-slate-400" : isPnlPositive ? "text-emerald-600" : "text-rose-600"
                  }`}>
                    {win.count === 0 ? "—" : `${isPnlPositive ? "+" : ""}$${pnlValue.toFixed(2)}`}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Filters Strip */}
      <div className="bg-white border border-slate-200 shadow-sm rounded-2xl p-4 flex flex-wrap items-center justify-between gap-4" id="history-filters-bar">
        <div className="flex items-center gap-2">
          <Filter className="w-4.5 h-4.5 text-indigo-600" />
          <span className="font-sans font-semibold text-xs text-slate-800 uppercase tracking-wider">Filter History</span>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {/* Direction Filter */}
          <div className="flex items-center gap-1.5 text-xs">
            <span className="text-slate-400 font-mono text-[10px] uppercase">Dir</span>
            <select
              value={directionFilter}
              onChange={(e) => setDirectionFilter(e.target.value as any)}
              className="bg-slate-50 border border-slate-200 text-slate-800 p-1.5 rounded-lg text-xs font-sans outline-none focus:ring-1 focus:ring-indigo-400 focus:border-indigo-400"
            >
              <option value="ALL">All Directions</option>
              <option value="LONG">Long Positions</option>
              <option value="SHORT">Short Positions</option>
            </select>
          </div>

          {/* Win/Loss Filter */}
          <div className="flex items-center gap-1.5 text-xs">
            <span className="text-slate-400 font-mono text-[10px] uppercase">Status</span>
            <select
              value={winFilter}
              onChange={(e) => setWinFilter(e.target.value as any)}
              className="bg-slate-50 border border-slate-200 text-slate-800 p-1.5 rounded-lg text-xs font-sans outline-none focus:ring-1 focus:ring-indigo-400 focus:border-indigo-400"
            >
              <option value="ALL">All Outcomes</option>
              <option value="WINS">Wins Only</option>
              <option value="LOSSES">Losses Only</option>
            </select>
          </div>

          {/* Reason Filter */}
          <div className="flex items-center gap-1.5 text-xs">
            <span className="text-slate-400 font-mono text-[10px] uppercase">Exit Trigger</span>
            <select
              value={reasonFilter}
              onChange={(e) => setReasonFilter(e.target.value as any)}
              className="bg-slate-50 border border-slate-200 text-slate-800 p-1.5 rounded-lg text-xs font-sans outline-none focus:ring-1 focus:ring-indigo-400 focus:border-indigo-400"
            >
              <option value="ALL">All Exits</option>
              <option value={ExitReason.TAKE_PROFIT}>Take Profit (TP)</option>
              <option value={ExitReason.STOP_LOSS}>Stop Loss (SL)</option>
              <option value={ExitReason.TIME_LIMIT_29MIN}>29 Min Timeout</option>
              <option value={ExitReason.SENTIMENT_REVERSAL}>Sentiment Reversal</option>
              <option value={ExitReason.MANUAL_EXIT}>Manual User Exit</option>
            </select>
          </div>

          {/* Timing Window Filter */}
          <div className="flex items-center gap-1.5 text-xs">
            <span className="text-slate-400 font-mono text-[10px] uppercase">Session</span>
            <select
              value={windowFilter}
              onChange={(e) => setWindowFilter(e.target.value)}
              className="bg-slate-50 border border-slate-200 text-slate-800 p-1.5 rounded-lg text-xs font-sans outline-none focus:ring-1 focus:ring-indigo-400 focus:border-indigo-400"
            >
              <option value="ALL">All Sessions</option>
              {windowsList.map((w) => (
                <option key={w.id} value={w.id}>{w.name}</option>
              ))}
              <option value="normal_hours">Normal Hours</option>
            </select>
          </div>

          {/* Regime Filter */}
          <div className="flex items-center gap-1.5 text-xs">
            <span className="text-slate-400 font-mono text-[10px] uppercase">Regime</span>
            <select
              value={regimeFilter}
              onChange={(e) => setRegimeFilter(e.target.value)}
              className="bg-slate-50 border border-slate-200 text-slate-800 p-1.5 rounded-lg text-xs font-sans outline-none focus:ring-1 focus:ring-indigo-400 focus:border-indigo-400"
            >
              <option value="ALL">All Regimes</option>
              <option value={MarketRegime.STRONG_UPTREND}>Strong Uptrend</option>
              <option value={MarketRegime.STRONG_DOWNTREND}>Strong Downtrend</option>
              <option value={MarketRegime.RANGE_BOUND}>Range Bound</option>
              <option value={MarketRegime.HIGH_VOLATILITY}>High Volatility</option>
              <option value={MarketRegime.LOW_VOLATILITY}>Low Volatility</option>
            </select>
          </div>

          {/* Toggle SL/TP columns */}
          <label className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-50 hover:bg-slate-100/80 text-slate-700 border border-slate-200 rounded-lg text-xs font-sans font-medium transition-colors cursor-pointer select-none">
            <input
              type="checkbox"
              checked={showTargetsInTable}
              onChange={(e) => setShowTargetsInTable(e.target.checked)}
              className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 h-3.5 w-3.5 cursor-pointer"
            />
            <span>Show SL/TP Targets</span>
          </label>

          {/* Toggle Entry ATR column */}
          <label className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-50 hover:bg-slate-100/80 text-slate-700 border border-slate-200 rounded-lg text-xs font-sans font-medium transition-colors cursor-pointer select-none">
            <input
              type="checkbox"
              checked={showAtrInTable}
              onChange={(e) => setShowAtrInTable(e.target.checked)}
              className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 h-3.5 w-3.5 cursor-pointer"
            />
            <span>Show Entry ATR</span>
          </label>

          {/* Clear History Button */}
          <button
            onClick={() => setShowClearModal(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-rose-50 hover:bg-rose-100 text-rose-600 hover:text-rose-700 rounded-lg text-xs font-sans font-semibold border border-rose-100 hover:border-rose-200 transition-colors cursor-pointer"
            title="Clear trade logs"
          >
            <Trash2 className="w-3.5 h-3.5" />
            Clear History
          </button>
        </div>
      </div>

      {/* Trades Table List */}
      <div className="bg-white border border-slate-200 shadow-sm rounded-2xl overflow-hidden" id="trades-table-card">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-slate-50/70 border-b border-slate-200 font-mono text-[10px] text-slate-400 uppercase">
                <th className="py-3 px-4 font-normal">Timestamp</th>
                <th className="py-3 px-4 font-normal">Direction</th>
                <th className="py-3 px-4 font-normal">Size (BTC)</th>
                <th className="py-3 px-4 font-normal">Entry Price</th>
                {showTargetsInTable && (
                  <>
                    <th className="py-3 px-4 font-normal">Target SL</th>
                    <th className="py-3 px-4 font-normal">Target TP</th>
                  </>
                )}
                {showAtrInTable && (
                  <th className="py-3 px-4 font-normal">Entry ATR</th>
                )}
                <th className="py-3 px-4 font-normal">Exit Price</th>
                <th className="py-3 px-4 font-normal">Session IST</th>
                <th className="py-3 px-4 font-normal">Trigger Reason</th>
                <th className="py-3 px-4 font-normal text-right">Net P&L</th>
                <th className="py-3 px-4 w-10"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredTrades.map((t) => {
                const isSelected = selectedTradeId === t.id;
                const tWindow = getTradeTimingWindow(t.entry_timestamp, windowsList);
                return (
                  <React.Fragment key={t.id}>
                                         <tr
                        onClick={() => toggleSelectTrade(t.id)}
                        className={`hover:bg-slate-50/50 transition-colors duration-150 cursor-pointer text-xs ${
                          isSelected ? "bg-slate-50" : ""
                        }`}
                      >
                        <td className="py-3.5 px-4 font-mono text-slate-500">
                          {safeFormatTime(t.entry_timestamp, true)}
                        </td>
                        <td className="py-3.5 px-4">
                          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold border uppercase tracking-wider ${
                            t.direction === TradeDirection.LONG ? "bg-emerald-50 border-emerald-200 text-emerald-700" : "bg-rose-50 border-rose-200 text-rose-700"
                          }`}>
                            {t.direction === TradeDirection.LONG ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                            {t.direction}
                          </span>
                        </td>
                        <td className="py-3.5 px-4 font-sans font-semibold text-slate-800">
                          {t.quantity_btc} BTC
                        </td>
                        <td className="py-3.5 px-4 font-mono text-slate-500">
                          ${safeFormatNumber(t.entry_price)}
                        </td>
                        {showTargetsInTable && (
                          <>
                            <td className="py-3.5 px-4 font-mono text-rose-600 font-medium">
                              {t.feature_snapshot?.stop_loss_price 
                                ? `$${safeFormatNumber(t.feature_snapshot.stop_loss_price)}` 
                                : t.feature_snapshot?.current_stop_loss_price 
                                ? `$${safeFormatNumber(t.feature_snapshot.current_stop_loss_price)}` 
                                : "—"}
                            </td>
                            <td className="py-3.5 px-4 font-mono text-emerald-600 font-medium">
                              {t.feature_snapshot?.take_profit_price 
                                ? `$${safeFormatNumber(t.feature_snapshot.take_profit_price)}` 
                                : "—"}
                            </td>
                          </>
                        )}
                        {showAtrInTable && (
                          <td className="py-3.5 px-4 font-mono text-amber-600 font-medium">
                            {t.feature_snapshot?.atr_14 !== undefined
                              ? `$${safeFormatNumber(t.feature_snapshot.atr_14, 2, 2)}`
                              : "—"}
                          </td>
                        )}
                        <td className="py-3.5 px-4 font-mono text-slate-500">
                          {t.exit_price ? `$${safeFormatNumber(t.exit_price)}` : "Active..."}
                        </td>
                        <td className="py-3.5 px-4">
                          <span className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-semibold border uppercase ${
                            tWindow.id === 'europe_us_overlap' ? 'bg-indigo-50 border-indigo-200 text-indigo-700' :
                            tWindow.id === 'late_us_session' ? 'bg-blue-50 border-blue-250 text-indigo-800' :
                            tWindow.id === 'asia_open' ? 'bg-emerald-50 border-emerald-250 text-emerald-800' :
                            tWindow.id === 'intraday_chop' ? 'bg-amber-50 border-amber-250 text-amber-850' :
                            tWindow.id === 'dead_liquidity' ? 'bg-rose-50 border-rose-250 text-rose-800' :
                            tWindow.id === 'weekends' ? 'bg-slate-100 border-slate-300 text-slate-700' :
                            'bg-slate-50 border-slate-200 text-slate-650'
                          }`} title={`${tWindow.name} (${tWindow.allowed ? "Allowed" : "Restricted"})`}>
                            <Clock className="w-2.5 h-2.5" />
                            {tWindow.name.replace(" Session", "").replace(" Overlap", "")}
                            {!tWindow.allowed && <span className="text-[9px] text-rose-500 font-bold ml-0.5" title="Bypassed restriction or manual trade in restricted window">⚠️</span>}
                          </span>
                        </td>
                        <td className="py-3.5 px-4">
                          {t.exit_reason ? (
                            <span className={`inline-flex items-center px-2.5 py-0.5 rounded text-[10px] font-medium border uppercase ${getReasonBadgeClass(t.exit_reason)}`}>
                              {t.exit_reason.replace("_", " ")}
                            </span>
                          ) : (
                            <span className="text-slate-400 font-mono italic text-[10px]">Active scanning...</span>
                          )}
                        </td>
                        <td className={`py-3.5 px-4 text-right font-sans font-bold text-sm ${t.pnl_usdt && t.pnl_usdt >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
                          {t.pnl_usdt ? `${t.pnl_usdt >= 0 ? "+" : ""}$${safeFormatNumber(t.pnl_usdt, 2, 2)}` : "Active"}
                        </td>
                        <td className="py-3.5 px-4 text-slate-400">
                          {isSelected ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                        </td>
                      </tr>

 
                     {/* Trade Detail Drawer */}
                     {isSelected && (
                       <tr>
                         <td colSpan={(showTargetsInTable ? 11 : 9) + (showAtrInTable ? 1 : 0)} className="bg-slate-50 border-t border-b border-slate-100 p-5">
                           <div className="grid grid-cols-1 md:grid-cols-4 gap-6 text-slate-600" id={`trade-drawer-${t.id}`}>
                             {/* Execution stats */}
                             <div className="space-y-3">
                               <h4 className="text-[10px] font-mono text-indigo-650 uppercase tracking-wider">Trade Parameters</h4>
                               <div className="space-y-1.5 text-xs font-sans">
                                 <div className="flex justify-between border-b border-slate-200/50 pb-1">
                                   <span className="text-slate-400">Leverage:</span>
                                   <span className="font-semibold text-slate-700">{t.leverage}x Cross</span>
                                 </div>
                                 <div className="flex justify-between border-b border-slate-200/50 pb-1">
                                   <span className="text-slate-400">Hold Duration:</span>
                                   <span className="font-semibold text-slate-700">{Math.floor(t.hold_duration_seconds / 60)}m {t.hold_duration_seconds % 60}s</span>
                                 </div>
                                 <div className="flex justify-between border-b border-slate-200/50 pb-1">
                                   <span className="text-slate-400">Commissions Paid:</span>
                                   <span className="font-mono text-slate-700">${t.fees_paid_usdt.toFixed(4)}</span>
                                 </div>
                                 <div className="flex justify-between border-b border-slate-200/50 pb-1">
                                   <span className="text-slate-400">Target Stop Loss:</span>
                                   <span className="font-mono text-rose-600 font-semibold">
                                     {t.feature_snapshot?.stop_loss_price 
                                       ? `$${safeFormatNumber(t.feature_snapshot.stop_loss_price)}` 
                                       : t.feature_snapshot?.current_stop_loss_price 
                                       ? `$${safeFormatNumber(t.feature_snapshot.current_stop_loss_price)}` 
                                       : "N/A"}
                                   </span>
                                 </div>
                                 <div className="flex justify-between">
                                   <span className="text-slate-400">Target Take Profit:</span>
                                   <span className="font-mono text-emerald-600 font-semibold">
                                     {t.feature_snapshot?.take_profit_price 
                                       ? `$${safeFormatNumber(t.feature_snapshot.take_profit_price)}` 
                                       : "N/A"}
                                   </span>
                                 </div>
                               </div>
                             </div>
 
                             {/* Adverse excursions */}
                             <div className="space-y-3">
                               <h4 className="text-[10px] font-mono text-rose-600 uppercase tracking-wider">Risk Excursions</h4>
                               <div className="space-y-1.5 text-xs font-sans">
                                 <div className="flex justify-between border-b border-slate-200/50 pb-1">
                                   <span className="text-slate-400">Max Fav Excursion (MFE):</span>
                                   <span className="font-mono text-emerald-600 font-bold">+{t.max_favorable_excursion.toFixed(3)}%</span>
                                 </div>
                                 <div className="flex justify-between">
                                   <span className="text-slate-400">Max Adv Excursion (MAE):</span>
                                   <span className="font-mono text-rose-600 font-bold">-{t.max_adverse_excursion.toFixed(3)}%</span>
                                 </div>
                               </div>
                             </div>
 
                             {/* Sentiment parameters */}
                             <div className="space-y-3">
                               <h4 className="text-[10px] font-mono text-amber-600 uppercase tracking-wider">Sentiment Factors</h4>
                               <div className="space-y-1.5 text-xs font-sans">
                                 <div className="flex justify-between border-b border-slate-200/50 pb-1">
                                   <span className="text-slate-400">Sentiment Score:</span>
                                   <span className={`font-mono font-bold ${t.sentiment_score_at_entry >= 0 ? "text-emerald-600" : "text-rose-600"}`}>{t.sentiment_score_at_entry.toFixed(2)}</span>
                                 </div>
                                 <div className="flex justify-between">
                                   <span className="text-slate-400">Momentum Vector:</span>
                                   <span className="font-mono text-slate-700">{t.sentiment_momentum_at_entry >= 0 ? "BULLISH" : "BEARISH"} ({t.sentiment_momentum_at_entry.toFixed(2)})</span>
                                 </div>
                               </div>
                             </div>
 
                             {/* Technical snapshots */}
                             <div className="space-y-3">
                               <h4 className="text-[10px] font-mono text-indigo-650 uppercase tracking-wider">Feature Snapshot</h4>
                               <div className="space-y-1.5 text-xs font-sans">
                                 <div className="flex justify-between border-b border-slate-200/50 pb-1">
                                   <span className="text-slate-400">Market Regime:</span>
                                   <span className="font-semibold text-slate-700 uppercase text-[10px]">{(t.regime_at_entry || "").replace("_", " ")}</span>
                                 </div>
                                 <div className="flex justify-between border-b border-slate-200/50 pb-1">
                                   <span className="text-slate-400">Entry ATR (14):</span>
                                   <span className="font-mono text-amber-600 font-semibold">
                                     {t.feature_snapshot?.atr_14 !== undefined 
                                       ? `$${safeFormatNumber(t.feature_snapshot.atr_14, 2, 2)}` 
                                       : "N/A"}
                                   </span>
                                 </div>
                                 <div className="flex justify-between">
                                   <span className="text-slate-400">Entry Score:</span>
                                   <span className="font-mono text-indigo-600 font-bold">{t.entry_signal_score}/100</span>
                                 </div>
                               </div>
                             </div>
                           </div>
                         </td>
                       </tr>
                     )}
                   </React.Fragment>
                 );
               })}
               {filteredTrades.length === 0 && (
                 <tr>
                   <td colSpan={(showTargetsInTable ? 11 : 9) + (showAtrInTable ? 1 : 0)} className="text-center font-mono text-slate-400 text-xs italic py-16">
                     No historical trades matching the current filter criteria...
                   </td>
                 </tr>
               )}
             </tbody>
           </table>
         </div>
       </div>

      {/* Clear Confirmation Modal */}
      {showClearModal && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-xl max-w-md w-full overflow-hidden animate-in fade-in zoom-in-95 duration-150">
            <div className="p-6">
              <div className="flex items-start gap-4">
                <div className="w-10 h-10 rounded-full bg-rose-50 flex items-center justify-center text-rose-600 shrink-0">
                  <AlertTriangle className="w-5 h-5" />
                </div>
                <div className="space-y-1">
                  <h3 className="font-sans font-bold text-base text-slate-800">Clear Trade History</h3>
                  <p className="text-xs text-slate-500 leading-relaxed">
                    This action will permanently delete historical trade logs. This cannot be undone. Please select which history you want to clear:
                  </p>
                </div>
              </div>

              <div className="mt-5 space-y-2.5">
                <label className={`flex items-center gap-3 p-3 rounded-xl border cursor-pointer transition-all ${
                  clearMode === "paper" ? "border-indigo-500 bg-indigo-50/30" : "border-slate-100 hover:bg-slate-50"
                }`}>
                  <input
                    type="radio"
                    name="clearMode"
                    checked={clearMode === "paper"}
                    onChange={() => setClearMode("paper")}
                    className="text-indigo-600 focus:ring-indigo-500 h-4 w-4"
                  />
                  <div>
                    <p className="text-xs font-sans font-bold text-slate-800">Paper Trading History</p>
                    <p className="text-[10px] text-slate-400 font-mono mt-0.5">Clears simulated paper trades only</p>
                  </div>
                </label>

                <label className={`flex items-center gap-3 p-3 rounded-xl border cursor-pointer transition-all ${
                  clearMode === "live" ? "border-indigo-500 bg-indigo-50/30" : "border-slate-100 hover:bg-slate-50"
                }`}>
                  <input
                    type="radio"
                    name="clearMode"
                    checked={clearMode === "live"}
                    onChange={() => setClearMode("live")}
                    className="text-indigo-600 focus:ring-indigo-500 h-4 w-4"
                  />
                  <div>
                    <p className="text-xs font-sans font-bold text-slate-800">Real Account Trading History</p>
                    <p className="text-[10px] text-slate-400 font-mono mt-0.5">Clears actual connected exchange trades only</p>
                  </div>
                </label>

                <label className={`flex items-center gap-3 p-3 rounded-xl border cursor-pointer transition-all ${
                  clearMode === "both" ? "border-indigo-500 bg-indigo-50/30" : "border-slate-100 hover:bg-slate-50"
                }`}>
                  <input
                    type="radio"
                    name="clearMode"
                    checked={clearMode === "both"}
                    onChange={() => setClearMode("both")}
                    className="text-indigo-600 focus:ring-indigo-500 h-4 w-4"
                  />
                  <div>
                    <p className="text-xs font-sans font-bold text-slate-800">All Trading History</p>
                    <p className="text-[10px] text-slate-400 font-mono mt-0.5">Clears both live and paper trades completely</p>
                  </div>
                </label>
              </div>

              {message && (
                <div className="mt-4 p-2.5 rounded-lg bg-emerald-50 border border-emerald-100 text-emerald-800 text-xs font-medium text-center">
                  {message}
                </div>
              )}
            </div>

            <div className="bg-slate-50 px-6 py-4 flex items-center justify-end gap-3 border-t border-slate-100">
              <button
                disabled={isClearing}
                onClick={() => setShowClearModal(false)}
                className="px-4 py-2 text-xs font-sans font-semibold text-slate-500 hover:text-slate-800 bg-transparent rounded-lg hover:bg-slate-100 transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                disabled={isClearing}
                onClick={handleClearSubmit}
                className="flex items-center gap-1.5 px-4 py-2 text-xs font-sans font-semibold text-white bg-rose-600 hover:bg-rose-700 disabled:bg-rose-400 rounded-lg shadow-sm transition-colors cursor-pointer"
              >
                {isClearing ? (
                  <>
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    Clearing...
                  </>
                ) : (
                  "Clear Selected"
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
