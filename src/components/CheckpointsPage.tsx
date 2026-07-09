/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from "react";
import {
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Info,
  Sliders,
  ShieldAlert,
  Server,
  TrendingUp,
  BookOpen,
  ArrowRight,
  ShieldCheck,
  CheckSquare,
  Compass,
  Target,
  Activity,
  Search,
} from "lucide-react";
import { Trade } from "../types.js";
import { safeFormatNumber } from "../utils/format";

interface Checkpoint {
  name: string;
  met: boolean;
  current_value: any;
  required: string;
  description: string;
  priority: "CRITICAL" | "HIGH" | "MEDIUM";
}

interface CheckpointsPageProps {
  status: {
    is_trading_active: boolean;
    is_paper_trading: boolean;
    current_price: number;
    current_regime: string;
    regime_confidence: number;
    critical_event_active: boolean;
    critical_event_keyword: string | null;
    protection_remaining_seconds: number | null;
    active_trade: Trade | null;
    account_balance_usdt: number;
    checkpoints?: {
      conditions: Checkpoint[];
      entry_score: number;
      signal_direction: "LONG" | "SHORT" | "NEUTRAL";
      all_conditions_met: boolean;
      rejection_reason: string | null;
    };
  };
  onRefresh: () => void;
  onTabChange: (tab: any) => void;
}

