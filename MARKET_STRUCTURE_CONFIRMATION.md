# Market Structure Confirmation (MSC) Engine Documentation

The **Market Structure Confirmation (MSC) Engine** is an institutional-grade, multi-regime trade validation and confirmation framework built directly into the core trading processor (`src/engine.ts`). Instead of executing trades based on simple lagging indicators or fixed percentage thresholds, the MSC engine models real-time order flow and price action across multiple timeframes. It utilizes adaptive fractal pivots, dynamic point-based pullback depth modeling, micro-trend alignments, objective candle rejection metrics, and linear regression-based EMA 200 slope filters to confirm high-probability trade setups and filter out high-risk chops.

This document describes the mathematical formulas, scoring criteria, multi-regime pathways, and logical structures of the MSC engine as implemented in the system.

---

## Architecture Overview

The MSC engine processes entry signals through a multi-stage sequential validation pipeline:

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
                      1m EMA Alignment             Pullback Classification
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

The engine branches into distinct confirmation pathways depending on the active **Market Regime**:

### A. Low Volatility Regime (`MarketRegime.LOW_VOLATILITY`)
* **Behavior**: Deactivates all trading immediately. 
* **Reasoning**: Eliminates execution inside tight ranges where bid-ask spreads and transaction slippage erode profits.

### B. Range Bound Regime (`MarketRegime.RANGE_BOUND`)
When the market is range-bound, the engine tracks price boundaries on a 1m chart and confirms reversals or breakouts:
1. **Range Boundaries**: Scans a lookback window of 30 candles on the 1m chart to find the highest price ($R_{\text{high}}$) and the lowest price ($R_{\text{low}}$).
2. **Range Width**: 
   $$W_{\text{range}} = R_{\text{high}} - R_{\text{low}}$$
3. **Dynamic Support & Resistance Gates**:
   $$S_{\text{threshold}} = R_{\text{low}} + \min(W_{\text{range}} \times 0.15, R_{\text{low}} \times 0.0015)$$
   $$R_{\text{threshold}} = R_{\text{high}} - \min(W_{\text{range}} \times 0.15, R_{\text{high}} \times 0.0015)$$
4. **Reversal Triggers**:
   * **LONG Reversal**: Current price $\le S_{\text{threshold}}$ AND the current 1m candle is bullish ($\text{Close} > \text{Open}$).
   * **SHORT Reversal**: Current price $\ge R_{\text{threshold}}$ AND the current 1m candle is bearish ($\text{Close} < \text{Open}$).
5. **Breakout / Breakdown Triggers**:
   * **LONG Breakout**: Current price $> R_{\text{high}}$ on High Relative Volume ($V_{\text{rel}} > 1.2$).
   * **SHORT Breakdown**: Current price $< R_{\text{low}}$ on High Relative Volume ($V_{\text{rel}} > 1.2$).
   * *Relative Volume Calculation*: Ratio of the current candle's volume to the 20-period Simple Moving Average (SMA) of volume:
     $$V_{\text{rel}} = \frac{\text{Volume}_{\text{current}}}{\text{SMA}_{20}(\text{Volume})}$$
6. **Micro-Trend Filter**: Long and short signals within ranges must align with 1m micro-trends calculated using fast ($p_{\text{fast}} = 5$) and slow ($p_{\text{slow}} = 15$) EMAs:
   * **LONG Reversal/Breakout**: Blocked unless the micro-trend is bullish ($\text{EMA}_5 > \text{EMA}_{15}$) OR the current price crosses above the slow EMA ($\text{Price} \ge \text{EMA}_{15}$).
   * **SHORT Reversal/Breakdown**: Blocked unless the micro-trend is bearish ($\text{EMA}_5 < \text{EMA}_{15}$) OR the current price crosses below the slow EMA ($\text{Price} \le \text{EMA}_{15}$).

### C. Trending/Breakout Regime
When a strong trend is active, the engine activates the comprehensive **Trend Breakout Validation System** described below.

---

## 2. Pivot Detection & Adaptive Fractal Sizing

At the base of the trending system is the **Fractal Pivot Engine** (`getTrendMarketStructure`). It scans the $1\text{m}$ candle series to extract peaks (Swing Highs) and troughs (Swing Lows).

