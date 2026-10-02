/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from "fs";
import path from "path";
import { Candlestick } from "../types.js";
import { fetchBinanceHistoricalKlines } from "./binanceFetcher.js";

const CACHE_DIR = path.resolve(process.cwd(), ".backtest_cache");
const BUFFER_FILE = path.join(CACHE_DIR, "rolling_7d_btcusdt.json");

// 7 weekdays * 24 hours * 60 minutes = 10,080 1-minute candles
export const TARGET_WEEKDAY_CANDLES = 10080; 

export function isWeekend(timestampMs: number): boolean {
  const date = new Date(timestampMs);
  const day = date.getUTCDay();
  // 0 = Sunday, 6 = Saturday in UTC
  return day === 0 || day === 6;
}

export interface BufferStatus {
  totalCandles: number;
  oldestCandleTime: string | null;
  newestCandleTime: string | null;
  weekdaysCovered: number;
  isSyncing: boolean;
  lastSyncTime: string | null;
  excludeWeekends: boolean;
  retentionTarget: number;
  bufferHealthPercent: number;
}

export class RollingBufferManager {
  private candles: (Candlestick & { takerBuyVolume: number })[] = [];
  private symbol: string = "BTCUSDT";
  private isSyncing: boolean = false;
  private lastSyncTime: number = 0;
  private syncIntervalTimer: NodeJS.Timeout | null = null;
  private excludeWeekends: boolean = true;

  constructor() {
    this.ensureCacheDir();
    this.loadFromDisk();
  }

  private ensureCacheDir() {
    if (!fs.existsSync(CACHE_DIR)) {
      try {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
      } catch (e) {
        console.warn("[RollingBuffer] Failed to create cache dir:", e);
      }
    }
  }

