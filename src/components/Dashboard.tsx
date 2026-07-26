/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from "react";
import { apiFetch } from "../utils/api.ts";
import { motion, AnimatePresence } from "motion/react";
import {
  Play,
  Square,
  AlertOctagon,
  Shield,
  Zap,
  ShieldAlert,
  TrendingUp,
  TrendingDown,
  Activity,
  Cpu,
  BarChart2,
  Newspaper,
  Terminal,
  RotateCw,
  TrendingUp as TrendUpIcon,
  CheckCircle,
  XCircle,
} from "lucide-react";
import {
  ComposedChart,
  Bar,
  Cell,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceDot,
} from "recharts";
import { safeFormatTime, safeFormatNumber } from "../utils/format";

// High-fidelity custom SVG renderer for Candlestick bodies and wicks
const CandlestickBar = (props: any) => {
  const { x, y, width, height, payload, yAxis } = props;
  if (x === undefined || y === undefined || width === undefined || height === undefined || !payload) {
    return null;
  }

  const { open, close, high, low } = payload;
  const isBullish = close >= open;
  const color = isBullish ? "#10b981" : "#ef4444";

  // Calculate the price-to-pixel ratio using the body or the domain
  let ratio = 1;
  const bodyPriceDiff = Math.abs(open - close);
  if (bodyPriceDiff > 0.01) {
    ratio = height / bodyPriceDiff;
  } else if (yAxis && yAxis.height && yAxis.domain) {
    const domainDiff = Math.abs(yAxis.domain[1] - yAxis.domain[0]);
    if (domainDiff > 0) {
      ratio = yAxis.height / domainDiff;
    }
  }

  // Calculate precise SVG coordinates for wicks using the ratio
  const maxOC = Math.max(open, close);
  const minOC = Math.min(open, close);
  const highY = y - (high - maxOC) * ratio;
  const lowY = y + height + (minOC - low) * ratio;

  const cx = x + width / 2;

  return (
    <g>
      {/* Wick line */}
      <line
        x1={cx}
        y1={highY}
        x2={cx}
        y2={lowY}
        stroke={color}
        strokeWidth={1.5}
      />
      {/* Candle body */}
      <rect
        x={x}
        y={y}
        width={width}
        height={Math.max(1, height)}
        fill={color}
        stroke={color}
      />
    </g>
  );
};

