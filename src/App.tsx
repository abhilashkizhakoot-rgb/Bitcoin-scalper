/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState, useRef } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  TrendingUp,
  Sliders,
  BookOpen,
  PieChart,
  Shield,
  Key,
  Database,
  Cpu,
  AlertCircle,
  CheckCircle2,
  RefreshCw,
  Server,
  Zap,
  Terminal,
  Brain,
} from "lucide-react";
import {
  Trade,
  TradingSignal,
  NewsHeadline,
  StrategyConfig,
  ConfigHistoryEntry,
  ExchangeCredentials,
  ConnectionStatus,
} from "./types.js";
import { safeFormatTime } from "./utils/format";
import { getApiBaseUrl, apiFetch } from "./utils/api.ts";

// Import modular components
import Dashboard from "./components/Dashboard.tsx";
import ConfigPage from "./components/ConfigPage.tsx";
import TradeHistory from "./components/TradeHistory.tsx";
import AnalyticsPage from "./components/AnalyticsPage.tsx";
import ManualTradingPage from "./components/ManualTradingPage.tsx";
import ApiAnalyzer from "./components/ApiAnalyzer.tsx";
import CheckpointsPage from "./components/CheckpointsPage.tsx";
import AiInsightsPage from "./components/AiInsightsPage.tsx";

