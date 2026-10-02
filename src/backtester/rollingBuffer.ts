/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from "fs";
import path from "path";
import { Candlestick } from "../types.js";
import { fetchBinanceHistoricalKlines } from "./binanceFetcher.js";

const CACHE_DIR = path.resolve(process.cwd(), ".backtest_cache");
const BUFFER_FILE = path.join(CACHE_DIR, "rolling_30d_btcusdt.json");
const LEGACY_7D_FILE = path.join(CACHE_DIR, "rolling_7d_btcusdt.json");

// 30 weekdays * 24 hours * 60 minutes = 43,200 1-minute candles
// Total RAM consumption: ~6.5 MB. Total Disk footprint: ~4.2 MB.
export const TARGET_WEEKDAY_CANDLES = 43200; 
export const MAX_BUFFER_SIZE = 45000;

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
  memoryUsageMb: number;
}

export class RollingBufferManager {
  private candles: (Candlestick & { takerBuyVolume: number })[] = [];
  private symbol: string = "BTCUSDT";
  private isSyncing: boolean = false;
  private lastSyncTime: number = 0;
  private lastDiskSaveTime: number = 0;
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
    // 1. Try primary 30-day buffer file
    if (fs.existsSync(BUFFER_FILE)) {
      try {
        const raw = fs.readFileSync(BUFFER_FILE, "utf8");
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          this.candles = parsed;
          console.log(
            `[RollingBuffer] Loaded ${this.candles.length} historical 1m candles from persistent 30-day buffer (~${((this.candles.length * 150) / (1024 * 1024)).toFixed(2)} MB RAM)`
          );
          return;
        }
      } catch (err) {
        console.warn("[RollingBuffer] Error loading 30-day buffer from disk:", err);
      }
    }

    // 2. Fall back to legacy 7-day file if available for fast warm-start
    if (fs.existsSync(LEGACY_7D_FILE)) {
      try {
        const raw = fs.readFileSync(LEGACY_7D_FILE, "utf8");
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          this.candles = parsed;
          console.log(
            `[RollingBuffer] Bootstrapped with ${this.candles.length} candles from legacy 7-day buffer; will expand to 30 days`
          );
        }
      } catch (e) {
        // ignore
      }
    }
  }

  public saveToDisk(force: boolean = false) {
    const now = Date.now();
    // Throttle disk writes to every 5 minutes during runtime to ensure zero disk I/O burden
    if (!force && now - this.lastDiskSaveTime < 5 * 60 * 1000) {
      return;
    }

    try {
      this.ensureCacheDir();
      fs.writeFileSync(BUFFER_FILE, JSON.stringify(this.candles), "utf8");
      this.lastDiskSaveTime = now;
    } catch (err) {
      console.warn("[RollingBuffer] Error saving 30-day buffer to disk:", err);
    }
  }

  /**
   * Starts background ingestion loop that maintains 30 weekdays with zero live engine burden
   */
  public async startContinuousIngestion(): Promise<void> {
    console.log("[RollingBuffer] Starting continuous 30-day rolling historical buffer service...");
    // 1. Initial background bootstrap/catch-up
    this.syncBuffer().catch((err) => {
      console.warn("[RollingBuffer] Initial sync error:", err);
    });

    // 2. Continuous real-time ingestion loop (syncs latest candle every 60 seconds)
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
   * Syncs the buffer: fills any historical gap back to 30 weekdays and appends latest closed candles
   */
  public async syncBuffer(): Promise<void> {
    if (this.isSyncing) return;
    this.isSyncing = true;

    try {
      const nowMs = Date.now();

      // Case A: Buffer has less than target (43,200 weekday candles)
      if (this.candles.length < TARGET_WEEKDAY_CANDLES) {
        console.log(`[RollingBuffer] Expanding historical buffer (current: ${this.candles.length}/${TARGET_WEEKDAY_CANDLES} weekday candles)...`);
        
        // 30 weekdays requires ~44 calendar days to account for 6 weekends
        const lookbackMs = 45 * 24 * 60 * 60 * 1000;
        const startTimeMs = nowMs - lookbackMs;

        const rawCandles = await fetchBinanceHistoricalKlines(this.symbol, startTimeMs, nowMs);

        // Filter weekends if enabled
        const filtered = rawCandles.filter((c) => {
          const tMs = c.time * 1000;
          return !this.excludeWeekends || !isWeekend(tMs);
        }) as (Candlestick & { takerBuyVolume: number })[];

        this.candles = filtered;
        this.trimBuffer();
        this.saveToDisk(true); // Force initial save
        console.log(`[RollingBuffer] 30-day bootstrap complete. Active buffer has ${this.candles.length} weekday candles (~${((this.candles.length * 150) / (1024 * 1024)).toFixed(2)} MB RAM).`);
      } else {
        // Case B: Buffer already populated, fetch incremental updates from latest candle
        const latestCandle = this.candles[this.candles.length - 1];
        const latestTimeMs = latestCandle.time * 1000;
        const gapMs = nowMs - latestTimeMs;

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
              if (this.candles.length === 0 || c.time > this.candles[this.candles.length - 1].time) {
                this.candles.push(c as Candlestick & { takerBuyVolume: number });
                appendedCount++;
              }
            }

            if (appendedCount > 0) {
              this.trimBuffer();
              this.saveToDisk(false); // Debounced save
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
    const days = options?.days || 30;
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
    const memoryUsageMb = Number(((totalCandles * 150) / (1024 * 1024)).toFixed(2));

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
      memoryUsageMb,
    };
  }

  public setExcludeWeekends(exclude: boolean): void {
    this.excludeWeekends = exclude;
  }
}

export const rollingBufferManager = new RollingBufferManager();
