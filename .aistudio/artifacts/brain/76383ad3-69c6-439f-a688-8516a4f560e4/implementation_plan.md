# Global Parameter Audit & Conflict Elimination Plan

Streamlines the trading engine and configuration interface by deprecating legacy 2D gating matrices, standardizing profit targets exclusively on Dynamic ATR Scalping with regime/ADX adaptation, and establishing clear separation between global operational hours and tactical setup timing.

---

### User Review & Critical Decisions

> [!IMPORTANT]
> **Summary of Confirmed Choices from Phase 1:**
> - **Legacy 2D Matrices**: Fully deprecate and remove the 3 legacy 2D matrix tables (`setup_regime_matrix`, `setup_session_matrix`, `day_session_matrix`) and dual-mode switcher. The **Single Unified Confluence Matrix** becomes the sole source of truth for setup gating.
> - **Timing Architecture**: Retain global IST operational hours under General Settings strictly as **Global Operational Safety Hours (Master Kill-Switch)**, while all tactical setup-specific session and hour requirements are governed exclusively by **Unified Confluence Rules**.
> - **Take Profit Framework**: Standardize exclusively on **Dynamic ATR Scalping** (with regime-adaptive multipliers, ADX target compression, and guaranteed R:R floor), completely removing the legacy fixed Risk-Reward ratio selector to eliminate mathematical target clashes.

---

### 1. Overview & Core Concept

#### The Problem: Historical Parameter Clutter & Dual-Engine Conflicts
Over multiple iterative development phases, settings accumulated overlapping controls that occasionally contradicted one another:
1. **Gating Redundancy**: Users had both the modern 5D Unified Confluence Matrix and an accordion containing 3 legacy 2D matrices (Regime, Day-Session, Session-Setup), plus a dual-mode master toggle. Even when bypassed, the legacy matrices created cognitive load and the possibility of stale fallback states.
2. **Take Profit Mode Duality**: Users could toggle between "ATR Scalp" and "R:R Ratio", while simultaneously having Regime-Adaptive TP, ADX Quick-Scalp TP compression, and Min R:R Guarantee floors active. In practice, fixed R:R contradicts dynamic volatility horizons on 1-minute Bitcoin charts.
3. **Timing Window Ambiguity**: Global IST session windows on the General tab were easily confused with setup-specific session timing inside the Unified Confluence Matrix.

#### The Solution: Zero-Conflict Single-Source Architecture
- **Single Gating Authority**: Retires all legacy 2D matrix accordions, endpoints, and fallback switches. Trade gating is 100% unified.
- **Unified Volatility-Adaptive Profit Target Engine**: Anchors all exits to dynamic ATR, with automatic compression in low-ADX chop and expansion in strong trends, protected by a minimum 1.25x R:R floor.
- **Clear Operational Hierarchy**: 
  $$\text{Global Operational Hours (Hard Safety Gate)} \quad\longrightarrow\quad \text{Unified Confluence Rule (Tactical Entry Permission)}$$

---

### 2. User Experience & Visual Design

#### A. Market Structure Setup Tab (`ConfigPage.tsx`)
1. **Removal of Legacy 2D Matrix Accordions**:
   - Completely removes:
     - The `Legacy 2D Matrix Projections` accordion.
     - The `Dynamic Market Regime Gating Matrix` table and its 4 presets (`QUANT_OPTIMAL`, etc.).
     - The `Scalper Day-Session Gating Matrix` table and presets.
     - The `Session-Setup Execution Gating Matrix` table and presets.
     - The Dual-Mode segmented button (`Unified Confluence` vs `Legacy 3-Matrix Gating`).
2. **Streamlined Unified Confluence Hub**:
   - The Unified Confluence Matrix stands as the clean, primary centerpiece.
   - Shows summary statistics (`Active Rules`, `100% WR Clusters`, `80%+ Clusters`, `70%+ Clusters`).
   - Clean Action Toolbar with `Add Confluence Rule`, `Export Confluence (JSON)`, `Import CSV`, and `Show Backtest Research Columns` toggle.

#### B. Risk Management & Protective Safeguards Tab (`ConfigPage.tsx`)
1. **Consolidated Dynamic Take Profit & Stop Loss Section**:
   - Removes the `Take Profit Mode` dropdown ("ATR_SCALP" vs "RR_RATIO") and the redundant `Take Profit Reward Ratio (Fallback)` field.
   - Groups Take Profit under a unified **Volatility-Adaptive Take Profit Engine**:
     - Base Scalp TP ATR Multiplier (Fallback: 1.50x)
     - Regime-Adaptive Dynamic SL & TP Calibration (Trending: 1.55x SL / 1.70x TP, Ranging: 1.35x SL / 1.40x TP, Volatile: 1.75x SL / 2.00x TP)
     - ADX Quick-Scalp Target Compression (when ADX < 18.0, compresses TP to 1.05x ATR)
     - Min Risk-to-Reward (R:R) Guarantee Floor (Default: 1.25x)
     - Breakeven Lock Trigger (Default: 1.15x ATR with green tick buffer)
2. **Simplified Stop Loss Placement**:
   - Single clean **Min Stop Loss Floor (USD)** ($25 USD floor) to prevent exchange sub-dollar rounding errors without price-percentage ambiguity.
   - Maximum ATR Cap for SL to guard against high-volatility flash wicks.

