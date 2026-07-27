# Market Structure Confirmation (MSC) Engine Documentation

The **Market Structure Confirmation (MSC) Engine** is an institutional-grade, multi-regime trade validation and confirmation framework built directly into the core trading processor (`src/engine.ts`). Designed specifically for high-frequency 1-minute Bitcoin (BTC) scalping, the MSC engine replaces simple lagging indicators with real-time order flow dynamics, multi-timeframe candle aggregations, adaptive fractal pivot tracking, dynamic point-based pullback depth modeling, micro-trend alignment, objective multi-pattern candle rejection verification, and linear-regression EMA 200 slope filters.

This document details the complete mathematical formulas, scoring criteria, multi-regime pathways, and logical decision structures of the MSC engine as implemented in the codebase.

---

## Architecture & Sequential Flow

The MSC engine processes incoming 1-minute market updates through a multi-stage sequential pipeline:

```
                      [1m Real-Time Price Feed]
                                 │
                                 ▼
                     [Market Regime Identifier]
       ┌─────────────────────────┼─────────────────────────┐
       ▼                         ▼                         ▼
 [LOW_VOLATILITY]          [RANGE_BOUND]              [TREND_BREAKOUT]
   Deactivate                Find Range                 Extract Pivots
  All Trading           (Support & Resistance)       (Adaptive Fractals)
                             │                             │
                             ▼                             ▼
                        Micro-Trend                Adaptive Point-Based
                     1m EMA & Reversal            Pullback Classification
                             │                             │
                             ▼                             ▼
                       Reversal/Breakout             Verify Breakout
                         Volume Checks             Candle Body-to-Range
                             │                             │
                             ▼                             ▼
                      [Entry Trigger]                 Multi-Timeframe
                                                      (5m) Trend Alignment
                                                           │
                                                           ▼
                                                    Check Invalidation
                                                    & Chasing Thresholds
                                                           │
                                                           ▼
                                                       Volume &
                                                   Candle Rejection
                                                           │
                                                           ▼
                                                  EMA 200 Proximity
                                                    & Angle Filter
                                                           │
                                                           ▼
                                                    [Entry Trigger]
```

---

## 1. Multi-Regime Validation Gating

Trade validation branches into specialized pathways based on the active **Market Regime**:

### A. Low Volatility Regime (`MarketRegime.LOW_VOLATILITY`)
* **Behavior**: Halts all signal confirmations and trade executions immediately.
* **Purpose**: Prevents whipsaws and fee erosion during tight consolidation phases where bid-ask spreads and slippage dominate price action.

### B. Range Bound Regime (`MarketRegime.RANGE_BOUND`)
When market structure is sideways, the engine evaluates support and resistance bounds on 1-minute candles:
1. **Boundary Extraction**: Scans a lookback window of 30 candles on the 1m chart to locate the high ($R_{\text{high}}$) and low ($R_{\text{low}}$).
2. **Range Width**:
   $$W_{\text{range}} = R_{\text{high}} - R_{\text{low}}$$
3. **Adaptive Zone Thresholds**:
   To ensure valid reversal zones remain active even during ultra-narrow 1m ranges, the zone width is clamped with an ATR floor:
   $$\text{ZoneWidth} = \max(W_{\text{range}} \times 0.40, 0.30 \times \text{ATR}_{14})$$
   $$S_{\text{threshold}} = R_{\text{low}} + \text{ZoneWidth}$$
   $$R_{\text{threshold}} = R_{\text{high}} - \text{ZoneWidth}$$
4. **Range Safeguards**:
   * **Floor Safeguard (LONG)**: Current price must remain above $R_{\text{low}} - 0.75 \times \text{ATR}_{14}$ to ensure the asset is not crashing in an unconfirmed breakdown.
   * **Ceiling Safeguard (SHORT)**: Current price must remain below $R_{\text{high}} + 0.75 \times \text{ATR}_{14}$ to ensure the asset is not exploding in an unconfirmed breakout.
