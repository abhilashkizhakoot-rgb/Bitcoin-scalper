/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from "fs";
import path from "path";
import { Candlestick } from "../types.js";
import { fetchBinanceHistoricalKlines } from "./binanceFetcher.js";

const CACHE_DIR = path.resolve(process.cwd(), ".backtest_cache");
const STORE_7D_FILE = path.join(CACHE_DIR, "stored_7d_BTCUSDT.json");
const METADATA_FILE = path.join(CACHE_DIR, "store_metadata.json");

export interface StoreMetadata {
  symbol: string;
  totalCandles: number;
  periodStart: string;
  periodEnd: string;
  lastSyncedAt: string;
  fileSizeBytes: number;
}

export function getStoreMetadata(): StoreMetadata | null {
  if (fs.existsSync(METADATA_FILE) && fs.existsSync(STORE_7D_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(METADATA_FILE, "utf8"));
    } catch (e) {
      return null;
    }
  }
  return null;
}

export async function getOrSync7DayStore(
  symbol: string = "BTCUSDT",
  forceRefresh: boolean = false
): Promise<{ candles: Candlestick[]; metadata: StoreMetadata }> {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }

  // If already cached and not force-refreshing, check age
  if (!forceRefresh && fs.existsSync(STORE_7D_FILE) && fs.existsSync(METADATA_FILE)) {
    try {
      const stats = fs.statSync(STORE_7D_FILE);
      const ageHours = (Date.now() - stats.mtimeMs) / (1000 * 60 * 60);

      // If cache is less than 3 hours old, use it directly
      if (ageHours < 3) {
        const candles: Candlestick[] = JSON.parse(fs.readFileSync(STORE_7D_FILE, "utf8"));
        const metadata: StoreMetadata = JSON.parse(fs.readFileSync(METADATA_FILE, "utf8"));
        return { candles, metadata };
      }
    } catch (e) {
      console.warn("[HistoricalStore] Cache read error, re-syncing:", e);
    }
  }

  // Fetch 7 rolling days of 1m data (7 * 24 * 60 = 10,080 candles)
  const nowMs = Date.now();
  const sevenDaysAgoMs = nowMs - 7 * 24 * 60 * 60 * 1000;

  console.log(`[HistoricalStore] Syncing 7 days of 1m data for ${symbol} from Binance...`);
  const candles = await fetchBinanceHistoricalKlines(symbol, sevenDaysAgoMs, nowMs);

  const periodStart = candles.length > 0 ? new Date(candles[0].time * 1000).toISOString() : new Date(sevenDaysAgoMs).toISOString();
  const periodEnd = candles.length > 0 ? new Date(candles[candles.length - 1].time * 1000).toISOString() : new Date(nowMs).toISOString();

  // Save candles to persistent storage
  fs.writeFileSync(STORE_7D_FILE, JSON.stringify(candles), "utf8");
  const stats = fs.statSync(STORE_7D_FILE);

  const metadata: StoreMetadata = {
    symbol,
    totalCandles: candles.length,
    periodStart,
    periodEnd,
    lastSyncedAt: new Date().toISOString(),
    fileSizeBytes: stats.size,
  };

  fs.writeFileSync(METADATA_FILE, JSON.stringify(metadata, null, 2), "utf8");
  console.log(`[HistoricalStore] Successfully stored ${candles.length} candles (${(stats.size / 1024 / 1024).toFixed(2)} MB) to ${STORE_7D_FILE}`);

  return { candles, metadata };
}
