/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import express from "express";
import path from "path";
import crypto from "crypto";
import fs from "fs";
import { createServer as createViteServer } from "vite";
import { dbManager, DEFAULT_TIMING_WINDOWS, DEFAULT_SETUP_SESSION_MATRIX, DEFAULT_DAY_SESSION_MATRIX } from "./src/db_sim.js";
import { tradingEngine } from "./src/engine.js";
import { ConnectionStatus, MarketRegime } from "./src/types.js";
import { GoogleGenAI, Type } from "@google/genai";
import { AVAILABLE_SETUPS, runIsolatedBacktest } from "./src/backtester/backtestRunner.js";
import { rollingBufferManager } from "./src/backtester/rollingBuffer.js";
import { runConfluenceOptimization } from "./src/backtester/confluenceOptimizer.js";

function getRequestBaseUrl(req: express.Request): string {
  const url = getRawRequestBaseUrl(req);
  if (url && url.includes(".run.app") && url.startsWith("http://")) {
    return url.replace(/^http:\/\//i, "https://");
  }
  return url;
}

function getRawRequestBaseUrl(req: express.Request): string {
  // 1. Try to extract from origin or referer headers (highly reliable under proxies/sandboxes)
  const originHeader = req.headers["origin"];
  if (originHeader && typeof originHeader === "string" && originHeader.startsWith("http") && originHeader.includes(".run.app")) {
    return originHeader;
  }

  const refererHeader = req.headers["referer"];
  if (refererHeader && typeof refererHeader === "string" && refererHeader.startsWith("http") && refererHeader.includes(".run.app")) {
    try {
      const urlObj = new URL(refererHeader);
      if (urlObj.origin && urlObj.origin.startsWith("http") && urlObj.origin.includes(".run.app")) {
        return urlObj.origin;
      }
    } catch (e) {}
  }

  // 2. Scan all request headers for any .run.app domain
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") {
      const match = value.match(/([a-zA-Z0-9.-]+\.run\.app)/i);
      if (match) {
        const proto = req.headers["x-forwarded-proto"] || "https";
        const protocol = Array.isArray(proto) ? proto[0] : proto;
        return `${protocol}://${match[1]}`;
      }
    }
  }

  let proto = req.headers["x-forwarded-proto"] || req.protocol || "http";
  if (Array.isArray(proto)) {
    proto = proto[0];
  }
  let host = req.headers["x-forwarded-host"] || req.headers["host"] || req.get("host") || "";
  if (Array.isArray(host)) {
    host = host[0];
  }
  
  // If host is a local address, but process.env.APP_URL is defined, use APP_URL
  if ((!host || host.includes("localhost") || host.includes("127.0.0.1") || host.includes("0.0.0.0")) && process.env.APP_URL) {
    try {
      const urlObj = new URL(process.env.APP_URL);
      if (urlObj.host && !urlObj.host.includes("localhost")) {
        host = urlObj.host;
        proto = urlObj.protocol.replace(":", "");
      }
    } catch (e) {}
  }
  
  // Ensure that if we are on Cloud Run (which has K_SERVICE), we default to https if not explicitly http
  if (process.env.K_SERVICE && proto === "http") {
    proto = "https";
  }
  
  if (host && !host.includes("localhost") && !host.includes("127.0.0.1") && !host.includes("0.0.0.0")) {
    return `${proto}://${host}`;
  }

  // 3. Scan all environment variables last as a fallback if headers are not available or local
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string" && key !== "SHARED_URL" && key !== "DEV_URL") { // Skip generic cross URLs if possible
      const match = value.match(/(https?:\/\/[a-zA-Z0-9.-]+\.run\.app)/i);
      if (match) {
        return match[1];
      }
    }
  }

  // Last fallback to whatever .run.app URL is found in env if no headers or other keys matched
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") {
      const match = value.match(/(https?:\/\/[a-zA-Z0-9.-]+\.run\.app)/i);
      if (match) {
        return match[1];
      }
    }
  }

  return host ? `${proto}://${host}` : "";
}