5. **Reversal Signals**:
   * **LONG Reversal**: Price $\le S_{\text{threshold}}$ AND current 1m candle is bullish ($\text{Close} > \text{Open}$).
   * **SHORT Reversal**: Price $\ge R_{\text{threshold}}$ AND current 1m candle is bearish ($\text{Close} < \text{Open}$).
6. **Breakout / Breakdown Signals**:
   * **LONG Breakout**: Price $> R_{\text{high}}$ with Relative Volume $V_{\text{rel}} \ge 1.2$.
   * **SHORT Breakdown**: Price $< R_{\text{low}}$ with Relative Volume $V_{\text{rel}} \ge 1.2$.
   * *Relative Volume Definition*:
     $$V_{\text{rel}} = \frac{\text{Volume}_{\text{current}}}{\text{SMA}_{20}(\text{Volume})}$$
7. **Micro-Trend & Reversal Alignment**:
   Signal validation checks fast ($p_{\text{fast}} = 5$) and slow ($p_{\text{slow}} = 15$) 1m EMAs:
   * **LONG Signals**: Allowed if Micro-Trend is bullish ($\text{EMA}_5 > \text{EMA}_{15}$), OR price crosses above EMA ($\text{Price} \ge \text{EMA}_{15}$ or $\text{Price} \ge \text{EMA}_5$), OR a confirmed Range Reversal bounce is active.
   * **SHORT Signals**: Allowed if Micro-Trend is bearish ($\text{EMA}_5 < \text{EMA}_{15}$), OR price crosses below EMA ($\text{Price} \le \text{EMA}_{15}$ or $\text{Price} \le \text{EMA}_5$), OR a confirmed Range Reversal bounce is active.

### C. Trending / Breakout Regime
In trending market conditions, the engine triggers the **Trend Breakout Validation System** detailed below.

---

## 2. Fractal Pivot Engine & Adaptive Lookback Sizing

The **Fractal Pivot Engine** (`getTrendMarketStructure`) extracts structural highs and lows from 1m candles.

### Adaptive Lookback Window
The fractal lookback window ($W_{\text{lookback}}$) adjusts dynamically to market volatility to prevent false pivot detection:
* **Strong Uptrend / Strong Downtrend**: $W_{\text{lookback}} = 9$ candles (filters out minor 1m noise).
* **High Volatility**: $W_{\text{lookback}} = 7$ candles (balanced responsiveness).
* **Default / Range-Bound**: $W_{\text{lookback}} = 5$ candles (ultra-sensitive for rapid pivot detection).

A candle at index $i$ is confirmed as a **Swing High** if:
$$\text{High}_i > \text{High}_{i \pm j} \quad \forall \ j \in \left[1, \lfloor W_{\text{lookback}}/2 \rfloor\right]$$
And a **Swing Low** if:
$$\text{Low}_i < \text{Low}_{i \pm j} \quad \forall \ j \in \left[1, \lfloor W_{\text{lookback}}/2 \rfloor\right]$$

### Structural Classification
* **Bullish Structure (Uptrend)**: Confirmed when $\text{HH}_{\text{current}} > \text{HH}_{\text{prev}}$ AND $\text{HL}_{\text{current}} > \text{HL}_{\text{prev}}$.
* **Bearish Structure (Downtrend)**: Confirmed when $\text{LL}_{\text{current}} < \text{LL}_{\text{prev}}$ AND $\text{LH}_{\text{current}} < \text{LH}_{\text{prev}}$.

---

## 3. Dynamic Point-Based Pullback Classification

When a trend is confirmed, the engine dynamically calculates a **Pullback Depth Score** based on trend strength, slope, acceleration, spread, stretch, and ATR volatility:

$$\text{Score} = \text{ADX\_Score} + \text{Slope\_Score} + \text{Accel\_Score} + \text{Spread\_Score} - \text{Stretch\_Penalty} - \text{Vol\_Penalty}$$