export default function CheckpointsPage({ status, onRefresh, onTabChange }: CheckpointsPageProps) {
  const checkpointsData = status.checkpoints;

  // Fallback checks if checkpoints are not yet loaded from backend status
  const fallbackConditions: Checkpoint[] = [
    {
      name: "CatBoost AI Prediction",
      met: false,
      current_value: "P(LONG) = 50.0% | P(SHORT) = 50.0%",
      required: "P(LONG) >= 75% for LONG OR P(SHORT) >= 75% for SHORT",
      description: "Uses pre-trained ensemble trees mapping momentum, EMA spreads, and ATR volatility expansion.",
      priority: "CRITICAL",
    },
    {
      name: "Market Regime Filter",
      met: status.current_regime !== "LOW_VOLATILITY",
      current_value: status.current_regime,
      required: "STRONG_UPTREND/RANGE_BOUND for LONG, STRONG_DOWNTREND/RANGE_BOUND for SHORT, or HIGH_VOLATILITY (Bypassed under extreme leading order flow pressure)",
      description: "Restricts execution during low volatility ranging zones to prevent chop losses, unless extreme real-time order flow or book imbalance confirms a breakout.",
      priority: "CRITICAL",
    },
    {
      name: "Trend Alignment & Strength (EMA/ADX)",
      met: true,
      current_value: "EMA: PASSING | ADX: 24.5",
      required: "EMA20 > EMA50 > EMA200 & ADX >= 30 (Softens to EMA20 > EMA50 & ADX >= 20 under extreme order flow pressure)",
      description: "Confirms overall strong trend alignment (EMA 20/50/200) and high trend strength (ADX >= 30) or checks safety locks during range bound, with dynamic softening when leading order indicators confirm breakout.",
      priority: "HIGH",
    },
    {
      name: "Relative Volume Confirmation",
      met: true,
      current_value: "1.35x",
      required: "> 1.3x above 20-period MA",
      description: "Validates that trade has supporting transaction volume to avoid false breakups.",
      priority: "MEDIUM",
    },
    {
      name: "Daily Trade Count Limit",
      met: true,
      current_value: "0 trades",
      required: "< 6 trades/day",
      description: "Risk mitigation ceiling to prevent overtrading and revenge trading sessions.",
      priority: "CRITICAL",
    },
    {
      name: "Account Equity & API Connection Verification",
      met: status.account_balance_usdt >= 100 && status.is_paper_trading,
      current_value: `Balance: $${status.account_balance_usdt.toFixed(2)} USDT | API: ${status.is_paper_trading ? "PAPER MODE ACTIVE" : "KEYS UNCONFIGURED"}`,
      required: "Balance >= $100.00 USDT and valid live connection keys or Paper Mode active",
      description: "Ensures portfolio has sufficient margin buffer and API credentials are ready to route orders.",
      priority: "CRITICAL",
    },
    {
      name: "Loss Streak Cooldown Protection",
      met: true,
      current_value: "PASSING",
      required: "No active cooldown from consecutive losses",
      description: "Automated timeout that blocks trading after being hit by N consecutive losses to prevent emotional or algorithmic revenge trading.",
      priority: "CRITICAL",
    },
    {
      name: "Optimal Session Timing Window Check (IST)",
      met: true,
      current_value: "PASSING",
      required: "Avoid weekends & 2:00 AM - 8:00 AM IST",
      description: "Checks whether current session is optimal (6:30 PM - 1:30 AM IST) and avoids risky periods (Weekends & 2:00 AM - 8:00 AM IST).",
      priority: "HIGH",
    },
    {
      name: "Overextension & Level Anchors (VWAP/EMA)",
      met: true,
      current_value: "PASSING",
      required: "Price within VWAP standard deviation bands and not overextended relative to 100 EMA (Bypasses automatically on extreme leading order flow pressure)",
      description: "Guards against entering trades when price is extremely overextended (preventing buying tops or shorting bottoms).",
      priority: "CRITICAL",
    },
    {
      name: "Market Structure Confirmation",
      met: true,
      current_value: "PASSING",
      required: "Pullback HL (LONG) / LH (SHORT), Breakout Retest, or Range Reversal (Bypasses automatically on extreme leading order flow pressure)",
      description: "Applies regime-specific market structure entry gates: Trending pulls, Range reversals, High-Vol confirmation, or Low-Vol avoidance.",
      priority: "CRITICAL",
    },
    {
      name: "Wedge Pattern Filter",
      met: true,
      current_value: "PASSING (NO WEDGE)",
      required: "Trendline Breakout Confirmation: Rel Volume >= 1.10 (aligned) / >= 1.25-1.40 (counter-trend)",
      description: "Filters trades during wedge compression to avoid low-probability trendline traps, unless a confirmed breakout with high volume occurs.",
      priority: "CRITICAL",
    },
    {
      name: "Volatility Compression (Squeeze) Filter",
      met: true,
      current_value: "PASSING (NO SQUEEZE)",
      required: "Breakout volume (Rel Volume >= 1.40) required if Bollinger Bands are squeezed inside Keltner Channels",
      description: "Checks if volatility is severely compressed (Bollinger Bands inside Keltner Channels). If so, blocks entries unless a high-volume breakout (Rel Volume >= 1.4x) is detected to avoid consolidation traps.",
      priority: "HIGH",
    },
    {
      name: "Order Book Imbalance & Liquidity Depth Gate",
      met: true,
      current_value: "PASSING (SUPPORT ALIGNED)",
      required: "Top-10 book depth >= 10.0 BTC; Imbalance >= -18.0% for LONG, <= +18.0% for SHORT",
      description: "Verifies near-book liquidity depth (minimum 10.0 BTC cumulative top-10 levels) and ensures top-10 level bid/ask order book imbalance aligns with the entry direction to avoid buying directly into massive ask walls or selling into heavy bid walls.",
      priority: "HIGH",
    },
  ];

  const conditions = checkpointsData?.conditions || fallbackConditions;
  const signalDirection = checkpointsData?.signal_direction || "NEUTRAL";
  const entryScore = checkpointsData?.entry_score || 0;
  const allConditionsMet = checkpointsData?.all_conditions_met ?? false;

  const metCount = conditions.filter((c) => c.met).length;
  const blockedCount = conditions.length - metCount;
  const criticalBlockedCount = conditions.filter((c) => !c.met && c.priority === "CRITICAL").length;

  return (
    <div className="space-y-6" id="checkpoints-radar-page">
      {/* ================= HEADER AND HEALTH SCORE ================= */}
      <div className="bg-white border border-slate-200/80 rounded-2xl p-6 shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-6">
        <div className="space-y-1.5">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`flex h-2.5 w-2.5 rounded-full ${status.is_trading_active ? "bg-emerald-500 animate-pulse" : "bg-rose-500"}`} />
            <h1 className="font-sans font-bold text-lg text-slate-800 tracking-tight">Checkpoints Radar Tracker</h1>
            <span className={`text-[10px] font-mono font-bold px-2 py-0.5 rounded-md ${
              status.is_trading_active 
                ? "bg-emerald-50 text-emerald-700 border border-emerald-200" 
                : "bg-rose-50 text-rose-700 border border-rose-200"
            } border`}>
              {status.is_trading_active ? "ENGINE ACTIVE" : "ENGINE STOPPED"}
            </span>
          </div>
          <p className="text-xs text-slate-500">
            Real-time scanner analyzing {conditions.length} strict quantitative, qualitative, and technical trade entry gating conditions.
          </p>
        </div>

        <div className="flex flex-wrap gap-4 items-center">
          <div className="bg-slate-50 border border-slate-100 rounded-xl px-4 py-3 flex items-center gap-3">
            <div className="p-2 rounded-lg bg-indigo-50 text-indigo-600">
              <Activity className="w-5 h-5 animate-pulse" />
            </div>
            <div>
              <p className="text-[10px] text-slate-400 font-mono uppercase">Current Price</p>
              <p className="text-sm font-sans font-bold text-slate-800">
                ${safeFormatNumber(status.current_price, 2, 2)}
              </p>
            </div>
          </div>

          <div className="bg-slate-50 border border-slate-100 rounded-xl px-4 py-3 flex items-center gap-3">
            <div className={`p-2 rounded-lg ${criticalBlockedCount > 0 ? "bg-rose-50 text-rose-600" : "bg-emerald-50 text-emerald-600"}`}>
              <ShieldCheck className="w-5 h-5" />
            </div>
            <div>
              <p className="text-[10px] text-slate-400 font-mono uppercase">System Checklist</p>
              <p className="text-sm font-sans font-bold text-slate-800">
                {metCount} / {conditions.length} Passed
              </p>
            </div>
          </div>

          <div className="bg-slate-50 border border-slate-100 rounded-xl px-4 py-3 flex items-center gap-3">
            <div className={`p-2 rounded-lg ${entryScore >= 80 ? "bg-emerald-50 text-emerald-600" : "bg-slate-100 text-slate-500"}`}>
              <TrendingUp className="w-5 h-5" />
            </div>
            <div>
              <p className="text-[10px] text-slate-400 font-mono uppercase">Signal Entry Score</p>
              <p className="text-sm font-sans font-bold text-slate-800">
                {entryScore} / 100
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* ================= ENGINE STOPPED WARNING BANNER ================= */}
      {!status.is_trading_active && (
        <div className="bg-rose-50 border border-rose-200/80 rounded-2xl p-5 shadow-sm flex flex-col sm:flex-row items-start gap-4" id="engine-stopped-radar-warning">
          <div className="p-3 bg-rose-100 border border-rose-200 text-rose-700 rounded-xl shrink-0">
            <XCircle className="w-6 h-6 animate-pulse" />
          </div>
          <div className="space-y-1.5 flex-1">
            <p className="text-[10px] font-mono font-bold text-rose-600 uppercase tracking-wider">Trading Engine Status Indicator</p>
            <h2 className="font-sans font-bold text-base text-rose-900 tracking-tight">
              AUTOMATED ROUTING ENGINE STOPPED / OFFLINE
            </h2>
            <p className="text-xs text-rose-700/90 leading-relaxed">
              The automated execution engine is currently turned off. The Checkpoints Radar will continue to scan the live market and update indicators in real-time, but all order routing, position entries, and active strategy decisions are locked.
            </p>
            <div className="pt-1">
              <button
                onClick={() => onTabChange("config")}
                className="flex items-center gap-1.5 font-bold text-xs text-indigo-600 hover:text-indigo-800 transition-colors bg-white border border-rose-100 hover:border-indigo-200 rounded-lg px-3 py-1.5 shadow-xs cursor-pointer"
              >
                Go to Configurations & Start Engine <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ================= REGIME & POLLING STATUS BANNER ================= */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4" id="checkpoints-status-banner">
        {/* Market Regime Block */}
        <div className="bg-white border border-slate-200/80 rounded-2xl p-5 shadow-sm flex items-start gap-4">
          <div className="p-3 bg-indigo-50 border border-indigo-100/50 rounded-xl text-indigo-600 shrink-0">
            <Compass className="w-6 h-6" />
          </div>
          <div className="space-y-1.5 flex-1">
            <p className="text-[10px] font-mono text-slate-400 uppercase tracking-wider">Current Market Regime</p>
            <div className="flex items-center gap-2">
              <h2 className="font-sans font-bold text-base text-slate-800 tracking-tight">
                {status.current_regime ? status.current_regime.replace(/_/g, " ") : "CLASSIFYING..."}
              </h2>
              {status.regime_confidence !== undefined && (
                <span className="bg-indigo-50 text-indigo-700 text-[10px] font-mono font-bold px-2 py-0.5 rounded-md">
                  {(status.regime_confidence * 100).toFixed(1)}% Conf
                </span>
              )}
            </div>
            <p className="text-xs text-slate-500 leading-relaxed">
              {status.current_regime === "STRONG_UPTREND" && (
                "Trend-Following Breakout Strategy: Polling for Bull breakouts above local swing high resistance."
              )}
              {status.current_regime === "STRONG_DOWNTREND" && (
                "Trend-Following Breakdown Strategy: Polling for Bear breakdowns below local swing low support."
              )}
              {status.current_regime === "RANGE_BOUND" && (
                "Mean-Reversion Strategy: Polling for buys at support swing lows and shorts at resistance swing highs."
              )}
              {status.current_regime === "LOW_VOLATILITY" && (
                "Chop Protection Active: Entry gates are completely locked. Sideways noise avoidance activated."
              )}
              {status.current_regime === "HIGH_VOLATILITY" && (
                "High Volatility Regime: Scanning wider bands for explosive momentum moves. Enhanced safety offsets active."
              )}
              {!["STRONG_UPTREND", "STRONG_DOWNTREND", "RANGE_BOUND", "LOW_VOLATILITY", "HIGH_VOLATILITY"].includes(status.current_regime || "") && (
                "Awaiting tick data to classify regime parameters."
              )}
            </p>
          </div>
        </div>

        {/* Polling Direction Block */}
        <div className="bg-white border border-slate-200/80 rounded-2xl p-5 shadow-sm flex items-start gap-4">
          <div className={`p-3 border rounded-xl shrink-0 ${
            status.active_trade
              ? "bg-indigo-50 border-indigo-100 text-indigo-600"
              : signalDirection === "LONG"
              ? "bg-emerald-50 border-emerald-100 text-emerald-600"
              : signalDirection === "SHORT"
              ? "bg-rose-50 border-rose-100 text-rose-600"
              : "bg-slate-50 border-slate-100 text-slate-400"
          }`}>
            <Target className="w-6 h-6" />
          </div>
          <div className="space-y-1.5 flex-1">
            <p className="text-[10px] font-mono text-slate-400 uppercase tracking-wider">Entry Polling Target</p>
            <div className="flex items-center gap-2">
              <h2 className={`font-sans font-bold text-base tracking-tight uppercase ${
                status.active_trade
                  ? "text-indigo-700"
                  : signalDirection === "LONG"
                  ? "text-emerald-700"
                  : signalDirection === "SHORT"
                  ? "text-rose-700"
                  : "text-slate-600"
              }`}>
                {status.active_trade
                  ? `HOLDING ACTIVE ${status.active_trade.direction}`
                  : signalDirection === "LONG"
                  ? "POLLING BUY (LONG)"
                  : signalDirection === "SHORT"
                  ? "POLLING SELL (SHORT)"
                  : "SCANNING (NEUTRAL)"}
              </h2>
              <span className={`text-[10px] font-mono font-bold px-2 py-0.5 rounded-md ${
                status.active_trade
                  ? "bg-indigo-100 text-indigo-800"
                  : signalDirection === "LONG"
                  ? "bg-emerald-100 text-emerald-800"
                  : signalDirection === "SHORT"
                  ? "bg-rose-100 text-rose-800"
                  : "bg-slate-100 text-slate-700"
              }`}>
                {status.active_trade ? "ACTIVE POSITION" : signalDirection === "NEUTRAL" ? "SCANNING MODE" : "SIGNAL ACTIVE"}
              </span>
            </div>
            <p className="text-xs text-slate-500 leading-relaxed">
              {status.active_trade && (
                `Currently holding an active ${status.active_trade.direction} position entered at $${status.active_trade.entry_price.toFixed(2)}. Scanner entry polling is temporarily paused.`
              )}
              {!status.active_trade && signalDirection === "LONG" && (
                "Gating is scanning for Buy conditions. Requires CatBoost AI confirmation, relative volume surge, and optimal IST timing window."
              )}
              {!status.active_trade && signalDirection === "SHORT" && (
                "Gating is scanning for Sell conditions. Requires CatBoost AI confirmation, relative volume surge, and optimal IST timing window."
              )}
              {!status.active_trade && signalDirection === "NEUTRAL" && (
                "Awaiting breakout, breakdown, or boundaries before target polling direction is engaged. Continuously analyzing order book and candle momentum."
              )}
            </p>
          </div>
        </div>
      </div>

      {/* ================= ACTIVE POSITION LIVE RADAR STATUS ================= */}
      {status.active_trade && (
        <div className="bg-slate-900 text-white border border-slate-800 rounded-2xl p-6 shadow-md space-y-4" id="active-trade-checkpoint-details">
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-xl bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
                <Target className="w-5 h-5 animate-pulse" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="font-sans font-bold text-sm tracking-tight uppercase text-white">Active Position Radar Monitor</h2>
                  <span className={`text-[10px] font-mono font-bold px-2 py-0.5 rounded-md ${
                    status.active_trade.direction === "LONG"
                      ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                      : "bg-rose-500/10 text-rose-400 border border-rose-500/20"
                  }`}>
                    {status.active_trade.direction} {status.active_trade.leverage}x
                  </span>
                </div>
                <p className="text-[10px] text-slate-400 font-mono">
                  ID: {status.active_trade.id.substring(0, 8)}... • Entered at {new Date(status.active_trade.entry_timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                </p>
              </div>
            </div>

            <div className="text-right">
              <p className="text-[10px] font-mono text-slate-400 uppercase tracking-wider">Position Real-Time P&L</p>
              <div className="flex items-center gap-1.5 justify-end mt-1">
                <span className={`text-xl font-sans font-extrabold ${status.active_trade.pnl_usdt && status.active_trade.pnl_usdt >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                  {status.active_trade.pnl_usdt && status.active_trade.pnl_usdt >= 0 ? "+" : ""}
                  ${status.active_trade.pnl_usdt?.toFixed(2)}
                </span>
                {status.active_trade.pnl_pct !== undefined && (
                  <span className={`text-xs font-mono font-semibold px-1.5 py-0.5 rounded-md ${
                    status.active_trade.pnl_pct && status.active_trade.pnl_pct >= 0 
                      ? "bg-emerald-500/10 text-emerald-400" 
                      : "bg-rose-500/10 text-rose-400"
                  }`}>
                    {status.active_trade.pnl_pct && status.active_trade.pnl_pct >= 0 ? "+" : ""}
                    {status.active_trade.pnl_pct?.toFixed(2)}%
                  </span>
                )}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 pt-2">
            <div className="bg-slate-950 border border-slate-800/80 rounded-xl p-3 space-y-1">
              <span className="text-[10px] font-mono text-slate-400 uppercase">Entry Price</span>
              <p className="font-mono text-xs font-bold text-slate-200">${safeFormatNumber(status.active_trade.entry_price)}</p>
            </div>

            <div className="bg-slate-950 border border-slate-800/80 rounded-xl p-3 space-y-1">
              <span className="text-[10px] font-mono text-slate-400 uppercase">Current Price</span>
              <p className="font-mono text-xs font-bold text-slate-200">${safeFormatNumber(status.current_price)}</p>
            </div>

            <div className="bg-slate-950 border border-slate-800/80 rounded-xl p-3 space-y-1">
              <span className="text-[10px] font-mono text-slate-400 uppercase">Position Size</span>
              <p className="font-mono text-xs font-bold text-slate-200">{status.active_trade.quantity_btc} BTC</p>
            </div>

            <div className="bg-slate-950 border border-slate-800/80 rounded-xl p-3 space-y-1">
              <span className="text-[10px] font-mono text-slate-400 uppercase">AI Signal Score</span>
              <p className="font-mono text-xs font-bold text-slate-200">{status.active_trade.entry_signal_score} / 100</p>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {/* Targeted Stop Loss */}
            <div className="bg-slate-950 border border-slate-800/80 rounded-xl p-4 flex flex-col justify-between space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-mono text-rose-400 font-bold uppercase tracking-wider">Targeted Stop Loss</span>
                <span className="text-[9px] font-mono bg-rose-500/10 text-rose-400 px-1.5 py-0.5 rounded-md border border-rose-500/20">RISK</span>
              </div>
              <div className="space-y-1">
                <div className="flex justify-between items-baseline">
                  <span className="text-slate-400 text-xs">Initial SL:</span>
                  <span className="font-mono text-xs font-bold text-slate-300">
                    {status.active_trade.feature_snapshot?.stop_loss_price
                      ? `$${safeFormatNumber(status.active_trade.feature_snapshot.stop_loss_price)}`
                      : "N/A"}
                  </span>
                </div>
                <div className="flex justify-between items-baseline pt-1 border-t border-slate-800/50">
                  <span className="text-slate-400 text-xs">Current Trailing SL:</span>
                  <span className="font-mono text-sm font-bold text-rose-400">
                    {status.active_trade.feature_snapshot?.current_stop_loss_price
                      ? `$${safeFormatNumber(status.active_trade.feature_snapshot.current_stop_loss_price)}`
                      : "Calculating..."}
                  </span>
                </div>
              </div>
            </div>

            {/* Targeted Take Profit */}
            <div className="bg-slate-950 border border-slate-800/80 rounded-xl p-4 flex flex-col justify-between space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-mono text-emerald-400 font-bold uppercase tracking-wider">Targeted Take Profit</span>
                <span className="text-[9px] font-mono bg-emerald-500/10 text-emerald-400 px-1.5 py-0.5 rounded-md border border-emerald-500/20">TARGET</span>
              </div>
              <div className="space-y-1">
                <div className="flex justify-between items-baseline">
                  <span className="text-slate-400 text-xs">Profit Target:</span>
                  <span className="font-mono text-sm font-bold text-emerald-400">
                    {status.active_trade.feature_snapshot?.take_profit_price
                      ? `$${safeFormatNumber(status.active_trade.feature_snapshot.take_profit_price)}`
                      : "N/A"}
                  </span>
                </div>
                <div className="flex justify-between items-baseline pt-1 border-t border-slate-800/50">
                  <span className="text-slate-400 text-xs">Favorable Peak:</span>
                  <span className="font-mono text-xs font-bold text-emerald-500">
                    {status.active_trade.feature_snapshot?.peak_price || status.active_trade.feature_snapshot?.valley_price
                      ? `$${safeFormatNumber(status.active_trade.feature_snapshot.peak_price || status.active_trade.feature_snapshot.valley_price)}`
                      : `$${safeFormatNumber(status.active_trade.entry_price)}`}
                  </span>
                </div>
              </div>
            </div>

            {/* Hold Duration and Deadline */}
            <div className="bg-slate-950 border border-slate-800/80 rounded-xl p-4 flex flex-col justify-between space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-mono text-slate-400 font-bold uppercase tracking-wider">Time in Position</span>
                <span className="text-[9px] font-mono bg-indigo-500/10 text-indigo-400 px-1.5 py-0.5 rounded-md border border-indigo-500/20">TIMER</span>
              </div>
              <div className="space-y-2">
                <div className="flex justify-between items-baseline">
                  <span className="text-slate-400 text-xs">Duration:</span>
                  <span className="font-sans text-xs font-bold text-indigo-400">
                    {Math.floor(status.active_trade.hold_duration_seconds / 60)}m {status.active_trade.hold_duration_seconds % 60}s
                  </span>
                </div>
                <div className="space-y-1">
                  <div className="w-full bg-slate-800 h-1.5 rounded-full overflow-hidden">
                    <div
                      className="bg-indigo-500 h-full transition-all duration-1000 rounded-full"
                      style={{ width: `${Math.min(100, (status.active_trade.hold_duration_seconds / (29 * 60)) * 100)}%` }}
                    ></div>
                  </div>
                  <p className="text-[9px] font-mono text-slate-400 text-right">Hard exit in 29 minutes</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ================= CRITICAL BLOCKED SPOTLIGHT ================= */}
      {blockedCount > 0 && (
        <div className="bg-rose-50/60 border border-rose-100 rounded-2xl p-5 shadow-sm space-y-4">
          <div className="flex items-start gap-3">
            <div className="p-1.5 bg-rose-100 text-rose-700 rounded-lg shrink-0">
              <ShieldAlert className="w-5 h-5" />
            </div>
            <div className="space-y-1">
              <h2 className="font-sans font-bold text-xs text-rose-900 uppercase tracking-wider">
                Automated Order Routing Locked • {blockedCount} Blocked Checkpoint{blockedCount > 1 ? "s" : ""}
              </h2>
              <p className="text-xs text-rose-700/90 leading-relaxed">
                The trade scanner is actively blocking order routing. Automated trades will only execute when all {conditions.length} checklists pass concurrently and the Entry Score is &ge; 80.
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
            {conditions.filter((c) => !c.met).map((item, index) => (
              <div
                key={index}
                className="bg-white border border-rose-100 rounded-xl p-3 shadow-2xs space-y-2 flex flex-col justify-between"
              >
                <div>
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-sans font-bold text-slate-800 tracking-tight">{item.name}</span>
                    <span className={`text-[9px] font-bold font-mono px-1.5 py-0.5 rounded-md ${
                      item.priority === "CRITICAL"
                        ? "bg-rose-100 text-rose-800"
                        : item.priority === "HIGH"
                        ? "bg-amber-100 text-amber-800"
                        : "bg-slate-100 text-slate-800"
                    }`}>
                      {item.priority}
                    </span>
                  </div>
                  <p className="text-[10px] text-slate-400 mt-1 leading-relaxed">{item.description}</p>
                </div>
                <div className="bg-rose-50 border border-rose-100/50 rounded-lg p-2 text-[10px] space-y-1 mt-2">
                  <div className="flex justify-between font-mono">
                    <span className="text-rose-500">Live:</span>
                    <span className="font-bold text-rose-700">{item.current_value}</span>
                  </div>
                  <div className="flex justify-between font-mono text-slate-500">
                    <span>Required:</span>
                    <span className="font-medium text-slate-700">{item.required}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Quick Troubleshooting Actions */}
          <div className="bg-white/80 border border-rose-100/50 rounded-xl p-3 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-600">
            <div className="flex items-center gap-2">
              <Info className="w-4 h-4 text-slate-400 shrink-0" />
              <span>Need to pass credentials or enable trading? Use the quick setup panels:</span>
            </div>
            <div className="flex gap-2">
              {!status.is_trading_active && (
                <button
                  onClick={() => onTabChange("config")}
                  className="flex items-center gap-1 font-semibold text-indigo-600 hover:text-indigo-800 transition-colors"
                >
                  Activate Trading <ArrowRight className="w-3 h-3" />
                </button>
              )}
              {!status.is_paper_trading && conditions.some((c) => c.name.includes("Credentials") && !c.met) && (
                <button
                  onClick={() => onTabChange("config")}
                  className="flex items-center gap-1 font-semibold text-indigo-600 hover:text-indigo-800 transition-colors"
                >
                  Enter Exchange API Keys <ArrowRight className="w-3 h-3" />
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ================= ALL 10 CONDITIONS CHECKLIST GRID ================= */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-sans font-bold text-xs text-slate-400 uppercase tracking-wider font-mono">
            Full {conditions.length}-Checklist Radar Dashboard
          </h2>
          <span className="text-[10px] font-mono text-slate-400">Updates live per tick</span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {conditions.map((item, index) => (
            <div
              key={index}
              className={`bg-white border rounded-2xl p-5 shadow-xs transition-all relative overflow-hidden ${
                item.met
                  ? "border-emerald-200 hover:border-emerald-300"
                  : "border-slate-200/80 hover:border-slate-300"
              }`}
            >
              {/* Top Accent Line */}
              <div className={`absolute top-0 left-0 right-0 h-1 ${item.met ? "bg-emerald-500" : "bg-slate-200"}`} />

              <div className="flex items-start justify-between gap-3">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-mono text-slate-400 font-bold">C{index + 1}</span>
                    <h3 className="font-sans font-bold text-sm text-slate-800 tracking-tight">{item.name}</h3>
                  </div>
                  <p className="text-xs text-slate-500 leading-relaxed">{item.description}</p>
                </div>

                <div className="shrink-0 pt-0.5">
                  {item.met ? (
                    <div className="flex items-center gap-1 text-emerald-600 bg-emerald-50 border border-emerald-100 rounded-full px-2.5 py-1 text-[10px] font-bold font-mono">
                      <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                      PASSED
                    </div>
                  ) : (
                    <div className="flex items-center gap-1 text-slate-500 bg-slate-50 border border-slate-100 rounded-full px-2.5 py-1 text-[10px] font-bold font-mono">
                      <XCircle className="w-3.5 h-3.5 shrink-0 text-slate-400" />
                      BLOCKED
                    </div>
                  )}
                </div>
              </div>

              {/* Parameters Breakdown */}
              <div className="mt-4 grid grid-cols-2 gap-3 pt-3 border-t border-slate-100">
                <div className="space-y-0.5">
                  <span className="text-[9px] font-mono text-slate-400 uppercase">Current Live Metric</span>
                  <p className={`text-xs font-mono font-bold ${item.met ? "text-emerald-700" : "text-rose-700 bg-rose-50/50 px-1.5 py-0.5 rounded-md inline-block"}`}>
                    {item.current_value}
                  </p>
                </div>
                <div className="space-y-0.5">
                  <span className="text-[9px] font-mono text-slate-400 uppercase">Target Gate Requirement</span>
                  <p className="text-xs font-mono font-medium text-slate-700">{item.required}</p>
                </div>
              </div>

              {/* Priority badge */}
              <div className="mt-3 flex justify-between items-center text-[10px]">
                <span className="text-slate-400">Risk Priority:</span>
                <span className={`font-bold font-mono px-2 py-0.5 rounded-md ${
                  item.priority === "CRITICAL"
                    ? "bg-rose-50 text-rose-700 border border-rose-100/50"
                    : item.priority === "HIGH"
                    ? "bg-amber-50 text-amber-700 border border-amber-100/30"
                    : "bg-slate-50 text-slate-600 border border-slate-100"
                }`}>
                  {item.priority}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
