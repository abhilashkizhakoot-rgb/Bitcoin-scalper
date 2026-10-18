# Days of the Week vs Trading Sessions Gating Matrix

An institutional calendar-filtering framework enabling algorithmic traders to restrict or allow trade execution for specific market session windows across individual days of the week (e.g., disabling Friday Asian Open or Sunday Dead Liquidity).

---

## User Review & Critical Decisions

> [!IMPORTANT]
> The following operational parameters were confirmed during the interactive interview:
> - **Default Pre-loaded Matrix**: Restrict **Friday Asian Open** (`asia_open` on Friday) and **Sunday Dead Liquidity** (`dead_liquidity` on Sunday) by default, while keeping high-volume institutional windows active Monday through Thursday.
> - **Live Signal Handling**: Hard-block trade candidate executions during restricted day/session combinations, logging an explicit, human-readable reason in `/api/status` (e.g. `Gated by Day x Session Matrix: Friday Asia Open is disabled for trading`).
> - **Backtest Simulation Integration**: Add a dedicated `respectDaySessionMatrix` toggle in the Backtest Lab parameter drawer, enabling side-by-side performance comparison of day-session restricted strategies against unrestricted baselines.

---

## 1. Overview & Core Concept

### What It Does
In cryptocurrency derivatives trading, historical edge varies drastically not just by intraday session (such as the US/Europe Overlap), but by day-of-week calendar seasonality. For instance, Asian market opens on Friday mornings frequently suffer from low weekend-frontrunning liquidity and false breakout wick sweeps.

This feature introduces a two-dimensional **Day of Week (Monday – Sunday) × Trading Session (Asia Open, Chop, Overlap, Late US, Dead Liquidity, Weekends)** gating matrix. When a candidate trade trigger occurs, the execution engine determines the current day and session (in IST/UTC reference) and verifies whether that specific day-session cell is permitted before placing exchange orders.

### Target Persona & Key Value
- **Algorithmic & Quantitative Scalpers**: Eliminates whipsaw losses during known low-edge calendar windows (e.g. Friday morning Asian open traps, Sunday midnight liquidity vacuums).
- **Risk Managers**: Enables granular scheduling of bot activity without having to shut down or reconfigure the bot manually before weekends or holidays.

---

## 2. User Experience & Visual Design

### Strategy Control Panel (`ConfigPage.tsx`)
A dedicated, data-dense matrix module integrated into the Market Structure & Regime settings section:

1. **Section Header & Master Switch**:
   - Clean title with `Calendar` icon and `Weekly Calendar Filter` badge.
   - Master toggle (`day_session_matrix_enabled`) enabling or bypassing the entire matrix with one click.
   - Live Session Spotlight: Displays the real-time active day and session with a pulsating indicator (e.g. `Live Now: Friday · US / Europe Overlap · Allowed`).

2. **Institutional Preset Bar**:
   - **Quant Seasonality (Default)**: Restricts Friday Asian Open and Sunday Dead Liquidity; preserves core institutional liquidity hours.
   - **Strict Peak Only**: Restricts all days strictly to high-beta US/Europe Overlap and Asia Open (Monday–Friday only).
   - **No Weekend Trading**: Completely blocks Saturday and Sunday across all hours.
   - **All Permissive**: Grants full access to all 42 day-session intersections for exploratory testing.

3. **Interactive 7×6 Matrix Grid**:
   - **Rows**: Monday, Tuesday, Wednesday, Thursday, Friday, Saturday, Sunday.
   - **Columns**: Asia Open (`05:00 - 09:30`), Intra-day Chop (`09:30 - 18:30`), US/Europe Overlap (`18:30 - 22:30`), Late US Session (`22:30 - 01:30`), Dead Liquidity (`01:30 - 05:00`), Weekends (`Sat/Sun`).
   - **Interactive Cells**: High-contrast, clickable toggle cells with checkmarks (allowed) and crosses (restricted). Clicking any cell immediately persists via `/api/strategy/day-session-matrix/toggle-cell`.
   - **Row Bulk Actions**: "Allow All" and "Block All" quick buttons for individual days.
   - **Live Intersection Highlight**: The cell corresponding to the present day and session is highlighted with an emerald border and a "LIVE" tag.