### Depth Scoring Rules
1. **ADX Trend Intensity**:
   * $\text{ADX} \ge 35$: $+2$ points (extremely strong trend; shallow pullback expected).
   * $\text{ADX} \ge 25$: $+1$ point (healthy trend).
2. **EMA 20 Slope (last 5 candles)**:
   * Strong Slope ($> 0.04\%$ for LONG or $< -0.04\%$ for SHORT): $+2$ points.
   * Moderate Slope ($> 0.015\%$ for LONG or $< -0.015\%$ for SHORT): $+1$ point.
3. **Trend Acceleration** (change in slope over prior 5 candles):
   * Acceleration in trade direction ($> 0.005\%$ for LONG or $< -0.005\%$ for SHORT): $+1$ point.
4. **Trend Momentum (EMA 20 / EMA 50 Spread)**:
   * Wide Separation ($\text{Spread} \ge 0.4\%$): $+1$ point.
   * Tight Compression ($\text{Spread} < 0.15\%$): $-1$ point.
5. **Over-Extension Stretch (Distance to EMA 200)**:
   * Highly Extended ($> 2.5\%$): $-2$ points (mean-reversion risk).
   * Moderately Extended ($> 1.2\%$): $-1$ point.
6. **Relative Volatility ($\text{ATR}_{14}$ / Price)**:
   * High Volatility ($> 0.5\%$): $-1$ point.

### Depth Classification & Multipliers

| Depth Score | Classification | Support EMAs | Pullback Limit ($M_{\text{pullback}}$) | EMA Retrace Limit ($M_{\text{ema}}$) | Invalidation Limit ($M_{\text{invalidation}}$) |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **$\ge 3$** | **Shallow** | **20 / 50 EMA** | $0.70 \times \text{ATR}$ | $0.45 \times \text{ATR}$ | $0.40 \times \text{ATR}$ |
| **$0$ to $2$** | **Medium** | **50 / 100 EMA** | $0.45 \times \text{ATR}$ | $0.30 \times \text{ATR}$ | $0.25 \times \text{ATR}$ |
| **$< 0$** | **Deep** | **100 / 200 EMA** | $0.25 \times \text{ATR}$ | $0.18 \times \text{ATR}$ | $0.15 \times \text{ATR}$ |

---

## 4. Breakout Validation & High-Frequency Immediate Entry

Before tracking retracements, the engine validates breakout candles to prevent fakeouts:

### Breakout Definition
* **LONG Breakout**: Current candle closes above previous Higher High ($\text{prev\_HH}$).
* **SHORT Breakout**: Current candle closes below previous Lower Low ($\text{prev\_LL}$).

### Body-to-Range Quality Ratio
$$\text{BodyRatio} = \frac{\left|\text{Close} - \text{Open}\right|}{\text{High} - \text{Low}} \ge 0.22$$
If $\text{BodyRatio} < 0.22$, the candle is classified as a low-conviction wick sweep, and the breakout setup is **immediately rejected**.

### High-Frequency Pressure Immediate Entry
Normally, breakouts require a retest. However, during extreme momentum and order flow pressure, the engine triggers an **Immediate Breakout Entry**:
1. `allow_immediate_breakout` configuration is enabled.
2. **High-Frequency Pressure** is active:
   * $\text{ADX}_{14} \ge 32$, OR
   * Order Flow / Book Imbalance exceeds scalping bounds:
     * **LONG**: $\text{Taker Buy Ratio} \ge 0.58$ OR $\text{Imbalance Ratio} \ge 0.30$.
     * **SHORT**: $\text{Taker Buy Ratio} \le 0.42$ OR $\text{Imbalance Ratio} \le -0.30$.

---

## 5. Multi-Timeframe (5m) Trend Alignment