### Adaptive Lookback Sizing
The lookup window size ($W_{\text{lookback}}$) adapts dynamically based on the current **Market Regime** to optimize sensitivity:
* **Strong Uptrend / Strong Downtrend**: $W_{\text{lookback}} = 9$ candles (heavy smoothing to filter out minor pullbacks).
* **High Volatility**: $W_{\text{lookback}} = 7$ candles (balanced sensitivity).
* **Default / Range-bound / Other**: $W_{\text{lookback}} = 5$ candles (ultra-responsive to capture quick pivot shifts).

A candle at index $i$ is confirmed as a **Swing High** if:
$$\text{High}_i > \text{High}_{i \pm j} \quad \forall \ j \in \left[1, \lfloor W_{\text{lookback}}/2 \rfloor\right]$$

And a **Swing Low** if:
$$\text{Low}_i < \text{Low}_{i \pm j} \quad \forall \ j \in \left[1, \lfloor W_{\text{lookback}}/2 \rfloor\right]$$

### Trend Structure Identification
The engine classifies consecutive pivots to define the structural trend:
* **Bullish Structure (Uptrend)**: Confirmed when $\text{current\_HH} > \text{prev\_HH}$ AND $\text{current\_HL} > \text{prev\_HL}$ (Higher Highs and Higher Lows).
* **Bearish Structure (Downtrend)**: Confirmed when $\text{current\_LL} < \text{prev\_LL}$ AND $\text{current\_LH} < \text{prev\_LH}$ (Lower Lows and Lower Highs).

---

## 3. Dynamic Point-Based Pullback Classification

When a trend is confirmed, the engine does not expect a uniform retracement. Instead, it scores current momentum, slope, spread, and volatility to dynamically classify the expected **Pullback Depth** into three tiers: **Shallow**, **Medium**, or **Deep**.

This scoring system calculates a **Depth Points** score:

$$\text{Score} = \text{ADX\_Influence} + \text{Slope\_Influence} + \text{Acceleration\_Influence} + \text{Spread\_Influence} - \text{Stretch\_Risk} - \text{Volatility\_Surcharges}$$

### Depth Score Rules:
1. **ADX Trend Intensity**:
   * $\text{ADX} \ge 35$: $+2$ points (extremely strong trend; shallow pullback highly probable).
   * $\text{ADX} \ge 25$: $+1$ point (healthy trend; supports shallow-to-medium pullback).
2. **EMA 20 Slope (over last 5 candles)**:
   * Strong Slope ($\text{Slope} > 0.04\%$ for LONG or $< -0.04\%$ for SHORT): $+2$ points.
   * Moderate Slope ($\text{Slope} > 0.015\%$ for LONG or $< -0.015\%$ for SHORT): $+1$ point.
3. **Trend Acceleration** (change in slope over prior 5 candles):
   * Accelerating in trade direction ($\text{Acceleration} > 0.005\%$ for LONG or $< -0.005\%$ for SHORT): $+1$ point.
4. **Trend Momentum (EMA 20/50 Spread)**:
   * Wide separation ($\text{Spread} \ge 0.4\%$): $+1$ point.
   * Tight consolidation ($\text{Spread} < 0.15\%$): $-1$ point (forces a deeper retrace expectation).
5. **Over-extension Stretch (Distance to EMA 200)**:
   * Highly extended ($\text{Distance} > 2.5\%$): $-2$ points (elevated mean-reversion risk; deep pullback required).
   * Moderately extended ($\text{Distance} > 1.2\%$): $-1$ point.
6. **Relative Volatility (14-period ATR relative to price)**:
   * High Volatility ($\text{ATR} > 0.5\%$ of current price): $-1$ point (highly volatile assets require deeper breathing room).

### Dynamic Zones Assignment:

Based on the accumulated score, the engine assigns the expected pullback zone and associated multipliers (multiplied by the current 14-period Average True Range, $\text{ATR}_{14}$):