export default function App() {
  const [activeTab, setActiveTabState] = useState<"dashboard" | "analytics" | "trades" | "config" | "manual" | "api_analyzer" | "checkpoints" | "ai_insights">(() => {
    const saved = localStorage.getItem("scalper_active_tab");
    const allowed = ["dashboard", "analytics", "trades", "config", "manual", "api_analyzer", "checkpoints", "ai_insights"];
    return (saved && allowed.includes(saved)) ? (saved as any) : "dashboard";
  });

  const setActiveTab = (tab: "dashboard" | "analytics" | "trades" | "config" | "manual" | "api_analyzer" | "checkpoints" | "ai_insights") => {
    localStorage.setItem("scalper_active_tab", tab);
    setActiveTabState(tab);
  };

  // State Buffers
  const [status, setStatus] = useState<any>({
    is_trading_active: false,
    current_price: 101500,
    current_regime: "RANGE_BOUND",
    regime_confidence: 0.5,
    critical_event_active: false,
    critical_event_keyword: null,
    protection_remaining_seconds: null,
    active_trade: null,
    account_balance_usdt: 100000,
  });

  const [credentials, setCredentials] = useState<ExchangeCredentials>({
    id: "delta-key",
    exchange_name: "Delta Exchange",
    api_url: "",
    ws_url: "",
    api_key: "",
    api_secret: "",
    connection_status: ConnectionStatus.NOT_CONFIGURED,
    last_tested_at: null,
    last_successful_connection: null,
    connection_error_message: null,
    account_balance_usdt: 100000,
    account_email: "",
    product_id: 1,
    product_symbol: "BTCUSD-FUTURES",
    is_testnet: false,
    is_india: false,
    created_at: "",
    updated_at: "",
  });

  const [trades, setTrades] = useState<Trade[]>([]);
  const [signals, setSignals] = useState<TradingSignal[]>([]);
  const [headlines, setHeadlines] = useState<NewsHeadline[]>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const [config, setConfig] = useState<StrategyConfig | null>(null);
  const [profiles, setProfiles] = useState<Record<string, StrategyConfig>>({});
  const [configHistory, setConfigHistory] = useState<ConfigHistoryEntry[]>([]);

  // Analytics datasets
  const [analyticsSummary, setAnalyticsSummary] = useState<any>({
    total_trades: 0,
    wins: 0,
    losses: 0,
    win_rate: 0,
    profit_factor: 0,
    net_profit_usdt: 0,
    fees_paid_usdt: 0,
    max_drawdown_usdt: 0,
    sharpe_ratio: 0,
    current_balance: 100000,
  });
  const [equityCurve, setEquityCurve] = useState<any[]>([]);
  const [dailyStats, setDailyStats] = useState<any[]>([]);
  const [regimeStats, setRegimeStats] = useState<any>({});

  // Exchange Config Panel visibility
  const [showExchangePanel, setShowExchangePanel] = useState(false);
  const showExchangePanelRef = useRef(showExchangePanel);
  useEffect(() => {
    showExchangePanelRef.current = showExchangePanel;
  }, [showExchangePanel]);

  const [formApiKey, setFormApiKey] = useState("");
  const [formApiSecret, setFormApiSecret] = useState("");
  const [formEmail, setFormEmail] = useState("");
  const [formIsTestnet, setFormIsTestnet] = useState(false);
  const [formIsIndia, setFormIsIndia] = useState(false);
  const [testingConnection, setTestingConnection] = useState(false);

  // Synchronize all REST datasets
  const fetchAllData = async (forceConfig = true) => {
    try {
      // Server Status
      const statusRes = await apiFetch("/api/status");
      if (statusRes.ok) setStatus(await statusRes.json());

      // Exchange Key
      const credsRes = await apiFetch("/api/exchange/credentials");
      if (credsRes.ok) {
        const credsData = await credsRes.json();
        setCredentials(credsData);
        // Only update form inputs when the drawer is NOT open, to avoid resetting active edits
        if (!showExchangePanelRef.current && !formApiKey) {
          setFormApiKey(credsData.api_key || "");
          setFormApiSecret(credsData.api_secret || "");
          setFormEmail(credsData.account_email || "");
          setFormIsTestnet(credsData.is_testnet || false);
          setFormIsIndia(credsData.is_india || false);
        }
      }

      // Trades, Signals, Headlines, Logs
      const tradesRes = await apiFetch("/api/trades");
      if (tradesRes.ok) setTrades(await tradesRes.json());

      const signalsRes = await apiFetch("/api/signals");
      if (signalsRes.ok) setSignals(await signalsRes.json());

      const headlinesRes = await apiFetch("/api/headlines");
      if (headlinesRes.ok) setHeadlines(await headlinesRes.json());

      const logsRes = await apiFetch("/api/logs");
      if (logsRes.ok) setLogs(await logsRes.json());

      // Configuration
      if (forceConfig || !config) {
        const configRes = await apiFetch("/api/config");
        if (configRes.ok) setConfig(await configRes.json());

        const profilesRes = await apiFetch("/api/config/profiles");
        if (profilesRes.ok) setProfiles(await profilesRes.json());

        const configHistoryRes = await apiFetch("/api/config/history");
        if (configHistoryRes.ok) setConfigHistory(await configHistoryRes.json());
      }

      // Quantitative Analytics
      const summaryRes = await apiFetch("/api/analytics/summary");
      if (summaryRes.ok) setAnalyticsSummary(await summaryRes.json());

      const equityRes = await apiFetch("/api/analytics/equity-curve");
      if (equityRes.ok) setEquityCurve(await equityRes.json());

      const dailyRes = await apiFetch("/api/analytics/daily-breakdown");
      if (dailyRes.ok) setDailyStats(await dailyRes.json());

      const regimeRes = await apiFetch("/api/analytics/regime-performance");
      if (regimeRes.ok) setRegimeStats(await regimeRes.json());
    } catch (e) {
      console.warn("Backend offline. Retrying synchronization loop in background...", e);
    }
  };

  useEffect(() => {
    fetchAllData();

    // 1. Establish SSE Server Sent Events Real-Time Stream
    let eventSource: EventSource | null = null;
    try {
      const baseUrl = getApiBaseUrl() || window.location.origin;
      const sseUrl = baseUrl && baseUrl.startsWith("http")
        ? new URL("/api/stream", baseUrl).href
        : "/api/stream";
      eventSource = new EventSource(sseUrl, { withCredentials: true });
      eventSource.onmessage = (event) => {
        try {
          if (!event.data || typeof event.data !== "string" || event.data.trim() === "") {
            return;
          }
          // Fast fail if it's clearly HTML or plain text error from proxy/load-balancer
          const trimmed = event.data.trim();
          if (trimmed.startsWith("<!DOCTYPE") || trimmed.startsWith("<html") || trimmed.startsWith("Error:")) {
            console.warn("Live stream received HTML or text error instead of JSON:", trimmed.slice(0, 100));
            return;
          }
          const msg = JSON.parse(event.data);
          if (msg.type === "status") {
            setStatus(msg.payload);
          }
        } catch (e) {
          console.warn("Could not parse live stream chunk (connection may have reset or fragmented):", e, "Raw data snippet:", event.data ? event.data.slice(0, 120) : "empty");
        }
      };
      eventSource.onerror = (e) => {
        console.warn("SSE stream closed or encountered a reconnect event:", e);
      };
    } catch (err) {
      console.warn("SSE EventSource not supported or failed to initialize, relying on fallback polling:", err);
    }

    // 2. Fallback Polling loop every 3 seconds to sync trades list and graphs
    const interval = setInterval(() => {
      fetchAllData(false);
    }, 3000);

    return () => {
      if (eventSource) {
        eventSource.close();
      }
      clearInterval(interval);
    };
  }, []);

  const handleUpdateCredentials = async (e: React.FormEvent) => {
    e.preventDefault();
    setTestingConnection(true);

    try {
      // Save credentials first
      const saveRes = await apiFetch("/api/exchange/credentials", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: formApiKey,
          api_secret: formApiSecret,
          account_email: formEmail,
          is_testnet: formIsTestnet,
          is_india: formIsIndia,
        }),
      });

      if (saveRes.ok) {
        // Trigger connectivity test
        await apiFetch("/api/exchange/test-connection", { method: "POST" });
        
        // Poll status every 500ms
        let attempts = 0;
        const interval = setInterval(async () => {
          attempts++;
          const res = await apiFetch("/api/exchange/credentials");
          if (res.ok) {
            const data = await res.json();
            setCredentials(data);
            if (data.connection_status !== ConnectionStatus.TESTING || attempts >= 15) {
              clearInterval(interval);
              setTestingConnection(false);
              await fetchAllData();
            }
          }
        }, 500);
      } else {
        setTestingConnection(false);
        alert("Failed to modify Delta Exchange credentials.");
      }
    } catch (e) {
      setTestingConnection(false);
      alert("Failed to modify Delta credentials.");
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-700 font-sans selection:bg-indigo-100 selection:text-indigo-800">
      {/* ================= TOP GLOW DECORATOR BAR ================= */}
      <div className="h-1 bg-indigo-500 w-full" />

      {/* ================= HEADER CONTROL BAR ================= */}
      <header className="bg-white border-b border-slate-200 sticky top-0 z-40 px-6 py-4 flex flex-col md:flex-row items-center justify-between gap-4 shadow-sm">
        {/* Title */}
        <div className="flex items-center gap-3">
          <div className="p-2.5 bg-indigo-50 border border-indigo-100 rounded-xl text-indigo-600">
            <Cpu className="w-5 h-5 animate-pulse" />
          </div>
          <div>
            <h1 className="font-sans font-bold text-slate-800 text-base leading-none tracking-tight">DELTA FUTURES AI SCALPER</h1>
            <p className="text-[9px] font-mono text-slate-400 uppercase tracking-widest mt-1.5">CatBoost + Trailing SL + Regime Detection</p>
          </div>
        </div>

        {/* Tab Selection */}
        <nav className="flex items-center bg-slate-100 border border-slate-200 p-1 rounded-xl" id="nav-tabs-bar">
          <button
            onClick={() => setActiveTab("dashboard")}
            className={`flex items-center gap-2 px-4 py-2 text-xs font-medium font-sans rounded-lg transition-all cursor-pointer ${
              activeTab === "dashboard" ? "bg-white text-indigo-600 font-semibold shadow-sm border border-slate-200/50" : "text-slate-500 hover:text-slate-800"
            }`}
            id="tab-dashboard"
          >
            <TrendingUp className="w-3.5 h-3.5" /> Dashboard
          </button>
          <button
            onClick={() => setActiveTab("analytics")}
            className={`flex items-center gap-2 px-4 py-2 text-xs font-medium font-sans rounded-lg transition-all cursor-pointer ${
              activeTab === "analytics" ? "bg-white text-indigo-600 font-semibold shadow-sm border border-slate-200/50" : "text-slate-500 hover:text-slate-800"
            }`}
            id="tab-analytics"
          >
            <PieChart className="w-3.5 h-3.5" /> Quant Analytics
          </button>
          <button
            onClick={() => setActiveTab("trades")}
            className={`flex items-center gap-2 px-4 py-2 text-xs font-medium font-sans rounded-lg transition-all cursor-pointer ${
              activeTab === "trades" ? "bg-white text-indigo-600 font-semibold shadow-sm border border-slate-200/50" : "text-slate-500 hover:text-slate-800"
            }`}
            id="tab-trades"
          >
            <BookOpen className="w-3.5 h-3.5" /> Historic Logs
          </button>
          <button
            onClick={() => setActiveTab("ai_insights")}
            className={`flex items-center gap-2 px-4 py-2 text-xs font-medium font-sans rounded-lg transition-all cursor-pointer ${
              activeTab === "ai_insights" ? "bg-white text-indigo-600 font-semibold shadow-sm border border-slate-200/50" : "text-slate-500 hover:text-slate-800"
            }`}
            id="tab-ai-insights"
          >
            <Brain className="w-3.5 h-3.5" /> AI Insights
          </button>
          <button
            onClick={() => setActiveTab("manual")}
            className={`flex items-center gap-2 px-4 py-2 text-xs font-medium font-sans rounded-lg transition-all cursor-pointer ${
              activeTab === "manual" ? "bg-white text-indigo-600 font-semibold shadow-sm border border-slate-200/50" : "text-slate-500 hover:text-slate-800"
            }`}
            id="tab-manual"
          >
            <Zap className="w-3.5 h-3.5" /> Take Trades Manually
          </button>
          <button
            onClick={() => setActiveTab("checkpoints")}
            className={`flex items-center gap-2 px-4 py-2 text-xs font-medium font-sans rounded-lg transition-all cursor-pointer ${
              activeTab === "checkpoints" ? "bg-white text-indigo-600 font-semibold shadow-sm border border-slate-200/50" : "text-slate-500 hover:text-slate-800"
            }`}
            id="tab-checkpoints"
          >
            <CheckCircle2 className="w-3.5 h-3.5" /> Checkpoints radar
          </button>
          <button
            onClick={() => setActiveTab("config")}
            className={`flex items-center gap-2 px-4 py-2 text-xs font-medium font-sans rounded-lg transition-all cursor-pointer ${
              activeTab === "config" ? "bg-white text-indigo-600 font-semibold shadow-sm border border-slate-200/50" : "text-slate-500 hover:text-slate-800"
            }`}
            id="tab-config"
          >
            <Sliders className="w-3.5 h-3.5" /> Strategy Params
          </button>
          <button
            onClick={() => setActiveTab("api_analyzer")}
            className={`flex items-center gap-2 px-4 py-2 text-xs font-medium font-sans rounded-lg transition-all cursor-pointer ${
              activeTab === "api_analyzer" ? "bg-white text-indigo-600 font-semibold shadow-sm border border-slate-200/50" : "text-slate-500 hover:text-slate-800"
            }`}
            id="tab-api-analyzer"
          >
            <Terminal className="w-3.5 h-3.5" /> API Analyzer
          </button>
        </nav>

        {/* Trading Mode Switch */}
        <div className="flex items-center bg-slate-100 border border-slate-200 p-1 rounded-xl" id="trading-mode-selector">
          <button
            onClick={async () => {
              const res = await apiFetch("/api/trading/toggle-paper-mode", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ is_paper_trading: true }),
              });
              if (res.ok) {
                await fetchAllData();
              }
            }}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-lg transition-all cursor-pointer ${
              status.is_paper_trading
                ? "bg-amber-100 border border-amber-200/50 text-amber-800 shadow-sm font-bold"
                : "text-slate-400 hover:text-slate-700 font-semibold"
            }`}
          >
            <Shield className={`w-3.5 h-3.5 ${status.is_paper_trading ? "text-amber-600 animate-pulse" : "text-slate-400"}`} />
            Paper Mode
          </button>
          <button
            onClick={async () => {
              const res = await apiFetch("/api/trading/toggle-paper-mode", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ is_paper_trading: false }),
              });
              if (res.ok) {
                await fetchAllData();
              }
            }}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-lg transition-all cursor-pointer ${
              !status.is_paper_trading
                ? "bg-rose-600 text-white shadow-sm font-bold"
                : "text-slate-400 hover:text-slate-700 font-semibold"
            }`}
          >
            <Zap className={`w-3.5 h-3.5 ${!status.is_paper_trading ? "text-amber-300" : "text-slate-400"}`} />
            Live Account
          </button>
        </div>

        {/* Exchange Key Connector Button */}
        <div className="flex items-center gap-3">
          <button
            onClick={() => {
              if (!showExchangePanel) {
                // Initialize form values from current active credentials when opening
                setFormApiKey(credentials.api_key || "");
                setFormApiSecret(credentials.api_secret || "");
                setFormEmail(credentials.account_email || "");
                setFormIsTestnet(credentials.is_testnet || false);
                setFormIsIndia(credentials.is_india || false);
              }
              setShowExchangePanel(!showExchangePanel);
            }}
            className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-medium font-sans border transition-all cursor-pointer ${
              credentials.connection_status === ConnectionStatus.CONNECTED
                ? "bg-emerald-50 border-emerald-200 text-emerald-700 hover:bg-emerald-100/50"
                : "bg-white border-slate-200 hover:bg-slate-50 text-slate-700"
            }`}
            id="btn-exchange-setup"
          >
            <Shield className="w-4 h-4" />
            Exchange: {credentials.connection_status === ConnectionStatus.CONNECTED ? "CONNECTED" : "SETUP API KEYS"}
          </button>
        </div>
      </header>

      {/* ================= CONFIGURATION DRAWER ================= */}
      <AnimatePresence>
        {showExchangePanel && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="bg-white border-b border-slate-200 overflow-hidden shadow-inner"
            id="exchange-keys-drawer"
          >
            <form onSubmit={handleUpdateCredentials} className="max-w-6xl mx-auto px-6 py-6 space-y-6">
              <div className="flex items-center gap-2.5 border-b border-slate-100 pb-3">
                <Key className="w-5 h-5 text-indigo-500" />
                <h2 className="font-sans font-semibold text-slate-800 text-sm">Delta Exchange API Configurations</h2>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
                {/* Left Side: Form Controls */}
                <div className="lg:col-span-7 space-y-5">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-5 text-xs text-slate-600">
                    <div className="space-y-1.5 md:col-span-2">
                      <label className="text-xs font-mono text-slate-400 uppercase">Delta API Key</label>
                      <input
                        type="text"
                        required
                        value={formApiKey}
                        onChange={(e) => setFormApiKey(e.target.value)}
                        className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 text-xs text-slate-800 outline-none focus:ring-1 focus:ring-indigo-400 focus:border-indigo-400 font-mono"
                      />
                    </div>

                    <div className="space-y-1.5 md:col-span-2">
                      <label className="text-xs font-mono text-slate-400 uppercase">Delta API Secret</label>
                      <input
                        type="password"
                        required
                        value={formApiSecret}
                        onChange={(e) => setFormApiSecret(e.target.value)}
                        className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 text-xs text-slate-800 outline-none focus:ring-1 focus:ring-indigo-400 focus:border-indigo-400 font-mono"
                      />
                    </div>

                    <div className="space-y-1.5">
                      <label className="text-xs font-mono text-slate-400 uppercase">Account Email</label>
                      <input
                        type="email"
                        required
                        value={formEmail}
                        onChange={(e) => setFormEmail(e.target.value)}
                        className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 text-xs text-slate-800 outline-none focus:ring-1 focus:ring-indigo-400 focus:border-indigo-400"
                      />
                    </div>

                    <div className="flex flex-col gap-3 pt-5">
                      <label className="flex items-center gap-2 cursor-pointer font-sans text-slate-500 hover:text-slate-800">
                        <input
                          type="checkbox"
                          checked={formIsTestnet}
                          onChange={(e) => setFormIsTestnet(e.target.checked)}
                          className="rounded border-slate-300 bg-slate-50 text-indigo-600 focus:ring-0"
                        />
                        <span>Deploy on Delta Mock-Testnet environment</span>
                      </label>

                      <label className="flex items-center gap-2 cursor-pointer font-sans text-slate-500 hover:text-slate-800">
                        <input
                          type="checkbox"
                          checked={formIsIndia}
                          onChange={(e) => setFormIsIndia(e.target.checked)}
                          className="rounded border-slate-300 bg-slate-50 text-indigo-600 focus:ring-0"
                        />
                        <span className="flex items-center gap-1.5">
                          <span>Use Delta India APIs (api.india.delta.exchange)</span>
                          <span className="text-[10px] font-mono bg-indigo-50 text-indigo-600 px-1.5 py-0.5 rounded uppercase font-semibold">India</span>
                        </span>
                      </label>
                    </div>
                  </div>
                </div>

                {/* Right Side: Verification Widget */}
                <div className="lg:col-span-5 bg-slate-50 rounded-xl p-5 border border-slate-200/60 flex flex-col justify-between space-y-4">
                  <div>
                    <h3 className="text-xs font-bold text-slate-700 uppercase tracking-wider font-sans mb-3 flex items-center gap-1.5">
                      <Server className="w-3.5 h-3.5 text-indigo-500" />
                      Verification & Current Status
                    </h3>

                    {/* Status Badge */}
                    <div className="flex items-center gap-3 bg-white p-3 rounded-lg border border-slate-200/50 shadow-sm">
                      <div className="relative flex h-3 w-3">
                        {credentials.connection_status === ConnectionStatus.TESTING ? (
                          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75"></span>
                        ) : credentials.connection_status === ConnectionStatus.CONNECTED ? (
                          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                        ) : null}
                        <span className={`relative inline-flex rounded-full h-3 w-3 ${
                          credentials.connection_status === ConnectionStatus.CONNECTED
                            ? "bg-emerald-500"
                            : credentials.connection_status === ConnectionStatus.TESTING
                            ? "bg-indigo-500"
                            : "bg-rose-500"
                        }`}></span>
                      </div>
                      <div>
                        <div className="text-xs font-bold font-mono text-slate-700">
                          {credentials.connection_status}
                        </div>
                        <div className="text-[10px] text-slate-400 font-sans">
                          Last checked: {credentials.last_tested_at ? safeFormatTime(credentials.last_tested_at) : "Never"}
                        </div>
                      </div>
                    </div>

                    {/* Error logs, if any */}
                    {credentials.connection_status === ConnectionStatus.FAILED && credentials.connection_error_message && (
                      <div className="mt-3 bg-rose-50 border border-rose-100 rounded-lg p-3 text-rose-700 text-[11px] font-sans">
                        <div className="font-bold flex items-center gap-1 mb-1">
                          <AlertCircle className="w-3.5 h-3.5 text-rose-600" />
                          Authentication Refused
                        </div>
                        <p>{credentials.connection_error_message}</p>
                      </div>
                    )}

                    {credentials.connection_status === ConnectionStatus.CONNECTED && (
                      <div className="mt-3 bg-emerald-50 border border-emerald-100 rounded-lg p-3 text-emerald-800 text-[11px] font-sans">
                        <div className="font-bold flex items-center gap-1 mb-1">
                          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                          Authenticated Successfully
                        </div>
                        <p>Delta Exchange API credentials validated and active. Live WebSocket feed is receiving ticker quotes.</p>
                      </div>
                    )}
                  </div>

                  {/* Message Signing Code Snippet */}
                  <div className="border-t border-slate-200/60 pt-3">
                    <h4 className="text-[10px] font-mono font-bold text-slate-400 uppercase tracking-widest mb-1.5 flex items-center gap-1">
                      <span>Message Signing Protocol</span>
                    </h4>
                    <div className="bg-slate-900 text-slate-300 p-3 rounded-lg font-mono text-[9px] leading-relaxed space-y-1 select-all overflow-x-auto shadow-inner">
                      <div className="text-slate-500">// Header: api-signature</div>
                      <div>const timestamp = Math.floor(Date.now() / 1000);</div>
                      <div>const data = "GET" + timestamp + "/v2/wallet/balances";</div>
                      <div className="text-indigo-400 font-bold">const signature = hmac_sha256(secret, data);</div>
                    </div>
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-between border-t border-slate-100 pt-4">
                <div className="flex items-center gap-2 text-slate-400 text-[10px] font-mono uppercase">
                  <Server className="w-3.5 h-3.5 text-slate-400" />
                  Routing via verified secure proxy
                </div>
                <div className="flex gap-3">
                  <button
                    type="button"
                    onClick={() => setShowExchangePanel(false)}
                    className="px-4 py-2 border border-slate-200 hover:bg-slate-50 text-slate-500 rounded-lg text-xs font-sans cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={testingConnection}
                    className="bg-slate-900 hover:bg-slate-800 text-white text-xs font-sans font-medium px-5 py-2.5 rounded-lg transition-colors cursor-pointer flex items-center gap-1.5"
                    id="btn-save-credentials"
                  >
                    {testingConnection ? "Verifying..." : "Save & Test Connection"}
                  </button>
                </div>
              </div>
            </form>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ================= CORE PAGE ROUTER CANVAS ================= */}
      <main className="max-w-7xl mx-auto px-6 py-8" id="main-content-area">
        <AnimatePresence mode="wait">
          <motion.div
            key={activeTab}
            initial={{ opacity: 0, y: 15 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -15 }}
            transition={{ duration: 0.2 }}
          >
            {activeTab === "dashboard" && (
              <Dashboard
                status={status}
                trades={trades}
                signals={signals}
                headlines={headlines}
                logs={logs}
                onRefresh={fetchAllData}
              />
            )}

            {activeTab === "analytics" && (
              <AnalyticsPage
                summary={analyticsSummary}
                equityCurve={equityCurve}
                dailyStats={dailyStats}
                regimeStats={regimeStats}
                trades={trades}
                config={config}
              />
            )}

            {activeTab === "trades" && (
              <TradeHistory
                trades={trades}
                isPaperMode={status?.is_paper_trading}
                onRefresh={fetchAllData}
                config={config}
              />
            )}

            {activeTab === "ai_insights" && (
              <AiInsightsPage />
            )}

            {activeTab === "manual" && (
              <ManualTradingPage
                status={status}
                config={config}
                onRefresh={fetchAllData}
              />
            )}

            {activeTab === "checkpoints" && (
              <CheckpointsPage
                status={status}
                config={config}
                onRefresh={fetchAllData}
                onTabChange={setActiveTab}
              />
            )}

            {activeTab === "config" && config && (
              <ConfigPage
                config={config}
                profiles={profiles}
                history={configHistory}
                onRefresh={fetchAllData}
              />
            )}

            {activeTab === "api_analyzer" && (
              <ApiAnalyzer isPaperMode={status?.is_paper_trading} />
            )}
          </motion.div>
        </AnimatePresence>
      </main>

      {/* ================= FOOTER WATERMARK ================= */}
      <footer className="border-t border-slate-200 py-6 text-center text-[10px] font-mono text-slate-400 uppercase tracking-widest">
        Bitcoin Futures AI Scalper Bot • Designed with Swiss Precision
      </footer>
    </div>
  );
}