1m candles are evaluated against aggregated 5m trends:
* **LONG Signals**: Blocked if 5m EMA 5 is below 5m EMA 15.
* **SHORT Signals**: Blocked if 5m EMA 5 is above 5m EMA 15.

### High-Frequency Bypass
To prevent missing high-velocity scalps, 5m trend alignment is bypassed when **High-Frequency Pressure** is verified ($\text{ADX} \ge 32$ or order book imbalance thresholds met).

---

## 6. Setup Invalidation & Chasing Limits

### A. Dynamic Invalidation Thresholds
If price breaks deeper than structural support or the dynamic breathing buffer, the setup is invalidated:
* **LONG Invalidation Floor**:
  $$\text{Floor} = \max(\text{BreakoutLevel} - M_{\text{invalidation}} \times \text{ATR}, \text{Structural\_HL} - 0.10 \times \text{ATR})$$
  *Invalidated if candle closes below Floor.*
* **SHORT Invalidation Ceiling**:
  $$\text{Ceiling} = \min(\text{BreakoutLevel} + M_{\text{invalidation}} \times \text{ATR}, \text{Structural\_LH} + 0.10 \times \text{ATR})$$
  *Invalidated if candle closes above Ceiling.*

### B. Chasing Lookback Limits
Prevents entering stale breakouts after extended price runs ($C_{\text{elapsed}}$ candles since breakout):
* **$\text{ADX} < 20$ (Weak Trend)**: Max $15$ candles.
* **$\text{ADX} \ge 40$ (Extreme Trend)**: Max $45$ candles.
* **Default**: Max $30$ candles.

---

## 7. Entry Setups, Backward Indexing, & Rejection Patterns

If an immediate breakout entry is not triggered, the setup requires retracement into an entry gate:

### Setup A: Pullback & Retest
Price retraces directly to the broken structural level ($\text{prev\_HH}$ or $\text{prev\_LL}$).
* **LONG Retest Limit**: $\text{Low} \le \text{BreakoutLevel} + M_{\text{pullback}} \times \text{ATR}$
* **SHORT Retest Limit**: $\text{High} \ge \text{BreakoutLevel} - M_{\text{pullback}} \times \text{ATR}$

### Setup B: Adaptive EMA Pushback Zone
Price retraces into the designated support/resistance EMA band (e.g., 20/50 EMA for Shallow pullbacks).
* **Proximity Check**: Candle low/high comes within $0.25 \times \text{ATR}$ of the EMA band.

---

### Volume-Validated Pullback Logic
To ensure volume evaluation reflects the current active sequence, the engine searches **backwards** from the current candle index to locate the precise breakout candle index (`breakoutIdx`):

$$\text{BaseVolumeThreshold} = \max\left(V_{\text{breakout}} \times R_{\text{breakout}}, \text{SMA}_{20}(\text{Volume}) \times M_{\text{dryup}}\right)$$

Where $R_{\text{breakout}} = 0.85$ and $M_{\text{dryup}} = 1.5$.

#### Adaptive Scalping Volume Tolerance
Under active High-Frequency Pressure, high 1m transaction density is expected. The volume threshold scales adaptively:
$$\text{VolumeThreshold} = \begin{cases} 1.25 \times \text{BaseVolumeThreshold} & \text{if High-Frequency Pressure Active} \\ \text{BaseVolumeThreshold} & \text{otherwise} \end{cases}$$

If average pullback volume ($V_{\text{pullback}}$) or single candle volume exceeds $\text{VolumeThreshold}$, the pullback is flagged as abnormal distribution/accumulation risk and **blocked**.

---

### Objective Candle Rejection Patterns
To confirm support or resistance holding, the current 1m candle must satisfy at least one objective geometric pattern:

1. **Classic Pin Bar**:
   * *LONG*: Lower wick $\ge 50\%$ of range AND upper wick $\le 25\%$ of range.
   * *SHORT*: Upper wick $\ge 50\%$ of range AND lower wick $\le 25\%$ of range.