### Backtest Lab (`BacktestLab.tsx`)
- In the configuration sidebar, a new toggle: `Enforce Days vs Sessions Matrix`.
- Allows backtesting strategies with and without the Friday Asian Open restriction to quantify empirical win-rate improvements.

---

## 3. Key Product Decisions & Trade-Offs

- **Timezone Grounding (IST Reference)**:
  - *Decision*: Align day-of-week boundaries with the exchange standard Indian Standard Time (IST, UTC+5:30) already used by the bot's session engine and Delta Exchange contracts.
  - *Rationale*: Prevents calendar day shifts from splitting mid-session intervals (e.g. the 22:30 to 01:30 Late US Session crosses UTC midnight but stays continuous within institutional trading schedules).
- **Two-Layer Execution Defense**:
  - *Decision*: Enforce gating at both `getISTTimingStatus` (timing window status displayed on dashboard) and `isSetupEligibleForConditions` (trade signal qualification).
  - *Rationale*: Guarantees that neither automated CatBoost/FinBERT signals nor manual setup triggers can bypass an active day-session block.

---

## 4. Technical Architecture & Data Strategy

### System Architecture & Data Flow

```
┌───────────────────────────────────────────────────────────────┐
│                    Strategy Control Panel                     │
│  [Enforce Day x Session Matrix] ──► [Presets: Quant / Peak]   │
│  Interactive 7x6 Matrix Grid: Click to Toggle Day x Session   │
└───────────────────────────────┬───────────────────────────────┘
                                │ POST /api/strategy/day-session-matrix/*
                                ▼
┌───────────────────────────────────────────────────────────────┐
│                 Backend Server & Persistence                  │
│  - dbManager.updateConfig('market_structure', { ... })        │
│  - db_store.json / db_paper_store.json config synchronization │
│  - Endpoints: toggle-cell, toggle-day, preset                 │
└───────────────────────────────┬───────────────────────────────┘
                                │
                                ▼
┌───────────────────────────────────────────────────────────────┐
│              Live Trading Engine (engine.ts)                  │
│  1. Incoming 1m Candle / Signal Evaluation                    │
│  2. Compute IST Date & Current Trading Session                │
│  3. Lookup Day x Session Matrix [currentDay][currentSession]  │
│  4. IF restricted:                                            │
│     - Block order entry                                       │
│     - Log reason in /api/status & Signal Audit Trail          │
│  5. IF permitted:                                             │
│     - Proceed to Regime & Setup-specific gating               │
└───────────────────────────────┬───────────────────────────────┘
                                │
                                ▼
┌───────────────────────────────────────────────────────────────┐
│            Backtester & Simulator (backtestRunner.ts)         │
│  - isSetupGatedBySessionAndRegime() evaluates timestamp       │
│  - Simulates historical PnL impact with day-session gating    │
└───────────────────────────────────────────────────────────────┘
```

### Data Schema (`MarketStructureConfig` in `src/types.ts`)
```ts
export interface MarketStructureConfig {
  // Existing fields...
  day_session_matrix_enabled?: boolean; // Master toggle (default: true)
  day_session_matrix?: Record<string, string[]>; // e.g. { friday: ["intraday_chop", "europe_us_overlap", "late_us_session"] }
}
```

### Default Day-Session Matrix
```ts
export const DEFAULT_DAY_SESSION_MATRIX: Record<string, string[]> = {
  monday: ["asia_open", "intraday_chop", "europe_us_overlap", "late_us_session", "dead_liquidity"],
  tuesday: ["asia_open", "intraday_chop", "europe_us_overlap", "late_us_session", "dead_liquidity"],
  wednesday: ["asia_open", "intraday_chop", "europe_us_overlap", "late_us_session", "dead_liquidity"],
  thursday: ["asia_open", "intraday_chop", "europe_us_overlap", "late_us_session", "dead_liquidity"],
  friday: ["intraday_chop", "europe_us_overlap", "late_us_session"], // Friday Asian Open disabled
  saturday: ["weekends", "intraday_chop"],
  sunday: ["weekends", "late_us_session"], // Sunday Dead Liquidity disabled
};
```
