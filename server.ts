/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import express from "express";
import path from "path";
import crypto from "crypto";
import fs from "fs";
import { createServer as createViteServer } from "vite";
import { dbManager } from "./src/db_sim.js";
import { tradingEngine } from "./src/engine.js";
import { ConnectionStatus } from "./src/types.js";

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

  app.post("/api/exchange/disconnect", (req, res) => {
    const disconnected = dbManager.updateCredentials({
      connection_status: ConnectionStatus.DISABLED,
    });
    res.json(disconnected);
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

  // ----------------------------------------------------
  // REST API: Strategy Configurations & Profiles
  // ----------------------------------------------------

  app.get("/api/config", (req, res) => {
    res.json(dbManager.getConfig());
  });

  app.put("/api/config/:category", (req, res) => {
    const category = req.params.category as any;
    const updates = req.body;
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
        tradingEngine.resetFeatureDrift();
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
      server: { middlewareMode: true },
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
          
          // Inject dynamic API Base URL
          const baseUrl = getRequestBaseUrl(req);
          const injection = `<script>window.__API_BASE_URL__ = ${JSON.stringify(baseUrl)};</script>`;
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
  });
}

startServer();
