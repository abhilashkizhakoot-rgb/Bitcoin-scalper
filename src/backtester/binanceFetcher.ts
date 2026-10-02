/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from "fs";
import path from "path";
import { Candlestick } from "../types.js";

const CACHE_DIR = path.resolve(process.cwd(), ".backtest_cache");

export async function fetchBinanceHistoricalKlines(
  symbol: string,
  startTimeMs: number,
  endTimeMs: number
): Promise<Candlestick[]> {
  // Ensure cache directory exists
  if (!fs.existsSync(CACHE_DIR)) {
    try {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
    } catch (e) {
      console.warn("[BinanceFetcher] Could not create cache directory:", e);
    }
  }

  const cacheKey = `${symbol}_${startTimeMs}_${endTimeMs}.json`;
  const cacheFilePath = path.join(CACHE_DIR, cacheKey);

  if (fs.existsSync(cacheFilePath)) {
    try {
      const data = JSON.parse(fs.readFileSync(cacheFilePath, "utf8"));
      if (Array.isArray(data) && data.length > 0) {
        console.log(`[BinanceFetcher] Loaded ${data.length} candles from cache for ${symbol}`);
        return data;
      }
    } catch (e) {
      console.warn("[BinanceFetcher] Cache read error, fetching fresh data:", e);
    }
  }

  const candles: Candlestick[] = [];
  let currentStart = startTimeMs;
  const chunkLimit = 1000;

  console.log(`[BinanceFetcher] Fetching historical 1m data for ${symbol} from ${new Date(startTimeMs).toISOString()} to ${new Date(endTimeMs).toISOString()}`);

  while (currentStart < endTimeMs) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(
      symbol
    )}&interval=1m&startTime=${currentStart}&endTime=${endTimeMs}&limit=${chunkLimit}`;

    try {
      const response = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
      });

      if (!response.ok) {
        throw new Error(`Binance API error: ${response.status} ${response.statusText}`);
      }

      const rawKlines: any[] = await response.json();
      if (!Array.isArray(rawKlines) || rawKlines.length === 0) {
        break;
      }

      for (const k of rawKlines) {
        const openTime = Number(k[0]);
        const open = parseFloat(k[1]);
        const high = parseFloat(k[2]);
        const low = parseFloat(k[3]);
        const close = parseFloat(k[4]);
        const volume = parseFloat(k[5]);
        const takerBuyBaseVolume = parseFloat(k[9]);

        candles.push({
          time: Math.floor(openTime / 1000),
          open,
          high,
          low,
          close,
          volume,
          takerBuyVolume: takerBuyBaseVolume,
        } as unknown as Candlestick & { takerBuyVolume: number });
      }

      const lastTimestamp = Number(rawKlines[rawKlines.length - 1][0]);
      if (lastTimestamp <= currentStart) {
        break;
      }

      currentStart = lastTimestamp + 60000;

      // Small throttle to be courteous to Binance public API
      if (currentStart < endTimeMs) {
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
    } catch (err) {
      console.error("[BinanceFetcher] Fetch error:", err);
      break;
    }
  }

  console.log(`[BinanceFetcher] Successfully fetched ${candles.length} historical 1m candles for ${symbol}`);

  // Save to cache if we got candles
  if (candles.length > 0 && fs.existsSync(CACHE_DIR)) {
    try {
      fs.writeFileSync(cacheFilePath, JSON.stringify(candles), "utf8");
    } catch (e) {
      console.warn("[BinanceFetcher] Could not write cache file:", e);
    }
  }

  return candles;
}
