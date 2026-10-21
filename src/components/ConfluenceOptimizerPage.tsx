/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo } from "react";
import {
  Layers,
  Sparkles,
  Target,
  Sliders,
  Filter,
  CheckCircle2,
  TrendingUp,
  TrendingDown,
  ShieldCheck,
  Activity,
  Calendar,
  Clock,
  ArrowUpRight,
  BarChart3,
  Flame,
  Zap,
  Download,
  RefreshCw,
  Search,
  Check,
  SlidersHorizontal,
  ChevronRight,
  Info,
  Upload,
  Trash2,
} from "lucide-react";
import { apiFetch } from "../utils/api.ts";
import {
  ConfluenceOptimizationReport,
  DiscoveredConfluenceCluster,
  ConfluenceOptimizerRequest,
  DEFAULT_AVAILABLE_SETUPS,
} from "../backtester/types.ts";
import { ConfluenceRule, UnifiedConfluenceConfig } from "../types.ts";

interface ConfluenceOptimizerPageProps {
  onNavigateToConfig?: () => void;
  onNavigateToBacktest?: () => void;
}

export default function ConfluenceOptimizerPage({
  onNavigateToConfig,
  onNavigateToBacktest,
}: ConfluenceOptimizerPageProps) {
  // Query Controls
  const [days, setDays] = useState<number>(14);
  const [minWinRate, setMinWinRate] = useState<number>(60.0);
  const [minTrades, setMinTrades] = useState<number>(5);
  const [selectedSetupId, setSelectedSetupId] = useState<string>("all");
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<ConfluenceOptimizationReport | null>(null);

  // Cluster Selection & Filtering State
  const [selectedClusterIds, setSelectedClusterIds] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [sessionFilter, setSessionFilter] = useState<string>("ALL");
  const [weekdayFilter, setWeekdayFilter] = useState<string>("ALL");
  const [verdictFilter, setVerdictFilter] = useState<string>("ALL");
  const [activeViewTab, setActiveViewTab] = useState<"clusters" | "comparison" | "dimensions" | "matrix_preview">("clusters");

  // Deployment State
  const [isApplying, setIsApplying] = useState<boolean>(false);
  const [isOptimizingRules, setIsOptimizingRules] = useState<boolean>(false);
  const [applySuccessMsg, setApplySuccessMsg] = useState<string | null>(null);
  const [liveConfluenceConfig, setLiveConfluenceConfig] = useState<UnifiedConfluenceConfig | null>(null);

  // Fetch Live Unified Confluence Config
  const fetchLiveConfig = async () => {
    try {
      const res = await apiFetch("/api/strategy/unified-confluence");
      if (res.ok) {
        const data = await res.json();
        if (data.config) {
          setLiveConfluenceConfig(data.config);
        }
      }
    } catch (e) {
      console.warn("Could not load live confluence config:", e);
    }
  };

  useEffect(() => {
    fetchLiveConfig();
    runOptimization(false);
  }, []);

  // Run Optimization Engine
  const runOptimization = async (forceRerun: boolean = false) => {
    setLoading(true);
    setError(null);
    setApplySuccessMsg(null);

    try {
      const payload: ConfluenceOptimizerRequest = {
        days,
        minWinRateThreshold: minWinRate,
        minTradesThreshold: minTrades,
        setupId: selectedSetupId,
        forceRerun,
      };

      const res = await apiFetch("/api/backtest/confluence-optimizer/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `HTTP ${res.status}: Failed to analyze confluence matrix`);
      }

      const data = await res.json();
      if (data.success && data.report) {
        setReport(data.report);
        // By default, select all discovered clusters that meet the criteria
        const allIds = new Set<string>((data.report.discoveredClusters || []).map((c: DiscoveredConfluenceCluster) => c.id));
        setSelectedClusterIds(allIds);
      } else {
        throw new Error(data.error || "No report returned from optimizer");
      }
    } catch (err: any) {
      console.error("[ConfluenceOptimizer] Error:", err);
      setError(err.message || "An unexpected error occurred during optimization analysis.");
    } finally {
      setLoading(false);
    }
  };

  // Filtered clusters based on local controls
  const displayedClusters = useMemo(() => {
    if (!report || !report.discoveredClusters) return [];
    return report.discoveredClusters.filter((c) => {
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchesName = c.name.toLowerCase().includes(q);
        const matchesSetup = c.setupName.toLowerCase().includes(q);
        if (!matchesName && !matchesSetup) return false;
      }
      if (sessionFilter !== "ALL") {
        if (c.sessions === "ALL" || !Array.isArray(c.sessions) || !c.sessions.includes(sessionFilter)) {
          return false;
        }
      }
      if (weekdayFilter !== "ALL") {
        if (c.days === "ALL" || !Array.isArray(c.days) || !c.days.map((d) => d.toLowerCase()).includes(weekdayFilter.toLowerCase())) {
          return false;
        }
      }
      if (verdictFilter !== "ALL") {
        if (c.verdict !== verdictFilter) return false;
      }
      return true;
    });
  }, [report, searchQuery, sessionFilter, weekdayFilter, verdictFilter]);

  // Recalculate dynamic portfolio metrics based on active selection
  const selectedClustersList = useMemo(() => {
    if (!report || !report.discoveredClusters) return [];
    return report.discoveredClusters.filter((c) => selectedClusterIds.has(c.id));
  }, [report, selectedClusterIds]);

  // Handle cluster toggle
  const toggleCluster = (id: string) => {
    setSelectedClusterIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    if (!report) return;
    setSelectedClusterIds(new Set(report.discoveredClusters.map((c) => c.id)));
  };

  const selectHighConviction = (threshold: number) => {
    if (!report) return;
    const filtered = report.discoveredClusters
      .filter((c) => c.winRate >= threshold)
      .map((c) => c.id);
    setSelectedClusterIds(new Set(filtered));
  };

  const deselectAll = () => {
    setSelectedClusterIds(new Set());
  };

  // One-Click Apply to Live Unified Confluence Matrix
  const handleApplyToLiveMatrix = async () => {
    if (selectedClustersList.length === 0) {
      alert("Please select at least 1 discovered confluence cluster before applying.");
      return;
    }

    setIsApplying(true);
    setApplySuccessMsg(null);
    setError(null);

    try {
      const rulesToDeploy: ConfluenceRule[] = selectedClustersList.map((c) => c.ruleCandidate);

      const res = await apiFetch("/api/backtest/confluence-optimizer/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rules: rulesToDeploy,
          minValidationWinRate: minWinRate,
          strictMode: true,
          enabled: true,
        }),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || errData.message || "Failed to deploy confluence matrix");
      }

      const data = await res.json();
      setApplySuccessMsg(data.message || `Successfully deployed ${rulesToDeploy.length} rules to Live Unified Confluence Matrix!`);
      await fetchLiveConfig();
    } catch (err: any) {
      console.error("[ConfluenceOptimizer] Apply error:", err);
      setError(err.message || "Failed to apply settings to live bot.");
    } finally {
      setIsApplying(false);
    }
  };

  // Export Rules to JSON
  const exportJson = () => {
    if (!report) return;
    const rulesToExport = selectedClustersList.map((c) => c.ruleCandidate);
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(rulesToExport, null, 2));
    const downloadAnchor = document.createElement("a");
    downloadAnchor.setAttribute("href", dataStr);
    downloadAnchor.setAttribute("download", `unified_confluence_matrix_wr${minWinRate}_${new Date().toISOString().slice(0, 10)}.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
  };

  // Non-destructive Import JSON
  const handleImportJson = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (evt) => {
      try {
        const parsed = JSON.parse(evt.target?.result as string);
        let incomingRules: any[] = [];
        const configUpdates: any = {};

        if (Array.isArray(parsed)) {
          incomingRules = parsed;
        } else if (parsed && typeof parsed === "object") {
          if (Array.isArray(parsed.rules)) {
            incomingRules = parsed.rules;
            if (typeof parsed.enabled === "boolean") configUpdates.enabled = parsed.enabled;
            if (typeof parsed.strict_mode === "boolean") configUpdates.strict_mode = parsed.strict_mode;
            if (typeof parsed.min_validation_win_rate === "number") configUpdates.min_validation_win_rate = parsed.min_validation_win_rate;
          } else if (Array.isArray(parsed.discoveredClusters)) {
            incomingRules = parsed.discoveredClusters.map((c: any) => c.ruleCandidate || c);
          }
        }

        if (incomingRules.length === 0) {
          setError("Invalid file format. Expected a JSON array of rules or an object with a rules property.");
          return;
        }

        // Call the non-destructive import endpoint (preserves all old settings and existing rules!)
        const res = await apiFetch("/api/strategy/unified-confluence/import", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            rules: incomingRules,
            mergeStrategy: "merge",
            configUpdates,
          }),
        });

        if (res.ok) {
          const data = await res.json();
          setApplySuccessMsg(data.message || `Successfully imported ${incomingRules.length} rules without deleting existing settings!`);
          await fetchLiveConfig();
        } else {
          const errData = await res.json().catch(() => ({}));
          setError(errData.error || errData.message || "Failed to import confluence rules.");
        }
      } catch (err: any) {
        setError("Failed to parse JSON file. Please ensure it is valid JSON.");
      } finally {
        if (e.target) {
          e.target.value = "";
        }
      }
    };
    reader.readAsText(file);
  };

  // Optimize & Deduplicate Rules Handler
  const handleOptimizeAndDeduplicateRules = async () => {
    setIsOptimizingRules(true);
    setError(null);
    setApplySuccessMsg(null);
    try {
      const res = await apiFetch("/api/strategy/unified-confluence/optimize-rules", {
        method: "POST",
      });
      if (res.ok) {
        const data = await res.json();
        const s = data.summary;
        setApplySuccessMsg(
          `Matrix Optimization Complete: ${s.duplicatesRemoved} duplicate rules removed, ${s.conflictsResolved} conflicts resolved, ${s.normalizedCount} normalized. Total clean rules: ${s.finalRulesCount}.`
        );
        await fetchLiveConfig();
      } else {
        const err = await res.json().catch(() => ({}));
        setError(err.message || "Failed to optimize rules.");
      }
    } catch (e: any) {
      setError("Error optimizing rules: " + (e.message || "Unknown error"));
    } finally {
      setIsOptimizingRules(false);
    }
  };

  // Clear All Live Rules Handler
  const handleClearAllLiveRules = async () => {
    if (!confirm("Are you sure you want to clear all active rules on the live bot? This will empty the live matrix while keeping your master settings intact.")) {
      return;
    }
    setError(null);
    setApplySuccessMsg(null);
    try {
      const res = await apiFetch("/api/strategy/unified-confluence/clear", {
        method: "POST",
      });
      if (res.ok) {
        setApplySuccessMsg("All live confluence rules have been successfully cleared.");
        await fetchLiveConfig();
      } else {
        const err = await res.json().catch(() => ({}));
        setError(err.message || "Failed to clear live rules.");
      }
    } catch (e: any) {
      setError("Error clearing rules: " + (e.message || "Unknown error"));
    }
  };

  const comp = report?.comparison;

  return (
    <div className="space-y-6">
      {/* ================= HERO HEADER & VALUE BANNER ================= */}
      <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm relative overflow-hidden">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6">
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="p-2 bg-indigo-50 border border-indigo-100 rounded-xl text-indigo-600">
                <Target className="w-5 h-5 text-indigo-600" />
              </span>
              <span className="text-[11px] font-mono uppercase tracking-widest text-indigo-600 font-semibold">
                Unified Confluence Intelligence Engine
              </span>
            </div>
            <h1 className="text-2xl font-bold text-slate-800 tracking-tight font-sans">
              Find Best Unified Confluence Matrix Settings (Win Rate &gt; 60%)
            </h1>
            <p className="text-xs text-slate-500 max-w-3xl leading-relaxed">
              Empirical combinatorial matrix clustering across historical candles. Slices price-action setups, trading sessions,
              market regimes, and day-of-week liquidity to isolate compound criteria where historical win rate consistently exceeds 60%.
            </p>
          </div>

          {/* Quick Status Pill & Links */}
          <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3">
            {liveConfluenceConfig && (
              <div className="bg-slate-50 border border-slate-200 rounded-xl p-3 text-xs">
                <div className="text-[10px] font-mono text-slate-400 uppercase">Live Bot Gating Matrix</div>
                <div className="flex items-center gap-2 mt-1">
                  <span
                    className={`w-2 h-2 rounded-full ${
                      liveConfluenceConfig.enabled ? "bg-emerald-500" : "bg-slate-400"
                    }`}
                  />
                  <span className="font-bold text-slate-700">
                    {liveConfluenceConfig.enabled ? "Active" : "Disabled"} (
                    {liveConfluenceConfig.rules?.length || 0} Rules, Min WR:{" "}
                    {liveConfluenceConfig.min_validation_win_rate || 70}%)
                  </span>
                </div>
              </div>
            )}

            {onNavigateToConfig && (
              <button
                onClick={onNavigateToConfig}
                className="px-3.5 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl text-xs font-semibold flex items-center gap-1.5 transition-all cursor-pointer border border-slate-200/80"
              >
                <Sliders className="w-3.5 h-3.5" /> Strategy Params
              </button>
            )}
          </div>
        </div>

        {/* ================= OPTIMIZATION PARAMETER CONTROLS ================= */}
        <div className="mt-6 pt-5 border-t border-slate-100 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-12 gap-4 items-end">
          {/* Lookback Duration */}
          <div className="lg:col-span-3 space-y-1.5">
            <label className="text-xs font-semibold text-slate-600 flex items-center gap-1.5">
              <Calendar className="w-3.5 h-3.5 text-indigo-500" /> Historical Lookback
            </label>
            <div className="grid grid-cols-5 gap-1">
              {[
                { label: "7D", val: 7 },
                { label: "14D", val: 14 },
                { label: "30D", val: 30 },
                { label: "90D", val: 90 },
                { label: "180D", val: 180 },
              ].map((p) => (
                <button
                  key={p.val}
                  type="button"
                  onClick={() => setDays(p.val)}
                  disabled={loading}
                  className={`py-1.5 text-xs font-mono font-medium rounded-lg border transition-all cursor-pointer ${
                    days === p.val
                      ? "bg-indigo-600 text-white border-indigo-600 font-bold shadow-xs"
                      : "bg-white border-slate-200 text-slate-600 hover:bg-slate-50"
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          {/* Min Win Rate Threshold Slider & Presets */}
          <div className="lg:col-span-4 space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="text-xs font-semibold text-slate-600 flex items-center gap-1.5">
                <Target className="w-3.5 h-3.5 text-emerald-500" /> Target Win Rate Threshold
              </label>
              <span className="text-xs font-mono font-bold text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded">
                &ge; {minWinRate.toFixed(1)}% WR
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              {[
                { label: "60%+", val: 60 },
                { label: "65%+", val: 65 },
                { label: "70%+", val: 70 },
                { label: "75%+", val: 75 },
                { label: "80%+", val: 80 },
              ].map((preset) => (
                <button
                  key={preset.val}
                  type="button"
                  onClick={() => setMinWinRate(preset.val)}
                  disabled={loading}
                  className={`flex-1 py-1.5 text-xs font-mono font-semibold rounded-lg border transition-all cursor-pointer ${
                    minWinRate === preset.val
                      ? "bg-emerald-600 text-white border-emerald-600 shadow-xs"
                      : "bg-white border-slate-200 text-slate-600 hover:bg-slate-50"
                  }`}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>

          {/* Min Trades Sample Filter */}
          <div className="lg:col-span-2 space-y-1.5">
            <label className="text-xs font-semibold text-slate-600 flex items-center gap-1.5">
              <Activity className="w-3.5 h-3.5 text-amber-500" /> Min Sample Size
            </label>
            <div className="grid grid-cols-4 gap-1">
              {[
                { label: "3T", val: 3 },
                { label: "5T", val: 5 },
                { label: "10T", val: 10 },
                { label: "15T", val: 15 },
              ].map((s) => (
                <button
                  key={s.val}
                  type="button"
                  onClick={() => setMinTrades(s.val)}
                  disabled={loading}
                  className={`py-1.5 text-xs font-mono font-medium rounded-lg border transition-all cursor-pointer ${
                    minTrades === s.val
                      ? "bg-slate-800 text-white border-slate-800 font-bold"
                      : "bg-white border-slate-200 text-slate-600 hover:bg-slate-50"
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>

          {/* Setup Scope */}
          <div className="lg:col-span-3 space-y-1.5">
            <label className="text-xs font-semibold text-slate-600 flex items-center gap-1.5">
              <Layers className="w-3.5 h-3.5 text-indigo-500" /> Setup Scope
            </label>
            <div className="flex items-center gap-2">
              <select
                value={selectedSetupId}
                onChange={(e) => setSelectedSetupId(e.target.value)}
                disabled={loading}
                className="w-full bg-white border border-slate-200 rounded-lg p-2 text-xs text-slate-800 outline-none focus:ring-1 focus:ring-indigo-400 font-sans"
              >
                <option value="all">All 11 Core Setups Combined</option>
                {DEFAULT_AVAILABLE_SETUPS.filter((s) => s.id !== "all").map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>

              <button
                type="button"
                onClick={() => runOptimization(true)}
                disabled={loading}
                className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white rounded-lg text-xs font-bold flex items-center gap-1.5 shadow-sm transition-all whitespace-nowrap cursor-pointer"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
                {loading ? "Analyzing..." : "Discover"}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Error Banner */}
      {error && (
        <div className="p-4 bg-rose-50 border border-rose-200 rounded-xl text-rose-700 text-xs font-medium flex items-center gap-2">
          <Info className="w-4 h-4 text-rose-500 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Success Banner */}
      {applySuccessMsg && (
        <div className="p-4 bg-emerald-50 border border-emerald-200 rounded-xl text-emerald-800 text-xs font-medium flex items-center justify-between">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
            <span>{applySuccessMsg}</span>
          </div>
          {onNavigateToConfig && (
            <button
              onClick={onNavigateToConfig}
              className="px-3 py-1 bg-emerald-600 text-white rounded-lg text-xs font-bold hover:bg-emerald-700 transition-colors cursor-pointer"
            >
              Verify in Strategy Params &rarr;
            </button>
          )}
        </div>
      )}

      {/* ================= COMPARATIVE TRANSFORMATION DASHBOARD ================= */}
      {comp && (
        <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-slate-100">
            <div>
              <div className="flex items-center gap-2">
                <BarChart3 className="w-4 h-4 text-indigo-600" />
                <h2 className="text-sm font-bold text-slate-800 uppercase tracking-wider font-sans">
                  Confluence Matrix Performance Transformation
                </h2>
              </div>
              <p className="text-xs text-slate-400 mt-0.5">
                Counterfactual impact of gating trades strictly through discovered high-win-rate ({minWinRate}%+) confluence rules.
              </p>
            </div>

            <div className="flex items-center gap-2">
              <span className="text-xs font-mono font-medium text-slate-500">
                Discovered: <strong className="text-indigo-600 font-bold">{report?.clustersCount || 0}</strong> clusters
              </span>
              <span className="text-slate-300">·</span>
              <span className="text-xs font-mono font-medium text-slate-500">
                Selected: <strong className="text-emerald-600 font-bold">{selectedClustersList.length}</strong> rules
              </span>
            </div>
          </div>

          {/* KPI Uplift Grid */}
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            {/* Win Rate Jump */}
            <div className="bg-slate-50 border border-slate-200/80 rounded-xl p-4">
              <span className="text-[11px] font-mono text-slate-400 uppercase block">Portfolio Win Rate</span>
              <div className="flex items-baseline gap-2 mt-1">
                <span className="text-sm font-mono text-slate-400 line-through">
                  {comp.baselineWinRate.toFixed(1)}%
                </span>
                <span className="text-2xl font-bold font-mono text-emerald-600">
                  {comp.optimizedWinRate.toFixed(1)}%
                </span>
              </div>
              <div className="mt-1 flex items-center gap-1 text-[11px] font-mono font-semibold text-emerald-600">
                <TrendingUp className="w-3 h-3" />
                +{comp.winRateDelta.toFixed(1)}% Win Rate Lift
              </div>
            </div>

            {/* Net P&L Uplift */}
            <div className="bg-slate-50 border border-slate-200/80 rounded-xl p-4">
              <span className="text-[11px] font-mono text-slate-400 uppercase block">Net P&amp;L Uplift</span>
              <div className="flex items-baseline gap-2 mt-1">
                <span className="text-sm font-mono text-slate-400 line-through">
                  ${comp.baselineNetPnlUsd.toFixed(1)}
                </span>
                <span className={`text-2xl font-bold font-mono ${comp.optimizedNetPnlUsd >= 0 ? "text-emerald-600" : "text-slate-800"}`}>
                  {comp.optimizedNetPnlUsd >= 0 ? "+" : ""}${comp.optimizedNetPnlUsd.toFixed(1)}
                </span>
              </div>
              <div className="mt-1 flex items-center gap-1 text-[11px] font-mono font-semibold text-emerald-600">
                <ArrowUpRight className="w-3 h-3" />
                +${comp.pnlDelta.toFixed(1)} vs Ungated
              </div>
            </div>

            {/* Loss Elimination Rate */}
            <div className="bg-slate-50 border border-slate-200/80 rounded-xl p-4">
              <span className="text-[11px] font-mono text-slate-400 uppercase block">Losing Trades Filtered</span>
              <div className="text-2xl font-bold font-mono text-indigo-600 mt-1">
                {comp.lossEliminationRate.toFixed(1)}%
              </div>
              <div className="mt-1 text-[11px] font-mono text-slate-500">
                {comp.filteredOutLosses} bad signals pruned
              </div>
            </div>

            {/* Profit Factor */}
            <div className="bg-slate-50 border border-slate-200/80 rounded-xl p-4">
              <span className="text-[11px] font-mono text-slate-400 uppercase block">Profit Factor</span>
              <div className="flex items-baseline gap-2 mt-1">
                <span className="text-sm font-mono text-slate-400 line-through">
                  {comp.baselineProfitFactor >= 99 ? "∞" : comp.baselineProfitFactor.toFixed(2)}
                </span>
                <span className="text-2xl font-bold font-mono text-slate-800">
                  {comp.optimizedProfitFactor >= 99 ? "∞" : comp.optimizedProfitFactor.toFixed(2)}
                </span>
              </div>
              <div className="mt-1 text-[11px] font-mono text-slate-500">
                Gross Win / Loss ratio
              </div>
            </div>

            {/* Selectivity / Signal Volume */}
            <div className="bg-slate-50 border border-slate-200/80 rounded-xl p-4">
              <span className="text-[11px] font-mono text-slate-400 uppercase block">High-Conviction Volume</span>
              <div className="text-2xl font-bold font-mono text-slate-800 mt-1">
                {comp.optimizedTrades} <span className="text-xs font-normal text-slate-400 font-sans">/ {comp.baselineTrades}</span>
              </div>
              <div className="mt-1 text-[11px] font-mono text-emerald-600">
                {comp.winRetentionRate.toFixed(1)}% Wins Retained
              </div>
            </div>
          </div>

          {/* ================= ONE-CLICK APPLY TO BOT BANNER ================= */}
          <div className="bg-indigo-50 border border-indigo-100 rounded-xl p-4 flex flex-col md:flex-row items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="p-2.5 bg-indigo-600 text-white rounded-xl shadow-xs">
                <ShieldCheck className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wide font-sans">
                  Deploy Optimized Confluence Matrix (Min WR &ge; {minWinRate.toFixed(1)}%)
                </h3>
                <p className="text-xs text-slate-600 mt-0.5">
                  Applies <strong className="text-indigo-700">{selectedClustersList.length} verified rules</strong> directly to your bot's live Unified Confluence Gating Matrix in Strict Mode.
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2 w-full md:w-auto">
              <button
                type="button"
                onClick={exportJson}
                className="flex-1 md:flex-none px-3.5 py-2.5 bg-white hover:bg-slate-50 text-slate-700 rounded-xl text-xs font-semibold flex items-center justify-center gap-1.5 border border-slate-200 transition-colors cursor-pointer"
              >
                <Download className="w-3.5 h-3.5" /> Export JSON
              </button>

              <label
                title="Import Unified Confluence JSON without deleting old settings"
                className="flex-1 md:flex-none px-3.5 py-2.5 bg-white hover:bg-slate-50 text-slate-700 rounded-xl text-xs font-semibold flex items-center justify-center gap-1.5 border border-slate-200 transition-colors cursor-pointer"
              >
                <Upload className="w-3.5 h-3.5 text-indigo-600" /> Import JSON
                <input type="file" accept=".json" onChange={handleImportJson} className="hidden" />
              </label>

              <button
                type="button"
                onClick={handleOptimizeAndDeduplicateRules}
                disabled={isOptimizingRules}
                title="Scan and remove duplicate rules, resolve conflicting criteria, and harmonize settings"
                className="flex-1 md:flex-none px-3.5 py-2.5 bg-white hover:bg-slate-50 text-slate-700 rounded-xl text-xs font-semibold flex items-center justify-center gap-1.5 border border-slate-200 transition-colors cursor-pointer disabled:opacity-50"
              >
                <Sparkles className="w-3.5 h-3.5 text-amber-500" />
                <span>{isOptimizingRules ? "Optimizing..." : "Remove Conflicts"}</span>
              </button>

              <button
                type="button"
                onClick={handleClearAllLiveRules}
                disabled={isApplying || !liveConfluenceConfig?.rules?.length}
                title="Clear all rules currently active in the live bot matrix"
                className="flex-1 md:flex-none px-3.5 py-2.5 bg-white hover:bg-rose-50 text-rose-600 rounded-xl text-xs font-semibold flex items-center justify-center gap-1.5 border border-rose-200 transition-colors cursor-pointer disabled:opacity-40"
              >
                <Trash2 className="w-3.5 h-3.5 text-rose-500" />
                <span>Clear Live Rules</span>
              </button>

              <button
                type="button"
                onClick={handleApplyToLiveMatrix}
                disabled={isApplying || selectedClustersList.length === 0}
                className="flex-1 md:flex-none px-5 py-2.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white rounded-xl text-xs font-bold flex items-center justify-center gap-2 shadow-sm transition-all cursor-pointer whitespace-nowrap"
              >
                {isApplying ? (
                  <>
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    Deploying...
                  </>
                ) : (
                  <>
                    <Zap className="w-3.5 h-3.5 fill-white" />
                    Apply {selectedClustersList.length} Rules to Live Bot
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ================= NAVIGATION TABS & FILTER BAR ================= */}
      <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          {/* Sub Navigation */}
          <div className="flex items-center bg-slate-100 p-1 rounded-xl">
            <button
              onClick={() => setActiveViewTab("clusters")}
              className={`px-3.5 py-1.5 text-xs font-medium rounded-lg transition-all cursor-pointer ${
                activeViewTab === "clusters"
                  ? "bg-white text-indigo-600 font-bold shadow-xs"
                  : "text-slate-500 hover:text-slate-800"
              }`}
            >
              Discovered Clusters ({report?.clustersCount || 0})
            </button>
            <button
              onClick={() => setActiveViewTab("dimensions")}
              className={`px-3.5 py-1.5 text-xs font-medium rounded-lg transition-all cursor-pointer ${
                activeViewTab === "dimensions"
                  ? "bg-white text-indigo-600 font-bold shadow-xs"
                  : "text-slate-500 hover:text-slate-800"
              }`}
            >
              Dimension Edge Rankings
            </button>
            <button
              onClick={() => setActiveViewTab("comparison")}
              className={`px-3.5 py-1.5 text-xs font-medium rounded-lg transition-all cursor-pointer ${
                activeViewTab === "comparison"
                  ? "bg-white text-indigo-600 font-bold shadow-xs"
                  : "text-slate-500 hover:text-slate-800"
              }`}
            >
              Before vs After Comparison
            </button>
            <button
              onClick={() => setActiveViewTab("matrix_preview")}
              className={`px-3.5 py-1.5 text-xs font-medium rounded-lg transition-all cursor-pointer ${
                activeViewTab === "matrix_preview"
                  ? "bg-white text-indigo-600 font-bold shadow-xs"
                  : "text-slate-500 hover:text-slate-800"
              }`}
            >
              Rule JSON Preview
            </button>
          </div>

          {/* Quick Selection Shortcuts */}
          {activeViewTab === "clusters" && (
            <div className="flex items-center gap-1.5 flex-wrap text-xs">
              <span className="text-slate-400 text-[11px] font-mono mr-1">Presets:</span>
              <button
                onClick={selectAll}
                className="px-2.5 py-1 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-xs font-medium transition-colors cursor-pointer"
              >
                All &gt;60%
              </button>
              <button
                onClick={() => selectHighConviction(70)}
                className="px-2.5 py-1 bg-emerald-50 hover:bg-emerald-100 text-emerald-700 border border-emerald-200 rounded-lg text-xs font-semibold transition-colors cursor-pointer"
              >
                &ge; 70% Only
              </button>
              <button
                onClick={() => selectHighConviction(75)}
                className="px-2.5 py-1 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border border-indigo-200 rounded-lg text-xs font-semibold transition-colors cursor-pointer"
              >
                &ge; 75% Elite
              </button>
              <button
                onClick={deselectAll}
                className="px-2.5 py-1 bg-slate-100 hover:bg-slate-200 text-slate-500 rounded-lg text-xs font-medium transition-colors cursor-pointer"
              >
                Clear
              </button>
            </div>
          )}
        </div>

        {/* Tab 1: Discovered Clusters View */}
        {activeViewTab === "clusters" && (
          <div className="space-y-4">
            {/* Search & Filter Controls */}
            <div className="flex flex-col md:flex-row items-center gap-2 pt-2 border-t border-slate-100">
              <div className="relative flex-1 w-full">
                <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  placeholder="Search setups, sessions, weekdays, or time windows..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full pl-9 pr-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-700 outline-none focus:ring-1 focus:ring-indigo-400 font-sans"
                />
              </div>

              {/* Session Filter */}
              <select
                value={sessionFilter}
                onChange={(e) => setSessionFilter(e.target.value)}
                className="bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs text-slate-700 outline-none focus:ring-1 focus:ring-indigo-400"
              >
                <option value="ALL">All Trading Sessions</option>
                <option value="europe_us_overlap">Europe/US Overlap</option>
                <option value="asia_open">Asian Session</option>
                <option value="intraday_chop">London Open</option>
                <option value="late_us_session">Late US Session</option>
              </select>

              {/* Weekday Filter */}
              <select
                value={weekdayFilter}
                onChange={(e) => setWeekdayFilter(e.target.value)}
                className="bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs text-slate-700 outline-none focus:ring-1 focus:ring-indigo-400"
              >
                <option value="ALL">All Weekdays</option>
                <option value="monday">Monday</option>
                <option value="tuesday">Tuesday</option>
                <option value="wednesday">Wednesday</option>
                <option value="thursday">Thursday</option>
                <option value="friday">Friday</option>
              </select>

              {/* Verdict Filter */}
              <select
                value={verdictFilter}
                onChange={(e) => setVerdictFilter(e.target.value)}
                className="bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs text-slate-700 outline-none focus:ring-1 focus:ring-indigo-400"
              >
                <option value="ALL">All Quality Tiers</option>
                <option value="Elite">Elite (&ge; 75% WR)</option>
                <option value="Robust">Robust (65–74% WR)</option>
                <option value="Moderate">Moderate (60–64% WR)</option>
              </select>
            </div>

            {/* Clusters Table */}
            {displayedClusters.length === 0 ? (
              <div className="text-center py-12 text-slate-400 text-xs">
                No confluence clusters found matching current filters ({minWinRate}% WR, {minTrades} trades).
                Try lowering the win rate threshold or selecting a longer lookback period.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 text-slate-400 font-semibold uppercase tracking-wider text-[10px]">
                      <th className="pb-2.5 w-10 text-center">Active</th>
                      <th className="pb-2.5">Confluence Cluster &amp; Criteria</th>
                      <th className="pb-2.5">Setup ID</th>
                      <th className="pb-2.5 text-center">Win Rate</th>
                      <th className="pb-2.5 text-center">Sample (W/L)</th>
                      <th className="pb-2.5 text-center">Profit Factor</th>
                      <th className="pb-2.5 text-right">Net P&amp;L</th>
                      <th className="pb-2.5 text-center">Risk Multiplier</th>
                      <th className="pb-2.5 text-center">Tier</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 font-mono text-slate-600">
                    {displayedClusters.map((cluster) => {
                      const isSelected = selectedClusterIds.has(cluster.id);

                      const wrColor =
                        cluster.winRate >= 75
                          ? "text-emerald-600 font-extrabold"
                          : cluster.winRate >= 65
                          ? "text-teal-600 font-bold"
                          : "text-indigo-600 font-bold";

                      const barColor =
                        cluster.winRate >= 75
                          ? "bg-emerald-500"
                          : cluster.winRate >= 65
                          ? "bg-teal-500"
                          : "bg-indigo-500";

                      return (
                        <tr
                          key={cluster.id}
                          className={`hover:bg-slate-50 transition-colors ${
                            isSelected ? "bg-indigo-50/30" : ""
                          }`}
                        >
                          {/* Checkbox */}
                          <td className="py-3 text-center">
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={() => toggleCluster(cluster.id)}
                              className="rounded border-slate-300 text-indigo-600 focus:ring-0 cursor-pointer"
                            />
                          </td>

                          {/* Cluster Criteria */}
                          <td className="py-3 font-sans">
                            <div className="font-semibold text-slate-800 text-xs">
                              {cluster.name}
                            </div>
                            <div className="flex items-center gap-2 mt-1 text-[10px] font-mono text-slate-400">
                              <span>Sessions: {Array.isArray(cluster.sessions) ? cluster.sessions.join(", ") : "ALL"}</span>
                              <span>·</span>
                              <span>Days: {Array.isArray(cluster.days) ? cluster.days.join(", ") : "ALL"}</span>
                              {cluster.hoursUtc !== "ALL" && (
                                <>
                                  <span>·</span>
                                  <span>Hours: {cluster.hoursUtc.join(", ")} UTC</span>
                                </>
                              )}
                            </div>
                          </td>

                          {/* Setup */}
                          <td className="py-3">
                            <span className="text-[11px] font-mono text-slate-500">
                              {cluster.setupId}
                            </span>
                          </td>

                          {/* Win Rate */}
                          <td className="py-3 text-center">
                            <div className="flex flex-col items-center">
                              <span className={`text-sm ${wrColor}`}>
                                {cluster.winRate.toFixed(1)}%
                              </span>
                              <div className="w-16 bg-slate-200 rounded-full h-1 mt-1 overflow-hidden">
                                <div
                                  className={`h-1 rounded-full ${barColor}`}
                                  style={{ width: `${Math.min(100, cluster.winRate)}%` }}
                                />
                              </div>
                            </div>
                          </td>

                          {/* Sample Size */}
                          <td className="py-3 text-center">
                            <span className="font-semibold text-slate-700">{cluster.tradesCount}</span>
                            <span className="text-[10px] text-slate-400 block">
                              ({cluster.winCount}W / {cluster.lossCount}L)
                            </span>
                          </td>

                          {/* Profit Factor */}
                          <td className="py-3 text-center">
                            <span className="font-bold text-slate-700">
                              {cluster.profitFactor >= 99 ? "∞" : cluster.profitFactor.toFixed(2)}
                            </span>
                          </td>

                          {/* Net P&L */}
                          <td
                            className={`py-3 text-right font-bold ${
                              cluster.netPnlUsd > 0
                                ? "text-emerald-600"
                                : cluster.netPnlUsd < 0
                                ? "text-rose-600"
                                : "text-slate-500"
                            }`}
                          >
                            {cluster.netPnlUsd >= 0 ? "+" : ""}${cluster.netPnlUsd.toFixed(2)}
                          </td>

                          {/* Risk Multiplier */}
                          <td className="py-3 text-center">
                            <span className="font-mono text-[11px] font-semibold text-indigo-600 bg-indigo-50 px-1.5 py-0.5 rounded">
                              {cluster.recommendedRiskMultiplier.toFixed(2)}x
                            </span>
                          </td>

                          {/* Verdict */}
                          <td className="py-3 text-center">
                            <span
                              className={`text-[10px] font-mono uppercase font-bold px-2 py-0.5 rounded ${
                                cluster.verdict === "Elite"
                                  ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                                  : cluster.verdict === "Robust"
                                  ? "bg-teal-50 text-teal-700 border border-teal-200"
                                  : "bg-indigo-50 text-indigo-700 border border-indigo-200"
                              }`}
                            >
                              {cluster.verdict}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* Tab 2: Dimension Edge Rankings View */}
        {activeViewTab === "dimensions" && report && (
          <div className="space-y-6 pt-2">
            <p className="text-xs text-slate-500">
              Single-variable marginal edge distributions across all individual parameters. Shows where setup probability is structurally highest.
            </p>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
              {/* Setups Breakdown */}
              <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-3">
                <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wide flex items-center gap-1.5">
                  <Layers className="w-3.5 h-3.5 text-indigo-600" /> By Strategy Setup
                </h3>
                <div className="divide-y divide-slate-200/60 font-mono text-xs">
                  {report.dimensionBreakdowns.setups.map((s) => (
                    <div key={s.id} className="py-2 flex items-center justify-between">
                      <div className="font-sans pr-2">
                        <span className="font-semibold text-slate-800">{s.name}</span>
                        <span className="text-[10px] text-slate-400 block font-mono">
                          {s.tradesCount} Trades · {s.winCount}W / {s.lossCount}L
                        </span>
                      </div>
                      <div className="text-right">
                        <span className={`font-bold ${s.winRate >= 60 ? "text-emerald-600" : s.winRate >= 50 ? "text-teal-600" : "text-slate-600"}`}>
                          {s.winRate.toFixed(1)}% WR
                        </span>
                        <span className="text-[10px] text-slate-500 block">
                          PF: {s.profitFactor >= 99 ? "∞" : s.profitFactor.toFixed(2)}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Trading Sessions Breakdown */}
              <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-3">
                <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wide flex items-center gap-1.5">
                  <Clock className="w-3.5 h-3.5 text-emerald-600" /> By Trading Session
                </h3>
                <div className="divide-y divide-slate-200/60 font-mono text-xs">
                  {report.dimensionBreakdowns.sessions.map((sess) => (
                    <div key={sess.id} className="py-2 flex items-center justify-between">
                      <div className="font-sans pr-2">
                        <span className="font-semibold text-slate-800">{sess.name}</span>
                        <span className="text-[10px] text-slate-400 block font-mono">
                          {sess.tradesCount} Trades · {sess.winCount}W / {sess.lossCount}L
                        </span>
                      </div>
                      <div className="text-right">
                        <span className={`font-bold ${sess.winRate >= 60 ? "text-emerald-600" : sess.winRate >= 50 ? "text-teal-600" : "text-slate-600"}`}>
                          {sess.winRate.toFixed(1)}% WR
                        </span>
                        <span className="text-[10px] text-slate-500 block">
                          P&amp;L: ${sess.netPnlUsd.toFixed(1)}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Weekdays Breakdown */}
              <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-3">
                <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wide flex items-center gap-1.5">
                  <Calendar className="w-3.5 h-3.5 text-indigo-600" /> By Day of Week
                </h3>
                <div className="divide-y divide-slate-200/60 font-mono text-xs">
                  {report.dimensionBreakdowns.weekdays.map((w) => (
                    <div key={w.id} className="py-2 flex items-center justify-between">
                      <div className="font-sans pr-2">
                        <span className="font-semibold text-slate-800">{w.name}</span>
                        <span className="text-[10px] text-slate-400 block font-mono">
                          {w.tradesCount} Trades · {w.winCount}W / {w.lossCount}L
                        </span>
                      </div>
                      <div className="text-right">
                        <span className={`font-bold ${w.winRate >= 60 ? "text-emerald-600" : w.winRate >= 50 ? "text-teal-600" : "text-slate-600"}`}>
                          {w.winRate.toFixed(1)}% WR
                        </span>
                        <span className="text-[10px] text-slate-500 block">
                          P&amp;L: ${w.netPnlUsd.toFixed(1)}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* UTC Time Windows Breakdown */}
              <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-3">
                <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wide flex items-center gap-1.5">
                  <SlidersHorizontal className="w-3.5 h-3.5 text-amber-600" /> By UTC 4-Hour Time Window
                </h3>
                <div className="divide-y divide-slate-200/60 font-mono text-xs">
                  {report.dimensionBreakdowns.timeWindows.map((tw) => (
                    <div key={tw.id} className="py-2 flex items-center justify-between">
                      <div className="font-sans pr-2">
                        <span className="font-semibold text-slate-800">{tw.name}</span>
                        <span className="text-[10px] text-slate-400 block font-mono">
                          {tw.tradesCount} Trades · {tw.winCount}W / {tw.lossCount}L
                        </span>
                      </div>
                      <div className="text-right">
                        <span className={`font-bold ${tw.winRate >= 60 ? "text-emerald-600" : tw.winRate >= 50 ? "text-teal-600" : "text-slate-600"}`}>
                          {tw.winRate.toFixed(1)}% WR
                        </span>
                        <span className="text-[10px] text-slate-500 block">
                          PF: {tw.profitFactor >= 99 ? "∞" : tw.profitFactor.toFixed(2)}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Tab 3: Detailed Before vs After Comparison */}
        {activeViewTab === "comparison" && comp && (
          <div className="space-y-5 pt-2">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              {/* Baseline Ungated Box */}
              <div className="bg-slate-50 border border-slate-200 rounded-xl p-5 space-y-4">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-mono uppercase font-bold text-slate-500">
                    Baseline (Ungated Execution)
                  </span>
                  <span className="text-[11px] font-mono text-slate-400">All Raw Trades</span>
                </div>
                <div className="space-y-3 font-mono text-xs">
                  <div className="flex justify-between py-1.5 border-b border-slate-200/60">
                    <span className="text-slate-500 font-sans">Total Trades Executed:</span>
                    <strong className="text-slate-800">{comp.baselineTrades}</strong>
                  </div>
                  <div className="flex justify-between py-1.5 border-b border-slate-200/60">
                    <span className="text-slate-500 font-sans">Win Rate:</span>
                    <strong className="text-slate-800">{comp.baselineWinRate.toFixed(1)}%</strong>
                  </div>
                  <div className="flex justify-between py-1.5 border-b border-slate-200/60">
                    <span className="text-slate-500 font-sans">Winning Trades:</span>
                    <strong className="text-emerald-600">{comp.baselineWins}</strong>
                  </div>
                  <div className="flex justify-between py-1.5 border-b border-slate-200/60">
                    <span className="text-slate-500 font-sans">Losing Trades:</span>
                    <strong className="text-rose-600">{comp.baselineLosses}</strong>
                  </div>
                  <div className="flex justify-between py-1.5 border-b border-slate-200/60">
                    <span className="text-slate-500 font-sans">Net P&amp;L ($):</span>
                    <strong className={comp.baselineNetPnlUsd >= 0 ? "text-emerald-600" : "text-rose-600"}>
                      ${comp.baselineNetPnlUsd.toFixed(2)}
                    </strong>
                  </div>
                  <div className="flex justify-between py-1.5">
                    <span className="text-slate-500 font-sans">Max Drawdown:</span>
                    <strong className="text-rose-600">-{comp.baselineMaxDrawdownPercent.toFixed(1)}%</strong>
                  </div>
                </div>
              </div>

              {/* Optimized Unified Confluence Box */}
              <div className="bg-indigo-50/50 border border-indigo-200 rounded-xl p-5 space-y-4">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-mono uppercase font-bold text-indigo-700">
                    Optimized Confluence Matrix (&gt;60% WR)
                  </span>
                  <span className="text-[11px] font-mono text-emerald-600 font-bold">Filtered Gating</span>
                </div>
                <div className="space-y-3 font-mono text-xs">
                  <div className="flex justify-between py-1.5 border-b border-indigo-100">
                    <span className="text-slate-600 font-sans">High-Conviction Trades:</span>
                    <strong className="text-slate-800">{comp.optimizedTrades}</strong>
                  </div>
                  <div className="flex justify-between py-1.5 border-b border-indigo-100">
                    <span className="text-slate-600 font-sans">Optimized Win Rate:</span>
                    <strong className="text-emerald-600 text-sm">{comp.optimizedWinRate.toFixed(1)}%</strong>
                  </div>
                  <div className="flex justify-between py-1.5 border-b border-indigo-100">
                    <span className="text-slate-600 font-sans">Losing Trades Avoided:</span>
                    <strong className="text-indigo-600">
                      {comp.filteredOutLosses} ({comp.lossEliminationRate.toFixed(1)}% eliminated)
                    </strong>
                  </div>
                  <div className="flex justify-between py-1.5 border-b border-indigo-100">
                    <span className="text-slate-600 font-sans">Wins Retained:</span>
                    <strong className="text-emerald-600">
                      {comp.optimizedWins} ({comp.winRetentionRate.toFixed(1)}% retained)
                    </strong>
                  </div>
                  <div className="flex justify-between py-1.5 border-b border-indigo-100">
                    <span className="text-slate-600 font-sans">Optimized Net P&amp;L ($):</span>
                    <strong className={comp.optimizedNetPnlUsd >= 0 ? "text-emerald-600" : "text-slate-800"}>
                      ${comp.optimizedNetPnlUsd.toFixed(2)}
                    </strong>
                  </div>
                  <div className="flex justify-between py-1.5">
                    <span className="text-slate-600 font-sans">Max Drawdown:</span>
                    <strong className="text-emerald-600">-{comp.optimizedMaxDrawdownPercent.toFixed(1)}%</strong>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Tab 4: JSON Rule Preview View */}
        {activeViewTab === "matrix_preview" && (
          <div className="space-y-4 pt-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-mono text-slate-500">
                Executable ConfluenceRule[] payload ({selectedClustersList.length} rules selected)
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleOptimizeAndDeduplicateRules}
                  disabled={isOptimizingRules}
                  title="Remove duplicate rules and resolve conflicting settings"
                  className="px-3 py-1 bg-white hover:bg-slate-50 border border-slate-200 text-slate-700 rounded-lg text-xs font-semibold flex items-center gap-1 transition-colors cursor-pointer disabled:opacity-50"
                >
                  <Sparkles className="w-3.5 h-3.5 text-amber-500" />
                  <span>{isOptimizingRules ? "Optimizing..." : "Remove Conflicts"}</span>
                </button>
                <label
                  title="Import Confluence JSON (merges rules without deleting old settings)"
                  className="px-3 py-1 bg-white hover:bg-slate-50 border border-slate-200 text-slate-700 rounded-lg text-xs font-semibold flex items-center gap-1 transition-colors cursor-pointer"
                >
                  <Upload className="w-3.5 h-3.5 text-indigo-600" /> Import JSON
                  <input type="file" accept=".json" onChange={handleImportJson} className="hidden" />
                </label>
                <button
                  onClick={exportJson}
                  className="px-3 py-1 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-xs font-semibold flex items-center gap-1 transition-colors cursor-pointer"
                >
                  <Download className="w-3.5 h-3.5" /> Download JSON
                </button>
              </div>
            </div>
            <pre className="p-4 bg-slate-900 text-slate-200 font-mono text-xs rounded-xl overflow-x-auto max-h-[450px]">
              {JSON.stringify(
                {
                  enabled: true,
                  strict_mode: true,
                  min_validation_win_rate: minWinRate,
                  rules: selectedClustersList.map((c) => c.ruleCandidate),
                },
                null,
                2
              )}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