// Polished custom tooltip for financial candlesticks
const CustomTooltip = ({ active, payload, label }: any) => {
  if (active && payload && payload.length) {
    const data = payload[0].payload;
    const isBullish = data.close >= data.open;
    return (
      <div className="bg-white border border-slate-200 shadow-lg rounded-xl p-3 text-xs font-sans">
        <p className="font-semibold text-slate-500 mb-1.5">{label}</p>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1">
          <div>
            <span className="text-slate-400">Open:</span>{" "}
            <span className="font-mono font-semibold text-slate-700">${safeFormatNumber(data.open)}</span>
          </div>
          <div>
            <span className="text-slate-400">High:</span>{" "}
            <span className="font-mono font-semibold text-emerald-600">${safeFormatNumber(data.high)}</span>
          </div>
          <div>
            <span className="text-slate-400">Low:</span>{" "}
            <span className="font-mono font-semibold text-rose-600">${safeFormatNumber(data.low)}</span>
          </div>
          <div>
            <span className="text-slate-400">Close:</span>{" "}
            <span className={`font-mono font-semibold ${isBullish ? "text-emerald-600" : "text-rose-600"}`}>
              ${safeFormatNumber(data.close)}
            </span>
          </div>
          <div className="col-span-2 border-t border-slate-100 my-1 pt-1 flex flex-col gap-0.5">
            <div className="flex justify-between">
              <span className="text-slate-400">EMA 21:</span>{" "}
              <span className="font-mono text-blue-600">${safeFormatNumber(data.ema21)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">EMA 50:</span>{" "}
              <span className="font-mono text-amber-600">${safeFormatNumber(data.ema50)}</span>
            </div>
            {data.vwap !== undefined && (
              <>
                <div className="flex justify-between">
                  <span className="text-slate-400">VWAP:</span>{" "}
                  <span className="font-mono text-violet-600">${safeFormatNumber(data.vwap)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400">VWAP Bands:</span>{" "}
                  <span className="font-mono text-rose-500 text-[10px]">
                    [${safeFormatNumber(data.vwap_lower)}, ${safeFormatNumber(data.vwap_upper)}]
                  </span>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    );
  }
  return null;
};
import {
  Trade,
  TradingSignal,
  NewsHeadline,
  MarketRegime,
  ConnectionStatus,
  TradeDirection,
  ExitReason,
} from "../types.js";

interface DashboardProps {
  status: any;
  trades: Trade[];
  signals: TradingSignal[];
  headlines: NewsHeadline[];
  logs: string[];
  onRefresh: () => void;
}

export default function Dashboard({
  status,
  trades,
  signals,
  headlines,
  logs,
  onRefresh,
}: DashboardProps) {
  const [isStarting, setIsStarting] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [isExiting, setIsExiting] = useState(false);

  const activeTrade = status.active_trade as Trade | null;
  const isTradingActive = status.is_trading_active;

  const handleToggleTrading = async () => {
    if (isTradingActive) {
      setIsStopping(true);
      await apiFetch("/api/trading/stop", { method: "POST" });
      setIsStopping(false);
    } else {
      setIsStarting(true);
      await apiFetch("/api/trading/start", { method: "POST" });
      setIsStarting(false);
    }
    onRefresh();
  };

  const handleForceExit = async () => {
    if (!activeTrade) return;
    setIsExiting(true);
    await apiFetch("/api/trading/force-exit", { method: "POST" });
    setIsExiting(false);
    onRefresh();
  };

  // Convert logs to short display format
  const recentLogs = logs.slice(0, 15);

  // Fetch real candles from the backend and format/process them for Recharts
  const [chartData, setChartData] = useState<any[]>([]);

  useEffect(() => {
    let active = true;
    const fetchCandles = async () => {
      try {
        const res = await apiFetch("/api/market/candles");
        if (!res.ok) return;
        const data: any[] = await res.json();
        if (!active || !Array.isArray(data) || data.length === 0) return;

        // Process data and compute mathematical EMA 21 and EMA 50
        const k21 = 2 / (21 + 1);
        const k50 = 2 / (50 + 1);

        let currentEma21 = data[0].close;
        let currentEma50 = data[0].close;

        const finalPoints = data.map((p, idx) => {
          if (idx > 0) {
            currentEma21 = p.close * k21 + currentEma21 * (1 - k21);
            currentEma50 = p.close * k50 + currentEma50 * (1 - k50);
          }

          const minOC = Math.min(p.open, p.close);
          const maxOC = Math.max(p.open, p.close);

          // Format timestamp to local time string (e.g. "02:43 PM")
          const formattedTime = p.time 
            ? safeFormatTime(p.time * 1000)
            : p.time;

          return {
            ...p,
            time: formattedTime,
            ema21: Number(currentEma21.toFixed(2)),
            ema50: Number(currentEma50.toFixed(2)),
            vwap: p.vwap !== undefined ? Number(p.vwap.toFixed(2)) : undefined,
            vwap_upper: p.vwap_upper !== undefined ? Number(p.vwap_upper.toFixed(2)) : undefined,
            vwap_lower: p.vwap_lower !== undefined ? Number(p.vwap_lower.toFixed(2)) : undefined,
            candlestickRange: [minOC, maxOC]
          };
        });

        setChartData(finalPoints.slice(-30));
      } catch (err) {
        console.warn("Failed to fetch market candles", err);
      }
    };

    fetchCandles();
    
    // Refresh candles on a short loop to keep current candle ticking live
    const interval = setInterval(fetchCandles, 5000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, []);

  // Determine sentiment score status color
  const getSentimentColor = (score: number) => {
    if (score > 0.25) return "text-emerald-700 bg-emerald-50 border-emerald-200";
    if (score < -0.25) return "text-rose-700 bg-rose-50 border-rose-200";
    return "text-slate-500 bg-slate-50 border-slate-200";
  };

  // Format countdown text for trade active hold time
  const formatCountdown = (secs: number) => {
    const totalSecs = 29 * 60;
    const elapsed = secs;
    const remaining = Math.max(0, totalSecs - elapsed);
    const mins = Math.floor(remaining / 60);
    const s = remaining % 60;
    return `${mins.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")} / 29:00`;
  };

  return (
    <div className="grid grid-cols-1 xl:grid-cols-4 gap-6 p-1">
      {/* ================= COLUMN 1: LIVE BOT CONTROLS & TRADES TIMELINE ================= */}
      <div className="xl:col-span-1 flex flex-col gap-6" id="dashboard-col-controls">
        {/* Connection & Run Control Card */}
        <div className="bg-white border border-slate-200 shadow-sm rounded-2xl p-5" id="bot-control-card">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Cpu className="w-5 h-5 text-indigo-600" />
              <span className="font-sans font-semibold text-slate-850 text-sm">Execution Engine</span>
            </div>
            <span className="flex h-2 w-2 relative">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
            </span>
          </div>

          <div className="space-y-4">
            {/* Trading Mode Indicator */}
            <div className={`p-3.5 rounded-xl border flex items-center justify-between shadow-sm transition-all ${
              status.is_paper_trading 
                ? "bg-amber-50/75 border-amber-200 text-amber-900" 
                : "bg-rose-50/75 border-rose-200 text-rose-900"
            }`}>
              <div className="flex items-center gap-2">
                <div className={`p-1.5 rounded-lg ${status.is_paper_trading ? "bg-amber-100 text-amber-700" : "bg-rose-100 text-rose-700"}`}>
                  {status.is_paper_trading ? (
                    <Shield className="w-4 h-4" />
                  ) : (
                    <Zap className="w-4 h-4" />
                  )}
                </div>
                <div>
                  <p className="text-[9px] font-mono uppercase tracking-widest text-slate-400">Environment</p>
                  <p className="text-xs font-sans font-bold mt-0.5">
                    {status.is_paper_trading ? "Paper Trading" : "Live Account"}
                  </p>
                </div>
              </div>
              <span className={`text-[9px] font-mono px-2 py-0.5 rounded font-bold uppercase ${
                status.is_paper_trading ? "bg-amber-200/50 text-amber-800 border border-amber-300/30" : "bg-rose-200/50 text-rose-800 border border-rose-300/30"
              }`}>
                {status.is_paper_trading ? "DEMO" : "REAL"}
              </span>
            </div>

            <div className="bg-slate-50 rounded-xl p-4 border border-slate-100 flex justify-between items-center">
              <div>
                <p className="text-[10px] font-mono text-slate-400 uppercase tracking-wider">Bot Status</p>
                <p className={`text-sm font-sans font-bold mt-0.5 ${isTradingActive ? "text-emerald-600" : "text-amber-500"}`}>
                  {isTradingActive ? "ACTIVE SCANNING" : "PAUSED"}
                </p>
              </div>
              <button
                onClick={handleToggleTrading}
                disabled={isStarting || isStopping}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold font-sans cursor-pointer transition-colors duration-200 ${
                  isTradingActive
                    ? "bg-amber-50 hover:bg-amber-100 border border-amber-200 text-amber-700 hover:text-amber-800"
                    : "bg-indigo-600 hover:bg-indigo-700 text-white shadow-sm"
                }`}
                id="btn-toggle-trading"
              >
                {isTradingActive ? (
                  <>
                    <Square className="w-3 h-3 fill-current" />
                    PAUSE ENGINE
                  </>
                ) : (
                  <>
                    <Play className="w-3 h-3 fill-current" />
                    START ENGINE
                  </>
                )}
              </button>
            </div>

            {/* Quick Balance Stats */}
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-slate-50 p-3 rounded-xl border border-slate-100">
                <p className="text-[10px] font-mono text-slate-400 uppercase tracking-wider">Account Equity</p>
                <p className="text-sm font-sans font-bold text-slate-800 mt-1">
                  ${safeFormatNumber(status.account_balance_usdt, 2, 2)}
                </p>
              </div>
              <div className="bg-slate-50 p-3 rounded-xl border border-slate-100">
                <p className="text-[10px] font-mono text-slate-400 uppercase tracking-wider">Selected Asset</p>
                <p className="text-sm font-sans font-bold text-indigo-600 mt-1">BTCUSD-FUTURES</p>
              </div>
            </div>

            {/* Real-time Market Structure Mapping */}
            <div className="bg-slate-50 border border-slate-100 rounded-xl p-3.5 space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-[10px] font-mono text-slate-400 uppercase tracking-wider font-semibold">Trend Market Structure</p>
                <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded-md font-extrabold uppercase ${
                  status.market_structure?.isLongStructureConfirmed ? "bg-emerald-100 text-emerald-800" :
                  status.market_structure?.isShortStructureConfirmed ? "bg-rose-100 text-rose-800" :
                  "bg-slate-200 text-slate-600"
                }`}>
                  {status.market_structure?.isLongStructureConfirmed ? "UPTREND CONFIRMED" :
                   status.market_structure?.isShortStructureConfirmed ? "DOWNTREND CONFIRMED" :
                   "CHOP / NO TREND"}
                </span>
              </div>

              {/* Grid of swing points */}
              <div className="grid grid-cols-2 gap-2 text-[11px] font-mono">
                <div className="bg-white/70 border border-slate-100 rounded-lg p-2 flex flex-col justify-between">
                  <span className="text-[9px] text-slate-400">HIGHER HIGH (HH)</span>
                  <span className="font-semibold text-slate-800 mt-1">
                    {status.market_structure?.current_HH ? `$${safeFormatNumber(status.market_structure.current_HH.price)}` : "None Detected"}
                  </span>
                </div>
                <div className="bg-white/70 border border-slate-100 rounded-lg p-2 flex flex-col justify-between">
                  <span className="text-[9px] text-slate-400">HIGHER LOW (HL)</span>
                  <span className="font-semibold text-slate-800 mt-1">
                    {status.market_structure?.current_HL ? `$${safeFormatNumber(status.market_structure.current_HL.price)}` : "None Detected"}
                  </span>
                </div>
                <div className="bg-white/70 border border-slate-100 rounded-lg p-2 flex flex-col justify-between">
                  <span className="text-[9px] text-slate-400">LOWER HIGH (LH)</span>
                  <span className="font-semibold text-slate-800 mt-1">
                    {status.market_structure?.current_LH ? `$${safeFormatNumber(status.market_structure.current_LH.price)}` : "None Detected"}
                  </span>
                </div>
                <div className="bg-white/70 border border-slate-100 rounded-lg p-2 flex flex-col justify-between">
                  <span className="text-[9px] text-slate-400">LOWER LOW (LL)</span>
                  <span className="font-semibold text-slate-800 mt-1">
                    {status.market_structure?.current_LL ? `$${safeFormatNumber(status.market_structure.current_LL.price)}` : "None Detected"}
                  </span>
                </div>
              </div>

              {/* Pullback condition display */}
              <div className="text-[10px] leading-relaxed bg-white/70 border border-slate-100 rounded-lg p-2.5 space-y-1">
                <div className="flex justify-between">
                  <span className="text-slate-400">Long Pullback Met:</span>
                  <span className={`font-semibold ${status.market_structure?.pullbackLongMet ? "text-emerald-600" : "text-slate-500"}`}>
                    {status.market_structure?.pullbackLongMet ? `YES (Retest/Fib/EMA${status.market_structure_config?.fast_ema_period || 20})` : "Waiting..."}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400">Short Pullback Met:</span>
                  <span className={`font-semibold ${status.market_structure?.pullbackShortMet ? "text-rose-600" : "text-slate-500"}`}>
                    {status.market_structure?.pullbackShortMet ? `YES (Retest/Fib/EMA${status.market_structure_config?.fast_ema_period || 20})` : "Waiting..."}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Dynamic Position Status */}
        <div className="bg-white border border-slate-200 shadow-sm rounded-2xl p-5 flex-1 flex flex-col justify-between min-h-[300px]" id="active-position-card">
          <div>
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Activity className="w-5 h-5 text-indigo-600" />
                <span className="font-sans font-semibold text-slate-800 text-sm">Active Position</span>
              </div>
              {activeTrade && (
                <span className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold uppercase tracking-wider ${
                  activeTrade.direction === TradeDirection.LONG ? "bg-emerald-50 border border-emerald-200 text-emerald-700" : "bg-rose-50 border border-rose-200 text-rose-700"
                }`}>
                  {activeTrade.direction}
                </span>
              )}
            </div>

            <AnimatePresence mode="wait">
              {activeTrade ? (
                <motion.div
                  key="active-trade-info"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  className="space-y-4"
                >
                  <div className="flex justify-between items-end border-b border-slate-100 pb-3">
                    <div>
                      <p className="text-[10px] font-mono text-slate-400 uppercase tracking-wider">Real-Time P&L</p>
                      <p className={`text-2xl font-sans font-extrabold mt-1 leading-none ${activeTrade.pnl_usdt && activeTrade.pnl_usdt >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
                        {activeTrade.pnl_usdt && activeTrade.pnl_usdt >= 0 ? "+" : ""}
                        ${activeTrade.pnl_usdt?.toFixed(2)}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-[10px] font-mono text-slate-400 uppercase tracking-wider">Leverage</p>
                      <p className="text-xs font-sans font-bold text-slate-700 mt-1">{activeTrade.leverage}x Cross</p>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-y-3 gap-x-4 text-xs text-slate-600">
                    <div>
                      <p className="font-mono text-slate-400 uppercase text-[10px]">Entry Price</p>
                      <p className="font-sans font-semibold text-slate-800 mt-0.5">${safeFormatNumber(activeTrade.entry_price)}</p>
                    </div>
                    <div>
                      <p className="font-mono text-slate-400 uppercase text-[10px]">Position Size</p>
                      <p className="font-sans font-semibold text-slate-800 mt-0.5">{activeTrade.quantity_btc} BTC</p>
                    </div>
                    <div>
                      <p className="font-mono text-slate-400 uppercase text-[10px]">Model Confidence</p>
                      <p className="font-sans font-semibold text-slate-800 mt-0.5">{(activeTrade.catboost_probability * 100).toFixed(1)}%</p>
                    </div>
                    <div>
                      <p className="font-mono text-slate-400 uppercase text-[10px]">Hold Progress</p>
                      <p className="font-sans font-semibold text-slate-800 mt-0.5">{formatCountdown(activeTrade.hold_duration_seconds)}</p>
                    </div>
                    <div>
                      <p className="font-mono text-indigo-500 uppercase text-[10px] font-bold">Active SL (Trailing)</p>
                      <p className="font-sans font-bold text-indigo-600 mt-0.5">
                        {activeTrade.feature_snapshot?.current_stop_loss_price
                          ? `$${safeFormatNumber(activeTrade.feature_snapshot.current_stop_loss_price)}`
                          : "Calculating..."}
                      </p>
                    </div>
                    <div>
                      <p className="font-mono text-emerald-600 uppercase text-[10px] font-bold">Favorable Peak</p>
                      <p className="font-sans font-bold text-emerald-600 mt-0.5">
                        {activeTrade.feature_snapshot?.peak_price || activeTrade.feature_snapshot?.valley_price
                          ? `$${safeFormatNumber(activeTrade.feature_snapshot.peak_price || activeTrade.feature_snapshot.valley_price)}`
                          : `$${safeFormatNumber(activeTrade.entry_price)}`}
                      </p>
                    </div>
                  </div>

                  {/* hold progress bar out of 29 minutes */}
                  <div className="space-y-1 mt-2">
                    <div className="w-full bg-slate-100 h-2 rounded-full overflow-hidden border border-slate-200">
                      <div
                        className="bg-indigo-600 h-full transition-all duration-1000 rounded-full"
                        style={{ width: `${Math.min(100, (activeTrade.hold_duration_seconds / (29 * 60)) * 100)}%` }}
                      ></div>
                    </div>
                    <p className="text-[10px] font-mono text-slate-400 text-right">Hard deadline in 29 min</p>
                  </div>
                </motion.div>
              ) : (
                <motion.div
                  key="no-active-trade"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="flex flex-col items-center justify-center py-10 text-center"
                >
                  <Activity className="w-8 h-8 text-slate-300 animate-pulse mb-3" />
                  <p className="text-sm font-sans font-semibold text-slate-500">Scanning BTC Markets</p>
                  <p className="text-xs font-mono text-slate-400 mt-1 max-w-[200px] leading-relaxed">
                    {isTradingActive ? "Checking 10+ entry parameters on every candle close..." : "Bot is paused. Start scanning to initiate execution."}
                  </p>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {activeTrade && (
            <button
              onClick={handleForceExit}
              disabled={isExiting}
              className="w-full bg-rose-50 hover:bg-rose-100 border border-rose-200 text-rose-700 text-xs font-bold font-sans py-2.5 rounded-lg transition-colors duration-200 mt-6 cursor-pointer flex items-center justify-center gap-1.5"
              id="btn-force-exit"
            >
              <Square className="w-3 h-3 fill-current" />
              FORCE EXECUTING EXIT (MARKET)
            </button>
          )}
        </div>
      </div>

      {/* ================= COLUMN 2 & 3: CHARTS & TELEMETRY ================= */}
      <div className="xl:col-span-2 flex flex-col gap-6" id="dashboard-col-chart">
        {/* Ticker Pricing Strip */}
        <div className="bg-white border border-slate-200 shadow-sm rounded-2xl p-4 flex flex-wrap items-center justify-between gap-4" id="ticker-strip">
          <div className="flex items-center gap-3">
            <span className="p-2 bg-indigo-50 rounded-xl text-indigo-600 border border-indigo-100">
              <BarChart2 className="w-5 h-5" />
            </span>
            <div>
              <p className="text-[10px] font-mono text-slate-400 uppercase leading-none">Bitcoin (USDT)</p>
              <p className="text-xl font-sans font-bold text-slate-800 mt-1 leading-none">
                ${safeFormatNumber(status.current_price, 2, 2)}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-6 text-sm">
            <div>
              <p className="text-[9px] font-mono text-slate-400 uppercase leading-none">Current Regime</p>
              <div className="flex items-center gap-1.5 mt-1 leading-none">
                <span className={`w-1.5 h-1.5 rounded-full ${status.current_regime === MarketRegime.RANGE_BOUND || status.current_regime === MarketRegime.LOW_VOLATILITY ? "bg-amber-500" : "bg-emerald-500"}`} />
                <span className="font-sans font-bold text-slate-700 uppercase text-xs">{status.current_regime?.replace("_", " ")}</span>
              </div>
            </div>

            {status.regime_change_cooldown_remaining_seconds !== undefined && status.regime_change_cooldown_remaining_seconds !== null && (
              <div>
                <p className="text-[9px] font-mono text-slate-400 uppercase leading-none">Regime Cooldown</p>
                <div className="flex items-center gap-1.5 mt-1 leading-none text-amber-600 font-sans font-bold text-xs animate-pulse">
                  <RotateCw className="w-3 h-3 animate-spin" />
                  PAUSED ({Math.ceil(status.regime_change_cooldown_remaining_seconds / 60)}m left)
                </div>
              </div>
            )}

            <div>
              <p className="text-[9px] font-mono text-slate-400 uppercase leading-none">Economic Protection</p>
              {status.critical_event_active ? (
                <div className="flex items-center gap-1.5 mt-1 leading-none text-rose-600">
                  <ShieldAlert className="w-3.5 h-3.5 animate-bounce" />
                  <span className="font-sans font-bold uppercase text-xs">BLOCKED ({status.critical_event_keyword})</span>
                </div>
              ) : (
                <p className="font-sans font-bold text-emerald-600 text-xs mt-1">SHIELD ACTIVE (PASSING)</p>
              )}
            </div>
          </div>
        </div>

        {/* Main Chart Card */}
        <div className="bg-white border border-slate-200 shadow-sm rounded-2xl p-5 flex flex-col justify-between" id="chart-card">
          <div>
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <TrendingUp className="w-5 h-5 text-indigo-600" />
                <span className="font-sans font-semibold text-slate-800 text-sm">Live Futures Tracker (1-Min candles)</span>
              </div>
              <div className="flex items-center gap-3 text-[10px] font-mono text-slate-400">
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 bg-emerald-500 rounded-sm" /> Bullish
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 bg-rose-500 rounded-sm" /> Bearish
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-2.5 h-0.5 bg-blue-500" /> EMA 21
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-2.5 h-0.5 bg-amber-500" /> EMA 50
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-2.5 h-0.5 bg-violet-500" /> VWAP
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-2.5 h-0.5 bg-rose-400" /> VWAP Bands
                </span>
              </div>
            </div>

            {/* Price Candlestick chart */}
            <div className="h-[280px] w-full" id="live-futures-chart">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={chartData} margin={{ top: 5, right: 5, left: 10, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                  <XAxis dataKey="time" stroke="#94a3b8" fontSize={10} tickLine={false} axisLine={false} />
                  <YAxis
                    domain={["auto", "auto"]}
                    stroke="#94a3b8"
                    fontSize={10}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(val) => `$${val}`}
                  />
                  <Tooltip content={<CustomTooltip />} />
                  
                  {/* Invisible bounds for high/low to force perfect YAxis auto-scaling */}
                  <Line type="monotone" dataKey="high" stroke="none" dot={false} activeDot={false} legendType="none" />
                  <Line type="monotone" dataKey="low" stroke="none" dot={false} activeDot={false} legendType="none" />
                  
                  {/* Candlestick bodies and wicks */}
                  <Bar dataKey="candlestickRange" shape={<CandlestickBar />} />
                  
                  {/* EMA overlays */}
                  <Line type="monotone" dataKey="ema21" stroke="#3b82f6" strokeWidth={1.5} dot={false} strokeDasharray="3 3" />
                  <Line type="monotone" dataKey="ema50" stroke="#f59e0b" strokeWidth={1.5} dot={false} strokeDasharray="4 4" />

                  {/* VWAP overlays */}
                  <Line type="monotone" dataKey="vwap" stroke="#8b5cf6" strokeWidth={1.5} dot={false} strokeDasharray="5 5" />
                  <Line type="monotone" dataKey="vwap_upper" stroke="#f43f5e" strokeWidth={1} dot={false} strokeDasharray="2 2" />
                  <Line type="monotone" dataKey="vwap_lower" stroke="#f43f5e" strokeWidth={1} dot={false} strokeDasharray="2 2" />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="border-t border-slate-100 pt-4 mt-2 flex justify-between items-center text-xs">
            <span className="font-mono text-slate-400">Live feed aggregated with Binance Liquidity</span>
            <button
              onClick={onRefresh}
              className="flex items-center gap-1 text-indigo-600 hover:text-indigo-700 font-semibold font-sans cursor-pointer"
            >
              <RotateCw className="w-3 h-3" /> Refresh Feed
            </button>
          </div>
        </div>

        {/* Telemetry Console Card */}
        <div className="bg-white border border-slate-200 shadow-sm rounded-2xl p-5" id="telemetry-logs-card">
          <div className="flex items-center justify-between mb-3 border-b border-slate-100 pb-2">
            <div className="flex items-center gap-2">
              <Terminal className="w-4 h-4 text-emerald-600" />
              <span className="font-mono text-slate-800 text-xs uppercase tracking-wider font-semibold">Live Telemetry Terminal</span>
            </div>
            <span className="text-[10px] font-mono text-slate-400 uppercase">Polling Active</span>
          </div>

          <div className="bg-slate-900 rounded-xl p-3 font-mono text-[10px] text-slate-300 h-[120px] overflow-y-auto space-y-1.5 border border-slate-800 shadow-inner" id="terminal-screen">
            {recentLogs.map((log, index) => (
              <div key={index} className="leading-relaxed break-all">
                <span className="text-emerald-400">{">"}</span> {log}
              </div>
            ))}
            {recentLogs.length === 0 && <p className="text-slate-500 text-center py-5 italic">No logs available in current buffer...</p>}
          </div>
        </div>
      </div>

      {/* ================= COLUMN 4: 3-LAYER SCORING & RSS HEADLINES ================= */}
      <div className="xl:col-span-1 flex flex-col gap-6" id="dashboard-col-scoring">
        {/* ML Ensemble Router Card */}
        <div className="bg-white border border-slate-200 shadow-sm rounded-2xl p-5" id="ensemble-router-card">
          <div className="flex items-center justify-between mb-4 border-b border-slate-100 pb-2">
            <div className="flex items-center gap-2">
              <Cpu className="w-4.5 h-4.5 text-indigo-600 animate-pulse" />
              <span className="font-sans font-semibold text-slate-800 text-xs uppercase tracking-wider">ML Ensemble Router</span>
            </div>
            <span className="text-[10px] font-mono text-slate-400">Ensemble Router</span>
          </div>

          <div className="space-y-4">
            {/* Active Model Routing */}
            <div className="bg-indigo-50/45 border border-indigo-100/50 rounded-xl p-3">
              <p className="text-[9px] font-mono text-indigo-500 uppercase tracking-wider font-semibold">Active Pipeline Model</p>
              <p className="text-xs font-sans font-extrabold text-slate-800 mt-1 flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-indigo-600 animate-pulse" />
                {status.active_ml_model || "Trend-Following CatBoost Model"}
              </p>
              <p className="text-[10px] text-slate-500 mt-1 leading-relaxed">
                {status.active_ml_model?.includes("Trend") 
                  ? "Optimized for high-momentum directional trend environments."
                  : "Optimized for low-volatility sideways mean-reverting ranges."}
              </p>
            </div>
          </div>
        </div>

        {/* Layer 3: CatBoost Probability Gauge */}
        <div className="bg-white border border-slate-200 shadow-sm rounded-2xl p-5" id="layer3-prediction-card">
          <div className="flex items-center justify-between mb-4 border-b border-slate-100 pb-2">
            <div className="flex items-center gap-2">
              <Cpu className="w-4.5 h-4.5 text-indigo-600" />
              <span className="font-sans font-semibold text-slate-800 text-xs uppercase tracking-wider">Layer 3: Prediction</span>
            </div>
            <span className="text-[10px] font-mono text-slate-400">CatBoost ML</span>
          </div>

          {/* Probability Bars */}
          <div className="space-y-4">
            <div>
              <div className="flex justify-between text-xs mb-1">
                <span className="text-emerald-600 font-sans font-semibold">LONG Probability</span>
                <span className="font-mono font-bold text-slate-700">
                  {signals.length > 0 ? (signals[0].catboost_probability * 100).toFixed(1) : "50.0"}%
                </span>
              </div>
              <div className="w-full bg-slate-100 h-2 rounded-full overflow-hidden border border-slate-200">
                <div
                  className="bg-emerald-500 h-full rounded-full transition-all duration-500"
                  style={{ width: `${signals.length > 0 ? signals[0].catboost_probability * 100 : 50}%` }}
                ></div>
              </div>
            </div>

            <div>
              <div className="flex justify-between text-xs mb-1">
                <span className="text-rose-600 font-sans font-semibold">SHORT Probability</span>
                <span className="font-mono font-bold text-slate-700">
                  {signals.length > 0 ? ((1 - signals[0].catboost_probability) * 100).toFixed(1) : "50.0"}%
                </span>
              </div>
              <div className="w-full bg-slate-100 h-2 rounded-full overflow-hidden border border-slate-200">
                <div
                  className="bg-rose-500 h-full rounded-full transition-all duration-500"
                  style={{ width: `${signals.length > 0 ? (1 - signals[0].catboost_probability) * 100 : 50}%` }}
                ></div>
              </div>
            </div>

            {/* Entry scoring gauge */}
            <div className="bg-slate-50 p-3 rounded-xl border border-slate-100 flex justify-between items-center mt-2">
              <div>
                <p className="text-[10px] font-mono text-slate-400 uppercase leading-none">Entry Score</p>
                <p className="text-lg font-sans font-black text-indigo-600 mt-1.5">
                  {signals.length > 0 && signals[0].direction !== "NEUTRAL" ? (signals[0].all_conditions_met ? 92 : 45) : 10}/100
                </p>
              </div>
              <div className="text-right">
                <p className="text-[9px] font-mono text-slate-400 uppercase leading-none">Min Threshold</p>
                <p className="text-xs font-sans font-bold text-slate-500 mt-1.5">80/100</p>
              </div>
            </div>
          </div>
        </div>

        {/* RSS News Sentiment Timeline */}
        <div className="bg-white border border-slate-200 shadow-sm rounded-2xl p-5 flex-1 flex flex-col h-[320px]" id="layer2-sentiment-timeline-card">
          <div className="flex items-center justify-between mb-3 border-b border-slate-100 pb-2 flex-shrink-0">
            <div className="flex items-center gap-2">
              <Newspaper className="w-4.5 h-4.5 text-indigo-600" />
              <span className="font-sans font-semibold text-slate-800 text-xs uppercase tracking-wider">Layer 2: Live RSS Headlines</span>
            </div>
            <span className="text-[10px] font-mono text-slate-400">Live Scrapes</span>
          </div>

          <div className="space-y-3 overflow-y-auto flex-1 pr-1" id="headlines-scroll">
            {headlines.slice(0, 8).map((hl) => (
              <div key={hl.id} className="bg-slate-50 border border-slate-100 rounded-xl p-2.5 hover:border-slate-200 transition-colors duration-200">
                <div className="flex justify-between items-start gap-2 mb-1.5">
                  <span className="px-1.5 py-0.5 bg-slate-200/55 text-slate-500 rounded text-[8px] font-mono border border-slate-200 uppercase">
                    {hl.source}
                  </span>
                </div>
                <p className="text-[10px] font-sans leading-relaxed text-slate-700 font-medium">{hl.headline}</p>
                <p className="text-[8px] font-mono text-slate-400 mt-1">{safeFormatTime(hl.timestamp)}</p>
              </div>
            ))}
            {headlines.length === 0 && <p className="text-slate-400 font-mono text-center text-[10px] py-10 italic">Waiting for incoming news ticker...</p>}
          </div>
        </div>
      </div>
    </div>
  );
}
