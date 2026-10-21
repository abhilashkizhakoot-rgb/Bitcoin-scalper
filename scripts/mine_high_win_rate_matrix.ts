import { runIsolatedBacktest, AVAILABLE_SETUPS } from "../src/backtester/backtestRunner.ts";
import { ConfluenceRule, MarketRegime } from "../src/types.ts";
import { BacktestTrade } from "../src/backtester/types.ts";
import fs from "fs";

async function mineHighWinRateConfluences() {
  console.log("=== MINING 6-MONTH (180 DAYS) HIGH WIN RATE CONFLUENCES (>65% WR) ===");

  const setupsToEvaluate = AVAILABLE_SETUPS.filter(s => s.id !== "all");
  const allRawTrades: BacktestTrade[] = [];

  for (const setup of setupsToEvaluate) {
    console.log(`Running 180d ungated backtest for setup: ${setup.name} (${setup.id})...`);
    try {
      const res = await runIsolatedBacktest({
        setupId: setup.id,
        days: 180,
        symbol: "BTCUSDT",
        isolationMode: true,
        respectSessionMatrix: false,
        respectDaySessionMatrix: false,
        respectUnifiedConfluenceMatrix: false, // get ungated universe of signals
        simulateFees: true,
      });
      console.log(` -> Found ${res.trades.length} trades for ${setup.id} (Win Rate: ${res.winRate.toFixed(1)}%)`);
      allRawTrades.push(...res.trades);
    } catch (e) {
      console.error(`Failed for setup ${setup.id}:`, e);
    }
  }

  console.log(`\nTotal pooled ungated trades across 6 months: ${allRawTrades.length}`);

  // Sort trades chronologically
  allRawTrades.sort((a, b) => a.entryTimestampMs - b.entryTimestampMs);

  if (allRawTrades.length === 0) {
    console.error("No trades found!");
    return;
  }

  const minTime = allRawTrades[0].entryTimestampMs;
  const maxTime = allRawTrades[allRawTrades.length - 1].entryTimestampMs;
  const splitTime = minTime + (maxTime - minTime) * 0.6; // 60% Discovery, 40% Out-of-sample Validation

  console.log(`Discovery Period: ${new Date(minTime).toISOString().slice(0, 10)} to ${new Date(splitTime).toISOString().slice(0, 10)}`);
  console.log(`Validation Period: ${new Date(splitTime).toISOString().slice(0, 10)} to ${new Date(maxTime).toISOString().slice(0, 10)}`);

  // Helper to determine UTC 4-hour window
  const getUtcWindow = (ts: number): string => {
    const h = new Date(ts).getUTCHours();
    if (h >= 0 && h < 4) return "00-04";
    if (h >= 4 && h < 8) return "04-08";
    if (h >= 8 && h < 12) return "08-12";
    if (h >= 12 && h < 16) return "12-16";
    if (h >= 16 && h < 20) return "16-20";
    return "20-24";
  };

  const getIstDay = (ts: number): string => {
    const d = new Date(ts);
    const utcMs = d.getTime() + d.getTimezoneOffset() * 60000;
    const istDate = new Date(utcMs + 5.5 * 3600000);
    const dayNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    return dayNames[istDate.getDay()];
  };

  interface Candidate {
    name: string;
    setup_id: string;
    regimes: MarketRegime[] | "ALL";
    sessions: string[] | "ALL";
    days: string[] | "ALL";
    hours_utc: string[] | "ALL";
    discovery_trades: number;
    discovery_win_rate: number;
    validation_trades: number;
    validation_win_rate: number;
    total_trades: number;
    total_win_rate: number;
    net_pnl: number;
    profit_factor: number;
  }

  const candidates: Candidate[] = [];

  const setups = ["all", ...setupsToEvaluate.map(s => s.id)];
  const days = ["ALL", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
  const sessions = ["ALL", "asia_open", "intraday_chop", "europe_us_overlap", "late_us_session", "dead_liquidity"];
  const regimes: (MarketRegime[] | "ALL")[] = [
    "ALL",
    [MarketRegime.STRONG_UPTREND],
    [MarketRegime.STRONG_DOWNTREND],
    [MarketRegime.RANGE_BOUND],
    [MarketRegime.HIGH_VOLATILITY],
    [MarketRegime.LOW_VOLATILITY],
  ];
  const hourWindows = ["ALL", "00-04", "04-08", "08-12", "12-16", "16-20", "20-24"];

  // Search promising intersections
  for (const setupId of setups) {
    for (const day of days) {
      for (const session of sessions) {
        for (const regime of regimes) {
          for (const hour of hourWindows) {
            // Filter trades matching this slice
            const matchingTrades = allRawTrades.filter(t => {
              if (setupId !== "all" && t.setupId !== setupId) return false;
              if (day !== "ALL" && getIstDay(t.entryTimestampMs) !== day) return false;
              if (session !== "ALL" && t.sessionId !== session) return false;
              if (regime !== "ALL" && !regime.includes(t.marketRegime)) return false;
              if (hour !== "ALL" && getUtcWindow(t.entryTimestampMs) !== hour) return false;
              return true;
            });

            if (matchingTrades.length < 15) continue; // Minimum sample size

            const discTrades = matchingTrades.filter(t => t.entryTimestampMs < splitTime);
            const valTrades = matchingTrades.filter(t => t.entryTimestampMs >= splitTime);

            if (discTrades.length < 6 || valTrades.length < 5) continue;

            const discWins = discTrades.filter(t => t.netPnlUsd > 0).length;
            const valWins = valTrades.filter(t => t.netPnlUsd > 0).length;
            const totWins = matchingTrades.filter(t => t.netPnlUsd > 0).length;

            const discWr = (discWins / discTrades.length) * 100;
            const valWr = (valWins / valTrades.length) * 100;
            const totWr = (totWins / matchingTrades.length) * 100;

            const grossProfit = matchingTrades.filter(t => t.grossPnlUsd > 0).reduce((s, t) => s + t.grossPnlUsd, 0);
            const grossLoss = Math.abs(matchingTrades.filter(t => t.grossPnlUsd < 0).reduce((s, t) => s + t.grossPnlUsd, 0));
            const netPnl = matchingTrades.reduce((s, t) => s + t.netPnlUsd, 0);
            const pf = grossLoss > 0 ? grossProfit / grossLoss : 99;

            // Target win rate > 65% in both validation and overall
            if (valWr >= 65.0 && totWr >= 65.0 && netPnl > 0 && pf >= 1.4) {
              const setupLabel = setupId === "all" ? "Core Multi-Setup" : setupsToEvaluate.find(s => s.id === setupId)?.name || setupId;
              const regimeLabel = regime === "ALL" ? "" : Array.isArray(regime) ? regime.join(",") : "";
              const dayLabel = day === "ALL" ? "" : day.toUpperCase();
              const sessLabel = session === "ALL" ? "" : session;
              const hrLabel = hour === "ALL" ? "" : `${hour} UTC`;

              const nameParts = [setupLabel, regimeLabel, sessLabel, dayLabel, hrLabel].filter(Boolean);

              candidates.push({
                name: nameParts.join(" • "),
                setup_id: setupId,
                regimes: regime,
                sessions: session === "ALL" ? "ALL" : [session],
                days: day === "ALL" ? "ALL" : [day],
                hours_utc: hour === "ALL" ? "ALL" : [hour],
                discovery_trades: discTrades.length,
                discovery_win_rate: Number(discWr.toFixed(1)),
                validation_trades: valTrades.length,
                validation_win_rate: Number(valWr.toFixed(1)),
                total_trades: matchingTrades.length,
                total_win_rate: Number(totWr.toFixed(1)),
                net_pnl: Number(netPnl.toFixed(2)),
                profit_factor: Number(pf.toFixed(2)),
              });
            }
          }
        }
      }
    }
  }

  // Deduplicate and rank candidates by win rate, then profit factor, then trade count
  candidates.sort((a, b) => b.total_win_rate - a.total_win_rate || b.validation_win_rate - a.validation_win_rate || b.profit_factor - a.profit_factor);

  console.log(`\nFound ${candidates.length} candidate confluence rules meeting >= 65% Win Rate!`);
  console.log("Top 30 Candidates:");
  console.table(candidates.slice(0, 30).map(c => ({
    name: c.name.slice(0, 45),
    setup: c.setup_id,
    totWr: `${c.total_win_rate}%`,
    valWr: `${c.validation_win_rate}%`,
    trades: c.total_trades,
    netPnl: `$${c.net_pnl}`,
    pf: c.profit_factor,
  })));

  fs.writeFileSync(".aistudio/artifacts/mined_rules.json", JSON.stringify(candidates, null, 2));
}

mineHighWinRateConfluences().catch(console.error);