2. **Major Wick Rejection ($65\%+$ Wick-to-Range)**:
   * *LONG*: Lower wick $\ge 65\%$ of total candle range.
   * *SHORT*: Upper wick $\ge 65\%$ of total candle range.
3. **Strong Close**:
   * *LONG*: $(\text{Close} - \text{Low}) / \text{Range} \ge 0.70$.
   * *SHORT*: $(\text{High} - \text{Close}) / \text{Range} \ge 0.70$.
4. **Engulfing Pattern**:
   * Bullish/Bearish candle body completely engulfs previous candle body.
5. **Momentum Candle**:
   * Candle body $\ge 70\%$ of current 14-period ATR closing strongly in trade direction.
6. **Multi-Candle Wick Rejection**:
   * Consecutive candles with wicks $\ge 35\%$ of range whose extremes lie within $0.15 \times \text{ATR}$.
7. **Indecision Filter**:
   * If candle body $< 15\%$ of total range AND fails Pin Bar and Major Wick Rejection checks, it is classified as **Indecision** and explicitly **blocked** from triggering entries.

---

## 8. Linear Regression EMA 200 Slope & Proximity Filter

The final layer prevents trading directly into opposing higher-period moving averages:

### Linear Regression Angle Formula
Calculates the 20-period slope of EMA 200:
$$\text{Slope} = \frac{N\sum(xy) - \sum x\sum y}{N\sum(x^2) - (\sum x)^2}$$
$$\text{Normalized Slope} = \frac{\text{Slope}}{\text{ATR}_{14}} \times 100$$
$$\text{Angle} = \arctan\left(\frac{\text{Normalized Slope}}{10}\right) \times \frac{180}{\pi}$$

### Filtering Rules
1. **Slope Direction Blocker**:
   * **LONG Signals**: Blocked if EMA 200 angle $< -12^\circ$ (downward resistance wall).
   * **SHORT Signals**: Blocked if EMA 200 angle $> 12^\circ$ (upward support floor).
2. **Proximity Barrier**:
   * Entry distance to EMA 200 must exceed $M_{\text{proximity}} \times \text{ATR}_{14}$:
     * Flat EMA 200 ($|\text{Angle}| \le 15^\circ$): $M_{\text{proximity}} = 2.0$ (wide buffer to prevent range chop).
     * Normal Trending EMA 200: $M_{\text{proximity}} = 1.5$.
     * Strongly Aligned EMA 200 ($\ge 30^\circ$ for LONG, $\le -30^\circ$ for SHORT): $M_{\text{proximity}} = 0.5$ (tight proximity allowed as EMA acts as trend support).
   * *Scalping Bypass*: Bypassed if $\text{ADX} \ge 30$ or extreme high-frequency order flow is active.

---

## Summary Decision Matrix

```
[Is Regime Low Volatility?] ──────► Yes ──► BLOCK (Chop Avoidance)
            │ No
[Regime Transition Cooldown?] ────► Yes ──► BLOCK (Transition Stabilization)
            │ No
[Is Multi-Timeframe Aligned?] ───► No  ──► BLOCK (Unless Extreme HF Pressure)
            │ Yes
[Breakout Body Ratio >= 22%?] ───► No  ──► BLOCK (Wick Sweep Protection)
            │ Yes
[Is High HF Pressure Active?] ───► Yes ──► [TRIGGER IMMEDIATE ENTRY]
            │ No
[Retraced to level / EMA zone?] ─► No  ──► WAIT (Awaiting Retracement)
            │ Yes
[Objective Rejection Confirmed?] ─► No  ──► WAIT (Indecision Filter Active)
            │ Yes
[Volume within Thresholds?] ─────► No  ──► BLOCK (Distribution/Accumulation Risk)
            │ Yes
[Is EMA 200 overhead blocking?] ─► Yes ──► BLOCK (Overhead Resistance/Support Wall)
            │ No
      [EXECUTE TRADE]
```