#### C. General Settings Tab (`ConfigPage.tsx`)
1. **Clarified Timing Terminology**:
   - Re-titles "Scalper Session Timing Windows (IST)" to **Global Operational Safety Hours (IST)**.
   - Adds explicit explanatory guidance: *"Defines master operating hours for the trading bot. Unchecked sessions act as a hard kill-switch, blocking all trades regardless of setup. Specific setup session permissions are handled by the Unified Confluence Matrix."*

---

### 3. Key Product Decisions & Trade-Offs

| Decision | Chosen Approach | Why | Alternatives Rejected |
| :--- | :--- | :--- | :--- |
| **Legacy 2D Matrices** | Complete deprecation & removal from UI/engine | Eliminates ~1,200 lines of UI deadweight, removes user confusion, and prevents dual-engine fallback bugs. | Keeping in a collapsed read-only drawer (still leaves clutter and mental overhead). |
| **Take Profit Calculation** | Standardize 100% on Dynamic ATR Scalping | Volatility-adaptive ATR targets are empirically proven for 1m BTC scalping; fixed R:R fails during market compression and expansion. | Keeping dual mode (causes parameter clashes with ADX compression and regime multipliers). |
| **Timing Distinction** | Global Safety Hours (Hard Gate) + Confluence Timing (Tactical) | Gives users an emergency schedule kill-switch while allowing granular setup-level session optimization. | Eliminating global hours entirely (leaves user without an overall operational kill-switch). |
| **Stop Loss Floors** | Fixed USD Floor ($25) only | Consistent dollar distance avoids percentage-based distortion as Bitcoin price moves between $60k and $100k+. | Keeping dual USD and percentage floors (causes overlapping threshold conflicts). |

---

### 4. Technical Architecture & Data Strategy

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          LIVE TICK & CANDLE STREAM                          │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                      PRE-FLIGHT & GLOBAL OPERATIONAL GATES                  │
│   • Global Operational Hours (IST): Allowed?                                │
│   • Pre-Flight Safety & Margin Check: Pass?                                 │
│   • Cooldown & Consecutive Loss Circuit Breakers: Clear?                    │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │ (PASS)
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                       TACTICAL SETUP SIGNAL GENERATION                      │
│   • 10 Master Setup Switches (Pullback, Sweep, FVG, CVD, etc.)              │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │ (CANDIDATE SIGNAL)
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                  SINGLE UNIFIED CONFLUENCE GATING ENGINE                    │
│   • Context Extraction: Setup × Day × Session/Hours × Regime                │
│   • Evaluates Active Multi-Dimensional Confluence Rules                     │
│   • Applies Rule-Specific Position Sizing Risk Multiplier                   │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │ (APPROVED)
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                   VOLATILITY-ADAPTIVE RISK & EXECUTION                      │
│   • Position Sizing: Base Qty × Dynamic ATR Parity Sizing                   │
│   • Stop Loss: Regime-Adaptive SL Multiplier (Capped by Max ATR)            │
│   • Take Profit: Regime-Adaptive TP Multiplier (ADX Compression & 1.25x RR) │
│   • Duration & Fee Management: Smart Stall & Runner Exit Engine             │
└─────────────────────────────────────────────────────────────────────────────┘
```

#### Code Modifications Breakdown:
1. **`src/components/ConfigPage.tsx`**:
   - Remove legacy 2D matrix container and render logic (`dynamic-regime-gating-matrix`, `day-session-matrix`, `session-setup-matrix`, and `isLegacyMatricesExpanded`).
   - Remove dual-mode switcher in Confluence header (`handleToggleConfluenceMaster`).
   - Clean up Risk Management Take Profit settings (remove `take_profit_mode` and `take_profit_ratio`).
   - Update General Tab timing section title and tooltip description.
2. **`src/engine.ts`**:
   - Streamline gating pipeline: enforce Unified Confluence Matrix directly, removing legacy fallback branching to obsolete 2D matrices.
   - Streamline Take Profit execution: calculate TP strictly via `calculateDynamicATRTakeProfit()` with ADX quick-scalp compression and regime adaptation.
3. **`src/types.ts`**:
   - Update `UnifiedConfluenceConfig` to remove obsolete `fallback_to_legacy` property.
   - Update `RiskManagementConfig` to standardize `take_profit_mode` as `"ATR_SCALP"`.

---

### 5. Implementation Sequence & Milestones

1. **Phase 1: Code Audit & Cleanup (`src/components/ConfigPage.tsx`)**:
   - Remove legacy 2D matrices UI and state.
   - Remove obsolete dual-mode switch.
   - Streamline Risk Management Take Profit controls.
   - Update timing window labels and tooltips.
2. **Phase 2: Engine Consolidation (`src/engine.ts` & `src/types.ts`)**:
   - Enforce single-path Unified Confluence gating.
   - Clean up take profit evaluation logic to strictly use dynamic ATR scalping.
3. **Phase 3: Verification & Compilation**:
   - Run `lint_applet` and `compile_applet` to ensure 0 errors across server and client.
   - Verify all views render without console warnings or layout shifts.