| Depth Score | Classified Depth | Active EMA Support Zone | Pullback Multiplier Limit ($M_{\text{pullback}}$) | EMA Retrace Multiplier Limit ($M_{\text{ema}}$) | Invalidation Multiplier ($M_{\text{invalidation}}$) |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **$\ge 3$** | **Shallow** | **20 / 50 EMA** | $0.70 \times \text{ATR}$ | $0.45 \times \text{ATR}$ | $0.40 \times \text{ATR}$ |
| **$0$ to $2$** | **Medium** | **50 / 100 EMA** | $0.45 \times \text{ATR}$ | $0.30 \times \text{ATR}$ | $0.25 \times \text{ATR}$ |
| **$< 0$** | **Deep** | **100 / 200 EMA** | $0.25 \times \text{ATR}$ | $0.18 \times \text{ATR}$ | $0.15 \times \text{ATR}$ |

---

## 4. Breakout Strength & Immediate Entry Gating

Before monitoring the retracement, the engine verifies the breakout itself to filter out false breakouts and "wick sweeps."

### Breakout Definition
* **LONG Breakout**: Current close crosses above the previous Higher High ($\text{prev\_HH}$).
* **SHORT Breakout**: Current close crosses below the previous Lower Low ($\text{prev\_LL}$).

### Breakout Candle Body Close verification
The candle that breaks and closes beyond the breakout level must have a high body-to-range ratio:
$$\text{Body-to-Range Ratio} = \frac{\left|\text{Close} - \text{Open}\right|}{\text{High} - \text{Low}} \ge \text{min\_breakout\_body\_ratio} \quad (\text{Default: } 0.22)$$
If the body is less than $22\%$ of the total range, the breakout is flagged as a "wick sweep" or false breakout, and the setup is **immediately blocked**.

### Lower Low / Higher High Breakout Immediate Entry Check
Normally, when a breakout is confirmed, the engine forbids immediate entries on the breakout candle itself to prevent buying top or selling bottom, forcing a wait for a pullback. However, under **Extreme Real-Time Momentum & High-Frequency Pressure**, the engine checks for an **Immediate Breakout Entry** (checking the breakout directly instead of waiting for a retracement):

* **Immediate Breakout Condition**: Enabled if `allow_immediate_breakout` is true, AND high-frequency pressure is active.
* **High-Frequency Pressure Detection**: Validated if:
  1. The 14-period ADX $\ge$ `hf_momentum_adx_threshold` (Default: `30`), OR
  2. Order Book Imbalance or Taker Buy/Sell ratios exceed extreme scalping thresholds:
     * **LONG**: $\text{Taker Buy Ratio} \ge 0.58$ OR $\text{Imbalance Ratio} \ge 0.30$
     * **SHORT**: $\text{Taker Buy Ratio} \le 0.42$ OR $\text{Imbalance Ratio} \le -0.30$

If these parameters are met on the breakout candle, the engine triggers an **immediate market entry**, capturing the momentum instantly without waiting for a retest.

---

## 5. Multi-Timeframe (5m) Trend Alignment

To trade in harmony with high-timeframe order flow, the engine aggregates $1\text{m}$ data into $5\text{m}$ candles:
* **LONG entries**: Blocked if $5\text{m}$ EMA 5 is below $5\text{m}$ EMA 15.
* **SHORT entries**: Blocked if $5\text{m}$ EMA 5 is above $5\text{m}$ EMA 15.

### High-Frequency Pressure Bypass
This filter is bypassed under **Extreme Real-Time Pressure**:
* If $\text{ADX} \ge \text{hf\_momentum\_adx\_threshold} + 2$ (Default: $32$), or
* Order Flow Taker Buy Ratio or Order Book Imbalance exceeds the extreme scalping limits described in Section 4.

---

## 6. Setup Invalidation & Chasing Limits

Once a valid breakout occurs, the engine tracks the setup candles and applies strict protective limits before entry triggers:

### A. Dynamic Invalidation Floor & Ceiling
If the price breaks past structural support or the dynamic breathing zone, the setup is invalidated to prevent catching a falling knife:
* **LONG Reclaim Threshold**: 
  $$\text{Reclaim Floor} = \max(\text{Breakout\_Level} - M_{\text{invalidation}} \times \text{ATR}, \text{Structural\_HL} - 0.1 \times \text{ATR})$$
  *If the price closes below this floor, the setup is invalidated.*