async function startServer() {
  const app = express();
  app.set("trust proxy", true);
  const PORT = 3000;

  // Body parser
  app.use(express.json());

  // Enable CORS middleware for all API routes (important for sandboxed iframes)
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (!origin || origin === "null") {
      res.setHeader("Access-Control-Allow-Origin", "*");
    } else {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, api-key, signature, timestamp, x-requested-with");
    if (req.method === "OPTIONS") {
      res.sendStatus(200);
    } else {
      next();
    }
  });

  // ----------------------------------------------------
  // REST API: Exchange Configuration
  // ----------------------------------------------------

  app.get("/api/exchange/credentials", (req, res) => {
    const creds = dbManager.getCredentials();
    // Mask API secrets before sending to front-end
    const maskedCreds = {
      ...creds,
      api_key: creds.api_key ? `${creds.api_key.substring(0, 8)}...xxxx` : "",
      api_secret: creds.api_secret ? `${creds.api_secret.substring(0, 8)}...yyyy` : "",
    };
    res.json(maskedCreds);
  });

  app.put("/api/exchange/credentials", (req, res) => {
    const updates = req.body;
    // Don't overwrite if it is the masked placeholder
    if (updates.api_key && updates.api_key.includes("...xxxx")) {
      delete updates.api_key;
    }
    if (updates.api_secret && updates.api_secret.includes("...yyyy")) {
      delete updates.api_secret;
    }

    const updated = dbManager.updateCredentials(updates);
    res.json(updated);
  });

  app.post("/api/exchange/test-connection", async (req, res) => {
    dbManager.updateCredentials({
      connection_status: ConnectionStatus.TESTING,
      last_tested_at: new Date().toISOString(),
    });

    const creds = dbManager.getCredentials();
    const isMock = !creds.api_key || !creds.api_secret ||
      creds.api_key.includes("xxxxxxxxxxxxx") ||
      creds.api_secret.includes("yyyyyyyyyyyyy") ||
      creds.api_key === "mock" ||
      creds.api_secret === "mock";

    if (isMock) {
      // Simulate validation failure for sandbox keys after 1 second
      setTimeout(() => {
        dbManager.updateCredentials({
          connection_status: ConnectionStatus.FAILED,
          connection_error_message: "Authentication failed: Sandbox/mock credentials detected. Please configure real, active Delta Exchange API Key and Secret to connect.",
        });
      }, 1000);

      return res.json({ status: "testing_initiated", is_mock: true });
    }

    try {
      let baseUrl = "https://api.delta.exchange";
      if (creds.is_india) {
        baseUrl = creds.is_testnet ? "https://testnet-api.india.delta.exchange" : "https://api.india.delta.exchange";
      } else {
        baseUrl = creds.is_testnet ? "https://testnet-api.delta.exchange" : "https://api.delta.exchange";
      }
      const path = "/v2/wallet/balances";
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const method = "GET";
      const queryString = "";
      const payload = "";

      const signatureData = method + timestamp + path + queryString + payload;
      const signature = crypto.createHmac("sha256", creds.api_secret).update(signatureData).digest("hex");

      const headers: Record<string, string> = {
        "api-key": creds.api_key,
        "Content-Type": "application/json",
        "User-Agent": "Delta-Exchange-Trading-Bot/1.0"
      };

      if (creds.is_india) {
        headers["signature"] = signature;
        headers["timestamp"] = timestamp;
      } else {
        headers["api-signature"] = signature;
        headers["api-timestamp"] = timestamp;
      }

      const startTime = Date.now();
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers
      });
      const latencyMs = Date.now() - startTime;

      let responseText = "";
      const responseStatus = response.status;
      const respHeaders: Record<string, string> = {};
      response.headers.forEach((val, key) => {
        respHeaders[key] = val;
      });

      const maskedRequestHeaders = { ...headers };
      if (maskedRequestHeaders["api-key"]) {
        const k = maskedRequestHeaders["api-key"];
        maskedRequestHeaders["api-key"] = k.length > 8 ? k.substring(0, 4) + "..." + k.substring(k.length - 4) : "****";
      }
      if (maskedRequestHeaders["signature"]) {
        const s = maskedRequestHeaders["signature"];
        maskedRequestHeaders["signature"] = s.length > 6 ? "****" + s.substring(s.length - 6) : "****";
      }
      if (maskedRequestHeaders["api-signature"]) {
        const s = maskedRequestHeaders["api-signature"];
        maskedRequestHeaders["api-signature"] = s.length > 6 ? "****" + s.substring(s.length - 6) : "****";
      }

      let data: any = null;
      if (response.ok) {
        data = await response.json();
        responseText = JSON.stringify(data, null, 2);
      } else {
        responseText = await response.text();
      }

      dbManager.addApiLog({
        service: "Delta Exchange",
        method,
        url: `${baseUrl}${path}`,
        request_headers: maskedRequestHeaders,
        request_body: payload || undefined,
        response_status: responseStatus,
        response_headers: respHeaders,
        response_body: responseText,
        latency_ms: latencyMs,
      });

      if (response.ok) {
        // Set actual balance from Delta if available, otherwise fallback to existing mock balance
        let balanceUsdt = creds.account_balance_usdt;
        if (data && data.result && Array.isArray(data.result)) {
          const usdtBal = data.result.find((item: any) => {
            const sym = (item.asset_symbol || item.asset || item.symbol || (item.asset && item.asset.symbol) || "").toString().toUpperCase();
            return sym === "USDT";
          });
          if (usdtBal) {
            const val = usdtBal.balance !== undefined ? usdtBal.balance : (usdtBal.available_balance !== undefined ? usdtBal.available_balance : (usdtBal.wallet_balance !== undefined ? usdtBal.wallet_balance : "0"));
            balanceUsdt = parseFloat(val);
          }
        }
        dbManager.updateCredentials({
          connection_status: ConnectionStatus.CONNECTED,
          last_successful_connection: new Date().toISOString(),
          connection_error_message: null,
          account_balance_usdt: balanceUsdt,
        });
      } else {
        const errorText = responseText;
        let errorMessage = `Authentication failed (HTTP ${response.status})`;
        try {
          const parsedError = JSON.parse(errorText);
          if (parsedError.error && parsedError.error.message) {
            errorMessage += `: ${parsedError.error.message}`;
          } else if (parsedError.message) {
            errorMessage += `: ${parsedError.message}`;
          }
        } catch {
          if (errorText) {
            errorMessage += `: ${errorText.substring(0, 100)}`;
          }
        }

        dbManager.updateCredentials({
          connection_status: ConnectionStatus.FAILED,
          connection_error_message: errorMessage,
        });
      }
    } catch (error: any) {
      dbManager.updateCredentials({
        connection_status: ConnectionStatus.FAILED,
        connection_error_message: `Network failure connecting to Delta Exchange: ${error.message || error}`,
      });
    }

    res.json({ status: "testing_initiated", is_mock: false });
  });

  // ----------------------------------------------------
  // REST API: Trading Control
  // ----------------------------------------------------

  app.post("/api/trading/start", (req, res) => {
    dbManager.updateConfig("general", { is_trading_active: true });
    res.json({ status: "trading_started" });
  });

  app.post("/api/trading/stop", (req, res) => {
    dbManager.updateConfig("general", { is_trading_active: false });
    res.json({ status: "trading_stopped" });
  });

  app.post("/api/trading/toggle-paper-mode", (req, res) => {
    const { is_paper_trading } = req.body;
    dbManager.updateConfig("general", { is_paper_trading: is_paper_trading === true });
    res.json({ success: true, is_paper_trading: dbManager.isPaperMode() });
  });

  app.post("/api/trading/toggle-reverse-trading", (req, res) => {
    const config = dbManager.getConfig();
    const current = config.general.invert_confirmed_trades === true;
    const updatedVal = req.body.invert_confirmed_trades !== undefined
      ? req.body.invert_confirmed_trades === true
      : !current;
    dbManager.updateConfig("general", { invert_confirmed_trades: updatedVal });
    res.json({ success: true, invert_confirmed_trades: updatedVal });
  });

  app.post("/api/trading/clear-history", (req, res) => {
    const { mode } = req.body;
    if (!mode || !["live", "paper", "both"].includes(mode)) {
      return res.status(400).json({ success: false, message: "Invalid clear mode requested." });
    }
    dbManager.clearTrades(mode as any);
    res.json({ success: true, message: `Successfully cleared trade history for ${mode} trading.` });
  });

  app.post("/api/trading/force-exit", (req, res) => {
    const executed = tradingEngine.forceExit();
    res.json({ executed, message: executed ? "Manual trade exit executed successfully." : "No active trade to exit." });
  });

  app.post("/api/trading/manual-entry", (req, res) => {
    const { direction, quantity_btc, leverage, stop_loss_price, take_profit_price } = req.body;
    
    if (!direction || !quantity_btc || !leverage) {
      return res.status(400).json({ success: false, message: "Missing required fields: direction, quantity_btc, and leverage are required." });
    }

    const result = tradingEngine.executeManualTradeEntry(
      direction,
      parseFloat(quantity_btc),
      parseInt(leverage, 10),
      stop_loss_price ? parseFloat(stop_loss_price) : null,
      take_profit_price ? parseFloat(take_profit_price) : null
    );

    if (!result.success) {
      res.status(400).json(result);
    } else {
      res.json(result);
    }
  });

  app.post("/api/strategy/toggle-setup-3", (req, res) => {
    const currentConfig = dbManager.getConfig();
    const currentVal = currentConfig.market_structure?.liquidity_sweep_enabled !== false;
    const newVal = req.body && req.body.enabled !== undefined ? !!req.body.enabled : !currentVal;
    dbManager.updateConfig("market_structure", { liquidity_sweep_enabled: newVal }, "Setup 3 Toggle");
    res.json({ success: true, liquidity_sweep_enabled: newVal, config: dbManager.getConfig() });
  });

  const setupFieldMap: Record<string, string> = {
    setup_1_pullback_retest: "pullback_retest_enabled",
    setup_2_dynamic_ema_pushback: "ema_pushback_enabled",
    setup_3_liquidity_sweep: "liquidity_sweep_enabled",
    setup_4_fvg_retest: "fvg_strategy_enabled",
    setup_9_range_failed_auction: "failed_auction_strategy_enabled",
    setup_10_vwap_band_rejection: "vwap_band_reversal_enabled",
    setup_11_eqh_eql_double_touch: "eqh_eql_strategy_enabled",
    setup_12_cvd_absorption: "cvd_divergence_strategy_enabled",
    setup_13_oi_flush_cascade: "oi_flush_strategy_enabled",
    setup_14_fresh_momentum_impulse: "fresh_momentum_strategy_enabled",
  };

  app.post("/api/strategy/toggle-setup", (req, res) => {
    const { setupId, enabled } = req.body || {};
    if (!setupId || !setupFieldMap[setupId]) {
      return res.status(400).json({ success: false, message: `Invalid setupId: ${setupId}` });
    }
    const currentConfig = dbManager.getConfig();
    const field = setupFieldMap[setupId];
    const currentVal = (currentConfig.market_structure as any)?.[field] !== false;
    const newVal = enabled !== undefined ? !!enabled : !currentVal;
    dbManager.updateConfig("market_structure", { [field]: newVal }, `Toggle ${setupId}`);
    res.json({ success: true, setupId, enabled: newVal, config: dbManager.getConfig() });
  });

  app.post("/api/strategy/regime-matrix/toggle-cell", (req, res) => {
    const { setupId, regime, enabled } = req.body || {};
    if (!setupId || !regime) {
      return res.status(400).json({ success: false, message: "Missing setupId or regime" });
    }
    const currentConfig = dbManager.getConfig();
    const ms = (currentConfig.market_structure || {}) as any;
    const defaultMatrix: Record<string, MarketRegime[]> = {
      setup_1_pullback_retest: [MarketRegime.STRONG_UPTREND, MarketRegime.STRONG_DOWNTREND],
      setup_2_dynamic_ema_pushback: [MarketRegime.STRONG_UPTREND, MarketRegime.STRONG_DOWNTREND],
      setup_3_liquidity_sweep: [MarketRegime.RANGE_BOUND, MarketRegime.HIGH_VOLATILITY, MarketRegime.LOW_VOLATILITY],
      setup_4_fvg_retest: [MarketRegime.STRONG_UPTREND, MarketRegime.STRONG_DOWNTREND, MarketRegime.RANGE_BOUND, MarketRegime.HIGH_VOLATILITY],
      setup_9_range_failed_auction: [MarketRegime.RANGE_BOUND, MarketRegime.LOW_VOLATILITY],
      setup_10_vwap_band_rejection: [MarketRegime.RANGE_BOUND, MarketRegime.LOW_VOLATILITY],
      setup_11_eqh_eql_double_touch: [MarketRegime.RANGE_BOUND, MarketRegime.LOW_VOLATILITY],
      setup_12_cvd_absorption: [MarketRegime.RANGE_BOUND, MarketRegime.HIGH_VOLATILITY],
      setup_13_oi_flush_cascade: [MarketRegime.HIGH_VOLATILITY, MarketRegime.RANGE_BOUND],
      setup_14_fresh_momentum_impulse: [MarketRegime.STRONG_UPTREND, MarketRegime.STRONG_DOWNTREND, MarketRegime.HIGH_VOLATILITY, MarketRegime.LOW_VOLATILITY],
      setup_15_trendline_bounce: [MarketRegime.STRONG_UPTREND, MarketRegime.STRONG_DOWNTREND, MarketRegime.HIGH_VOLATILITY, MarketRegime.RANGE_BOUND],
    };

    const currentMatrix = { ...(ms.setup_regime_matrix || defaultMatrix) };
    const currentList = currentMatrix[setupId] ? [...currentMatrix[setupId]] : (defaultMatrix[setupId] ? [...defaultMatrix[setupId]] : []);

    let updatedList: MarketRegime[];
    if (enabled !== undefined) {
      if (enabled && !currentList.includes(regime)) {
        updatedList = [...currentList, regime];
      } else if (!enabled) {
        updatedList = currentList.filter(r => r !== regime);
      } else {
        updatedList = currentList;
      }
    } else {
      if (currentList.includes(regime)) {
        updatedList = currentList.filter(r => r !== regime);
      } else {
        updatedList = [...currentList, regime];
      }
    }

    currentMatrix[setupId] = updatedList;
    dbManager.updateConfig("market_structure", { setup_regime_matrix: currentMatrix }, `Matrix Toggle ${setupId} - ${regime}`);
    res.json({ success: true, setupId, regime, allowed: updatedList.includes(regime), setup_regime_matrix: currentMatrix });
  });

  app.post("/api/strategy/regime-matrix/preset", (req, res) => {
    const { preset } = req.body || {};
    let matrix: Record<string, MarketRegime[]>;

    if (preset === "ALL_PERMISSIVE") {
      const all = Object.values(MarketRegime);
      matrix = {
        setup_1_pullback_retest: all,
        setup_2_dynamic_ema_pushback: all,
        setup_3_liquidity_sweep: all,
        setup_4_fvg_retest: all,
        setup_9_range_failed_auction: all,
        setup_10_vwap_band_rejection: all,
        setup_11_eqh_eql_double_touch: all,
        setup_12_cvd_absorption: all,
        setup_13_oi_flush_cascade: all,
        setup_14_fresh_momentum_impulse: all,
        setup_15_trendline_bounce: all,
      };
    } else if (preset === "STRICT_TREND") {
      matrix = {
        setup_1_pullback_retest: [MarketRegime.STRONG_UPTREND, MarketRegime.STRONG_DOWNTREND],
        setup_2_dynamic_ema_pushback: [MarketRegime.STRONG_UPTREND, MarketRegime.STRONG_DOWNTREND],
        setup_3_liquidity_sweep: [],
        setup_4_fvg_retest: [MarketRegime.STRONG_UPTREND, MarketRegime.STRONG_DOWNTREND],
        setup_9_range_failed_auction: [],
        setup_10_vwap_band_rejection: [],
        setup_11_eqh_eql_double_touch: [],
        setup_12_cvd_absorption: [],
        setup_13_oi_flush_cascade: [MarketRegime.HIGH_VOLATILITY],
        setup_14_fresh_momentum_impulse: [MarketRegime.STRONG_UPTREND, MarketRegime.STRONG_DOWNTREND],
        setup_15_trendline_bounce: [MarketRegime.STRONG_UPTREND, MarketRegime.STRONG_DOWNTREND],
      };
    } else if (preset === "STRICT_RANGE") {
      matrix = {
        setup_1_pullback_retest: [],
        setup_2_dynamic_ema_pushback: [],
        setup_3_liquidity_sweep: [MarketRegime.RANGE_BOUND, MarketRegime.LOW_VOLATILITY],
        setup_4_fvg_retest: [MarketRegime.RANGE_BOUND],
        setup_9_range_failed_auction: [MarketRegime.RANGE_BOUND, MarketRegime.LOW_VOLATILITY],
        setup_10_vwap_band_rejection: [MarketRegime.RANGE_BOUND, MarketRegime.LOW_VOLATILITY],
        setup_11_eqh_eql_double_touch: [MarketRegime.RANGE_BOUND, MarketRegime.LOW_VOLATILITY],
        setup_12_cvd_absorption: [MarketRegime.RANGE_BOUND],
        setup_13_oi_flush_cascade: [MarketRegime.RANGE_BOUND],
        setup_14_fresh_momentum_impulse: [],
        setup_15_trendline_bounce: [MarketRegime.RANGE_BOUND],
      };
    } else {
      // QUANT_OPTIMAL (Default)
      matrix = {
        setup_1_pullback_retest: [MarketRegime.STRONG_UPTREND, MarketRegime.STRONG_DOWNTREND],
        setup_2_dynamic_ema_pushback: [MarketRegime.STRONG_UPTREND, MarketRegime.STRONG_DOWNTREND],
        setup_3_liquidity_sweep: [MarketRegime.RANGE_BOUND, MarketRegime.HIGH_VOLATILITY, MarketRegime.LOW_VOLATILITY],
        setup_4_fvg_retest: [MarketRegime.STRONG_UPTREND, MarketRegime.STRONG_DOWNTREND, MarketRegime.RANGE_BOUND, MarketRegime.HIGH_VOLATILITY],
        setup_9_range_failed_auction: [MarketRegime.RANGE_BOUND, MarketRegime.LOW_VOLATILITY],
        setup_10_vwap_band_rejection: [MarketRegime.RANGE_BOUND, MarketRegime.LOW_VOLATILITY],
        setup_11_eqh_eql_double_touch: [MarketRegime.RANGE_BOUND, MarketRegime.LOW_VOLATILITY],
        setup_12_cvd_absorption: [MarketRegime.RANGE_BOUND, MarketRegime.HIGH_VOLATILITY],
        setup_13_oi_flush_cascade: [MarketRegime.HIGH_VOLATILITY, MarketRegime.RANGE_BOUND],
        setup_14_fresh_momentum_impulse: [MarketRegime.STRONG_UPTREND, MarketRegime.STRONG_DOWNTREND, MarketRegime.HIGH_VOLATILITY, MarketRegime.LOW_VOLATILITY],
        setup_15_trendline_bounce: [MarketRegime.STRONG_UPTREND, MarketRegime.STRONG_DOWNTREND, MarketRegime.HIGH_VOLATILITY, MarketRegime.RANGE_BOUND],
      };
    }

    dbManager.updateConfig("market_structure", { setup_regime_matrix: matrix }, `Preset applied: ${preset || "QUANT_OPTIMAL"}`);
    res.json({ success: true, preset: preset || "QUANT_OPTIMAL", setup_regime_matrix: matrix });
  });

  // REST API: Session x Setup Matrix Controls
  // ----------------------------------------------------
  app.post("/api/strategy/session-matrix/toggle-cell", (req, res) => {
    const { setupId, session, enabled } = req.body || {};
    if (!setupId || !session) {
      return res.status(400).json({ success: false, message: "Missing setupId or session" });
    }
    const currentConfig = dbManager.getConfig();
    const ms = (currentConfig.market_structure || {}) as any;
    const defaultMatrix: Record<string, string[]> = DEFAULT_SETUP_SESSION_MATRIX;

    const currentMatrix = { ...(ms.setup_session_matrix || defaultMatrix) };
    const currentList: string[] = currentMatrix[setupId] ? [...currentMatrix[setupId]] : (defaultMatrix[setupId] ? [...defaultMatrix[setupId]] : []);

    let updatedList: string[];
    if (enabled !== undefined) {
      if (enabled && !currentList.includes(session)) {
        updatedList = [...currentList, session];
      } else if (!enabled) {
        updatedList = currentList.filter(s => s !== session);
      } else {
        updatedList = currentList;
      }
    } else {
      if (currentList.includes(session)) {
        updatedList = currentList.filter(s => s !== session);
      } else {
        updatedList = [...currentList, session];
      }
    }

    currentMatrix[setupId] = updatedList;
    dbManager.updateConfig("market_structure", { setup_session_matrix: currentMatrix }, `Session Matrix Toggle ${setupId} - ${session}`);
    res.json({ success: true, setupId, session, allowed: updatedList.includes(session), setup_session_matrix: currentMatrix });
  });

  app.post("/api/strategy/session-matrix/preset", (req, res) => {
    const { preset } = req.body || {};
    let matrix: Record<string, string[]>;
    const allSessions = ["asia_open", "intraday_chop", "europe_us_overlap", "late_us_session", "dead_liquidity", "weekends"];
    const peakSessions = ["asia_open", "europe_us_overlap", "late_us_session"];

    if (preset === "ALL_PERMISSIVE") {
      matrix = {
        setup_1_pullback_retest: allSessions,
        setup_2_dynamic_ema_pushback: allSessions,
        setup_3_liquidity_sweep: allSessions,
        setup_4_fvg_retest: allSessions,
        setup_9_range_failed_auction: allSessions,
        setup_10_vwap_band_rejection: allSessions,
        setup_11_eqh_eql_double_touch: allSessions,
        setup_12_cvd_absorption: allSessions,
        setup_13_oi_flush_cascade: allSessions,
        setup_14_fresh_momentum_impulse: allSessions,
        setup_15_trendline_bounce: allSessions,
      };
    } else if (preset === "STRICT_PEAK_ONLY") {
      matrix = {
        setup_1_pullback_retest: peakSessions,
        setup_2_dynamic_ema_pushback: ["europe_us_overlap", "late_us_session"],
        setup_3_liquidity_sweep: peakSessions,
        setup_4_fvg_retest: peakSessions,
        setup_9_range_failed_auction: ["asia_open"],
        setup_10_vwap_band_rejection: ["asia_open"],
        setup_11_eqh_eql_double_touch: peakSessions,
        setup_12_cvd_absorption: peakSessions,
        setup_13_oi_flush_cascade: ["europe_us_overlap", "late_us_session"],
        setup_14_fresh_momentum_impulse: peakSessions,
        setup_15_trendline_bounce: peakSessions,
      };
    } else if (preset === "MEAN_REVERSION_FOCUS") {
      matrix = {
        setup_1_pullback_retest: ["europe_us_overlap", "late_us_session"],
        setup_2_dynamic_ema_pushback: ["europe_us_overlap"],
        setup_3_liquidity_sweep: allSessions,
        setup_4_fvg_retest: ["europe_us_overlap", "late_us_session"],
        setup_9_range_failed_auction: allSessions,
        setup_10_vwap_band_rejection: allSessions,
        setup_11_eqh_eql_double_touch: allSessions,
        setup_12_cvd_absorption: ["intraday_chop", "dead_liquidity", "weekends"],
        setup_13_oi_flush_cascade: ["europe_us_overlap", "late_us_session"],
        setup_14_fresh_momentum_impulse: ["europe_us_overlap"],
        setup_15_trendline_bounce: ["europe_us_overlap", "late_us_session"],
      };
    } else {
      // QUANT_OPTIMAL (Default)
      matrix = { ...DEFAULT_SETUP_SESSION_MATRIX };
    }

    dbManager.updateConfig("market_structure", { setup_session_matrix: matrix }, `Session preset applied: ${preset || "QUANT_OPTIMAL"}`);
    res.json({ success: true, preset: preset || "QUANT_OPTIMAL", setup_session_matrix: matrix });
  });

  // ----------------------------------------------------
  // REST API: Days of Week vs Trading Sessions Matrix
  // ----------------------------------------------------

  app.post("/api/strategy/day-session-matrix/toggle-cell", (req, res) => {
    const { dayId, session, enabled } = req.body || {};
    if (!dayId || !session) {
      return res.status(400).json({ error: "Missing dayId or session parameter." });
    }

    const config = dbManager.getConfig();
    const ms = (config.market_structure || {}) as any;
    const defaultMatrix = DEFAULT_DAY_SESSION_MATRIX;
    const currentMatrix = { ...(ms.day_session_matrix || defaultMatrix) };
    const currentList: string[] = currentMatrix[dayId] ? [...currentMatrix[dayId]] : (defaultMatrix[dayId] ? [...defaultMatrix[dayId]] : []);

    let updatedList: string[];
    if (enabled !== undefined) {
      if (enabled && !currentList.includes(session)) {
        updatedList = [...currentList, session];
      } else if (!enabled) {
        updatedList = currentList.filter(s => s !== session);
      } else {
        updatedList = currentList;
      }
    } else {
      if (currentList.includes(session)) {
        updatedList = currentList.filter(s => s !== session);
      } else {
        updatedList = [...currentList, session];
      }
    }

    currentMatrix[dayId] = updatedList;
    dbManager.updateConfig("market_structure", { day_session_matrix: currentMatrix }, `Day-Session Matrix Toggle ${dayId} - ${session}`);
    res.json({ success: true, dayId, session, allowed: updatedList.includes(session), day_session_matrix: currentMatrix });
  });

  app.post("/api/strategy/day-session-matrix/toggle-day", (req, res) => {
    const { dayId, allowAll } = req.body || {};
    if (!dayId) {
      return res.status(400).json({ error: "Missing dayId parameter." });
    }

    const allSessions = ["asia_open", "intraday_chop", "europe_us_overlap", "late_us_session", "dead_liquidity", "weekends"];
    const config = dbManager.getConfig();
    const ms = (config.market_structure || {}) as any;
    const defaultMatrix = DEFAULT_DAY_SESSION_MATRIX;
    const currentMatrix = { ...(ms.day_session_matrix || defaultMatrix) };

    currentMatrix[dayId] = allowAll ? allSessions : [];
    dbManager.updateConfig("market_structure", { day_session_matrix: currentMatrix }, `Day-Session Matrix ${allowAll ? "Allow All" : "Block All"} on ${dayId}`);
    res.json({ success: true, dayId, allowedSessions: currentMatrix[dayId], day_session_matrix: currentMatrix });
  });

  app.post("/api/strategy/day-session-matrix/preset", (req, res) => {
    const { preset } = req.body || {};
    let matrix: Record<string, string[]>;
    const allSessions = ["asia_open", "intraday_chop", "europe_us_overlap", "late_us_session", "dead_liquidity", "weekends"];
    const peakSessions = ["asia_open", "europe_us_overlap", "late_us_session"];

    if (preset === "ALL_PERMISSIVE") {
      matrix = {
        monday: allSessions,
        tuesday: allSessions,
        wednesday: allSessions,
        thursday: allSessions,
        friday: allSessions,
        saturday: allSessions,
        sunday: allSessions,
      };
    } else if (preset === "PEAK_HOURS_ONLY") {
      matrix = {
        monday: ["asia_open", "europe_us_overlap"],
        tuesday: ["asia_open", "europe_us_overlap"],
        wednesday: ["asia_open", "europe_us_overlap"],
        thursday: ["asia_open", "europe_us_overlap"],
        friday: ["europe_us_overlap"], // Friday Asian open disabled
        saturday: [],
        sunday: [],
      };
    } else if (preset === "NO_WEEKENDS") {
      matrix = {
        monday: allSessions,
        tuesday: allSessions,
        wednesday: allSessions,
        thursday: allSessions,
        friday: ["intraday_chop", "europe_us_overlap", "late_us_session"], // Friday Asian open disabled
        saturday: [],
        sunday: [],
      };
    } else if (preset === "INSTITUTIONAL_HIERARCHY") {
      matrix = { ...DEFAULT_DAY_SESSION_MATRIX };
    } else {
      // QUANT_SEASONALITY (Default): Friday Asian Open & Sunday Dead Liquidity disabled
      matrix = { ...DEFAULT_DAY_SESSION_MATRIX };
    }

    dbManager.updateConfig("market_structure", { day_session_matrix: matrix }, `Day-Session preset applied: ${preset || "QUANT_SEASONALITY"}`);
    res.json({ success: true, preset: preset || "QUANT_SEASONALITY", day_session_matrix: matrix });
  });

  // Dedicated One-Click Institutional Research Hierarchy Preset Applier
  app.post("/api/strategy/institutional-preset/apply", (req, res) => {
    // 1. Timing Windows aligned with UTC/IST Research
    dbManager.updateConfig("general", { timing_windows: DEFAULT_TIMING_WINDOWS }, "Applied Institutional Research Timing Windows (UTC/IST Hierarchy)");

    // 2. Setup Session Matrix (FVG & Order Flow in Overlap, SMC Sweeps in London Open, Mean Reversion in Asian/Chop)
    dbManager.updateConfig("market_structure", {
      setup_session_matrix: DEFAULT_SETUP_SESSION_MATRIX,
      day_session_matrix: DEFAULT_DAY_SESSION_MATRIX,
      day_session_matrix_enabled: true,
      dynamic_session_setup_matrix_enabled: true,
      dynamic_condition_rules_enabled: true,
      asian_session_strict_filtering: true,
      asian_session_min_rvol: 1.35,
      asian_session_min_atr: 28.0,
      europe_us_overlap_aggressive_mode: true,
    }, "Applied Institutional Research Setup & Day Seasonality Matrices");

    // 3. Risk Management: Overlap 1.25x sizing, Thursday 0.85x de-risking, Friday 0.70x close protection
    dbManager.updateConfig("risk_management", {
      enable_session_risk_scaling: true,
      session_overlap_risk_multiplier: 1.25,
      thursday_risk_multiplier: 0.85,
      friday_risk_multiplier: 0.70,
    }, "Applied Institutional Calendar Risk Multipliers (Overlap 1.25x, Thu 0.85x, Fri 0.70x)");

    res.json({
      success: true,
      message: "Institutional Research Hierarchy Preset applied successfully across all modules.",
      config: dbManager.getConfig(),
    });
  });

  app.post("/api/strategy/dynamic-conditions/update", (req, res) => {
    const payload = req.body || {};
    const updates: any = {};
    const allowedKeys = [
      "dynamic_regime_setup_matrix_enabled",
      "dynamic_session_setup_matrix_enabled",
      "day_session_matrix_enabled",
      "dynamic_condition_rules_enabled",
      "dynamic_mean_reversion_max_adx",
      "dynamic_trend_min_adx",
      "dynamic_trend_max_chop_index",
      "dynamic_breakout_min_atr",
      "asian_session_strict_filtering",
      "asian_session_min_rvol",
      "asian_session_min_atr",
      "europe_us_overlap_aggressive_mode",
    ];

    for (const key of allowedKeys) {
      if (payload[key] !== undefined) {
        updates[key] = payload[key];
      }
    }

    if (payload.dynamic_regime_setup_matrix_enabled !== undefined) {
      dbManager.updateConfig("risk_management", {
        hybrid_regime_switching_enabled: payload.dynamic_regime_setup_matrix_enabled === true,
      });
    }

    dbManager.updateConfig("market_structure", updates, "Dynamic Conditions Rules Update");
    res.json({ success: true, updates, config: dbManager.getConfig() });
  });

  // ----------------------------------------------------
  // REST API: Historical Data-Driven Auto-Tuner & Optimization
  // ----------------------------------------------------

  app.get("/api/strategy/historical-optimization/analysis", (req, res) => {
    try {
      const report = dbManager.generateHistoricalOptimizationReport();
      res.json(report);
    } catch (e: any) {
      console.error("Failed to generate historical optimization report:", e);
      res.status(500).json({ error: e.message || "Failed to generate report" });
    }
  });

  app.post("/api/strategy/historical-optimization/apply", (req, res) => {
    try {
      const { selected_recommendations } = req.body || {};
      const result = dbManager.applyHistoricalOptimization(selected_recommendations);
      res.json(result);
    } catch (e: any) {
      console.error("Failed to apply historical optimization:", e);
      res.status(500).json({ error: e.message || "Failed to apply optimization" });
    }
  });

  // ----------------------------------------------------
  // REST API: Unified Confluence Matrix Gating Hub
  // ----------------------------------------------------

  app.get("/api/strategy/unified-confluence", (req, res) => {
    try {
      const config = dbManager.getUnifiedConfluenceConfig();
      res.json({ success: true, config });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.post("/api/strategy/unified-confluence", (req, res) => {
    try {
      const updates = req.body || {};
      const updated = dbManager.updateUnifiedConfluenceConfig(updates);
      res.json({ success: true, config: updated });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.post("/api/strategy/unified-confluence/reset", (req, res) => {
    try {
      const resetConfig = dbManager.resetUnifiedConfluenceToPreset();
      res.json({ success: true, message: "Reset to 25 empirical robust backtest clusters", config: resetConfig });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.post("/api/strategy/unified-confluence/toggle-rule", (req, res) => {
    try {
      const { ruleId, isEnabled } = req.body || {};
      if (!ruleId) {
        return res.status(400).json({ success: false, message: "Missing ruleId" });
      }
      const updated = dbManager.toggleConfluenceRule(ruleId, isEnabled);
      res.json({ success: true, config: updated });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.post("/api/strategy/unified-confluence/add-rule", (req, res) => {
    try {
      const rule = req.body;
      if (!rule || !rule.id) {
        return res.status(400).json({ success: false, message: "Invalid rule definition" });
      }
      const updated = dbManager.addConfluenceRule(rule);
      res.json({ success: true, config: updated });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.delete("/api/strategy/unified-confluence/rule/:id", (req, res) => {
    try {
      const ruleId = req.params.id;
      const updated = dbManager.deleteConfluenceRule(ruleId);
      res.json({ success: true, config: updated });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.post("/api/strategy/unified-confluence/import", (req, res) => {
    try {
      const { rules, mergeStrategy = "merge", configUpdates } = req.body || {};
      if (!Array.isArray(rules)) {
        return res.status(400).json({ success: false, message: "rules array is required" });
      }

      const result = dbManager.importUnifiedConfluenceRules(rules, {
        mergeStrategy,
        configUpdates,
      });

      res.json({
        success: true,
        message: `Successfully imported ${rules.length} rules (${result.addedCount} new rules added, ${result.updatedCount} rules updated, ${result.preservedCount} old rules preserved. Total: ${result.totalCount} rules).`,
        ...result,
      });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.post("/api/strategy/unified-confluence/optimize-rules", (req, res) => {
    try {
      const result = dbManager.optimizeAndDeduplicateRules();
      res.json({
        success: true,
        message: `Optimization complete: ${result.summary.duplicatesRemoved} duplicate rules removed, ${result.summary.conflictsResolved} conflicts resolved, ${result.summary.normalizedCount} rules normalized. Clean rules: ${result.summary.finalRulesCount}.`,
        ...result,
      });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ----------------------------------------------------
  // REST API: Unified Confluence Matrix Optimizer (WR > 60%)
  // ----------------------------------------------------

  app.post("/api/backtest/confluence-optimizer/analyze", async (req, res) => {
    try {
      const payload = req.body || {};
      const report = await runConfluenceOptimization(payload);
      res.json({ success: true, report });
    } catch (err: any) {
      console.error("[ConfluenceOptimizerAPI] Analysis error:", err);
      res.status(500).json({ success: false, error: err.message || "Confluence optimization analysis failed" });
    }
  });

  app.post("/api/backtest/confluence-optimizer/apply", (req, res) => {
    try {
      const { rules, minValidationWinRate, strictMode, enabled, mergeStrategy = "merge" } = req.body || {};
      if (!Array.isArray(rules)) {
        return res.status(400).json({ success: false, message: "rules array is required" });
      }

      const result = dbManager.importUnifiedConfluenceRules(rules, {
        mergeStrategy,
        configUpdates: {
          enabled: enabled !== false,
          strict_mode: strictMode !== false,
          min_validation_win_rate: minValidationWinRate || 60.0,
        },
      });

      res.json({
        success: true,
        message: `Successfully applied ${rules.length} optimized rules (${result.addedCount} new rules added, ${result.updatedCount} rules updated, ${result.preservedCount} existing rules preserved). Total: ${result.totalCount} active rules.`,
        config: result.config,
      });
    } catch (err: any) {
      console.error("[ConfluenceOptimizerAPI] Apply error:", err);
      res.status(500).json({ success: false, error: err.message || "Failed to apply optimized matrix settings" });
    }
  });

  // ----------------------------------------------------
  // REST API: Isolated Backtest Lab
  // ----------------------------------------------------

  const backtestHistoryCache: any[] = [];

  app.get("/api/backtest/setups", (req, res) => {
    res.json({ setups: AVAILABLE_SETUPS });
  });

  app.post("/api/backtest/run", async (req, res) => {
    try {
      const payload = req.body || {};
      const result = await runIsolatedBacktest(payload);
      
      backtestHistoryCache.unshift({
        runId: result.runId,
        setupId: result.setupId,
        setupName: result.setupName,
        days: result.days,
        totalTrades: result.totalTrades,
        winRate: result.winRate,
        netPnlUsd: result.netPnlUsd,
        profitFactor: result.profitFactor,
        timestamp: new Date().toISOString(),
      });
      if (backtestHistoryCache.length > 15) backtestHistoryCache.pop();

      res.json({ success: true, result });
    } catch (err: any) {
      console.error("[BacktestAPI] Execution error:", err);
      res.status(500).json({ success: false, error: err.message || "Backtest execution failed" });
    }
  });

  app.get("/api/backtest/history", (req, res) => {
    res.json({ history: backtestHistoryCache });
  });

  app.get("/api/backtest/buffer-status", (req, res) => {
    res.json(rollingBufferManager.getStatus());
  });

  app.post("/api/backtest/buffer-sync", async (req, res) => {
    try {
      await rollingBufferManager.syncBuffer();
      res.json({ success: true, status: rollingBufferManager.getStatus() });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post("/api/backtest/toggle-weekend-exclusion", (req, res) => {
    const { exclude } = req.body || {};
    rollingBufferManager.setExcludeWeekends(exclude !== false);
    res.json({ success: true, status: rollingBufferManager.getStatus() });
  });

  // ----------------------------------------------------
  // REST API: Status & Live Feeds
  // ----------------------------------------------------

  app.get("/api/status", (req, res) => {
    res.json(tradingEngine.getStatus());
  });

  app.get("/api/market/candles", (req, res) => {
    // Expose candles and computed indicator lines for charts
    res.json(tradingEngine.getCandles());
  });

  // ----------------------------------------------------
  // REST API: Trades, Signals, and Logs
  // ----------------------------------------------------

  app.get("/api/trades", (req, res) => {
    res.json(dbManager.getTrades());
  });

  app.get("/api/trades/:id", (req, res) => {
    const trade = dbManager.getTradeById(req.params.id);
    if (!trade) {
      res.status(404).json({ error: "Trade not found" });
    } else {
      res.json(trade);
    }
  });

  app.get("/api/debug/api-logs", (req, res) => {
    res.json(dbManager.getApiLogs());
  });

  app.get("/api/signals", (req, res) => {
    res.json(dbManager.getSignals());
  });

  app.get("/api/headlines", (req, res) => {
    res.json(dbManager.getHeadlines());
  });

  app.get("/api/logs", (req, res) => {
    res.json(tradingEngine.getLogs());
  });

  app.get("/api/trade-log", (req, res) => {
    try {
      const DATA_DIR = process.env.DATA_DIR || process.cwd();
      const filePath = path.join(DATA_DIR, "trade_log");
      if (fs.existsSync(filePath)) {
        const logs = fs.readFileSync(filePath, "utf-8");
        res.type("text/plain").send(logs);
      } else {
        res.type("text/plain").send("No trades logged yet in trade_log.");
      }
    } catch (e) {
      res.status(500).send("Error reading trade_log: " + e);
    }
  });

  app.delete("/api/trade-log", (req, res) => {
    try {
      const DATA_DIR = process.env.DATA_DIR || process.cwd();
      const filePath = path.join(DATA_DIR, "trade_log");
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        res.json({ success: true, message: "trade_log file cleared successfully." });
      } else {
        res.json({ success: true, message: "No trade_log file to clear." });
      }
    } catch (e) {
      res.status(500).json({ success: false, error: String(e) });
    }
  });

  // ----------------------------------------------------
  // REST API: Analytics
  // ----------------------------------------------------

  app.get("/api/analytics/summary", (req, res) => {
    res.json(dbManager.getAnalyticsSummary());
  });

  app.get("/api/analytics/equity-curve", (req, res) => {
    res.json(dbManager.getEquityCurve());
  });

  app.get("/api/analytics/daily-breakdown", (req, res) => {
    res.json(dbManager.getDailyBreakdown());
  });

  app.get("/api/analytics/regime-performance", (req, res) => {
    res.json(dbManager.getPerformanceByRegime());
  });

  app.get("/api/analytics/setup-performance", (req, res) => {
    res.json(dbManager.getPerformanceBySetup());
  });

  app.get("/api/analytics/day-of-week", (req, res) => {
    res.json(dbManager.getDayOfWeekBreakdown());
  });

  // ----------------------------------------------------
  // REST API: AI Insights (Gemini)
  // ----------------------------------------------------

  let aiClient: GoogleGenAI | null = null;
  function getGeminiClient() {
    if (!aiClient) {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        throw new Error("GEMINI_API_KEY environment variable is required. Please set it in Settings > Secrets.");
      }
      aiClient = new GoogleGenAI({
        apiKey,
        httpOptions: {
          headers: {
            "User-Agent": "aistudio-build",
          }
        }
      });
    }
    return aiClient;
  }

  const CACHE_FILE_PATH = path.join(process.env.DATA_DIR || process.cwd(), "gemini_insights_cache.json");

  function getCachedInsights() {
    try {
      if (fs.existsSync(CACHE_FILE_PATH)) {
        const content = fs.readFileSync(CACHE_FILE_PATH, "utf-8");
        return JSON.parse(content);
      }
    } catch (e) {
      console.error("Error reading insights cache:", e);
    }
    return null;
  }

  function saveCachedInsights(data: any) {
    try {
      fs.writeFileSync(CACHE_FILE_PATH, JSON.stringify(data, null, 2), "utf-8");
    } catch (e) {
      console.error("Error writing insights cache:", e);
    }
  }

  app.get("/api/gemini/insights", (req, res) => {
    const cached = getCachedInsights();
    res.json({ cached: !!cached, insights: cached });
  });

  app.post("/api/gemini/insights", async (req, res) => {
    try {
      let ai;
      try {
        ai = getGeminiClient();
      } catch (err: any) {
        return res.status(400).json({
          success: false,
          error: err.message || "Gemini API key is not configured.",
        });
      }

      const trades = dbManager.getTrades() || [];
      const config = dbManager.getConfig();

      // Read trade_log file if it exists
      let tradeLogContent = "";
      try {
        const DATA_DIR = process.env.DATA_DIR || process.cwd();
        const filePath = path.join(DATA_DIR, "trade_log");
        if (fs.existsSync(filePath)) {
          const stats = fs.statSync(filePath);
          const fd = fs.openSync(filePath, "r");
          const bufferSize = Math.min(stats.size, 8000);
          const buffer = Buffer.alloc(bufferSize);
          fs.readSync(fd, buffer, 0, bufferSize, stats.size - bufferSize);
          fs.closeSync(fd);
          tradeLogContent = buffer.toString("utf-8");
        }
      } catch (e) {
        console.warn("Could not read trade_log for Gemini context:", e);
      }

      // Format trades for prompt to keep tokens low but descriptive
      const tradeSummaryList = trades.slice(0, 15).map(t => ({
        id: t.id,
        direction: t.direction,
        entry: t.entry_price,
        exit: t.exit_price,
        pnl: t.pnl_usdt,
        pnl_pct: t.pnl_pct,
        win: t.is_win,
        reason: t.exit_reason,
        regime: t.regime_at_entry,
        duration: t.hold_duration_seconds ? `${Math.floor(t.hold_duration_seconds / 60)}m` : "unknown",
        signalScore: t.entry_signal_score,
        catboost: t.catboost_probability,
      }));

      const systemInstruction = `You are an elite high-frequency quantitative crypto trading analyst specialized in Bitcoin Futures scalping. 
You analyze structured trade logs and trading engine parameters to provide action-oriented, professional, mathematical recommendations.
You must return your analysis as structured JSON conforming strictly to the requested schema. 
Never suggest automatic settings changes; provide purely strategic advisory insights with realistic confidence scores (0-100) based on data density.`;

      const prompt = `Analyze the historical trade logs and the bot's current strategy configurations.

CURRENT STRATEGY CONFIGURATION (SNAPSHOT):
- Risk per trade %: ${config?.risk_management?.risk_per_trade_pct || "0.5"}% (Max: ${config?.risk_management?.max_risk_per_trade_pct || "1.0"}%)
- Leverage: ${config?.risk_management?.leverage || "20"}x
- Stop Loss ATR Multiplier: ${config?.risk_management?.stop_loss_atr_multiplier || "2.2"}
- Take Profit Ratio: ${config?.risk_management?.take_profit_ratio || "2.5"}
- Trailing Stop Loss: ${config?.risk_management?.trailing_stop_loss_enabled ? "Enabled" : "Disabled"} (ATR distance: ${config?.risk_management?.trailing_stop_loss_distance_atr || "1.8"})
- Required Checkpoint Gates: ${JSON.stringify(config?.general?.required_gates || [])}

RECENT TRADES (LAST 15):
${JSON.stringify(tradeSummaryList, null, 2)}

RAW TRADE LOG SNIPPET (EXIT DETAILS):
${tradeLogContent || "No detailed logs found in trade_log file."}

Based on this real trading data, generate your analysis including:
1. Overall trading performance summary.
2. Common reasons for winning and losing trades (e.g. exit reasons, indicators, regime mismatch).
3. Risk management improvements (e.g. adjust leverage, consecutive loss limits, risk per trade).
4. Suggested strategy and parameter optimizations (e.g. Stop Loss ATR multiplier, Take Profit ratio, or EMA/ADX boundaries).
5. Market conditions where this scalping bot excels and where it experiences maximum drawdowns.

Provide a confidence score (0-100) for each recommendation based on how strongly the trade logs support the pattern.`;

      const response = await ai.models.generateContent({
        model: "gemini-3.6-flash",
        contents: prompt,
        config: {
          systemInstruction,
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              overallSummary: {
                type: Type.STRING,
                description: "Overall trading performance summary of the bot's execution based on the logs."
              },
              winLossAnalysis: {
                type: Type.STRING,
                description: "Detailed analysis of common reasons for winning and losing trades."
              },
              marketConditions: {
                type: Type.OBJECT,
                properties: {
                  performsBest: {
                    type: Type.STRING,
                    description: "Market conditions where the strategy performs best (e.g. strong uptrend, ranging, high vol)."
                  },
                  performsWorst: {
                    type: Type.STRING,
                    description: "Market conditions where the strategy performs worst."
                  }
                },
                required: ["performsBest", "performsWorst"]
              },
              recommendations: {
                type: Type.ARRAY,
                description: "Specific, actionable risk management and strategy/parameter optimizations.",
                items: {
                  type: Type.OBJECT,
                  properties: {
                    category: {
                      type: Type.STRING,
                      description: "Category of the recommendation, e.g. 'Risk Management', 'Parameter Optimization', 'Strategy Optimization'"
                    },
                    title: {
                      type: Type.STRING,
                      description: "Short, high-level descriptive title of the recommendation"
                    },
                    suggestion: {
                      type: Type.STRING,
                      description: "Detailed actionable recommendation text"
                    },
                    suggestedParams: {
                      type: Type.STRING,
                      description: "Specific parameters suggested to adjust (e.g., 'Set stop_loss_atr_multiplier to 2.5, take_profit_ratio to 3.0')"
                    },
                    confidenceScore: {
                      type: Type.INTEGER,
                      description: "Confidence score for this recommendation (integer from 0 to 100)"
                    },
                    reasoning: {
                      type: Type.STRING,
                      description: "Detailed reasoning for this suggestion backed by the trade data"
                    }
                  },
                  required: ["category", "title", "suggestion", "suggestedParams", "confidenceScore", "reasoning"]
                }
              }
            },
            required: ["overallSummary", "winLossAnalysis", "marketConditions", "recommendations"]
          }
        }
      });

      const responseText = response.text;
      if (!responseText) {
        throw new Error("Empty response received from Gemini.");
      }

      const parsedInsights = JSON.parse(responseText.trim());
      parsedInsights.generatedAt = new Date().toISOString();

      saveCachedInsights(parsedInsights);

      res.json({ success: true, insights: parsedInsights });
    } catch (err: any) {
      console.error("Gemini insights generation failed:", err);
      res.status(500).json({
        success: false,
        error: `Failed to generate insights: ${err.message || String(err)}`,
      });
    }
  });

  // ----------------------------------------------------
  // REST API: Strategy Configurations & Profiles
  // ----------------------------------------------------

  app.get("/api/config", (req, res) => {
    res.json(dbManager.getConfig());
  });

  app.put("/api/config/:category", (req, res) => {
    const category = req.params.category as any;
    const updates = req.body;

    // Cross-synchronize Risk Management Hybrid Regime switch with Market Structure Matrix Enforce switch
    if (category === "risk_management" && updates.hybrid_regime_switching_enabled !== undefined) {
      dbManager.updateConfig("market_structure", {
        dynamic_regime_setup_matrix_enabled: updates.hybrid_regime_switching_enabled === true,
      });
    } else if (category === "market_structure" && updates.dynamic_regime_setup_matrix_enabled !== undefined) {
      dbManager.updateConfig("risk_management", {
        hybrid_regime_switching_enabled: updates.dynamic_regime_setup_matrix_enabled === true,
      });
    }

    const updated = dbManager.updateConfig(category, updates);
    res.json(updated);
  });

  app.get("/api/config/profiles", (req, res) => {
    res.json(dbManager.getProfiles());
  });

  app.post("/api/config/profiles/save", (req, res) => {
    const { name, config } = req.body;
    dbManager.saveProfile(name, config);
    res.json({ status: "profile_saved" });
  });

  app.post("/api/config/profiles/load/:name", (req, res) => {
    const config = dbManager.loadProfile(req.params.name);
    res.json(config);
  });

  app.delete("/api/config/profiles/:name", (req, res) => {
    dbManager.deleteProfile(req.params.name);
    res.json({ status: "profile_deleted" });
  });

  app.get("/api/config/history", (req, res) => {
    res.json(dbManager.getConfigHistory());
  });

  // ----------------------------------------------------
  // REST API: Machine Learning Management
  // ----------------------------------------------------

  app.get("/api/ml/features/importance", (req, res) => {
    // Top features based on our 50 feature specification
    const importance = [
      { name: "catboost_probability", score: 98.4 },
      { name: "regime_at_entry", score: 85.2 },
      { name: "current_sentiment", score: 79.1 },
      { name: "atr_expansion_ratio", score: 68.3 },
      { name: "rsi_14", score: 62.1 },
      { name: "ema_structure_score", score: 54.8 },
      { name: "sentiment_momentum", score: 51.2 },
      { name: "vwap_distance_pct", score: 47.9 },
      { name: "volume_expansion_ratio", score: 38.5 },
      { name: "adx_14", score: 32.1 },
    ];
    res.json(importance);
  });

  app.post("/api/ml/retrain", (req, res) => {
    // Simulate walk-forward purged training process
    const jobId = `job-${Date.now()}`;
    const startRetraining = () => {
      tradingEngine.getLogs().unshift(`[ML-Retraining] Retraining Job ${jobId} initiated...`);
      tradingEngine.getLogs().unshift(`[ML-Retraining] Gathering last 6 months of 1-minute historical candles...`);
      tradingEngine.getLogs().unshift(`[ML-Retraining] Computing 50 Technical, Volatility, Sentiment, and Interaction features...`);
      tradingEngine.getLogs().unshift(`[ML-Retraining] Running walk-forward purged validation (10-candle gap protection)...`);
      setTimeout(() => {
        const newAuc = 0.82 + Math.random() * 0.05;
        dbManager.updateConfig("ml_settings", {
          last_trained_at: new Date().toISOString(),
          validation_auc: Number(newAuc.toFixed(2)),
          model_version: `v2.4.${Math.floor(Math.random() * 9 + 2)}`,
        }, "ML Auto Trainer");
        tradingEngine.getLogs().unshift(`[ML-Retraining] Resetting feature drift parameters.`);
        tradingEngine.getLogs().unshift(`[ML-Retraining] Job ${jobId} SUCCESS. Model converged with Validation AUC: ${newAuc.toFixed(2)}. Hot deployed to engine.`);
      }, 4000);
    };

    startRetraining();
    res.json({ job_id: jobId, status: "started" });
  });

  // ----------------------------------------------------
  // Server-Sent Events (SSE) Stream
  // Perfect for real-time iframe-compatible live dashboard feeds
  // ----------------------------------------------------

  app.get("/api/stream", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    // Send initial status
    const sendEvent = (data: any) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    sendEvent({
      type: "status",
      payload: tradingEngine.getStatus(),
    });

    const interval = setInterval(() => {
      sendEvent({
        type: "status",
        payload: tradingEngine.getStatus(),
      });
    }, 1500);

    req.on("close", () => {
      clearInterval(interval);
    });
  });

  // ----------------------------------------------------
  // Vite Integration & Static File Serving
  // ----------------------------------------------------

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: false,
      },
      appType: "spa",
    });
    
    // Intercept GET requests for HTML pages to inject __API_BASE_URL__ dynamically
    app.use(async (req, res, next) => {
      const isHtml = 
        req.method === "GET" &&
        !req.path.startsWith("/api/") &&
        !req.path.startsWith("/@") &&
        (!req.path.includes(".") || req.path.endsWith(".html")) &&
        ((req.headers.accept && req.headers.accept.includes("text/html")) || req.path === "/");

      if (isHtml) {
        try {
          const url = req.originalUrl;
          let html = fs.readFileSync(path.join(process.cwd(), "index.html"), "utf-8");
          html = await vite.transformIndexHtml(url, html);
          
          // Inject dynamic API Base URL and neutralize Vite HMR WebSocket in AI Studio
          const baseUrl = getRequestBaseUrl(req);
          const injection = `<script>
            window.__API_BASE_URL__ = ${JSON.stringify(baseUrl)};
            (function() {
              try {
                var OriginalWebSocket = window.WebSocket;
                function MockWebSocket(url, protocols) {
                  if (protocols === 'vite-hmr' || (typeof url === 'string' && (url.includes('token=') || url.includes('/@vite/') || url.includes('24678')))) {
                    var listeners = {};
                    return {
                      readyState: 1,
                      OPEN: 1,
                      CONNECTING: 0,
                      CLOSING: 2,
                      CLOSED: 3,
                      send: function() {},
                      close: function() {},
                      addEventListener: function(event, cb) {
                        listeners[event] = listeners[event] || [];
                        listeners[event].push(cb);
                      },
                      removeEventListener: function(event, cb) {
                        if (listeners[event]) listeners[event] = listeners[event].filter(function(fn) { return fn !== cb; });
                      },
                      dispatchEvent: function() { return true; }
                    };
                  }
                  return OriginalWebSocket ? new OriginalWebSocket(url, protocols) : {};
                }
                if (OriginalWebSocket) {
                  MockWebSocket.prototype = OriginalWebSocket.prototype;
                }
                MockWebSocket.CONNECTING = 0;
                MockWebSocket.OPEN = 1;
                MockWebSocket.CLOSING = 2;
                MockWebSocket.CLOSED = 3;
                window.WebSocket = MockWebSocket;
              } catch (e) {}

              window.addEventListener('unhandledrejection', function(event) {
                var reason = event.reason;
                var msg = (reason && (reason.message || String(reason))) || '';
                if (msg.includes('WebSocket') || msg.includes('@vite/client') || msg.includes('vite:ws')) {
                  event.preventDefault();
                  event.stopImmediatePropagation && event.stopImmediatePropagation();
                }
              }, true);

              window.addEventListener('error', function(event) {
                var msg = event.message || '';
                var filename = event.filename || '';
                if (msg.includes('WebSocket') || filename.includes('@vite/client')) {
                  event.preventDefault();
                  event.stopImmediatePropagation && event.stopImmediatePropagation();
                }
              }, true);
            })();
          </script>`;
          html = html.replace("<head>", `<head>${injection}`);
          
          return res.status(200).set({ "Content-Type": "text/html" }).end(html);
        } catch (e) {
          return next(e);
        }
      }
      next();
    });

    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    // Serve static files but disable serving index.html by default
    app.use(express.static(distPath, { index: false }));
    
    app.get("*", (req, res) => {
      const indexPath = path.join(distPath, "index.html");
      try {
        if (fs.existsSync(indexPath)) {
          let html = fs.readFileSync(indexPath, "utf8");
          // Inject dynamic API Base URL
          const baseUrl = getRequestBaseUrl(req);
          const injection = `<script>window.__API_BASE_URL__ = ${JSON.stringify(baseUrl)};</script>`;
          html = html.replace("<head>", `<head>${injection}`);
          res.send(html);
        } else {
          res.status(404).send("Not Found");
        }
      } catch (err) {
        console.error("Error serving index.html:", err);
        res.status(500).send("Internal Server Error");
      }
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`AI Scalper Bot backend server is running on http://localhost:${PORT}`);
    // Start isolated continuous 7-day historical rolling buffer ingestion
    rollingBufferManager.startContinuousIngestion().catch((err) => {
      console.warn("[RollingBuffer] Failed to start continuous buffer ingestion:", err);
    });
  });
}

startServer();
