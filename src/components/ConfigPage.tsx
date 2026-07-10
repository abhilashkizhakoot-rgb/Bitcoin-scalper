/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from "react";
import { apiFetch } from "../utils/api.ts";
import {
  Settings,
  Cpu,
  Shield,
  History,
  Save,
  Trash2,
  FolderOpen,
  ArrowLeftRight,
  Sparkles,
  TrendingUp,
  Clock,
  Globe,
  Sliders,
} from "lucide-react";
import { StrategyConfig, ConfigHistoryEntry, NewsSource } from "../types.js";

const AVAILABLE_GATES = [
  { id: "catboost", label: "CatBoost AI Prediction Threshold" },
  { id: "regime", label: "Market Regime Lock" },
  { id: "trend", label: "Exponential Trend Alignment" },
  { id: "volume", label: "Relative Volume Confirmation" },
  { id: "limit", label: "Daily Trade Count Limit" },
  { id: "adx", label: "ADX Trend Strength Filter" },
  { id: "equity", label: "Minimum Account Equity Check" },
  { id: "credentials", label: "Exchange API Credentials Validation" },
  { id: "cooldown", label: "Loss Streak Cooldown Protection" },
  { id: "timing", label: "Optimal Session Timing Window Check (IST)" },
  { id: "vwap", label: "VWAP Deviation Anchor Check" },
  { id: "wedge", label: "Wedge Pattern Filter" },
  { id: "ema100", label: "EMA 100 Overextension Protection" },
  { id: "structure", label: "Market Structure Confirmation" },
  { id: "orderflow", label: "Binance Order Flow Confirmation" },
  { id: "squeeze", label: "Volatility Compression (Squeeze) Filter" },
  { id: "orderbook", label: "Order Book Imbalance & Liquidity Depth Gate" },
];

interface ConfigPageProps {
  config: StrategyConfig;
  profiles: Record<string, StrategyConfig>;
  history: ConfigHistoryEntry[];
  onRefresh: () => void;
}