* **SHORT Reclaim Threshold**: 
  $$\text{Reclaim Ceiling} = \min(\text{Breakout\_Level} + M_{\text{invalidation}} \times \text{ATR}, \text{Structural\_LH} + 0.1 \times \text{ATR})$$
  *If the price closes above this ceiling, the setup is invalidated.*

### B. Chasing Lookback Limits
To prevent late entries on a run-away price, the engine counts the number of candles elapsed since the breakout ($C_{\text{elapsed}}$) and blocks entries if it exceeds a dynamic threshold based on ADX:
* **ADX $< 20$ (Weak Trend)**: $C_{\text{max}} = 15$ candles.
* **ADX $\ge 40$ (Extreme Trend)**: $C_{\text{max}} = 45$ candles.
* **Default (Normal Trend)**: $C_{\text{max}} = 30$ candles.

*If $C_{\text{elapsed}} > C_{\text{max}}$, the entry is blocked as "chasing".*

---

## 7. Entry Setups & Objective Rejection Patterns

If an immediate breakout entry is not triggered and the setup remains valid, the price must pull back into one of two entry gates:

### Setup A: Pullback & Retest
The price pulls back directly to the broken structural level ($\text{prev\_HH}$ or $\text{prev\_LL}$).
1. **Pullback Depth Check**: The low of the post-breakout candles must reach the pullback limit:
   * **LONG Pullback Limit**: $\text{Low} \le \text{Breakout\_Level} + M_{\text{pullback}} \times \text{ATR}$
   * **SHORT Pullback Limit**: $\text{High} \ge \text{Breakout\_Level} - M_{\text{pullback}} \times \text{ATR}$
2. **Volume-Validated Pullback**: The average volume during the pullback phase ($V_{\text{pullback}}$) must be declining relative to the breakout volume ($V_{\text{breakout}}$) and the 20-period average volume ($V_{\text{avg20}}$). High-volume pullbacks flag aggressive distribution/accumulation risk and are blocked:
   * *Blocked if*: $V_{\text{pullback}} > \max(V_{\text{breakout}} \times 1.8, V_{\text{avg20}} \times 2.2)$
3. **Candle Rejection Confirmation**: A candle rejection pattern must occur at the level.

### Setup B: Adaptive EMA Pushback Zone
The price retraces into the dynamically selected EMA support/resistance band (e.g. 20/50 EMA for Shallow pullbacks).
1. **EMA Depth Check**: At least one post-breakout candle must retrace into the EMA zone:
   * **LONG Retrace**: $\text{Low} \le \text{First\_EMA\_Val} + M_{\text{ema}} \times \text{ATR}$ or $\text{Low} \le \text{Second\_EMA\_Val} + M_{\text{ema}} \times \text{ATR}$
   * **SHORT Retrace**: $\text{High} \ge \text{First\_EMA\_Val} - M_{\text{ema}} \times \text{ATR}$ or $\text{High} \ge \text{Second\_EMA\_Val} - M_{\text{ema}} \times \text{ATR}$
2. **Touch Proximity**: The entering candle must touch or come very close to the selected EMA lines:
   * **LONG Touch**: $\text{Low} \le \text{EMA\_Val} + 0.25 \times \text{ATR}$ AND $\text{High} \ge \text{EMA\_Val} - 0.15 \times \text{ATR}$
   * **SHORT Touch**: $\text{High} \ge \text{EMA\_Val} - 0.25 \times \text{ATR}$ AND $\text{Low} \le \text{EMA\_Val} + 0.15 \times \text{ATR}$
3. **Candle Rejection Confirmation**: A confirming candle rejection pattern must print inside this EMA band.

---

### Objective Rejection Evaluation System
The current candle must satisfy strict geometric wick-and-body checks to confirm support/resistance rejections:

1. **Classic Pin Bar**:
   * *Bullish (LONG)*: Lower wick $\ge 50\%$ of the total range AND upper wick $\le 25\%$ of the range.
   * *Bearish (SHORT)*: Upper wick $\ge 50\%$ of the total range AND lower wick $\le 25\%$ of the range.
