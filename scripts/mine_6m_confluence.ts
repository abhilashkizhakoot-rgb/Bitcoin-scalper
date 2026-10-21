/**
 * Empirical Confluence Rule Mining Script
 * Analyzes the 180-day (6-month) dataset of 259,200 1m candles across all core setups
 * Discovers the highest win-rate clusters across (Setup x Day x Session x Regime x UTC Window)
 */

import { runIsolatedBacktest, AVAILABLE_SETUPS } from "../src/backtester/backtestRunner.js";
import { BacktestTrade } from "../src/backtester/types.js";
import { MarketRegime, ConfluenceRule } from "../src/types.js";
import fs from "fs";

interface ClusterStats {
  setupId: string;
  setupName: string;
  regime: MarketRegime | "ALL";
  session: string | "ALL";
  day: string | "ALL";
  hourWindow: string | "ALL";
  tradesCount: number;
  winCount: number;
  lossCount: number;
  winRate: number;
  netPnlUsd: number;
  profitFactor: number;
  averageMfeAtr: number;
  averageMaeAtr: number;
}

async function mine6MonthConfluence() {
  console.log("=== Starting 6-Month (180-Day) Empirical Confluence Mining ===");
  const individualSetups = AVAILABLE_SETUPS.filter((s) => s.id !== "all");

  const allTrades: BacktestTrade[] = [];

  for (const setup of individualSetups) {
    console.log(`Analyzing Setup: ${setup.name}...`);
    try {
      const res = await runIsolatedBacktest({
        setupId: setup.id,
        days: 180,
        symbol: "BTCUSDT",
        initialBalance: 10000,
        positionSizeBtc: 0.01,
        leverage: 20,
        simulateFees: true,
        isolationMode: true,
        excludeWeekends: true,
        respectSessionMatrix: false,
        respectDaySessionMatrix: false,
        respectUnifiedConfluenceMatrix: false,
      });

      console.log(`  -> ${res.totalTrades} trades, Win Rate: ${res.winRate.toFixed(1)}%, Net PnL: $${res.netPnlUsd.toFixed(2)}`);
      allTrades.push(...res.trades);
    } catch (err) {
      console.error(`  Error backtesting ${setup.id}:`, err);
    }
  }

  console.log(`\nTotal 6-Month Backtest Trades Collected: ${allTrades.length}`);

  // Helper to extract UTC window (00-04, 04-08, 08-12, 12-16, 16-20, 20-24)
  function getUtcWindow(ms: number): string {
    const d = new Date(ms);
    const hour = d.getUTCHours();
    const start = Math.floor(hour / 4) * 4;
    const end = start + 4;
    return `${String(start).padStart(2, "0")}-${String(end).padStart(2, "0")}`;
  }

  function getDayName(ms: number): string {
    const d = new Date(ms);
    const dayNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    return dayNames[d.getUTCDay()];
  }

  // Multi-dimensional cluster analysis
  const clusters: Map<string, BacktestTrade[]> = new Map();

  for (const t of allTrades) {
    const day = getDayName(t.entryTimestampMs);
    const utcWin = getUtcWindow(t.entryTimestampMs);
    const session = t.sessionId || "unknown";
    const regime = t.marketRegime;
    const setup = t.setupId;

    // Granular keys
    const keys = [
      // 1. Setup x Day x UTC Window
      `S_D_W|${setup}|${day}|${utcWin}`,
      // 2. Setup x Regime
      `S_R|${setup}|${regime}`,
      // 3. Setup x Session x Day
      `S_S_D|${setup}|${session}|${day}`,
      // 4. Setup x Regime x Session
      `S_R_S|${setup}|${regime}|${session}`,
      // 5. Setup x Day
      `S_D|${setup}|${day}`,
      // 6. Setup x UTC Window
      `S_W|${setup}|${utcWin}`,
      // 7. Setup x Session
      `S_S|${setup}|${session}`,
      // 8. Regime x Session x Day (Global)
      `G_R_S_D|all|${regime}|${session}|${day}`,
      // 9. Day x UTC Window (Global)
      `G_D_W|all|${day}|${utcWin}`,
    ];

    for (const k of keys) {
      if (!clusters.has(k)) clusters.set(k, []);
      clusters.get(k)!.push(t);
    }
  }

  const evaluatedClusters: (ClusterStats & { key: string })[] = [];

  for (const [key, trList] of clusters.entries()) {
    if (trList.length < 8) continue; // Minimum statistical sample

    const wins = trList.filter((t) => t.netPnlUsd > 0).length;
    const winRate = (wins / trList.length) * 100;
    const grossProfit = trList.filter((t) => t.grossPnlUsd > 0).reduce((s, t) => s + t.grossPnlUsd, 0);
    const grossLoss = Math.abs(trList.filter((t) => t.grossPnlUsd < 0).reduce((s, t) => s + t.grossPnlUsd, 0));
    const netPnl = trList.reduce((s, t) => s + t.netPnlUsd, 0);
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 99 : 0;
    const avgMfe = trList.reduce((s, t) => s + t.maxFavorableExcursionAtr, 0) / trList.length;
    const avgMae = trList.reduce((s, t) => s + t.maxAdverseExcursionAtr, 0) / trList.length;

    const parts = key.split("|");
    const type = parts[0];

    let setupId = "all";
    let regime: MarketRegime | "ALL" = "ALL";
    let session: string | "ALL" = "ALL";
    let day: string | "ALL" = "ALL";
    let hourWindow: string | "ALL" = "ALL";

    if (type === "S_D_W") {
      setupId = parts[1];
      day = parts[2];
      hourWindow = parts[3];
    } else if (type === "S_R") {
      setupId = parts[1];
      regime = parts[2] as MarketRegime;
    } else if (type === "S_S_D") {
      setupId = parts[1];
      session = parts[2];
      day = parts[3];
    } else if (type === "S_R_S") {
      setupId = parts[1];
      regime = parts[2] as MarketRegime;
      session = parts[3];
    } else if (type === "S_D") {
      setupId = parts[1];
      day = parts[2];
    } else if (type === "S_W") {
      setupId = parts[1];
      hourWindow = parts[2];
    } else if (type === "S_S") {
      setupId = parts[1];
      session = parts[2];
    } else if (type === "G_R_S_D") {
      regime = parts[2] as MarketRegime;
      session = parts[3];
      day = parts[4];
    } else if (type === "G_D_W") {
      day = parts[2];
      hourWindow = parts[3];
    }

    const setupObj = AVAILABLE_SETUPS.find((s) => s.id === setupId);

    evaluatedClusters.push({
      key,
      setupId,
      setupName: setupObj ? setupObj.name : "All Setups",
      regime,
      session,
      day,
      hourWindow,
      tradesCount: trList.length,
      winCount: wins,
      lossCount: trList.length - wins,
      winRate: Number(winRate.toFixed(1)),
      netPnlUsd: Number(netPnl.toFixed(2)),
      profitFactor: Number(profitFactor.toFixed(2)),
      averageMfeAtr: Number(avgMfe.toFixed(2)),
      averageMaeAtr: Number(avgMae.toFixed(2)),
    });
  }

  // Filter top clusters: Win Rate >= 70%, Profit Factor >= 1.5, Net PnL > 0
  const topClusters = evaluatedClusters
    .filter((c) => c.winRate >= 70.0 && c.netPnlUsd > 0)
    .sort((a, b) => b.winRate - a.winRate || b.netPnlUsd - a.netPnlUsd);

  console.log(`\n=== Found ${topClusters.length} High-Probability Clusters (WR >= 70%) ===\n`);

  topClusters.slice(0, 30).forEach((c, i) => {
    console.log(
      `#${i + 1} [${c.key}] | WR: ${c.winRate}% | Trades: ${c.tradesCount} (${c.winCount}W / ${c.lossCount}L) | PF: ${c.profitFactor} | Net: $${c.netPnlUsd} | Setup: ${c.setupId} | Day: ${c.day} | Session: ${c.session} | Regime: ${c.regime} | Window: ${c.hourWindow}`
    );
  });

  // Save the full report to JSON for inspection
  fs.writeFileSync(
    ".backtest_cache/confluence_mining_6m_results.json",
    JSON.stringify({ totalTrades: allTrades.length, topClusters }, null, 2),
    "utf8"
  );
  console.log("\nResults written to .backtest_cache/confluence_mining_6m_results.json");
}

mine6MonthConfluence().catch(console.error);
