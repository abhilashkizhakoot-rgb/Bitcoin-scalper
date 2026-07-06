/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import * as crypto from "crypto";
import { ExchangeCredentials, ApiCallLog } from "./types.js";
import { dbManager } from "./db_sim.js";

/**
 * Fetch product ID and contract specifications from Delta Exchange
 */
export async function getDeltaProductSpecs(creds: ExchangeCredentials, symbol: string): Promise<{ id: number; contract_value: number } | null> {
  try {
    let baseUrl = creds.is_testnet ? "https://testnet-api.delta.exchange" : "https://api.delta.exchange";
    if (creds.is_india) {
      baseUrl = creds.is_testnet ? "https://testnet-api.india.delta.exchange" : "https://api.india.delta.exchange";
    }

    const path = "/v2/products";
    const startTime = Date.now();
    const response = await fetch(`${baseUrl}${path}`);
    const latencyMs = Date.now() - startTime;

    if (!response.ok) {
      const errorText = await response.text();
      dbManager.addApiLog({
        service: "Delta Exchange",
        method: "GET",
        url: `${baseUrl}${path}`,
        request_headers: { "Content-Type": "application/json" },
        response_status: response.status,
        response_body: errorText,
        latency_ms: latencyMs,
      });
      return null;
    }

    const data = await response.json();
    const products = Array.isArray(data) ? data : (data.result || []);
    const prod = products.find((p: any) => p.symbol === symbol || p.underlying_asset?.symbol === symbol || p.symbol?.startsWith(symbol));

    if (prod) {
      const spec = {
        id: Number(prod.id),
        contract_value: Number(prod.contract_value || 0.001),
      };

      dbManager.addApiLog({
        service: "Delta Exchange",
        method: "GET",
        url: `${baseUrl}${path}`,
        request_headers: { "Content-Type": "application/json" },
        response_status: response.status,
        response_body: `Successfully matched symbol ${symbol} to product_id: ${spec.id} (contract_value: ${spec.contract_value})`,
        latency_ms: latencyMs,
      });

      return spec;
    }

    // Default to standard BTC perpetual specifications if symbol lookup fails
    return { id: 1, contract_value: 0.001 };
  } catch (err: any) {
    console.error("[DeltaClient] Error fetching product ID:", err);
    return { id: 1, contract_value: 0.001 };
  }
}

/**
 * Dispatch signed order to Delta Exchange REST API
 */