2. **Strong Close**:
   * *Bullish (LONG)*: Close is in the upper $30\%$ of the total range: $(\text{Close} - \text{Low}) / \text{Range} \ge 0.70$.
   * *Bearish (SHORT)*: Close is in the lower $30\%$ of the total range: $(\text{High} - \text{Close}) / \text{Range} \ge 0.70$.
3. **Engulfing Pattern**:
   * *Bullish (LONG)*: Current candle is bullish, previous was bearish, and the current body completely engulfs the previous body.
   * *Bearish (SHORT)*: Current candle is bearish, previous was bullish, and the current body completely engulfs the previous body.
4. **Momentum Candle**:
   * Candle body size $\ge 70\%$ of the current 14-period ATR, closing strongly in the trade direction.
5. **Multi-Candle Wick Rejection**:
   * Consecutive candles showing wicks $\ge 35\%$ of their ranges, with lows (or highs) printing within $15\%$ of ATR of each other (confirming double bottoms/tops).
6. **Indecision Filter**:
   * If the candle body size is $< 15\%$ of the total range and does not qualify as a Pin Bar, it is classified as **Indecision** and explicitly **prevented** from triggering an entry.

---

## 8. EMA 200 Proximity & Angle Filter

The final layer of defense is the **EMA 200 overhead blocker**. Trading directly into a flat or counter-sloping high-period moving average often results in immediate rejection.

### Linear Regression Angle Analysis
The engine calculates a stable, lag-reduced slope of the last $20$ values of the EMA 200 using linear regression:
$$\text{Slope} = \frac{N\sum(xy) - \sum x\sum y}{N\sum(x^2) - (\sum x)^2}$$
This slope is normalized against the ATR to make it asset-agnostic:
$$\text{Normalized Slope} = \frac{\text{Slope}}{\text{ATR}} \times 100$$
$$\text{Angle} = \arctan\left(\frac{\text{Normalized Slope}}{10}\right) \times \frac{180}{\pi}$$

### Protective Filters:
1. **Trend Alignment Blocker**:
   * **LONG** trades are **blocked** if the EMA 200 angle is $< -12^\circ$ (strongly downward sloping, overhead hazard).
   * **SHORT** trades are **blocked** if the EMA 200 angle is $> 12^\circ$ (strongly upward sloping, heavy dynamic support).
2. **Adaptive Proximity Barrier**:
   Entering a trade too close to the EMA 200 is blocked. The proximity barrier is computed as:
   $$\text{Barrier} = M_{\text{proximity}} \times \text{ATR}$$
   * **Flat / Ranging EMA 200** ($\left|\text{Angle}\right| \le 15^\circ$): $M_{\text{proximity}} = 2.0$ (forces a wide safety zone to prevent magnetic chop crossings).
   * **Normal Trending EMA 200**: $M_{\text{proximity}} = 1.5$.
   * **Strongly Aligned EMA 200** ($\text{Angle} \ge 30^\circ$ for LONG or $\le -30^\circ$ for SHORT): $M_{\text{proximity}} = 0.5$ (allows very close entries as the moving average acts as a strong springboard).
   * *Scalping Momentum Bypass*: If $\text{ADX} \ge 30$ or extreme order-book pressure is active, this proximity blocker is bypassed completely.

---

## Summary of Rule Execution

For a trade to be triggered, the setup must pass every check:

```
[Is Regime Low Volatility?] ──────► Yes ──► BLOCK (Chop Avoidance)
            │ No
[Regime Transition Cooldown?] ────► Yes ──► BLOCK (Transition Stabilization)
            │ No
[Is Multi-Timeframe Aligned?] ───► No  ──► BLOCK (Unless Extreme Momentum)
            │ Yes
[Breakout Body Ratio >= 22%?] ───► No  ──► BLOCK (False Breakout Protection)
            │ Yes
[Is High HF Pressure Active?] ───► Yes ──► [TRIGGER IMMEDIATE ENTRY]
            │ No
[Retraced to level / EMA zone?] ─► No  ──► WAIT (No entry trigger yet)
            │ Yes
[Objective Rejection Confirmed?] ─► No  ──► WAIT (Indecision candle filtered)
            │ Yes
[Is EMA 200 overhead blocking?] ─► Yes ──► BLOCK (Avoid immediate overhead wall)
            │ No
      [EXECUTE TRADE]
```
