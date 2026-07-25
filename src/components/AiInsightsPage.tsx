/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from "react";
import { motion } from "motion/react";
import {
  Sparkles,
  RefreshCw,
  Brain,
  ShieldCheck,
  TrendingUp,
  TrendingDown,
  AlertTriangle,
  Sliders,
  Gauge,
  History,
  BookOpen,
  CheckCircle2,
  ArrowUpRight,
  HelpCircle
} from "lucide-react";
import { apiFetch } from "../utils/api.ts";

interface Recommendation {
  category: string;
  title: string;
  suggestion: string;
  suggestedParams: string;
  confidenceScore: number;
  reasoning: string;
}

interface InsightsData {
  overallSummary: string;
  winLossAnalysis: string;
  marketConditions: {
    performsBest: string;
    performsWorst: string;
  };
  recommendations: Recommendation[];
  generatedAt?: string;
}

export default function AiInsightsPage() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [insights, setInsights] = useState<InsightsData | null>(null);
  const [isCached, setIsCached] = useState(false);

  // Fetch cached insights on mount
  const fetchCachedInsights = async () => {
    try {
      const res = await apiFetch("/api/gemini/insights");
      if (res.ok) {
        const data = await res.json();
        if (data.cached && data.insights) {
          setInsights(data.insights);
          setIsCached(true);
        }
      }
    } catch (e) {
      console.error("Failed to load cached insights:", e);
    }
  };

  useEffect(() => {
    fetchCachedInsights();
  }, []);

  const generateNewInsights = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch("/api/gemini/insights", {
        method: "POST",
      });
      const data = await res.json();
      if (res.ok && data.success && data.insights) {
        setInsights(data.insights);
        setIsCached(false);
      } else {
        setError(data.error || "Failed to generate AI insights. Please make sure GEMINI_API_KEY is configured.");
      }
    } catch (err: any) {
      setError(`Network error or model timeout: ${err.message || String(err)}`);
    } finally {
      setLoading(false);
    }
  };

  const getConfidenceColor = (score: number) => {
    if (score >= 85) return "text-emerald-600 bg-emerald-50 border-emerald-100";
    if (score >= 70) return "text-indigo-600 bg-indigo-50 border-indigo-100";
    return "text-amber-600 bg-amber-50 border-amber-100";
  };

  const getCategoryIcon = (category: string) => {
    const cat = category.toLowerCase();
    if (cat.includes("risk") || cat.includes("leverage")) return <ShieldCheck className="w-4 h-4 text-emerald-500" />;
    if (cat.includes("param") || cat.includes("atr") || cat.includes("profit") || cat.includes("stop")) return <Sliders className="w-4 h-4 text-indigo-500" />;
    return <Brain className="w-4 h-4 text-purple-500" />;
  };

  return (
    <div className="space-y-8" id="ai-insights-page-container">
      {/* ================= HEADER PANEL ================= */}
      <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm flex flex-col md:flex-row items-start md:items-center justify-between gap-6">
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <span className="bg-indigo-50 text-indigo-600 text-[10px] font-mono uppercase tracking-widest px-2.5 py-1 rounded-md border border-indigo-100/50 font-semibold">
              Advisory Mode
            </span>
            {insights && (
              <span className="bg-slate-50 border border-slate-200 text-slate-500 text-[10px] font-mono px-2 py-0.5 rounded-md flex items-center gap-1">
                <History className="w-3 h-3" />
                {isCached ? "Loaded from cache" : "Freshly generated"}
              </span>
            )}
          </div>
          <h2 className="text-xl font-sans font-bold text-slate-800 tracking-tight flex items-center gap-2.5">
            <Brain className="w-5.5 h-5.5 text-indigo-500 animate-pulse" />
            QUANT AI INSIGHTS
          </h2>
          <p className="text-xs text-slate-500 max-w-xl">
            Leverage Gemini-3.6-flash deep reasoning to audit historical trade logs, detect structural slippage, and calculate optimal risk-reward stop boundary modifications.
          </p>
        </div>

        <button
          onClick={generateNewInsights}
          disabled={loading}
          className={`px-5 py-3 rounded-xl text-xs font-medium font-sans border transition-all cursor-pointer flex items-center gap-2.5 shadow-sm min-w-[190px] justify-center ${
            loading
              ? "bg-slate-100 border-slate-200 text-slate-400"
              : "bg-slate-900 border-slate-900 hover:bg-slate-800 text-white"
          }`}
          id="btn-generate-ai-insights"
        >
          {loading ? (
            <>
              <RefreshCw className="w-4 h-4 animate-spin text-indigo-400" />
              Auditing Trade Logs...
            </>
          ) : (
            <>
              <Sparkles className="w-4 h-4 text-indigo-300" />
              Generate AI Insights
            </>
          )}
        </button>
      </div>

      {/* ================= ERROR STATE ================= */}
      {error && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-rose-50 border border-rose-200 rounded-xl p-5 text-rose-800 text-xs"
        >
          <div className="flex items-center gap-2 font-bold mb-1">
            <AlertTriangle className="w-4 h-4 text-rose-600" />
            Insights Generation Blocked
          </div>
          <p className="leading-relaxed mb-3">{error}</p>
          <div className="text-[10px] text-rose-500 font-mono">
            Ensure your GEMINI_API_KEY is configured in the AI Studio platform Settings menu.
          </div>
        </motion.div>
      )}

      {/* ================= EMPTY STATE ================= */}
      {!insights && !loading && !error && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="bg-white border border-slate-200 rounded-2xl p-12 text-center shadow-sm max-w-2xl mx-auto my-6"
        >
          <div className="w-12 h-12 bg-indigo-50 rounded-full flex items-center justify-center mx-auto mb-4 border border-indigo-100">
            <Brain className="w-6 h-6 text-indigo-500" />
          </div>
          <h3 className="font-sans font-bold text-slate-800 text-sm mb-2">No Advisor Report Generated Yet</h3>
          <p className="text-xs text-slate-500 max-w-md mx-auto leading-relaxed mb-6">
            Run a full-scale audit of your paper and live trades. The AI agent will parse technical parameters, orderbook depths, and regimes from recent sessions to isolate edge optimizations.
          </p>
          <button
            onClick={generateNewInsights}
            className="bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold px-5 py-2.5 rounded-xl shadow-sm transition-all cursor-pointer"
          >
            Audit Trade History Now
          </button>
        </motion.div>
      )}

      {/* ================= LOADING CANVAS STATE ================= */}
      {loading && (
        <div className="space-y-6">
          <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm space-y-4">
            <div className="h-4 bg-slate-100 rounded w-1/4 animate-pulse" />
            <div className="h-3 bg-slate-100 rounded w-full animate-pulse" />
            <div className="h-3 bg-slate-100 rounded w-5/6 animate-pulse" />
            <div className="h-3 bg-slate-100 rounded w-4/5 animate-pulse" />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm h-40 animate-pulse" />
            <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm h-40 animate-pulse" />
          </div>
        </div>
      )}

      {/* ================= INSIGHTS REPORT PRESENTATION ================= */}
      {insights && !loading && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="space-y-6"
        >
          {/* 1. Performance Summary & Win/Loss Block */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            <div className="lg:col-span-7 bg-white border border-slate-200 rounded-2xl p-6 shadow-sm space-y-4">
              <h3 className="font-sans font-bold text-slate-800 text-xs uppercase tracking-wider flex items-center gap-2">
                <BookOpen className="w-4 h-4 text-indigo-500" />
                Performance Audit Summary
              </h3>
              <p className="text-sm text-slate-600 leading-relaxed font-sans font-normal">
                {insights.overallSummary}
              </p>
              {insights.generatedAt && (
                <div className="text-[10px] font-mono text-slate-400 border-t border-slate-100 pt-3">
                  Report Compiled At: {new Date(insights.generatedAt).toLocaleString()}
                </div>
              )}
            </div>

            <div className="lg:col-span-5 bg-white border border-slate-200 rounded-2xl p-6 shadow-sm space-y-4">
              <h3 className="font-sans font-bold text-slate-800 text-xs uppercase tracking-wider flex items-center gap-2">
                <Gauge className="w-4 h-4 text-indigo-500" />
                Empirical Win/Loss Drivers
              </h3>
              <p className="text-sm text-slate-600 leading-relaxed font-sans font-normal">
                {insights.winLossAnalysis}
              </p>
            </div>
          </div>

          {/* 2. Best vs Worst Market Conditions */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Performs Best */}
            <div className="bg-emerald-50/40 border border-emerald-100 rounded-2xl p-6 shadow-sm space-y-3">
              <h4 className="font-sans font-bold text-emerald-800 text-xs uppercase tracking-wider flex items-center gap-2">
                <TrendingUp className="w-4 h-4 text-emerald-600" />
                Optimal Trading Environment
              </h4>
              <p className="text-xs text-emerald-900 leading-relaxed font-normal">
                {insights.marketConditions.performsBest}
              </p>
            </div>

            {/* Performs Worst */}
            <div className="bg-amber-50/40 border border-amber-100 rounded-2xl p-6 shadow-sm space-y-3">
              <h4 className="font-sans font-bold text-amber-800 text-xs uppercase tracking-wider flex items-center gap-2">
                <TrendingDown className="w-4 h-4 text-amber-600" />
                Underperforming Environment
              </h4>
              <p className="text-xs text-amber-900 leading-relaxed font-normal">
                {insights.marketConditions.performsWorst}
              </p>
            </div>
          </div>

          {/* 3. Actionable Quantitative Recommendations */}
          <div className="space-y-4">
            <h3 className="font-sans font-bold text-slate-800 text-xs uppercase tracking-wider flex items-center gap-2 px-1">
              <Sparkles className="w-4 h-4 text-indigo-500" />
              Strategic Risk & Parameter Optimizations
            </h3>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {insights.recommendations.map((rec, index) => (
                <div
                  key={index}
                  className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm space-y-4 flex flex-col justify-between"
                >
                  <div className="space-y-3">
                    {/* Category & Confidence bar */}
                    <div className="flex items-center justify-between gap-4">
                      <div className="flex items-center gap-2">
                        {getCategoryIcon(rec.category)}
                        <span className="text-[10px] font-mono uppercase tracking-wider text-slate-500 font-bold">
                          {rec.category}
                        </span>
                      </div>
                      <span className={`text-[10px] font-semibold font-mono border px-2 py-0.5 rounded-full ${getConfidenceColor(rec.confidenceScore)}`}>
                        {rec.confidenceScore}% Confidence
                      </span>
                    </div>

                    {/* Title */}
                    <h4 className="text-sm font-bold text-slate-800 leading-tight">
                      {rec.title}
                    </h4>

                    {/* Suggestion */}
                    <p className="text-xs text-slate-600 leading-relaxed font-normal">
                      {rec.suggestion}
                    </p>
                  </div>

                  <div className="space-y-3 pt-3 border-t border-slate-100">
                    {/* Suggested adjustment parameters code block */}
                    {rec.suggestedParams && (
                      <div className="bg-slate-50 border border-slate-100 p-2.5 rounded-lg text-slate-700">
                        <div className="text-[9px] font-mono text-indigo-500 font-bold uppercase tracking-widest mb-1">
                          Advisory Parameters
                        </div>
                        <code className="text-[10px] font-mono block select-all text-slate-800 break-words leading-normal font-semibold">
                          {rec.suggestedParams}
                        </code>
                      </div>
                    )}

                    {/* Detailed Data Reasoning */}
                    <div className="text-[11px] text-slate-500 leading-normal bg-slate-50/40 p-2.5 rounded-lg border border-slate-100/50">
                      <div className="font-bold text-slate-600 mb-0.5 flex items-center gap-1">
                        <ArrowUpRight className="w-3.5 h-3.5 text-slate-400" />
                        Log Analysis Reasoning:
                      </div>
                      <p className="italic font-sans text-slate-500">{rec.reasoning}</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* ================= STRATEGIC DISCLAIMER BLOCK ================= */}
          <div className="bg-indigo-50/50 border border-indigo-100 rounded-2xl p-5 flex items-start gap-4 shadow-sm">
            <div className="p-2 bg-indigo-100/60 rounded-xl text-indigo-600">
              <ShieldCheck className="w-5 h-5" />
            </div>
            <div className="space-y-1.5">
              <h4 className="text-xs font-bold text-indigo-900 uppercase tracking-wide">
                Rigid Safety & Non-Autonomous Constraints Active
              </h4>
              <p className="text-[11px] text-indigo-800 leading-relaxed font-normal">
                To protect live funds, the quant advisor is configured in **purely descriptive advisory mode**. It provides analytical observations and parameter estimates only, and is **strictly prohibited** from altering any configuration files or live engine parameters. Review recommendations and manually input optimization choices via the **Strategy Params** page when appropriate.
              </p>
            </div>
          </div>
        </motion.div>
      )}
    </div>
  );
}
