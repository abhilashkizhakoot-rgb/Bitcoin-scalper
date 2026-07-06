import React, { useEffect, useState } from "react";
import { apiFetch } from "../utils/api.ts";
import {
  Terminal,
  RefreshCw,
  ChevronRight,
  ChevronDown,
  CheckCircle2,
  XCircle,
  Info,
  Shield,
  Search,
  SlidersHorizontal,
  Clock,
  ArrowRightLeft,
} from "lucide-react";
import { ApiCallLog } from "../types.js";
import { safeFormatTime } from "../utils/format";

interface ApiAnalyzerProps {
  isPaperMode?: boolean;
}

export default function ApiAnalyzer({ isPaperMode = true }: ApiAnalyzerProps) {
  const [logs, setLogs] = useState<ApiCallLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [selectedLogId, setSelectedLogId] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [serviceFilter, setServiceFilter] = useState<"ALL" | "Delta Exchange" | "Binance">("ALL");
  const [statusFilter, setStatusFilter] = useState<"ALL" | "SUCCESS" | "ERROR">("ALL");
  const [detailTab, setDetailTab] = useState<"headers" | "request" | "response">("response");

  const fetchLogs = async () => {
    try {
      const res = await apiFetch("/api/debug/api-logs");
      if (res.ok) {
        const data = await res.json();
        setLogs(data);
      }
    } catch (e) {
      console.error("Failed to fetch API logs:", e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchLogs();
  }, []);

  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(() => {
      fetchLogs();
    }, 2000);
    return () => clearInterval(interval);
  }, [autoRefresh]);

  const selectedLog = logs.find((l) => l.id === selectedLogId) || (logs.length > 0 ? logs[0] : null);

  // Auto-select first log if none is selected
  useEffect(() => {
    if (logs.length > 0 && !selectedLogId) {
      setSelectedLogId(logs[0].id);
    }
  }, [logs, selectedLogId]);

  const filteredLogs = logs.filter((log) => {
    const matchesSearch =
      log.url.toLowerCase().includes(searchTerm.toLowerCase()) ||
      log.method.toLowerCase().includes(searchTerm.toLowerCase()) ||
      log.response_body.toLowerCase().includes(searchTerm.toLowerCase());

    const matchesService = serviceFilter === "ALL" || log.service === serviceFilter;

    const isSuccess = log.response_status >= 200 && log.response_status < 300;
    const matchesStatus =
      statusFilter === "ALL" ||
      (statusFilter === "SUCCESS" && isSuccess) ||
      (statusFilter === "ERROR" && !isSuccess);

    return matchesSearch && matchesService && matchesStatus;
  });

  const avgLatency =
    logs.length > 0
      ? Math.round(logs.reduce((acc, curr) => acc + curr.latency_ms, 0) / logs.length)
      : 0;

  const successRate =
    logs.length > 0
      ? Math.round(
          (logs.filter((l) => l.response_status >= 200 && l.response_status < 300).length /
            logs.length) *
            100
        )
      : 100;

  return (
    <div className="grid grid-cols-1 xl:grid-cols-12 gap-6" id="api-analyzer-layout">
      {/* Explanation Banner */}
      <div className="xl:col-span-12 bg-indigo-50/60 border border-indigo-100 rounded-2xl p-5" id="api-analyzer-banner">
        <div className="flex gap-4">
          <div className="w-10 h-10 rounded-full bg-indigo-100 flex items-center justify-center text-indigo-600 shrink-0">
            <Info className="w-5 h-5" />
          </div>
          <div className="space-y-1">
            <h3 className="font-sans font-bold text-sm text-slate-800">
              Why do my manual/automatic trades not show up on my Delta Exchange account?
            </h3>
            <p className="text-xs text-slate-600 leading-relaxed max-w-4xl">
              Currently, the application's automated and manual trading engines operate on a 
              <strong> high-fidelity local engine</strong> using real-time Binance and Delta prices. 
              The Delta Exchange API integration is designed specifically for 
              <strong> live connection testing, credentials handshake validation, and secure real-time balance fetching</strong>. 
              Actual order packets are not dispatched to the live Delta Exchange order book to prevent accidental real-world financial losses during development. 
              Use this tool to analyze secure real-time API handshakes, verify signatures, and debug exchange connectivity.
            </p>
          </div>
        </div>
      </div>

      {/* Metrics Dashboard */}
      <div className="xl:col-span-12 grid grid-cols-1 md:grid-cols-4 gap-4" id="api-analyzer-metrics">
        <div className="bg-white border border-slate-200/80 p-4 rounded-xl shadow-sm flex items-center gap-3">
          <div className="p-2.5 rounded-lg bg-indigo-50 text-indigo-600">
            <Terminal className="w-5 h-5" />
          </div>
          <div>
            <p className="text-[10px] font-mono text-slate-400 uppercase tracking-wider leading-none">Total API Requests</p>
            <p className="text-lg font-sans font-extrabold text-slate-800 mt-1 leading-none">{logs.length}</p>
          </div>
        </div>

        <div className="bg-white border border-slate-200/80 p-4 rounded-xl shadow-sm flex items-center gap-3">
          <div className="p-2.5 rounded-lg bg-emerald-50 text-emerald-600">
            <CheckCircle2 className="w-5 h-5" />
          </div>
          <div>
            <p className="text-[10px] font-mono text-slate-400 uppercase tracking-wider leading-none">API Success Rate</p>
            <p className="text-lg font-sans font-extrabold text-slate-800 mt-1 leading-none">{successRate}%</p>
          </div>
        </div>

        <div className="bg-white border border-slate-200/80 p-4 rounded-xl shadow-sm flex items-center gap-3">
          <div className="p-2.5 rounded-lg bg-amber-50 text-amber-600">
            <Clock className="w-5 h-5" />
          </div>
          <div>
            <p className="text-[10px] font-mono text-slate-400 uppercase tracking-wider leading-none">Avg Latency</p>
            <p className="text-lg font-sans font-extrabold text-slate-800 mt-1 leading-none">{avgLatency} ms</p>
          </div>
        </div>

        <div className="bg-white border border-slate-200/80 p-4 rounded-xl shadow-sm flex items-center gap-3">
          <div className="p-2.5 rounded-lg bg-indigo-50 text-indigo-600">
            <ArrowRightLeft className="w-5 h-5" />
          </div>
          <div>
            <p className="text-[10px] font-mono text-slate-400 uppercase tracking-wider leading-none">Auto-Refresh</p>
            <div className="flex items-center gap-2 mt-1">
              <span className={`w-2 h-2 rounded-full ${autoRefresh ? "bg-emerald-500 animate-pulse" : "bg-slate-400"}`} />
              <button
                onClick={() => setAutoRefresh(!autoRefresh)}
                className="text-xs font-sans font-bold text-indigo-600 hover:text-indigo-700 cursor-pointer underline"
              >
                {autoRefresh ? "Enabled (2s)" : "Disabled"}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Main Panel - Left: Request List (5 cols), Right: Detail Inspector (7 cols) */}
      <div className="xl:col-span-5 bg-white border border-slate-200 shadow-sm rounded-2xl overflow-hidden flex flex-col h-[620px]" id="api-request-list-container">
        {/* Header Controls */}
        <div className="p-4 border-b border-slate-150 space-y-3 shrink-0">
          <div className="flex items-center justify-between">
            <h3 className="font-sans font-bold text-sm text-slate-800 flex items-center gap-2">
              <Terminal className="w-4 h-4 text-indigo-600" />
              Outgoing HTTP Requests
            </h3>
            <button
              onClick={fetchLogs}
              disabled={loading}
              className="p-1.5 hover:bg-slate-50 border border-slate-200 rounded-lg text-slate-500 hover:text-slate-700 transition-colors disabled:opacity-50 cursor-pointer"
              title="Manual Reload"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
            </button>
          </div>

          <div className="relative">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-2.5" />
            <input
              type="text"
              placeholder="Filter by endpoint..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-9 pr-4 py-1.5 text-xs border border-slate-200 rounded-xl bg-slate-50/50 focus:bg-white focus:outline-none focus:ring-1 focus:ring-indigo-500 font-sans"
            />
          </div>

          <div className="flex gap-2">
            <select
              value={serviceFilter}
              onChange={(e: any) => setServiceFilter(e.target.value)}
              className="flex-1 px-2.5 py-1 bg-slate-50 border border-slate-200 rounded-lg text-[10px] font-sans font-medium text-slate-600 focus:outline-none"
            >
              <option value="ALL">All Services</option>
              <option value="Delta Exchange">Delta Exchange</option>
              <option value="Binance">Binance</option>
            </select>

            <select
              value={statusFilter}
              onChange={(e: any) => setStatusFilter(e.target.value)}
              className="flex-1 px-2.5 py-1 bg-slate-50 border border-slate-200 rounded-lg text-[10px] font-sans font-medium text-slate-600 focus:outline-none"
            >
              <option value="ALL">All Status</option>
              <option value="SUCCESS">Success (2xx)</option>
              <option value="ERROR">Error (non-2xx)</option>
            </select>
          </div>
        </div>

        {/* Requests List */}
        <div className="flex-1 overflow-y-auto divide-y divide-slate-100 min-h-0">
          {filteredLogs.map((log) => {
            const isSelected = selectedLogId === log.id;
            const isSuccess = log.response_status >= 200 && log.response_status < 300;
            return (
              <div
                key={log.id}
                onClick={() => setSelectedLogId(log.id)}
                className={`p-3.5 cursor-pointer hover:bg-slate-50/75 transition-all flex flex-col gap-1.5 ${
                  isSelected ? "bg-indigo-50/40 border-l-2 border-indigo-600" : ""
                }`}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <span className={`px-1.5 py-0.5 rounded text-[8px] font-extrabold font-mono tracking-wide ${
                      log.method === "GET" ? "bg-emerald-50 text-emerald-600 border border-emerald-100" : "bg-blue-50 text-blue-600 border border-blue-100"
                    }`}>
                      {log.method}
                    </span>
                    <span className="text-[10px] font-sans font-semibold text-slate-700">
                      {log.service}
                    </span>
                  </div>
                  <span className={`inline-flex items-center gap-1 text-[10px] font-mono font-bold ${
                    isSuccess ? "text-emerald-600" : "text-rose-600"
                  }`}>
                    {isSuccess ? <CheckCircle2 className="w-3 h-3" /> : <XCircle className="w-3 h-3" />}
                    {log.response_status}
                  </span>
                </div>

                <div className="text-[10.5px] font-mono text-slate-500 truncate" title={log.url}>
                  {log.url.replace("https://api.delta.exchange", "").replace("https://testnet-api.delta.exchange", "").replace("https://api.binance.com", "")}
                </div>

                <div className="flex items-center justify-between text-[9px] font-mono text-slate-400 mt-0.5">
                  <span>{safeFormatTime(log.timestamp)}</span>
                  <span>{log.latency_ms} ms</span>
                </div>
              </div>
            );
          })}

          {filteredLogs.length === 0 && (
            <div className="p-8 text-center text-slate-400 font-sans text-xs italic">
              No recent real-time API logs found. Keep testing connection or start trading to generate requests.
            </div>
          )}
        </div>
      </div>

      {/* Main Panel - Right: Log Detail Inspector */}
      <div className="xl:col-span-7 bg-slate-950 border border-slate-900 shadow-xl rounded-2xl overflow-hidden flex flex-col h-[620px]" id="api-inspector-container">
        {selectedLog ? (
          <div className="flex flex-col h-full min-h-0 text-slate-200">
            {/* Inspector Header */}
            <div className="p-4 border-b border-slate-900 bg-slate-900/60 shrink-0">
              <div className="flex items-center gap-2">
                <span className={`px-2 py-0.5 rounded text-[9px] font-extrabold font-mono ${
                  selectedLog.method === "GET" ? "bg-emerald-950/80 text-emerald-400 border border-emerald-900" : "bg-blue-950/80 text-blue-400 border border-blue-900"
                }`}>
                  {selectedLog.method}
                </span>
                <h4 className="font-mono text-xs font-bold text-slate-100 truncate" title={selectedLog.url}>
                  {selectedLog.url}
                </h4>
              </div>

              <div className="flex items-center gap-4 mt-2.5 text-[10px] font-mono text-slate-400">
                <div className="flex items-center gap-1">
                  <span className="text-slate-500">Service:</span>
                  <span className="text-slate-300 font-semibold">{selectedLog.service}</span>
                </div>
                <div className="flex items-center gap-1">
                  <span className="text-slate-500">Status:</span>
                  <span className={`font-bold ${selectedLog.response_status < 300 ? "text-emerald-400" : "text-rose-400"}`}>
                    {selectedLog.response_status}
                  </span>
                </div>
                <div className="flex items-center gap-1">
                  <span className="text-slate-500">Latency:</span>
                  <span className="text-amber-400 font-semibold">{selectedLog.latency_ms} ms</span>
                </div>
                <div className="flex items-center gap-1 ml-auto">
                  <span className="text-slate-500">Time:</span>
                  <span className="text-slate-300">{safeFormatTime(selectedLog.timestamp)}</span>
                </div>
              </div>

              {/* Inspector Tabs */}
              <div className="flex gap-2 mt-4 border-b border-slate-900">
                <button
                  onClick={() => setDetailTab("response")}
                  className={`px-3 py-1.5 text-xs font-sans font-semibold transition-all cursor-pointer ${
                    detailTab === "response"
                      ? "text-indigo-400 border-b-2 border-indigo-500 bg-slate-900"
                      : "text-slate-400 hover:text-slate-200"
                  }`}
                >
                  Response Payload
                </button>
                <button
                  onClick={() => setDetailTab("headers")}
                  className={`px-3 py-1.5 text-xs font-sans font-semibold transition-all cursor-pointer ${
                    detailTab === "headers"
                      ? "text-indigo-400 border-b-2 border-indigo-500 bg-slate-900"
                      : "text-slate-400 hover:text-slate-200"
                  }`}
                >
                  Request Headers
                </button>
                {selectedLog.request_body && (
                  <button
                    onClick={() => setDetailTab("request")}
                    className={`px-3 py-1.5 text-xs font-sans font-semibold transition-all cursor-pointer ${
                      detailTab === "request"
                        ? "text-indigo-400 border-b-2 border-indigo-500 bg-slate-900"
                        : "text-slate-400 hover:text-slate-200"
                    }`}
                  >
                    Request Body
                  </button>
                )}
              </div>
            </div>

            {/* Inspector Tab Body */}
            <div className="flex-1 p-4 overflow-y-auto font-mono text-[11px] leading-relaxed select-all bg-slate-950 min-h-0">
              {detailTab === "headers" && (
                <div className="space-y-3">
                  <div>
                    <h5 className="text-[10px] text-indigo-400 font-bold uppercase tracking-wider mb-1.5">Request Headers</h5>
                    <div className="bg-slate-900/50 p-3 rounded-xl border border-slate-900 space-y-1.5">
                      {Object.keys(selectedLog.request_headers).map((key) => (
                        <div key={key} className="flex gap-2">
                          <span className="text-slate-400 shrink-0 select-none">{key}:</span>
                          <span className="text-emerald-400 break-all">{selectedLog.request_headers[key]}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div>
                    <h5 className="text-[10px] text-indigo-400 font-bold uppercase tracking-wider mb-1.5">Response Headers</h5>
                    <div className="bg-slate-900/50 p-3 rounded-xl border border-slate-900 space-y-1.5">
                      {Object.keys(selectedLog.response_headers || {}).map((key) => (
                        <div key={key} className="flex gap-2">
                          <span className="text-slate-400 shrink-0 select-none">{key}:</span>
                          <span className="text-slate-300 break-all">{selectedLog.response_headers?.[key]}</span>
                        </div>
                      ))}
                      {Object.keys(selectedLog.response_headers || {}).length === 0 && (
                        <span className="text-slate-500 italic">No response headers logged.</span>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {detailTab === "request" && (
                <div className="space-y-2">
                  <h5 className="text-[10px] text-indigo-400 font-bold uppercase tracking-wider mb-1.5">HTTP Request Body</h5>
                  <pre className="bg-slate-900/50 p-4 rounded-xl border border-slate-900 overflow-x-auto text-emerald-400 whitespace-pre-wrap break-all">
                    {selectedLog.request_body}
                  </pre>
                </div>
              )}

              {detailTab === "response" && (
                <div className="space-y-2 h-full flex flex-col">
                  <h5 className="text-[10px] text-indigo-400 font-bold uppercase tracking-wider shrink-0">HTTP Response Body</h5>
                  <pre className="flex-1 bg-slate-900/50 p-4 rounded-xl border border-slate-900 overflow-auto whitespace-pre-wrap break-all text-slate-300">
                    {selectedLog.response_body}
                  </pre>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="h-full flex items-center justify-center text-slate-500 font-sans text-xs italic">
            Select a request from the list to analyze live transaction handshakes
          </div>
        )}
      </div>
    </div>
  );
}