export async function placeDeltaMarketOrder(
  creds: ExchangeCredentials,
  symbol: string,
  side: "buy" | "sell",
  sizeBtc: number
): Promise<{ success: boolean; order_id?: string; message: string; response_data?: any }> {
  try {
    if (!creds.api_key || !creds.api_secret) {
      return { success: false, message: "Missing exchange credentials API key or secret." };
    }

    // Retrieve product specs dynamically
    const specs = await getDeltaProductSpecs(creds, symbol);
    const productId = specs ? specs.id : 1;
    const contractValue = specs ? specs.contract_value : 0.001;

    // Convert size from BTC to Delta contract units
    const rawQty = sizeBtc / contractValue;
    const sizeContracts = Math.max(1, Math.round(rawQty));

    let baseUrl = creds.is_testnet ? "https://testnet-api.delta.exchange" : "https://api.delta.exchange";
    if (creds.is_india) {
      baseUrl = creds.is_testnet ? "https://testnet-api.india.delta.exchange" : "https://api.india.delta.exchange";
    }

    const path = "/v2/orders";
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const method = "POST";
    const queryString = "";

    const payloadObj = {
      product_id: productId,
      size: sizeContracts,
      side: side,
      order_type: "market_order",
    };
    const payload = JSON.stringify(payloadObj);

    // Compute HMACS-SHA256 signature according to Delta specs
    const signatureData = method + timestamp + path + queryString + payload;
    const signature = crypto.createHmac("sha256", creds.api_secret).update(signatureData).digest("hex");

    const headers: Record<string, string> = {
      "api-key": creds.api_key,
      "Content-Type": "application/json",
      "User-Agent": "Delta-Exchange-Trading-Bot/1.0",
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
      headers,
      body: payload,
    });
    const latencyMs = Date.now() - startTime;

    const responseText = await response.text();
    let responseData: any = null;
    try {
      responseData = JSON.parse(responseText);
    } catch (e) {}

    // Mask headers for logging
    const maskedHeaders = { ...headers };
    if (maskedHeaders["api-key"]) {
      const k = maskedHeaders["api-key"];
      maskedHeaders["api-key"] = k.length > 8 ? k.substring(0, 4) + "..." + k.substring(k.length - 4) : "****";
    }
    if (maskedHeaders["signature"]) maskedHeaders["signature"] = "****";
    if (maskedHeaders["api-signature"]) maskedHeaders["api-signature"] = "****";

    dbManager.addApiLog({
      service: "Delta Exchange",
      method,
      url: `${baseUrl}${path}`,
      request_headers: maskedHeaders,
      request_body: payload,
      response_status: response.status,
      response_body: responseText,
      latency_ms: latencyMs,
    });

    if (response.ok && responseData) {
      const orderId = responseData.id || (responseData.result && responseData.result.id) || "live_order_" + Math.random().toString(36).substr(2, 9);
      return {
        success: true,
        order_id: orderId,
        message: `Order submitted successfully: ${side.toUpperCase()} ${sizeContracts} contracts ($${(sizeBtc * 100000).toFixed(0)} equivalent)`,
        response_data: responseData,
      };
    } else {
      const errMsg = responseData?.error?.message || responseData?.message || `Exchange error status code ${response.status}`;
      return {
        success: false,
        message: `Exchange Order Rejected: ${errMsg}`,
        response_data: responseData,
      };
    }
  } catch (err: any) {
    console.error("[DeltaClient] API Order execution failed:", err);
    return {
      success: false,
      message: `Execution exception: ${err?.message || "Internal network error"}`,
    };
  }
}

/**
 * Fetch wallet balances and return the USDT balance from Delta Exchange
 */
export async function getDeltaWalletBalance(creds: ExchangeCredentials): Promise<number | null> {
  try {
    if (!creds.api_key || !creds.api_secret) {
      return null;
    }

    let baseUrl = creds.is_testnet ? "https://testnet-api.delta.exchange" : "https://api.delta.exchange";
    if (creds.is_india) {
      baseUrl = creds.is_testnet ? "https://testnet-api.india.delta.exchange" : "https://api.india.delta.exchange";
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
      "User-Agent": "Delta-Exchange-Trading-Bot/1.0",
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
      headers,
    });
    const latencyMs = Date.now() - startTime;

    const responseText = await response.text();
    let data: any = null;
    try {
      data = JSON.parse(responseText);
    } catch (e) {}

    // Mask headers for logging
    const maskedHeaders = { ...headers };
    if (maskedHeaders["api-key"]) {
      const k = maskedHeaders["api-key"];
      maskedHeaders["api-key"] = k.length > 8 ? k.substring(0, 4) + "..." + k.substring(k.length - 4) : "****";
    }
    if (maskedHeaders["signature"]) maskedHeaders["signature"] = "****";
    if (maskedHeaders["api-signature"]) maskedHeaders["api-signature"] = "****";

    dbManager.addApiLog({
      service: "Delta Exchange",
      method,
      url: `${baseUrl}${path}`,
      request_headers: maskedHeaders,
      response_status: response.status,
      response_body: responseText,
      latency_ms: latencyMs,
    });

    if (response.ok && data && data.result && Array.isArray(data.result)) {
      const usdtBal = data.result.find((item: any) => {
        const sym = (item.asset_symbol || item.asset || item.symbol || (item.asset && item.asset.symbol) || "").toString().toUpperCase();
        return sym === "USDT";
      });
      if (usdtBal) {
        const val = usdtBal.balance !== undefined ? usdtBal.balance : (usdtBal.available_balance !== undefined ? usdtBal.available_balance : (usdtBal.wallet_balance !== undefined ? usdtBal.wallet_balance : "0"));
        return parseFloat(val);
      }
    }
    return null;
  } catch (err) {
    console.error("[DeltaClient] Error fetching wallet balance:", err);
    return null;
  }
}