  private loadFromDisk() {
    if (fs.existsSync(BUFFER_FILE)) {
      try {
        const raw = fs.readFileSync(BUFFER_FILE, "utf8");
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          this.candles = parsed;
          console.log(
            `[RollingBuffer] Loaded ${this.candles.length} historical 1m candles from persistent buffer`
          );
        }
      } catch (err) {
        console.warn("[RollingBuffer] Error loading buffer from disk, will re-bootstrap:", err);
        this.candles = [];
      }
    }
  }

  public saveToDisk() {
    try {
      this.ensureCacheDir();
      fs.writeFileSync(BUFFER_FILE, JSON.stringify(this.candles), "utf8");
    } catch (err) {
      console.warn("[RollingBuffer] Error saving buffer to disk:", err);
    }
  }

  /**
   * Initializes continuous background ingestion and ensures at least 7 days of 1-minute data
   */
  public async startContinuousIngestion(): Promise<void> {
    console.log("[RollingBuffer] Starting continuous 7-day rolling historical buffer service...");
    // 1. Initial bootstrap or catch-up
    await this.syncBuffer();

    // 2. Continuous real-time ingestion loop (syncs every 60 seconds)
    if (!this.syncIntervalTimer) {
      this.syncIntervalTimer = setInterval(() => {
        this.syncBuffer().catch((err) => {
          console.warn("[RollingBuffer] Routine background sync warning:", err);
        });
      }, 60 * 1000);
    }
  }

  public stopContinuousIngestion(): void {
    if (this.syncIntervalTimer) {
      clearInterval(this.syncIntervalTimer);
      this.syncIntervalTimer = null;
    }
  }

  /**
   * Syncs the buffer: fills any historical gap back to 7 weekdays and appends latest closed candles
   */
  public async syncBuffer(): Promise<void> {
    if (this.isSyncing) return;
    this.isSyncing = true;

    try {
      const nowMs = Date.now();

      // Case A: Buffer is empty or insufficient (< TARGET_WEEKDAY_CANDLES)
      if (this.candles.length < TARGET_WEEKDAY_CANDLES) {
        console.log(`[RollingBuffer] Bootstrapping buffer (current: ${this.candles.length}/${TARGET_WEEKDAY_CANDLES} weekday candles)...`);
        
        // Approximate time needed: 7 weekdays = 10 calendar days back to account for weekend exclusion
        const lookbackMs = 11 * 24 * 60 * 60 * 1000;
        const startTimeMs = nowMs - lookbackMs;

        const rawCandles = await fetchBinanceHistoricalKlines(this.symbol, startTimeMs, nowMs);

        // Filter weekends if enabled
        const filtered = rawCandles.filter((c) => {
          const tMs = c.time * 1000;
          return !this.excludeWeekends || !isWeekend(tMs);
        }) as (Candlestick & { takerBuyVolume: number })[];

        this.candles = filtered;
        this.trimBuffer();
        this.saveToDisk();
        console.log(`[RollingBuffer] Bootstrap complete. Active buffer has ${this.candles.length} weekday candles.`);
      } else {
        // Case B: Buffer already has data, fetch incremental updates from latest candle
        const latestCandle = this.candles[this.candles.length - 1];
        const latestTimeMs = latestCandle.time * 1000;
        const gapMs = nowMs - latestTimeMs;

        // If more than 60 seconds since last candle, fetch incremental
        if (gapMs >= 60000) {
          const startFetchMs = latestTimeMs + 60000;
          const newCandles = await fetchBinanceHistoricalKlines(this.symbol, startFetchMs, nowMs);

          if (newCandles.length > 0) {
            let appendedCount = 0;
            for (const c of newCandles) {
              const tMs = c.time * 1000;
              if (this.excludeWeekends && isWeekend(tMs)) {
                continue;
              }
              // Ensure uniqueness and ascending order
              if (this.candles.length === 0 || c.time > this.candles[this.candles.length - 1].time) {
                this.candles.push(c as Candlestick & { takerBuyVolume: number });
                appendedCount++;
              }
            }

            if (appendedCount > 0) {
              this.trimBuffer();
              this.saveToDisk();
            }
          }
        }
      }

      this.lastSyncTime = Date.now();
    } catch (err) {
      console.error("[RollingBuffer] Error during sync:", err);
    } finally {
      this.isSyncing = false;
    }
  }

  private trimBuffer(): void {
    // Keep up to 12,000 candles (~8.3 weekdays) to ensure at least 7 full weekdays (10,080)
    const MAX_BUFFER_SIZE = 12000;
    if (this.candles.length > MAX_BUFFER_SIZE) {
      this.candles = this.candles.slice(this.candles.length - MAX_BUFFER_SIZE);
    }
  }

  /**
   * Retrieves candles from the rolling buffer for isolated backtesting
   */
  public getCandles(options?: {
    days?: number;
    excludeWeekends?: boolean;
    maxCandles?: number;
  }): (Candlestick & { takerBuyVolume: number })[] {
    const days = options?.days || 7;
    const filterWeekends = options?.excludeWeekends !== undefined ? options.excludeWeekends : this.excludeWeekends;
    const targetCandleCount = options?.maxCandles || Math.min(days * 1440, this.candles.length);

    let result = this.candles;
    if (filterWeekends) {
      result = result.filter((c) => !isWeekend(c.time * 1000));
    }

    if (result.length > targetCandleCount) {
      result = result.slice(result.length - targetCandleCount);
    }

    return result;
  }

  public getStatus(): BufferStatus {
    const totalCandles = this.candles.length;
    const oldest = totalCandles > 0 ? new Date(this.candles[0].time * 1000).toISOString() : null;
    const newest = totalCandles > 0 ? new Date(this.candles[totalCandles - 1].time * 1000).toISOString() : null;
    const weekdaysCovered = Number((totalCandles / 1440).toFixed(2));
    const bufferHealthPercent = Math.min(100, Number(((totalCandles / TARGET_WEEKDAY_CANDLES) * 100).toFixed(1)));

    return {
      totalCandles,
      oldestCandleTime: oldest,
      newestCandleTime: newest,
      weekdaysCovered,
      isSyncing: this.isSyncing,
      lastSyncTime: this.lastSyncTime > 0 ? new Date(this.lastSyncTime).toISOString() : null,
      excludeWeekends: this.excludeWeekends,
      retentionTarget: TARGET_WEEKDAY_CANDLES,
      bufferHealthPercent,
    };
  }

  public setExcludeWeekends(exclude: boolean): void {
    this.excludeWeekends = exclude;
  }
}

export const rollingBufferManager = new RollingBufferManager();