export default function ConfigPage({
  config,
  profiles,
  history,
  onRefresh,
}: ConfigPageProps) {
  const [activeTab, setActiveTab] = useState<"general" | "ml" | "sentiment" | "risk" | "profiles" | "history" | "market_structure">("general");
  const [newProfileName, setNewProfileName] = useState("");
  const [keywordInput, setKeywordInput] = useState("");
  const [isRetraining, setIsRetraining] = useState(false);
  const [retrainMsg, setRetrainMsg] = useState("");

  const handleRetrainModel = async () => {
    if (isRetraining) return;
    setIsRetraining(true);
    setRetrainMsg("Retraining job initiated on previous data...");
    try {
      const res = await apiFetch("/api/ml/retrain", {
        method: "POST"
      });
      if (res.ok) {
        const data = await res.json();
        setRetrainMsg(`Success: Walk-forward retraining job (${data.job_id}) started in background. Hot-deploying converged model parameters shortly!`);
        setTimeout(() => {
          onRefresh();
          // Read updated config after training completion (which takes ~4 seconds in simulation)
          apiFetch("/api/config").then(configRes => {
            if (configRes.ok) {
              configRes.json().then(latest => {
                if (latest && latest.ml_settings) {
                  setMlConfig(latest.ml_settings);
                }
              });
            }
          });
          setIsRetraining(false);
          setRetrainMsg("");
        }, 5000);
      } else {
        setRetrainMsg("Failed to start retraining job. Check backend logs.");
        setIsRetraining(false);
      }
    } catch (e) {
      setRetrainMsg("Error connecting to retraining service.");
      setIsRetraining(false);
    }
  };

  // Sub-tab State Mirroring
  const [generalConfig, setGeneralConfig] = useState(config.general);
  const [mlConfig, setMlConfig] = useState(config.ml_settings);
  const [sentimentConfig, setSentimentConfig] = useState(config.sentiment_settings);
  const [riskConfig, setRiskConfig] = useState(config.risk_management);
  const [msConfig, setMsConfig] = useState(config.market_structure || {
    min_breakout_body_ratio: 0.22,
    allow_immediate_breakout: true,
    hf_momentum_adx_threshold: 30,
    hf_orderflow_taker_buy_ratio_long: 0.58,
    hf_orderflow_imbalance_ratio_long: 0.30,
    hf_orderflow_taker_buy_ratio_short: 0.42,
    hf_orderflow_imbalance_ratio_short: -0.30,
    pullback_multiplier_limit: 0.6,
    ema_retrace_multiplier_limit: 0.4,
    bypass_ema200_on_momentum: true,
    ema200_proximity_divisor: 3.0,
    weak_trend_adx_threshold: 25,
    trend_alignment_adx_threshold: 30,
    super_trend_adx_threshold: 35,
    fast_ema_period: 20,
    medium_ema_period: 50,
    slow_ema_period: 200,
  });

  useEffect(() => {
    setGeneralConfig(config.general);
    setMlConfig(config.ml_settings);
    setSentimentConfig(config.sentiment_settings);
    setRiskConfig(config.risk_management);
    if (config.market_structure) {
      setMsConfig(config.market_structure);
    }
  }, [config]); // Run on config update

  const handleSaveCategory = async (category: string, data: any) => {
    try {
      const res = await apiFetch(`/api/config/${category}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (res.ok) {
        onRefresh();
        alert(`Success: ${category.toUpperCase()} parameters successfully committed to DB.`);
      }
    } catch (e) {
      alert("Failed to commit settings, check server connection.");
    }
  };

  const handleSaveRiskAndGeneral = async () => {
    try {
      const resGeneral = await apiFetch(`/api/config/general`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(generalConfig),
      });
      const resRisk = await apiFetch(`/api/config/risk_management`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(riskConfig),
      });
      if (resGeneral.ok && resRisk.ok) {
        onRefresh();
        alert("Success: General & Risk Management parameters successfully committed to DB.");
      } else {
        alert("Failed to commit settings, check server connection.");
      }
    } catch (e) {
      alert("Failed to commit settings, check server connection.");
    }
  };

  const toggleGateBypass = (gateId: string) => {
    const currentSkipped = generalConfig.skipped_gates || [];
    let updated: string[];
    if (currentSkipped.includes(gateId)) {
      updated = currentSkipped.filter((g) => g !== gateId);
    } else {
      updated = [...currentSkipped, gateId];
    }
    setGeneralConfig({ ...generalConfig, skipped_gates: updated });
  };

  const handleSaveProfile = async () => {
    if (!newProfileName.trim()) return;
    try {
      const res = await apiFetch("/api/config/profiles/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newProfileName, config }),
      });
      if (res.ok) {
        setNewProfileName("");
        onRefresh();
        alert(`Profile "${newProfileName}" successfully exported.`);
      }
    } catch (e) {
      alert("Failed to save profile.");
    }
  };

  const handleLoadProfile = async (name: string) => {
    try {
      const res = await apiFetch(`/api/config/profiles/load/${name}`, {
        method: "POST",
      });
      if (res.ok) {
        const loaded = await res.json();
        setGeneralConfig(loaded.general);
        setMlConfig(loaded.ml_settings);
        setSentimentConfig(loaded.sentiment_settings);
        setRiskConfig(loaded.risk_management);
        if (loaded.market_structure) {
          setMsConfig(loaded.market_structure);
        }
        onRefresh();
        alert(`Strategy Profile "${name}" successfully compiled and hot-deployed.`);
      }
    } catch (e) {
      alert("Failed to load profile.");
    }
  };

  const handleDeleteProfile = async (name: string) => {
    if (!confirm(`Are you sure you want to delete profile "${name}"?`)) return;
    try {
      const res = await apiFetch(`/api/config/profiles/${name}`, {
        method: "DELETE",
      });
      if (res.ok) {
        onRefresh();
      }
    } catch (e) {
      alert("Failed to delete profile.");
    }
  };

  const handleAddKeyword = () => {
    if (!keywordInput.trim()) return;
    const kw = keywordInput.trim();
    if (sentimentConfig.critical_keywords.includes(kw)) return;

    const updatedKw = [...sentimentConfig.critical_keywords, kw];
    setSentimentConfig({ ...sentimentConfig, critical_keywords: updatedKw });
    setKeywordInput("");
  };

  const handleRemoveKeyword = (kw: string) => {
    const updatedKw = sentimentConfig.critical_keywords.filter((k) => k !== kw);
    setSentimentConfig({ ...sentimentConfig, critical_keywords: updatedKw });
  };

  return (
    <div className="bg-white border border-slate-200 shadow-sm rounded-2xl p-6 min-h-[500px] flex flex-col md:flex-row gap-8">
      {/* Sidebar Tabs Selectors */}
      <div className="md:w-1/4 flex flex-col gap-1 border-r border-slate-100 pr-4 flex-shrink-0" id="config-tabs-sidebar">
        <button
          onClick={() => setActiveTab("general")}
          className={`flex items-center gap-3 px-4 py-3 rounded-lg text-xs font-sans font-semibold transition-all duration-150 cursor-pointer ${
            activeTab === "general" ? "bg-indigo-50 text-indigo-700 border border-indigo-100 shadow-sm" : "text-slate-500 hover:text-slate-700 hover:bg-slate-50"
          }`}
        >
          <Sliders className="w-4 h-4" />
          General Strategy Setup
        </button>

        <button
          onClick={() => setActiveTab("risk")}
          className={`flex items-center gap-3 px-4 py-3 rounded-lg text-xs font-sans font-semibold transition-all duration-150 cursor-pointer ${
            activeTab === "risk" ? "bg-indigo-50 text-indigo-700 border border-indigo-100 shadow-sm" : "text-slate-500 hover:text-slate-700 hover:bg-slate-50"
          }`}
        >
          <Shield className="w-4 h-4" />
          Risk & Safeguards
        </button>

        <button
          onClick={() => setActiveTab("ml")}
          className={`flex items-center gap-3 px-4 py-3 rounded-lg text-xs font-sans font-semibold transition-all duration-150 cursor-pointer ${
            activeTab === "ml" ? "bg-indigo-50 text-indigo-700 border border-indigo-100 shadow-sm" : "text-slate-500 hover:text-slate-700 hover:bg-slate-50"
          }`}
        >
          <Cpu className="w-4 h-4" />
          CatBoost AI Thresholds
        </button>

        <button
          onClick={() => setActiveTab("sentiment")}
          className={`flex items-center gap-3 px-4 py-3 rounded-lg text-xs font-sans font-semibold transition-all duration-150 cursor-pointer ${
            activeTab === "sentiment" ? "bg-indigo-50 text-indigo-700 border border-indigo-100 shadow-sm" : "text-slate-500 hover:text-slate-700 hover:bg-slate-50"
          }`}
        >
          <Globe className="w-4 h-4" />
          Sentiment & News Filter
        </button>

        <button
          onClick={() => setActiveTab("market_structure")}
          className={`flex items-center gap-3 px-4 py-3 rounded-lg text-xs font-sans font-semibold transition-all duration-150 cursor-pointer ${
            activeTab === "market_structure" ? "bg-indigo-50 text-indigo-700 border border-indigo-100 shadow-sm" : "text-slate-500 hover:text-slate-700 hover:bg-slate-50"
          }`}
        >
          <TrendingUp className="w-4 h-4" />
          Market Structure Setup
        </button>

        <button
          onClick={() => setActiveTab("profiles")}
          className={`flex items-center gap-3 px-4 py-3 rounded-lg text-xs font-sans font-semibold transition-all duration-150 cursor-pointer ${
            activeTab === "profiles" ? "bg-indigo-50 text-indigo-700 border border-indigo-100 shadow-sm" : "text-slate-500 hover:text-slate-700 hover:bg-slate-50"
          }`}
        >
          <FolderOpen className="w-4 h-4" />
          Strategy Profiles
        </button>

        <button
          onClick={() => setActiveTab("history")}
          className={`flex items-center gap-3 px-4 py-3 rounded-lg text-xs font-sans font-semibold transition-all duration-150 cursor-pointer ${
            activeTab === "history" ? "bg-indigo-50 text-indigo-700 border border-indigo-100 shadow-sm" : "text-slate-500 hover:text-slate-700 hover:bg-slate-50"
          }`}
        >
          <History className="w-4 h-4" />
          Rollback Audit History
        </button>
      </div>

      {/* Main Form Fields Container */}
      <div className="flex-1" id="config-form-content">
        {/* ================= GENERAL STRATEGY SETUP TAB ================= */}
        {activeTab === "general" && (
          <div className="space-y-6">
            <div>
              <h3 className="font-sans font-bold text-sm text-slate-800">General Strategy Setup</h3>
              <p className="text-xs text-slate-400 font-sans mt-1">Configure system execution environment, price feeds, indicator periods, timing windows, and entry checklist gates.</p>
            </div>

            {/* Section 1: Execution Mode */}
            <div className="bg-slate-50 border border-slate-200/60 rounded-xl p-4 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 shadow-sm">
              <div className="max-w-xl">
                <h4 className="text-xs font-bold font-sans text-slate-700 flex items-center gap-1.5 uppercase">
                  <Sliders className="w-4 h-4 text-indigo-500" />
                  Execution Environment Mode
                </h4>
                <p className="text-[11px] text-slate-400 mt-1 leading-relaxed">
                  Toggle between simulated paper execution with zero financial risk (where order fills, taker/maker fees, and GST are mathematically simulated on live order books) and real live capital trading on your Delta Exchange India account.
                </p>
              </div>
              <div className="flex gap-2 flex-shrink-0">
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      const res = await apiFetch("/api/trading/toggle-paper-mode", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ is_paper_trading: true }),
                      });
                      if (res.ok) {
                        onRefresh();
                        alert("Environment successfully toggled to PAPER TRADING.");
                      }
                    } catch (e) {
                      alert("Failed to toggle mode.");
                    }
                  }}
                  className={`px-4 py-2 text-xs font-semibold rounded-lg border transition-all cursor-pointer ${
                    generalConfig.is_paper_trading
                      ? "bg-amber-100 border-amber-200 text-amber-800"
                      : "bg-white border-slate-200 text-slate-500 hover:text-slate-700 hover:bg-slate-50"
                  }`}
                >
                  Paper Trading
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      const res = await apiFetch("/api/trading/toggle-paper-mode", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ is_paper_trading: false }),
                      });
                      if (res.ok) {
                        onRefresh();
                        alert("Environment successfully toggled to LIVE ACCOUNT.");
                      }
                    } catch (e) {
                      alert("Failed to toggle mode.");
                    }
                  }}
                  className={`px-4 py-2 text-xs font-semibold rounded-lg border transition-all cursor-pointer ${
                    !generalConfig.is_paper_trading
                      ? "bg-rose-600 border-rose-600 text-white"
                      : "bg-white border-slate-200 text-slate-500 hover:text-slate-700 hover:bg-slate-50"
                  }`}
                >
                  Live Account
                </button>
              </div>
            </div>

            {/* Section 2: Feed & Timeframe */}
            <div className="border border-slate-200/80 rounded-xl p-5 space-y-4 bg-white shadow-sm">
              <h4 className="text-xs font-bold text-slate-700 uppercase tracking-wider font-sans border-b border-slate-100 pb-2">
                Data Feed & Regime Timeframes
              </h4>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                <div className="space-y-1.5">
                  <label className="text-xs font-mono text-slate-400 uppercase">Price Data Feed Source</label>
                  <select
                    value={generalConfig.data_feed_source !== undefined ? generalConfig.data_feed_source : "BINANCE"}
                    onChange={(e) => setGeneralConfig({ ...generalConfig, data_feed_source: e.target.value as "BINANCE" | "DELTA_EXCHANGE" })}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 text-xs text-slate-800 focus:ring-1 focus:ring-indigo-400 focus:border-indigo-400 outline-none font-sans"
                    id="config-data-feed-source"
                  >
                    <option value="BINANCE">Binance Spot Feed (Standard / High Liquidity)</option>
                    <option value="DELTA_EXCHANGE">Delta Exchange Perpetual Feed (Native / Delta Spot)</option>
                  </select>
                  <p className="text-[10px] text-slate-400 leading-relaxed">
                    The external price feed used to drive real-time ticker feeds, aggregate candle records, and evaluate technical breakout indicators. Binance Spot provides deep global retail liquidity reference points, while Delta Exchange provides native local execution price alignment.
                  </p>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-mono text-slate-400 uppercase">Market Regime Candle Interval</label>
                  <select
                    value={generalConfig.regime_candle_interval_minutes !== undefined ? generalConfig.regime_candle_interval_minutes : 3}
                    onChange={(e) => setGeneralConfig({ ...generalConfig, regime_candle_interval_minutes: parseInt(e.target.value) || 3 })}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 text-xs text-slate-800 focus:ring-1 focus:ring-indigo-400 focus:border-indigo-400 outline-none font-sans"
                    id="config-regime-candle-interval"
                  >
                    <option value="1">1 Minute (Standard / Sensitive)</option>
                    <option value="3">3 Minutes (Optimized / Balanced)</option>
                    <option value="5">5 Minutes (Conservative / Less Noise)</option>
                    <option value="10">10 Minutes (Macro Trend View)</option>
                  </select>
                  <p className="text-[10px] text-slate-400 leading-relaxed">
                    Specifies the candle timeframe interval used for calculating standard deviations, rolling VWAP bands, and market regime direction locks. Higher values (like 3m or 5m) filter out short-term random noise, boosting trade probability.
                  </p>
                </div>
              </div>
            </div>

            {/* Section 3: Indicators & Order Book Thresholds */}
            <div className="border border-slate-200/80 rounded-xl p-5 space-y-4 bg-white shadow-sm">
              <h4 className="text-xs font-bold text-slate-700 uppercase tracking-wider font-sans border-b border-slate-100 pb-2">
                Breakout Indicators & Liquidity Depth Filters
              </h4>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                <div className="space-y-1.5">
                  <label className="text-xs font-mono text-slate-400 uppercase">Relative Volume Threshold (x)</label>
                  <input
                    type="number"
                    step="0.05"
                    min="0.1"
                    value={generalConfig.relative_volume_threshold !== undefined ? generalConfig.relative_volume_threshold : 1.3}
                    onChange={(e) => setGeneralConfig({ ...generalConfig, relative_volume_threshold: parseFloat(e.target.value) || 1.3 })}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 text-xs text-slate-800 focus:ring-1 focus:ring-indigo-400 focus:border-indigo-400 outline-none font-mono"
                    id="config-relative-volume-threshold"
                  />
                  <p className="text-[10px] text-slate-400 leading-relaxed">
                    Minimum volume multiplier above the 20-period simple moving average required to validate key levels breakout. Prevents entering trades on low-volume false breakouts.
                  </p>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-mono text-slate-400 uppercase">ADX Trend Strength Threshold</label>
                  <input
                    type="number"
                    step="0.5"
                    min="0.0"
                    max="100.0"
                    value={generalConfig.adx_threshold !== undefined ? generalConfig.adx_threshold : 22.0}
                    onChange={(e) => setGeneralConfig({ ...generalConfig, adx_threshold: parseFloat(e.target.value) || 22.0 })}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 text-xs text-slate-800 focus:ring-1 focus:ring-indigo-400 focus:border-indigo-400 outline-none font-mono"
                    id="config-adx-threshold"
                  />
                  <p className="text-[10px] text-slate-400 leading-relaxed">
                    Minimum value of the 14-period Average Directional Index (ADX) required to verify a solid structural trend. Values above 22 confirm sufficient macro-momentum to support break-out trades.
                  </p>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-mono text-slate-400 uppercase">Order Book Min Depth (BTC)</label>
                  <input
                    type="number"
                    step="0.5"
                    min="0.1"
                    value={generalConfig.order_book_min_depth !== undefined ? generalConfig.order_book_min_depth : 4.0}
                    onChange={(e) => setGeneralConfig({ ...generalConfig, order_book_min_depth: parseFloat(e.target.value) || 4.0 })}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 text-xs text-slate-800 focus:ring-1 focus:ring-indigo-400 focus:border-indigo-400 outline-none font-mono"
                    id="config-order-book-min-depth"
                  />
                  <p className="text-[10px] text-slate-400 leading-relaxed">
                    Minimum top-10 ask/bid level cumulative depth in BTC required to execute. Protects trades from massive slippage in illiquid order books during extreme sudden market crashes.
                  </p>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-mono text-slate-400 uppercase">Order Book Max Imbalance</label>
                  <input
                    type="number"
                    step="0.05"
                    min="0.0"
                    max="1.0"
                    value={generalConfig.order_book_max_imbalance !== undefined ? generalConfig.order_book_max_imbalance : 0.35}
                    onChange={(e) => setGeneralConfig({ ...generalConfig, order_book_max_imbalance: parseFloat(e.target.value) || 0.35 })}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 text-xs text-slate-800 focus:ring-1 focus:ring-indigo-400 focus:border-indigo-400 outline-none font-mono"
                    id="config-order-book-max-imbalance"
                  />
                  <p className="text-[10px] text-slate-400 leading-relaxed">
                    Maximum allowed imbalance between buy and sell order books. (e.g. 0.35 limits excess opposite-side pressure to 35% to prevent entering right before an immediate order wall reversion).
                  </p>
                </div>

                <div className="space-y-2 flex flex-col justify-end pb-1">
                  <label className="flex items-center gap-2.5 cursor-pointer font-sans select-none">
                    <input
                      type="checkbox"
                      checked={generalConfig.enable_orderflow_softening !== false}
                      onChange={(e) => setGeneralConfig({ ...generalConfig, enable_orderflow_softening: e.target.checked })}
                      className="rounded border-slate-300 bg-white text-indigo-600 focus:ring-indigo-400 h-4 w-4 cursor-pointer"
                      id="config-enable-orderflow-softening"
                    />
                    <span className="text-xs font-semibold text-slate-700">Enable Real-time Order Flow Softening</span>
                  </label>
                  <p className="text-[10px] text-slate-400 leading-relaxed pl-6.5">
                    Allows extreme real-time order book imbalance or high taker buy/sell ratios (highly localized buy/sell pressure) to dynamically bypass or "soften" trend and regime gates, allowing fast breakout entries.
                  </p>
                </div>

                <div className="space-y-2 flex flex-col justify-end pb-1">
                  <label className="flex items-center gap-2.5 cursor-pointer font-sans select-none">
                    <input
                      type="checkbox"
                      checked={generalConfig.enable_block_logging !== false}
                      onChange={(e) => setGeneralConfig({ ...generalConfig, enable_block_logging: e.target.checked })}
                      className="rounded border-slate-300 bg-white text-indigo-600 focus:ring-indigo-400 h-4 w-4 cursor-pointer"
                    />
                    <span className="text-xs font-semibold text-slate-700">Enable 1-Min Checklist Block Logging</span>
                  </label>
                  <p className="text-[10px] text-slate-400 leading-relaxed pl-6.5">
                    Actively logs standard polling checklists and any disqualified checkpoint gates to the terminal/file log every single minute. Helps with diagnostics and verification.
                  </p>
                </div>

                <div className="space-y-2 flex flex-col justify-end pb-1">
                  <label className="flex items-center gap-2.5 cursor-pointer font-sans select-none">
                    <input
                      type="checkbox"
                      checked={generalConfig.enable_trade_logging !== false}
                      onChange={(e) => setGeneralConfig({ ...generalConfig, enable_trade_logging: e.target.checked })}
                      className="rounded border-slate-300 bg-white text-indigo-600 focus:ring-indigo-400 h-4 w-4 cursor-pointer"
                      id="config-enable-trade-logging"
                    />
                    <span className="text-xs font-semibold text-slate-700">Enable Comprehensive Trade Logging</span>
                  </label>
                  <p className="text-[10px] text-slate-400 leading-relaxed pl-6.5">
                    Actively records all trade execution details, final parameters (SL, TP, ATR), and complete entry checkpoint gates status into the backend file <code className="bg-slate-100 text-indigo-600 font-mono text-[9px] px-1 py-0.5 rounded">trade_log</code> at entry/exit.
                  </p>
                </div>
              </div>
            </div>

            {/* Section 4: Timing & Session Windows */}
            <div className="border border-slate-200/80 rounded-xl p-5 space-y-4 bg-white shadow-sm">
              <div>
                <h4 className="text-xs font-bold font-sans text-slate-700 uppercase flex items-center gap-1.5">
                  <Clock className="w-4 h-4 text-indigo-500" />
                  Scalper Session Timing Windows (IST)
                </h4>
                <p className="text-[11px] text-slate-400 mt-1 leading-relaxed">
                  Configure active Indian Standard Time (IST) sessions during which automated trades are permitted. Disable periods of low volatility (e.g. dead liquidity hours) or weekends to minimize sideways churn and slippages.
                </p>
              </div>

              <div className="space-y-3 bg-slate-50 border border-slate-200/60 rounded-xl p-4">
                {(generalConfig.timing_windows || []).map((win, idx) => (
                  <div key={win.id || idx} className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4 p-3 bg-white border border-slate-100 rounded-lg hover:shadow-sm transition-all">
                    <div className="flex items-start gap-3 select-none">
                      <input
                        type="checkbox"
                        checked={win.allowed}
                        onChange={() => {
                          const updated = (generalConfig.timing_windows || []).map(w => w.id === win.id ? { ...w, allowed: !w.allowed } : w);
                          setGeneralConfig({ ...generalConfig, timing_windows: updated });
                        }}
                        className="mt-0.5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 h-4 w-4 shrink-0 cursor-pointer"
                        id={`timing-allow-${win.id}`}
                      />
                      <div className="space-y-0.5">
                        <span className={`text-xs font-semibold ${win.allowed ? "text-slate-800" : "text-slate-500 line-through decoration-slate-300"}`}>
                          {win.name}
                        </span>
                        <p className="text-[10px] text-slate-400 max-w-sm">
                          {win.description}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0 self-end md:self-auto">
                      <span className="text-[10px] font-mono text-slate-400 uppercase">IST Hours:</span>
                      <input
                        type="time"
                        value={win.start_time}
                        onChange={(e) => {
                          const updated = (generalConfig.timing_windows || []).map(w => w.id === win.id ? { ...w, start_time: e.target.value } : w);
                          setGeneralConfig({ ...generalConfig, timing_windows: updated });
                        }}
                        className="bg-slate-50 hover:bg-slate-100/50 border border-slate-200 rounded px-2 py-1 text-xs text-slate-700 font-mono focus:ring-1 focus:ring-indigo-400 outline-none transition-all"
                        disabled={win.id === "weekends"}
                      />
                      <span className="text-slate-400 text-xs">—</span>
                      <input
                        type="time"
                        value={win.end_time}
                        onChange={(e) => {
                          const updated = (generalConfig.timing_windows || []).map(w => w.id === win.id ? { ...w, end_time: e.target.value } : w);
                          setGeneralConfig({ ...generalConfig, timing_windows: updated });
                        }}
                        className="bg-slate-50 hover:bg-slate-100/50 border border-slate-200 rounded px-2 py-1 text-xs text-slate-700 font-mono focus:ring-1 focus:ring-indigo-400 outline-none transition-all"
                        disabled={win.id === "weekends"}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Section 5: Checkpoint Gates Bypass */}
            <div className="border border-slate-200/80 rounded-xl p-5 space-y-4 bg-white shadow-sm">
              <div>
                <h4 className="text-xs font-bold font-sans text-slate-700 uppercase flex items-center gap-1.5">
                  <Sparkles className="w-4 h-4 text-amber-500" />
                  Checkpoint Gates Bypass (Skip Gates)
                </h4>
                <p className="text-[11px] text-slate-400 mt-1 leading-relaxed">
                  Bypass specific checklist gate checks. Bypassed gates will always evaluate as TRUE and will not block automated signal execution. Use with caution to disable non-critical filters during active test sessions.
                </p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 bg-slate-50 border border-slate-200/60 rounded-xl p-4">
                {AVAILABLE_GATES.map((gate) => {
                  const isBypassed = (generalConfig.skipped_gates || []).includes(gate.id);
                  return (
                    <label
                      key={gate.id}
                      className="flex items-start gap-3 p-2.5 rounded-lg border hover:bg-white transition-all cursor-pointer select-none bg-slate-50 border-transparent hover:border-slate-200/80"
                    >
                      <input
                        type="checkbox"
                        checked={isBypassed}
                        onChange={() => toggleGateBypass(gate.id)}
                        className="mt-0.5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 h-4 w-4 shrink-0 cursor-pointer"
                      />
                      <div className="space-y-0.5">
                        <span className="text-xs font-sans font-medium text-slate-700">
                          {gate.label}
                        </span>
                        <p className="text-[10px] text-slate-400">
                          {isBypassed ? "✓ Force Passing (Skipped)" : "Active evaluation gate"}
                        </p>
                      </div>
                    </label>
                  );
                })}
              </div>
            </div>

            {/* Commit Button */}
            <div className="border-t border-slate-200 pt-5 flex justify-end">
              <button
                onClick={() => handleSaveCategory("general", generalConfig)}
                className="bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-sans font-semibold px-5 py-2.5 rounded-lg transition-colors duration-150 cursor-pointer shadow-sm"
              >
                COMMIT GENERAL PARAMETERS
              </button>
            </div>
          </div>
        )}

        {/* ================= RISK MANAGEMENT TAB ================= */}
        {activeTab === "risk" && (
          <div className="space-y-6">
            <div>
              <h3 className="font-sans font-bold text-sm text-slate-800">Risk Management & Protective Safeguards</h3>
              <p className="text-xs text-slate-400 font-sans mt-1">Configure position scaling, dynamic volatility-based stops, reward targets, trailing mechanisms, and circuit breakers.</p>
            </div>

            {/* Section 1: Position Sizing & Leverage */}
            <div className="border border-slate-200/80 rounded-xl p-5 space-y-4 bg-white shadow-sm">
              <h4 className="text-xs font-bold text-slate-700 uppercase tracking-wider font-sans border-b border-slate-100 pb-2">
                Position Sizing & Capital Leverage
              </h4>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-5 text-slate-600">
                <div className="space-y-1.5">
                  <label className="text-xs font-mono text-slate-400 uppercase">Default Trading Quantity (BTC)</label>
                  <input
                    type="number"
                    step="0.0001"
                    min="0.0001"
                    value={riskConfig.default_quantity_btc !== undefined ? riskConfig.default_quantity_btc : 0.001}
                    onChange={(e) => setRiskConfig({ ...riskConfig, default_quantity_btc: parseFloat(e.target.value) || 0.001 })}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 text-xs text-slate-800 focus:ring-1 focus:ring-indigo-400 focus:border-indigo-400 outline-none font-mono"
                    id="config-default-quantity-btc"
                  />
                  <p className="text-[10px] text-slate-400 leading-relaxed">
                    Standard trade position volume size in BTC used for automatic breakout signal execution and manual UI orders (e.g. 0.001 BTC scales exposure accordingly).
                  </p>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-mono text-slate-400 uppercase">Risk Per Trade (%)</label>
                  <input
                    type="number"
                    step="0.05"
                    value={riskConfig.risk_per_trade_pct}
                    onChange={(e) => setRiskConfig({ ...riskConfig, risk_per_trade_pct: parseFloat(e.target.value) || 0.1 })}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 text-xs text-slate-800 focus:ring-1 focus:ring-indigo-400 focus:border-indigo-400 outline-none font-mono"
                  />
                  <p className="text-[10px] text-slate-400 leading-relaxed">
                    Percentage of overall account capital risked per individual trade based on stop loss distance (Recommended: 0.5% - 1.0% to keep drawdowns small).
                  </p>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-mono text-slate-400 uppercase">Max Risk Per Trade (%)</label>
                  <input
                    type="number"
                    step="0.1"
                    value={riskConfig.max_risk_per_trade_pct}
                    onChange={(e) => setRiskConfig({ ...riskConfig, max_risk_per_trade_pct: parseFloat(e.target.value) || 1.0 })}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 text-xs text-slate-800 focus:ring-1 focus:ring-indigo-400 focus:border-indigo-400 outline-none font-mono"
                  />
                  <p className="text-[10px] text-slate-400 leading-relaxed">
                    Absolute maximum limit of account capital permitted to be risked on any single trade's stop-loss under high volatility.
                  </p>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-mono text-slate-400 uppercase">Max Trades Per Day</label>
                  <input
                    type="number"
                    value={generalConfig.max_trades_per_day}
                    onChange={(e) => setGeneralConfig({ ...generalConfig, max_trades_per_day: parseInt(e.target.value) || 8 })}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 text-xs text-slate-800 focus:ring-1 focus:ring-indigo-400 focus:border-indigo-400 outline-none font-mono"
                  />
                  <p className="text-[10px] text-slate-400 leading-relaxed">
                    Hard daily limit on the total number of trades executed by the bot. Prevents overtrading and protects capital during erratic, choppy consolidation (Standard: 8).
                  </p>
                </div>

                <div className="space-y-2 col-span-1 md:col-span-2 bg-indigo-50/40 border border-indigo-100/50 rounded-xl p-4 mt-1">
                  <div className="flex justify-between items-center">
                    <label className="text-xs font-semibold text-indigo-950 font-sans uppercase tracking-wider flex items-center gap-1.5">
                      <TrendingUp className="w-3.5 h-3.5 text-indigo-500" />
                      Target Leverage
                    </label>
                    <span className="font-mono text-xs font-bold bg-indigo-100 text-indigo-700 px-2.5 py-0.5 rounded-full">
                      {riskConfig.leverage || 20}x
                    </span>
                  </div>
                  <div className="flex items-center gap-4 mt-2">
                    <input
                      type="range"
                      min="1"
                      max="100"
                      step="1"
                      value={riskConfig.leverage || 20}
                      onChange={(e) => setRiskConfig({ ...riskConfig, leverage: parseInt(e.target.value) || 20 })}
                      className="flex-1 h-1.5 bg-indigo-100 rounded-lg appearance-none cursor-pointer accent-indigo-600"
                    />
                    <input
                      type="number"
                      min="1"
                      max="100"
                      value={riskConfig.leverage || 20}
                      onChange={(e) => setRiskConfig({ ...riskConfig, leverage: Math.max(1, Math.min(100, parseInt(e.target.value) || 1)) })}
                      className="w-16 bg-white border border-slate-200 rounded-lg p-1.5 text-center text-xs font-mono font-bold text-slate-800 focus:ring-1 focus:ring-indigo-400 outline-none"
                    />
                  </div>
                  <p className="text-[10px] text-indigo-600/80 mt-1 font-sans leading-relaxed">
                    Specifies position scaling on Delta Exchange India contract margin. High leverage multiplies buy/sell exposure relative to account balance, magnifying net profit potential but proportionally narrowing the liquidation safety corridor.
                  </p>
                </div>
              </div>
            </div>

            {/* Section 2: Stop Loss & Take Profit */}
            <div className="border border-slate-200/80 rounded-xl p-5 space-y-4 bg-white shadow-sm">
              <h4 className="text-xs font-bold text-slate-700 uppercase tracking-wider font-sans border-b border-slate-100 pb-2">
                Dynamic Stop Loss & Target Take Profit
              </h4>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-5 text-slate-600">
                <div className="space-y-1.5">
                  <label className="text-xs font-mono text-slate-400 uppercase">Stop Loss ATR Multiplier</label>
                  <input
                    type="number"
                    step="0.1"
                    value={riskConfig.stop_loss_atr_multiplier}
                    onChange={(e) => setRiskConfig({ ...riskConfig, stop_loss_atr_multiplier: parseFloat(e.target.value) || 1.0 })}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 text-xs text-slate-800 focus:ring-1 focus:ring-indigo-400 focus:border-indigo-400 outline-none font-mono"
                  />
                  <p className="text-[10px] text-slate-400 leading-relaxed">
                    Stop loss distance multiplier applied to Average True Range (14-period ATR). Dynamic SL adapts to historical 1m candle volatility, expanding stop distances during wide swings and narrowing them during tight ranges (Standard: 1.3 - 2.2).
                  </p>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-mono text-slate-400 uppercase">Take Profit Reward Ratio</label>
                  <input
                    type="number"
                    step="0.1"
                    value={riskConfig.take_profit_ratio}
                    onChange={(e) => setRiskConfig({ ...riskConfig, take_profit_ratio: parseFloat(e.target.value) || 3.5 })}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 text-xs text-slate-800 focus:ring-1 focus:ring-indigo-400 focus:border-indigo-400 outline-none font-mono"
                  />
                  <p className="text-[10px] text-slate-400 leading-relaxed">
                    Target Risk-to-Reward ratio (e.g., 3.5 means the profit target is set 3.5 times further than the stop loss distance). Ratios of 3.0+ are recommended to comfortably exceed exchange commissions and preserve positive expected return.
                  </p>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-mono text-slate-400 uppercase">Min Stop Loss (USD Floor)</label>
                  <input
                    type="number"
                    step="5"
                    value={riskConfig.min_stop_loss_distance_usd !== undefined ? riskConfig.min_stop_loss_distance_usd : 80}
                    onChange={(e) => setRiskConfig({ ...riskConfig, min_stop_loss_distance_usd: Math.max(0, parseFloat(e.target.value) || 0) })}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 text-xs text-slate-800 focus:ring-1 focus:ring-indigo-400 focus:border-indigo-400 outline-none font-mono"
                  />
                  <p className="text-[10px] text-slate-400 leading-relaxed">
                    Absolute minimum price distance allowed in USD for stop loss placement. Prevents excessively tight stops in BTC during consolidation, avoiding false stops by random noise before the actual breakout direction settles (Default: $80).
                  </p>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-mono text-slate-400 uppercase">Min Stop Loss (Price % Floor)</label>
                  <input
                    type="number"
                    step="0.01"
                    value={riskConfig.min_stop_loss_distance_pct !== undefined ? riskConfig.min_stop_loss_distance_pct : 0.12}
                    onChange={(e) => setRiskConfig({ ...riskConfig, min_stop_loss_distance_pct: Math.max(0, parseFloat(e.target.value) || 0) })}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 text-xs text-slate-800 focus:ring-1 focus:ring-indigo-400 focus:border-indigo-400 outline-none font-mono"
                  />
                  <p className="text-[10px] text-slate-400 leading-relaxed">
                    Absolute minimum stop loss percentage from the entry price. Protects trade executions from micro stop placements that fail to accommodate regular spread volatility and local exchange order routing slippage (Default: 0.12%).
                  </p>
                </div>

                <div className="space-y-2 col-span-1 md:col-span-2 border-t border-slate-100 pt-4 mt-2">
                  <label className="flex items-center gap-2.5 cursor-pointer font-sans select-none text-xs font-semibold text-slate-700 uppercase">
                    <input
                      type="checkbox"
                      checked={riskConfig.static_stop_loss_enabled === true}
                      onChange={(e) => setRiskConfig({ ...riskConfig, static_stop_loss_enabled: e.target.checked })}
                      className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 w-4 h-4 cursor-pointer"
                    />
                    Enable Static Stop Loss Override
                  </label>
                  <p className="text-[10px] text-slate-400 leading-relaxed">
                    When enabled, the dynamic ATR-based calculation is bypassed, and a fixed static stop loss price distance (configured below) is applied to all trades.
                  </p>
                </div>

                {riskConfig.static_stop_loss_enabled && (
                  <div className="space-y-1.5 col-span-1 md:col-span-2">
                    <label className="text-xs font-mono text-slate-400 uppercase">Static Stop Loss Value (USD Distance)</label>
                    <input
                      type="number"
                      step="10"
                      value={riskConfig.static_stop_loss_value_usd !== undefined ? riskConfig.static_stop_loss_value_usd : 150}
                      onChange={(e) => setRiskConfig({ ...riskConfig, static_stop_loss_value_usd: Math.max(10, parseFloat(e.target.value) || 10) })}
                      className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 text-xs text-slate-800 focus:ring-1 focus:ring-indigo-400 focus:border-indigo-400 outline-none font-mono"
                    />
                    <p className="text-[10px] text-slate-400 leading-relaxed">
                      Fixed USD price distance from the entry price to place the static stop loss (e.g., $150 means the stop loss will always be placed exactly $150 away from the entry price regardless of current ATR volatility).
                    </p>
                  </div>
                )}

                <div className="space-y-2 col-span-1 md:col-span-2 border-t border-slate-100 pt-4 mt-2">
                  <label className="flex items-center gap-2.5 cursor-pointer font-sans select-none text-xs font-semibold text-slate-700 uppercase">
                    <input
                      type="checkbox"
                      checked={riskConfig.max_atr_for_stop_loss_enabled === true}
                      onChange={(e) => setRiskConfig({ ...riskConfig, max_atr_for_stop_loss_enabled: e.target.checked })}
                      className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 w-4 h-4 cursor-pointer"
                    />
                    Enable Maximum ATR Stop Loss Cap
                  </label>
                  <p className="text-[10px] text-slate-400 leading-relaxed">
                    When enabled, if the current market ATR exceeds the Maximum ATR value defined below, the capped Maximum ATR value is used to calculate the trade entry's stop loss instead of the higher market ATR. This helps prevent excessively wide stop losses during sudden high-volatility spikes, and is not used for any other trade entry signals or strategy filters.
                  </p>
                </div>

                {riskConfig.max_atr_for_stop_loss_enabled && (
                  <div className="space-y-1.5 col-span-1 md:col-span-2">
                    <label className="text-xs font-mono text-slate-400 uppercase">Maximum ATR Value Cap</label>
                    <input
                      type="number"
                      step="5"
                      value={riskConfig.max_atr_for_stop_loss_value !== undefined ? riskConfig.max_atr_for_stop_loss_value : 100}
                      onChange={(e) => setRiskConfig({ ...riskConfig, max_atr_for_stop_loss_value: Math.max(1, parseFloat(e.target.value) || 1) })}
                      className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 text-xs text-slate-800 focus:ring-1 focus:ring-indigo-400 focus:border-indigo-400 outline-none font-mono"
                    />
                    <p className="text-[10px] text-slate-400 leading-relaxed">
                      The maximum capped ATR value used for multiplying by the stop loss ATR multiplier on trade entry.
                    </p>
                  </div>
                )}
              </div>
            </div>

            {/* Section 3: Trailing Stop Loss */}
            <div className="border border-slate-200/80 rounded-xl p-5 space-y-4 bg-white shadow-sm">
              <h4 className="text-xs font-bold text-slate-700 uppercase tracking-wider font-sans border-b border-slate-100 pb-2">
                Dynamic Trailing Stop Loss
              </h4>
              <div className="space-y-4">
                <div className="space-y-2">
                  <label className="flex items-center gap-2.5 cursor-pointer font-sans select-none">
                    <input
                      type="checkbox"
                      checked={riskConfig.trailing_stop_loss_enabled === true}
                      onChange={(e) => setRiskConfig({ ...riskConfig, trailing_stop_loss_enabled: e.target.checked })}
                      className="rounded border-slate-300 bg-white text-indigo-600 focus:ring-indigo-400 h-4 w-4 cursor-pointer"
                    />
                    <span className="text-xs font-semibold text-indigo-700 font-bold">Activate Dynamic Trailing Stop Loss</span>
                  </label>
                  <p className="text-[10px] text-slate-500 leading-relaxed pl-6.5">
                    When active, the stop loss price is dynamically moved in the profitable direction as the market price climbs. Once the price reverses, the position is immediately closed at the trailing stop, securing maximum trend payout.
                  </p>
                </div>

                {riskConfig.trailing_stop_loss_enabled && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pl-6.5">
                    <div className="space-y-1.5">
                      <label className="text-xs font-mono text-slate-400 uppercase">Trailing SL Distance (ATR Multiplier)</label>
                      <input
                        type="number"
                        step="0.1"
                        value={riskConfig.trailing_stop_loss_distance_atr !== undefined ? riskConfig.trailing_stop_loss_distance_atr : 1.8}
                        onChange={(e) => setRiskConfig({ ...riskConfig, trailing_stop_loss_distance_atr: parseFloat(e.target.value) || 1.8 })}
                        className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 text-xs text-slate-800 focus:ring-1 focus:ring-indigo-400 focus:border-indigo-400 outline-none font-mono"
                      />
                      <p className="text-[9px] text-slate-400 leading-relaxed text-slate-500">
                        Distance to trail behind the peak/valley, computed as ATR(14) * multiplier. Narrower trailing secures near-term gains faster; wider trailing captures longer trends (Standard: 1.2 - 2.0).
                      </p>
                    </div>

                    <div className="space-y-1.5">
                      <label className="text-xs font-mono text-slate-400 uppercase">Trailing Activation (Risk Multiple)</label>
                      <input
                        type="number"
                        step="0.1"
                        value={riskConfig.trailing_stop_loss_activation_ratio !== undefined ? riskConfig.trailing_stop_loss_activation_ratio : 1.2}
                        onChange={(e) => setRiskConfig({ ...riskConfig, trailing_stop_loss_activation_ratio: parseFloat(e.target.value) || 1.2 })}
                        className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 text-xs text-slate-800 focus:ring-1 focus:ring-indigo-400 focus:border-indigo-400 outline-none font-mono"
                      />
                      <p className="text-[9px] text-slate-400 leading-relaxed text-slate-500">
                        The multiple of the initial stop loss distance (risk) required in profit before trailing is armed (e.g., 1.2x means a 1:1.2 R:R profit level). Keeps stop loss wide early so the trade can breathe!
                      </p>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Section 4: Delta Fees & Indian GST */}
            <div className="border border-slate-200/80 rounded-xl p-5 space-y-4 bg-white shadow-sm">
              <h4 className="text-xs font-bold text-slate-700 uppercase tracking-wider font-sans border-b border-slate-100 pb-2">
                Delta Exchange India Fee Settings
              </h4>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-slate-600">
                <div className="space-y-2">
                  <label className="flex items-center gap-2.5 cursor-pointer font-sans select-none">
                    <input
                      type="checkbox"
                      checked={riskConfig.simulate_paper_fees !== false}
                      onChange={(e) => setRiskConfig({ ...riskConfig, simulate_paper_fees: e.target.checked })}
                      className="rounded border-slate-300 bg-white text-indigo-600 focus:ring-indigo-400 h-4 w-4 cursor-pointer"
                    />
                    <span className="text-xs font-semibold text-slate-700">Simulate Trading Fees</span>
                  </label>
                  <p className="text-[10px] text-slate-500 leading-relaxed pl-6.5">
                    Replicates realistic brokerage commissions on entry and exit during paper trading mode. Ensures performance metrics match real account trading net results.
                  </p>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-mono text-slate-500 uppercase">Default Order Execution</label>
                  <select
                    value={riskConfig.default_order_execution || "TAKER"}
                    onChange={(e) => setRiskConfig({ ...riskConfig, default_order_execution: e.target.value as "MAKER" | "TAKER" })}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2 text-xs text-slate-800 focus:ring-1 focus:ring-indigo-400 focus:border-indigo-400 outline-none font-mono"
                  >
                    <option value="TAKER">Taker (0.05% Commission)</option>
                    <option value="MAKER">Maker (0.02% Commission)</option>
                  </select>
                  <p className="text-[10px] text-slate-400 leading-relaxed">
                    Maker orders (passive limits) earn rebates or pay lower fees (0.02%); Taker orders (aggressive market/immediate fills) pay higher fees (0.05%) but guarantee instant execution.
                  </p>
                </div>

                <div className="space-y-2">
                  <label className="flex items-center gap-2.5 cursor-pointer font-sans select-none">
                    <input
                      type="checkbox"
                      checked={riskConfig.delta_india_gst_enabled !== false}
                      onChange={(e) => setRiskConfig({ ...riskConfig, delta_india_gst_enabled: e.target.checked })}
                      className="rounded border-slate-300 bg-white text-indigo-600 focus:ring-indigo-400 h-4 w-4 cursor-pointer"
                    />
                    <span className="text-xs font-semibold text-slate-700">Apply 18% Mandatory GST</span>
                  </label>
                  <p className="text-[10px] text-slate-500 leading-relaxed pl-6.5">
                    Delta Exchange India enforces standard statutory 18% GST taxation specifically on top of all generated brokerage commissions. Recommended to keep active for perfect accounting matching.
                  </p>
                </div>

                <div className="space-y-2">
                  <label className="flex items-center gap-2.5 cursor-pointer font-sans select-none">
                    <input
                      type="checkbox"
                      checked={riskConfig.delta_scalper_offer_enabled !== false}
                      onChange={(e) => setRiskConfig({ ...riskConfig, delta_scalper_offer_enabled: e.target.checked })}
                      className="rounded border-slate-300 bg-white text-indigo-600 focus:ring-indigo-400 h-4 w-4 cursor-pointer"
                    />
                    <span className="text-xs font-semibold text-emerald-700 font-bold">Activate Scalper Offer (FREE CloseLeg)</span>
                  </label>
                  <p className="text-[10px] text-slate-500 leading-relaxed pl-6.5">
                    Simulates Delta Exchange India's special promotion: exit trading fees are completely waived (Free CloseLeg) on any BTC/ETH futures positions opened and closed within a tight 30-minute window.
                  </p>
                </div>
              </div>
            </div>

            {/* Section 5: Cooldown Locks & Consecutive Losses */}
            <div className="border border-slate-200/80 rounded-xl p-5 space-y-4 bg-white shadow-sm">
              <h4 className="text-xs font-bold text-slate-700 uppercase tracking-wider font-sans border-b border-slate-100 pb-2">
                Trading Cooldown & Loss Streaks Lockout
              </h4>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-5 text-slate-600">
                <div className="space-y-1.5">
                  <label className="text-xs font-mono text-slate-400 uppercase">General System Cooldown (Minutes)</label>
                  <input
                    type="number"
                    value={generalConfig.cooldown_minutes !== undefined ? generalConfig.cooldown_minutes : 30}
                    onChange={(e) => setGeneralConfig({ ...generalConfig, cooldown_minutes: parseInt(e.target.value) || 30 })}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 text-xs text-slate-800 focus:ring-1 focus:ring-indigo-400 focus:border-indigo-400 outline-none font-mono"
                  />
                  <p className="text-[10px] text-slate-400 leading-relaxed">
                    Mandatory minimum rest duration in minutes applied immediately after closing a position. Restricts the system from executing subsequent trade entries too quickly, mitigating emotional re-entry.
                  </p>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-mono text-slate-400 uppercase">Max Consecutive Losses</label>
                  <input
                    type="number"
                    value={riskConfig.max_consecutive_losses}
                    onChange={(e) => setRiskConfig({ ...riskConfig, max_consecutive_losses: parseInt(e.target.value) || 3 })}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 text-xs text-slate-800 focus:ring-1 focus:ring-indigo-400 focus:border-indigo-400 outline-none font-mono"
                  />
                  <p className="text-[10px] text-slate-400 leading-relaxed">
                    The maximum number of consecutive losses allowed in a streak before triggering a hard temporary lockout on all subsequent automated scans.
                  </p>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-mono text-slate-400 uppercase">Loss Cooldown (Minutes)</label>
                  <input
                    type="number"
                    value={riskConfig.consecutive_losses_cooldown_minutes !== undefined ? riskConfig.consecutive_losses_cooldown_minutes : 30}
                    onChange={(e) => setRiskConfig({ ...riskConfig, consecutive_losses_cooldown_minutes: parseInt(e.target.value) || 30 })}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 text-xs text-slate-800 focus:ring-1 focus:ring-indigo-400 focus:border-indigo-400 outline-none font-mono"
                  />
                  <p className="text-[10px] text-slate-400 leading-relaxed">
                    The total ban duration (in minutes) during which the system is prohibited from taking any new trades once the consecutive loss streak limit has been breached.
                  </p>
                </div>
              </div>
            </div>

            {/* Section 6: Drawdown Circuit Breakers */}
            <div className="border border-slate-200/80 rounded-xl p-5 space-y-4 bg-white shadow-sm">
              <h4 className="text-xs font-bold text-slate-700 uppercase tracking-wider font-sans border-b border-slate-100 pb-2">
                Account Drawdown Circuit Breakers
              </h4>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-5 text-slate-600">
                <div className="space-y-1.5">
                  <label className="text-xs font-mono text-slate-400 uppercase">Daily Drawdown Circuit Breaker (%)</label>
                  <input
                    type="number"
                    step="0.5"
                    value={riskConfig.daily_loss_limit_pct}
                    onChange={(e) => setRiskConfig({ ...riskConfig, daily_loss_limit_pct: parseFloat(e.target.value) || 2.0 })}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 text-xs text-slate-800 focus:ring-1 focus:ring-indigo-400 focus:border-indigo-400 outline-none font-mono"
                  />
                  <p className="text-[10px] text-slate-400 leading-relaxed">
                    Account daily loss ceiling. When hit, all automated trading is suspended until the next calendar day UTC 00:00. This guarantees a single bad day won't destroy account equity (Strict Recommendation: 2.0%).
                  </p>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-mono text-slate-400 uppercase">Weekly Drawdown Circuit Breaker (%)</label>
                  <input
                    type="number"
                    step="0.5"
                    value={riskConfig.weekly_loss_limit_pct !== undefined ? riskConfig.weekly_loss_limit_pct : 5.0}
                    onChange={(e) => setRiskConfig({ ...riskConfig, weekly_loss_limit_pct: parseFloat(e.target.value) || 5.0 })}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 text-xs text-slate-800 focus:ring-1 focus:ring-indigo-400 focus:border-indigo-400 outline-none font-mono"
                  />
                  <p className="text-[10px] text-slate-400 leading-relaxed">
                    Account weekly loss limit. Trading halts immediately once cumulative net weekly loss reaches this percentage, only re-enabling on the next weekly cycle start.
                  </p>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-mono text-slate-400 uppercase">Intra-Trade Drawdown Limit (%)</label>
                  <input
                    type="number"
                    step="0.1"
                    value={riskConfig.intra_trade_drawdown_limit_pct !== undefined ? riskConfig.intra_trade_drawdown_limit_pct : 1.5}
                    onChange={(e) => setRiskConfig({ ...riskConfig, intra_trade_drawdown_limit_pct: parseFloat(e.target.value) || 1.5 })}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 text-xs text-slate-800 focus:ring-1 focus:ring-indigo-400 focus:border-indigo-400 outline-none font-mono"
                  />
                  <p className="text-[10px] text-slate-400 leading-relaxed">
                    Peak permissible unrealized loss percentage allowed within a single active open position. Breaching this instantly triggers a panic emergency market-close order to prevent catastrophic liquidation.
                  </p>
                </div>
              </div>
            </div>

            {/* Commit Button */}
            <div className="border-t border-slate-200 pt-5 flex justify-end">
              <button
                onClick={handleSaveRiskAndGeneral}
                className="bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-sans font-semibold px-5 py-2.5 rounded-lg transition-colors duration-150 cursor-pointer shadow-sm"
              >
                COMMIT RISK PARAMETERS
              </button>
            </div>
          </div>
        )}

        {/* ================= ML AI THRESHOLDS TAB ================= */}
        {activeTab === "ml" && (
          <div className="space-y-6">
            <div>
              <h3 className="font-sans font-bold text-sm text-slate-800">CatBoost Classifier Probability Parameters</h3>
              <p className="text-xs text-slate-400 font-sans mt-1">Configure walk-forward decision model thresholds and automated retraining triggers.</p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-5 text-slate-600">
              <div className="space-y-1.5">
                <label className="text-xs font-mono text-slate-400 uppercase">Entry Threshold (LONG)</label>
                <input
                  type="number"
                  step="0.01"
                  min="0.5"
                  max="0.99"
                  value={mlConfig.entry_threshold_long}
                  onChange={(e) => setMlConfig({ ...mlConfig, entry_threshold_long: parseFloat(e.target.value) || 0.8 })}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 text-xs text-slate-800 focus:ring-1 focus:ring-indigo-400 focus:border-indigo-400 outline-none font-mono"
                />
                <p className="text-[10px] text-slate-400">Minimum P(LONG) probability to allow buy order entry (Recommended: 0.80)</p>
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-mono text-slate-400 uppercase">Entry Threshold (SHORT)</label>
                <input
                  type="number"
                  step="0.01"
                  min="0.01"
                  max="0.5"
                  value={mlConfig.entry_threshold_short}
                  onChange={(e) => setMlConfig({ ...mlConfig, entry_threshold_short: parseFloat(e.target.value) || 0.2 })}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 text-xs text-slate-800 focus:ring-1 focus:ring-indigo-400 focus:border-indigo-400 outline-none font-mono"
                />
                <p className="text-[10px] text-slate-400">Maximum P(LONG) threshold to allow short sell entry (Recommended: 0.20)</p>
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-mono text-slate-400 uppercase">Active Classifier Model Version</label>
                <input
                  type="text"
                  value={mlConfig.model_version !== undefined ? mlConfig.model_version : "v2.4.1"}
                  onChange={(e) => setMlConfig({ ...mlConfig, model_version: e.target.value || "v2.4.1" })}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 text-xs text-slate-800 focus:ring-1 focus:ring-indigo-400 focus:border-indigo-400 outline-none font-mono"
                />
                <p className="text-[10px] text-slate-400">Model registry tag identifier (e.g. v2.4.1, production-catboost)</p>
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-mono text-slate-400 uppercase">Walk-Forward Training Window (Months)</label>
                <input
                  type="number"
                  step="1"
                  min="1"
                  max="36"
                  value={mlConfig.training_window_months !== undefined ? mlConfig.training_window_months : 6}
                  onChange={(e) => setMlConfig({ ...mlConfig, training_window_months: parseInt(e.target.value) || 6 })}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 text-xs text-slate-800 focus:ring-1 focus:ring-indigo-400 focus:border-indigo-400 outline-none font-mono"
                />
                <p className="text-[10px] text-slate-400">Historical dataset length used during walk-forward retraining (Recommended: 6 months)</p>
              </div>
            </div>

            <div className="bg-slate-50/50 p-4 border border-slate-200 rounded-xl space-y-3">
              <h4 className="text-xs font-sans font-bold text-indigo-700 uppercase">Retraining Schedules</h4>
              <div className="space-y-2.5 text-xs text-slate-600">
                <label className="flex items-center gap-2.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={mlConfig.auto_retrain_weekly}
                    onChange={(e) => setMlConfig({ ...mlConfig, auto_retrain_weekly: e.target.checked })}
                    className="rounded border-slate-300 bg-white text-indigo-600 focus:ring-indigo-400"
                  />
                  <span>Perform Automatic Walk-Forward Retraining Weekly (Sunday 00:00 UTC)</span>
                </label>

                <label className="flex items-center gap-2.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={mlConfig.retrain_on_perf_drop}
                    onChange={(e) => setMlConfig({ ...mlConfig, retrain_on_perf_drop: e.target.checked })}
                    className="rounded border-slate-300 bg-white text-indigo-600 focus:ring-indigo-400"
                  />
                  <span>Retrain on Strategy Performance Drop ({">"}10% win-rate variance)</span>
                </label>


              </div>
            </div>

            {retrainMsg && (
              <div className="text-[11px] font-mono text-indigo-600 bg-indigo-50 border border-indigo-100 p-2.5 rounded-lg animate-pulse">
                {retrainMsg}
              </div>
            )}

            <div className="border-t border-slate-200 pt-5 flex justify-between items-center">
              <button
                type="button"
                onClick={handleRetrainModel}
                disabled={isRetraining}
                className={`text-xs font-sans font-semibold px-5 py-2.5 rounded-lg transition-colors duration-150 cursor-pointer shadow-sm border ${
                  isRetraining
                    ? "bg-slate-100 border-slate-200 text-slate-400 cursor-not-allowed animate-pulse"
                    : "bg-white border-purple-200 hover:bg-purple-50 text-purple-700 hover:border-purple-300"
                }`}
              >
                {isRetraining ? "RETRAINING IN PROGRESS..." : "⚡ RETRAIN CATBOOST NOW"}
              </button>

              <button
                onClick={() => handleSaveCategory("ml_settings", mlConfig)}
                className="bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-sans font-semibold px-5 py-2.5 rounded-lg transition-colors duration-150 cursor-pointer shadow-sm"
              >
                COMMIT ML PARAMETERS
              </button>
            </div>
          </div>
        )}

        {/* ================= SENTIMENT ENGINE TAB ================= */}
        {activeTab === "sentiment" && (
          <div className="space-y-6">
            <div>
              <h3 className="font-sans font-bold text-sm text-slate-800">Sentiment RSS & News Protection Lock</h3>
              <p className="text-xs text-slate-400 font-sans mt-1">Configure headlines keyword matching thresholds and individual feed scoring ratios.</p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-5 text-slate-600">
              <div className="space-y-1.5">
                <label className="text-xs font-mono text-slate-400 uppercase">LONG Sentiment Minimum</label>
                <input
                  type="number"
                  step="0.05"
                  value={sentimentConfig.entry_threshold_long}
                  onChange={(e) => setSentimentConfig({ ...sentimentConfig, entry_threshold_long: parseFloat(e.target.value) || 0.25 })}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 text-xs text-slate-800 focus:ring-1 focus:ring-indigo-400 focus:border-indigo-400 outline-none font-mono"
                />
                <p className="text-[10px] text-slate-400">Weighted average threshold needed to buy (Default: +0.25)</p>
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-mono text-slate-400 uppercase">SHORT Sentiment Maximum</label>
                <input
                  type="number"
                  step="0.05"
                  value={sentimentConfig.entry_threshold_short}
                  onChange={(e) => setSentimentConfig({ ...sentimentConfig, entry_threshold_short: parseFloat(e.target.value) || -0.25 })}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 text-xs text-slate-800 focus:ring-1 focus:ring-indigo-400 focus:border-indigo-400 outline-none font-mono"
                />
                <p className="text-[10px] text-slate-400">Weighted average threshold needed to short sell (Default: -0.25)</p>
              </div>
            </div>

            {/* Safeguards and Lockdown Window */}
            <div className="bg-slate-50/50 p-4 border border-slate-200 rounded-xl space-y-4">
              <h4 className="text-xs font-sans font-bold text-indigo-700 uppercase">Sentiment Momentum & Safeguards</h4>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs text-slate-600">
                <label className="flex items-center gap-2.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={sentimentConfig.require_momentum_long !== undefined ? sentimentConfig.require_momentum_long : true}
                    onChange={(e) => setSentimentConfig({ ...sentimentConfig, require_momentum_long: e.target.checked })}
                    className="rounded border-slate-300 bg-white text-indigo-600 focus:ring-indigo-400"
                  />
                  <span>Require positive sentiment momentum for LONG trade entry</span>
                </label>

                <label className="flex items-center gap-2.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={sentimentConfig.require_momentum_short !== undefined ? sentimentConfig.require_momentum_short : true}
                    onChange={(e) => setSentimentConfig({ ...sentimentConfig, require_momentum_short: e.target.checked })}
                    className="rounded border-slate-300 bg-white text-indigo-600 focus:ring-indigo-400"
                  />
                  <span>Require negative sentiment momentum for SHORT trade entry</span>
                </label>

                <label className="flex items-center gap-2.5 cursor-pointer md:col-span-2">
                  <input
                    type="checkbox"
                    checked={sentimentConfig.block_on_critical_keywords !== undefined ? sentimentConfig.block_on_critical_keywords : true}
                    onChange={(e) => setSentimentConfig({ ...sentimentConfig, block_on_critical_keywords: e.target.checked })}
                    className="rounded border-slate-300 bg-white text-indigo-600 focus:ring-indigo-400"
                  />
                  <span>Actively block trade entries when a critical keyword is matched in RSS headlines</span>
                </label>
              </div>

              <div className="space-y-1.5 pt-2">
                <label className="text-xs font-mono text-slate-400 uppercase">News Protection Lockout Duration (Minutes)</label>
                <input
                  type="number"
                  step="1"
                  min="1"
                  value={sentimentConfig.protection_window_minutes !== undefined ? sentimentConfig.protection_window_minutes : 15}
                  onChange={(e) => setSentimentConfig({ ...sentimentConfig, protection_window_minutes: parseInt(e.target.value) || 15 })}
                  className="w-full bg-white border border-slate-200 rounded-lg p-2.5 text-xs text-slate-800 focus:ring-1 focus:ring-indigo-400 outline-none font-mono"
                />
                <p className="text-[10px] text-slate-400">Lock duration (minutes) for bypassing trade entries after critical keyword match.</p>
              </div>
            </div>

            {/* Individual News Source Weights and Refresh Intervals */}
            <div className="bg-slate-50/50 p-4 border border-slate-200 rounded-xl space-y-4">
              <div>
                <h4 className="text-xs font-sans font-bold text-indigo-700 uppercase">RSS Feed Configuration (Weights & Refresh Intervals)</h4>
                <p className="text-[10px] text-slate-400 mt-1">Configure individual weights (%) contributing to sentiment index and RSS feed fetch intervals (mins).</p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {Object.keys(sentimentConfig.weights || {}).map((source) => {
                  const src = source as NewsSource;
                  return (
                    <div key={src} className="bg-white border border-slate-200/80 rounded-xl p-3 space-y-3 shadow-sm">
                      <div className="flex justify-between items-center border-b border-slate-100 pb-1.5">
                        <span className="text-xs font-bold text-slate-700 font-sans tracking-tight">{src}</span>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <div className="space-y-1">
                          <label className="text-[9px] font-mono text-slate-400 uppercase">Weight (%)</label>
                          <input
                            type="number"
                            min="0"
                            max="100"
                            value={sentimentConfig.weights[src] !== undefined ? sentimentConfig.weights[src] : 20}
                            onChange={(e) => {
                              const updatedWeights = { ...sentimentConfig.weights, [src]: parseInt(e.target.value) || 0 };
                              setSentimentConfig({ ...sentimentConfig, weights: updatedWeights });
                            }}
                            className="w-full bg-slate-50 border border-slate-200 rounded-md p-1.5 text-xs text-slate-800 focus:ring-1 focus:ring-indigo-400 outline-none font-mono"
                          />
                        </div>
                        <div className="space-y-1">
                          <label className="text-[9px] font-mono text-slate-400 uppercase">Refresh (Min)</label>
                          <input
                            type="number"
                            min="1"
                            max="1440"
                            value={sentimentConfig.refresh_rates_min && sentimentConfig.refresh_rates_min[src] !== undefined ? sentimentConfig.refresh_rates_min[src] : 5}
                            onChange={(e) => {
                              const updatedIntervals = { ...sentimentConfig.refresh_rates_min, [src]: parseInt(e.target.value) || 5 };
                              setSentimentConfig({ ...sentimentConfig, refresh_rates_min: updatedIntervals });
                            }}
                            className="w-full bg-slate-50 border border-slate-200 rounded-md p-1.5 text-xs text-slate-800 focus:ring-1 focus:ring-indigo-400 outline-none font-mono"
                          />
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Keyword block list */}
            <div className="bg-slate-50/50 p-4 border border-slate-200 rounded-xl space-y-3">
              <h4 className="text-xs font-sans font-bold text-indigo-700 uppercase">Shield Protection: Critical Keywords</h4>
              <p className="text-[10px] text-slate-400 leading-relaxed font-sans">
                RSS news headings containing any keyword below will trigger an immediate entry block and lock trading parameters to mitigate news event slippages.
              </p>

              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder="Enter keyword (e.g. SEC, CPI, FED)..."
                  value={keywordInput}
                  onChange={(e) => setKeywordInput(e.target.value)}
                  className="flex-1 bg-white border border-slate-200 rounded-lg p-2 text-xs text-slate-800 outline-none"
                />
                <button
                  onClick={handleAddKeyword}
                  className="bg-indigo-600 hover:bg-indigo-500 px-4 py-2 text-xs text-white rounded-lg font-sans cursor-pointer shadow-sm font-semibold"
                >
                  Add
                </button>
              </div>

              <div className="flex flex-wrap gap-2 pt-2">
                {sentimentConfig.critical_keywords.map((kw) => (
                  <span
                    key={kw}
                    className="flex items-center gap-1.5 px-2.5 py-1 bg-slate-100 border border-slate-200 rounded-lg text-xs font-sans text-slate-700"
                  >
                    {kw}
                    <button
                      onClick={() => handleRemoveKeyword(kw)}
                      className="text-slate-400 hover:text-rose-500 font-bold transition-colors cursor-pointer"
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            </div>

            <div className="border-t border-slate-200 pt-5 flex justify-end">
              <button
                onClick={() => handleSaveCategory("sentiment_settings", sentimentConfig)}
                className="bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-sans font-semibold px-5 py-2.5 rounded-lg transition-colors duration-150 cursor-pointer shadow-sm"
              >
                COMMIT SENTIMENT PARAMETERS
              </button>
            </div>
          </div>
        )}

        {/* ================= STRATEGY PROFILE TAB ================= */}
        {activeTab === "profiles" && (
          <div className="space-y-6">
            <div>
              <h3 className="font-sans font-bold text-sm text-slate-800">Active Profile Management</h3>
              <p className="text-xs text-slate-400 font-sans mt-1">Export, snapshot, and hot-reload active parameter configurations.</p>
            </div>

            <div className="bg-slate-50/50 p-4 border border-slate-200 rounded-xl space-y-4">
              <h4 className="text-xs font-sans font-bold text-indigo-700 uppercase">Save Active Parameters</h4>
              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder="Profile Name (e.g. Extreme Volatility Grid)..."
                  value={newProfileName}
                  onChange={(e) => setNewProfileName(e.target.value)}
                  className="flex-1 bg-white border border-slate-200 rounded-lg p-2.5 text-xs text-slate-800 outline-none"
                />
                <button
                  onClick={handleSaveProfile}
                  className="bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-sans font-semibold px-5 py-2.5 rounded-lg cursor-pointer flex items-center gap-2 shadow-sm"
                >
                  <Save className="w-4 h-4" /> Export
                </button>
              </div>
            </div>

            <div className="space-y-3">
              <h4 className="text-xs font-sans font-bold text-slate-400 uppercase">Stored Configs</h4>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {Object.keys(profiles).map((name) => (
                  <div
                    key={name}
                    className="bg-slate-50/50 border border-slate-200 rounded-xl p-4 flex justify-between items-center"
                  >
                    <div>
                      <p className="text-sm font-sans font-bold text-slate-800">{name}</p>
                      <p className="text-[10px] font-mono text-slate-400 mt-1 uppercase">Ready to compile</p>
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={() => handleLoadProfile(name)}
                        className="p-2 bg-indigo-50 hover:bg-indigo-100 border border-indigo-200 text-indigo-600 rounded-lg cursor-pointer"
                        title="Load Strategy Profile"
                      >
                        <FolderOpen className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => handleDeleteProfile(name)}
                        className="p-2 bg-slate-100 border border-slate-200 hover:bg-rose-50 hover:text-rose-600 rounded-lg text-slate-400 cursor-pointer"
                        title="Delete Profile"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                ))}
                {Object.keys(profiles).length === 0 && (
                  <p className="text-slate-400 font-mono text-center text-xs italic py-10 col-span-2">No stored profiles found...</p>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ================= MARKET STRUCTURE SETUP TAB ================= */}
        {activeTab === "market_structure" && (
          <div className="space-y-6">
            <div>
              <h3 className="font-sans font-bold text-sm text-slate-800">Market Structure Setup</h3>
              <p className="text-xs text-slate-400 font-sans mt-1">
                Configure breakout confirmation metrics, immediate entry triggers, order flow softener bypass levels, and dynamic long-term EMA filters.
              </p>
            </div>

            {/* Section 1: Breakout & Body Confirmations */}
            <div className="border border-slate-200/80 rounded-xl p-5 space-y-4 bg-white shadow-sm">
              <h4 className="text-xs font-bold text-slate-700 uppercase tracking-wider font-sans border-b border-slate-100 pb-2">
                Level Breakthrough & Body Confirmations
              </h4>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                <div className="space-y-1.5">
                  <label className="text-xs font-mono text-slate-400 uppercase">Min Breakout Body Ratio</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0.01"
                    max="1.0"
                    value={msConfig.min_breakout_body_ratio}
                    onChange={(e) => setMsConfig({ ...msConfig, min_breakout_body_ratio: parseFloat(e.target.value) || 0.22 })}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 text-xs text-slate-800 focus:ring-1 focus:ring-indigo-400 focus:border-indigo-400 outline-none font-mono"
                  />
                  <p className="text-[10px] text-slate-400 leading-relaxed">
                    The minimum percentage of the breakout candle's total range (high to low) that must be comprised of the solid body (open to close). Values below this threshold suggest weak breakout volume/sweep wicks (Standard: 0.22).
                  </p>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-mono text-slate-400 uppercase">Weak Trend ADX Limit</label>
                  <input
                    type="number"
                    step="1"
                    min="5"
                    max="50"
                    value={msConfig.weak_trend_adx_threshold}
                    onChange={(e) => setMsConfig({ ...msConfig, weak_trend_adx_threshold: parseInt(e.target.value) || 25 })}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 text-xs text-slate-800 focus:ring-1 focus:ring-indigo-400 focus:border-indigo-400 outline-none font-mono"
                  />
                  <p className="text-[10px] text-slate-400 leading-relaxed">
                    Under moderate or weak momentum (ADX below this value), fast structures require secondary confirmation, such as price being strictly aligned with the long-term EMA 100 or 200 (Standard: 25).
                  </p>
                </div>

                <div className="space-y-2 flex flex-col justify-end pb-1">
                  <label className="flex items-center gap-2.5 cursor-pointer font-sans select-none">
                    <input
                      type="checkbox"
                      checked={msConfig.allow_immediate_breakout}
                      onChange={(e) => setMsConfig({ ...msConfig, allow_immediate_breakout: e.target.checked })}
                      className="rounded border-slate-300 bg-white text-indigo-600 focus:ring-indigo-400 h-4 w-4 cursor-pointer"
                    />
                    <span className="text-xs font-semibold text-slate-700">Allow Immediate Breakout Entry</span>
                  </label>
                  <p className="text-[10px] text-slate-400 leading-relaxed pl-6.5">
                    Permits the scalper engine to immediately chase breakouts on the very first candle break of Higher Highs or Lower Lows, provided strong high-frequency momentum or buy/sell pressure is actively confirmed.
                  </p>
                </div>
              </div>
            </div>

            {/* Section 2: High Frequency Momentum & Order Flow Settings */}
            <div className="border border-slate-200/80 rounded-xl p-5 space-y-4 bg-white shadow-sm">
              <h4 className="text-xs font-bold text-slate-700 uppercase tracking-wider font-sans border-b border-slate-100 pb-2">
                High-Frequency Momentum & Order Flow Settings
              </h4>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                <div className="space-y-1.5">
                  <label className="text-xs font-mono text-slate-400 uppercase">HF Momentum ADX Threshold</label>
                  <input
                    type="number"
                    step="1"
                    min="10"
                    max="60"
                    value={msConfig.hf_momentum_adx_threshold}
                    onChange={(e) => setMsConfig({ ...msConfig, hf_momentum_adx_threshold: parseInt(e.target.value) || 30 })}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 text-xs text-slate-800 focus:ring-1 focus:ring-indigo-400 focus:border-indigo-400 outline-none font-mono"
                  />
                  <p className="text-[10px] text-slate-400 leading-relaxed">
                    The ADX threshold representing extreme velocity. If ADX is higher than this value, the system considers the trend parabolic and bypasses standard pullback confirmations to lock entries immediately (Standard: 30).
                  </p>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-mono text-slate-400 uppercase">Pullback Zone ATR Limit Floor</label>
                  <input
                    type="number"
                    step="0.05"
                    min="0.1"
                    max="2.5"
                    value={msConfig.pullback_multiplier_limit}
                    onChange={(e) => setMsConfig({ ...msConfig, pullback_multiplier_limit: parseFloat(e.target.value) || 0.6 })}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 text-xs text-slate-800 focus:ring-1 focus:ring-indigo-400 focus:border-indigo-400 outline-none font-mono"
                  />
                  <p className="text-[10px] text-slate-400 leading-relaxed">
                    The minimum allowed ATR-based pullback distance coefficient. Keeps the pullback entry zones sufficiently wide to filter out normal tick noise (Standard: 0.6).
                  </p>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-mono text-slate-400 uppercase">EMA Retrace Zone ATR Limit Floor</label>
                  <input
                    type="number"
                    step="0.05"
                    min="0.1"
                    max="2.0"
                    value={msConfig.ema_retrace_multiplier_limit}
                    onChange={(e) => setMsConfig({ ...msConfig, ema_retrace_multiplier_limit: parseFloat(e.target.value) || 0.4 })}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 text-xs text-slate-800 focus:ring-1 focus:ring-indigo-400 focus:border-indigo-400 outline-none font-mono"
                  />
                  <p className="text-[10px] text-slate-400 leading-relaxed">
                    The minimum ATR-based retrace coefficient allowed for EMA pushback support/resistance confirmations (Standard: 0.4).
                  </p>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-mono text-slate-400 uppercase">Taker Buy Ratio Limit (Long)</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0.3"
                    max="0.8"
                    value={msConfig.hf_orderflow_taker_buy_ratio_long}
                    onChange={(e) => setMsConfig({ ...msConfig, hf_orderflow_taker_buy_ratio_long: parseFloat(e.target.value) || 0.58 })}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 text-xs text-slate-800 focus:ring-1 focus:ring-indigo-400 focus:border-indigo-400 outline-none font-mono"
                  />
                  <p className="text-[10px] text-slate-400 leading-relaxed">
                    Orderflow taker buy volume percentage above which extreme buying pressure triggers immediate breakout entry bypasses (Standard: 0.58).
                  </p>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-mono text-slate-400 uppercase">Order Book Imbalance Bid Skew (Long)</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0.1"
                    max="0.9"
                    value={msConfig.hf_orderflow_imbalance_ratio_long}
                    onChange={(e) => setMsConfig({ ...msConfig, hf_orderflow_imbalance_ratio_long: parseFloat(e.target.value) || 0.30 })}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 text-xs text-slate-800 focus:ring-1 focus:ring-indigo-400 focus:border-indigo-400 outline-none font-mono"
                  />
                  <p className="text-[10px] text-slate-400 leading-relaxed">
                    Order book depth bid skew percentage required to justify immediate bullish momentum chase (Standard: 0.30).
                  </p>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-mono text-slate-400 uppercase">Taker Buy Ratio Limit (Short)</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0.2"
                    max="0.7"
                    value={msConfig.hf_orderflow_taker_buy_ratio_short}
                    onChange={(e) => setMsConfig({ ...msConfig, hf_orderflow_taker_buy_ratio_short: parseFloat(e.target.value) || 0.42 })}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 text-xs text-slate-800 focus:ring-1 focus:ring-indigo-400 focus:border-indigo-400 outline-none font-mono"
                  />
                  <p className="text-[10px] text-slate-400 leading-relaxed">
                    Orderflow taker buy volume percentage below which extreme selling pressure triggers immediate breakdown entry bypasses (Standard: 0.42).
                  </p>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-mono text-slate-400 uppercase">Order Book Imbalance Ask Skew (Short)</label>
                  <input
                    type="number"
                    step="0.01"
                    min="-0.9"
                    max="-0.1"
                    value={msConfig.hf_orderflow_imbalance_ratio_short}
                    onChange={(e) => setMsConfig({ ...msConfig, hf_orderflow_imbalance_ratio_short: parseFloat(e.target.value) || -0.30 })}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 text-xs text-slate-800 focus:ring-1 focus:ring-indigo-400 focus:border-indigo-400 outline-none font-mono"
                  />
                  <p className="text-[10px] text-slate-400 leading-relaxed">
                    Order book depth ask skew percentage (negative value) required to justify immediate bearish momentum chase (Standard: -0.30).
                  </p>
                </div>
              </div>
            </div>

            {/* Section 3: EMA 200 Proximity & Protection Settings */}
            <div className="border border-slate-200/80 rounded-xl p-5 space-y-4 bg-white shadow-sm">
              <h4 className="text-xs font-bold text-slate-700 uppercase tracking-wider font-sans border-b border-slate-100 pb-2">
                EMA 200 Proximity Protection & Barrier Bypasses
              </h4>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                <div className="space-y-1.5">
                  <label className="text-xs font-mono text-slate-400 uppercase">EMA 200 Proximity Divisor</label>
                  <input
                    type="number"
                    step="0.1"
                    min="1.0"
                    max="10.0"
                    value={msConfig.ema200_proximity_divisor}
                    onChange={(e) => setMsConfig({ ...msConfig, ema200_proximity_divisor: parseFloat(e.target.value) || 3.0 })}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 text-xs text-slate-800 focus:ring-1 focus:ring-indigo-400 focus:border-indigo-400 outline-none font-mono"
                  />
                  <p className="text-[10px] text-slate-400 leading-relaxed">
                    In high-frequency scalping conditions (when ADX is moderate but not yet bypassing EMA 200), we compress the proximity protection barrier width by dividing it by this coefficient to allow closer entries (Standard: 3.0).
                  </p>
                </div>

                <div className="space-y-2 flex flex-col justify-end pb-1 col-span-1">
                  <label className="flex items-center gap-2.5 cursor-pointer font-sans select-none">
                    <input
                      type="checkbox"
                      checked={msConfig.bypass_ema200_on_momentum}
                      onChange={(e) => setMsConfig({ ...msConfig, bypass_ema200_on_momentum: e.target.checked })}
                      className="rounded border-slate-300 bg-white text-indigo-600 focus:ring-indigo-400 h-4 w-4 cursor-pointer"
                    />
                    <span className="text-xs font-semibold text-slate-700">Bypass EMA 200 Barrier on High ADX</span>
                  </label>
                  <p className="text-[10px] text-slate-400 leading-relaxed pl-6.5">
                    Permits the strategy to completely bypass long-term EMA 200 proximity barrier limits when ADX momentum is higher than the HF ADX Threshold, letting trade entries pass immediately.
                  </p>
                </div>
              </div>
            </div>

            {/* Section 4: Trend Alignment & Strength */}
            <div className="border border-slate-200/80 rounded-xl p-5 space-y-4 bg-white shadow-sm">
              <h4 className="text-xs font-bold text-slate-700 uppercase tracking-wider font-sans border-b border-slate-100 pb-2">
                Trend Alignment & Strength Setup (EMA/ADX)
              </h4>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                <div className="space-y-1.5">
                  <label className="text-xs font-mono text-slate-400 uppercase">Trend Alignment ADX Threshold</label>
                  <input
                    type="number"
                    step="1"
                    min="5"
                    max="60"
                    value={msConfig.trend_alignment_adx_threshold !== undefined ? msConfig.trend_alignment_adx_threshold : 30}
                    onChange={(e) => setMsConfig({ ...msConfig, trend_alignment_adx_threshold: parseInt(e.target.value) || 30 })}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 text-xs text-slate-800 focus:ring-1 focus:ring-indigo-400 focus:border-indigo-400 outline-none font-mono"
                  />
                  <p className="text-[10px] text-slate-400 leading-relaxed">
                    The ADX threshold representing strong trend alignment. If ADX is higher than this value, trend-following filters are activated (Standard: 30).
                  </p>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-mono text-slate-400 uppercase">Super Trend ADX Threshold</label>
                  <input
                    type="number"
                    step="1"
                    min="5"
                    max="60"
                    value={msConfig.super_trend_adx_threshold !== undefined ? msConfig.super_trend_adx_threshold : 35}
                    onChange={(e) => setMsConfig({ ...msConfig, super_trend_adx_threshold: parseInt(e.target.value) || 35 })}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 text-xs text-slate-800 focus:ring-1 focus:ring-indigo-400 focus:border-indigo-400 outline-none font-mono"
                  />
                  <p className="text-[10px] text-slate-400 leading-relaxed">
                    The ADX threshold representing an extremely strong trend, unlocking more aggressive entries or tighter trailing stops (Standard: 35).
                  </p>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-mono text-slate-400 uppercase">Fast EMA Period</label>
                  <input
                    type="number"
                    step="1"
                    min="2"
                    max="100"
                    value={msConfig.fast_ema_period !== undefined ? msConfig.fast_ema_period : 20}
                    onChange={(e) => setMsConfig({ ...msConfig, fast_ema_period: parseInt(e.target.value) || 20 })}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 text-xs text-slate-800 focus:ring-1 focus:ring-indigo-400 focus:border-indigo-400 outline-none font-mono"
                  />
                  <p className="text-[10px] text-slate-400 leading-relaxed">
                    Fast-moving exponential moving average period used to determine short-term momentum and alignment (Standard: 20).
                  </p>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-mono text-slate-400 uppercase">Medium EMA Period</label>
                  <input
                    type="number"
                    step="1"
                    min="5"
                    max="200"
                    value={msConfig.medium_ema_period !== undefined ? msConfig.medium_ema_period : 50}
                    onChange={(e) => setMsConfig({ ...msConfig, medium_ema_period: parseInt(e.target.value) || 50 })}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 text-xs text-slate-800 focus:ring-1 focus:ring-indigo-400 focus:border-indigo-400 outline-none font-mono"
                  />
                  <p className="text-[10px] text-slate-400 leading-relaxed">
                    Medium-moving exponential moving average period used as intermediate trend filter or support zone (Standard: 50).
                  </p>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-mono text-slate-400 uppercase">Slow EMA Period</label>
                  <input
                    type="number"
                    step="1"
                    min="20"
                    max="500"
                    value={msConfig.slow_ema_period !== undefined ? msConfig.slow_ema_period : 200}
                    onChange={(e) => setMsConfig({ ...msConfig, slow_ema_period: parseInt(e.target.value) || 200 })}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 text-xs text-slate-800 focus:ring-1 focus:ring-indigo-400 focus:border-indigo-400 outline-none font-mono"
                  />
                  <p className="text-[10px] text-slate-400 leading-relaxed">
                    Slow-moving exponential moving average period representing long-term trend direction and baseline support/resistance (Standard: 200).
                  </p>
                </div>
              </div>
            </div>

            {/* Commit Button */}
            <div className="border-t border-slate-200 pt-5 flex justify-end">
              <button
                onClick={() => handleSaveCategory("market_structure", msConfig)}
                className="bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-sans font-semibold px-5 py-2.5 rounded-lg transition-colors duration-150 cursor-pointer shadow-sm"
              >
                COMMIT MARKET STRUCTURE PARAMETERS
              </button>
            </div>
          </div>
        )}

        {/* ================= ROLLBACK AUDIT HISTORY TAB ================= */}
        {activeTab === "history" && (
          <div className="space-y-6">
            <div>
              <h3 className="font-sans font-semibold text-sm text-slate-800">Rollback & Audit Log</h3>
              <p className="text-xs text-slate-400 font-sans mt-1">Review strategy parameter modifications and rollback previous executions.</p>
            </div>

            <div className="space-y-3 h-[400px] overflow-y-auto pr-1">
              {history.map((entry) => (
                <div
                  key={entry.id}
                  className="bg-slate-50/50 border border-slate-200 rounded-xl p-4 space-y-3"
                >
                  <div className="flex justify-between items-center text-xs border-b border-slate-200 pb-2">
                    <span className="font-mono text-slate-400">
                      {new Date(entry.timestamp).toLocaleString()}
                    </span>
                    <span className="px-2 py-0.5 bg-slate-100 text-slate-600 rounded-md font-sans text-[10px] border border-slate-200">
                      {entry.changed_by}
                    </span>
                  </div>

                  <div className="space-y-1.5">
                    {entry.changes.map((c, i) => (
                      <div key={i} className="flex flex-wrap items-center gap-2 text-xs">
                        <span className="font-mono text-slate-500 font-semibold">{c.key}</span>
                        <span className="text-slate-400">:</span>
                        <span className="px-1.5 py-0.5 bg-slate-100 text-slate-500 rounded font-mono">
                          {JSON.stringify(c.old_value)}
                        </span>
                        <ArrowLeftRight className="w-3.5 h-3.5 text-slate-400" />
                        <span className="px-1.5 py-0.5 bg-indigo-50 text-indigo-700 rounded font-mono">
                          {JSON.stringify(c.new_value)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
              {history.length === 0 && (
                <p className="text-slate-400 font-mono text-center text-xs italic py-10">No config modification audits found...</p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
