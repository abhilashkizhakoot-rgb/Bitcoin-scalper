# Market Structure Confirmation (MSC) Engine Documentation

The **Market Structure Confirmation (MSC) Engine** is a high-precision, institutional-grade trade execution and confirmation framework built into the core trading processor (`src/engine.ts`). Rather than executing trades based on simple, lagging indicators or static thresholds, the MSC engine models price action using a dynamic combination of multi-timeframe swing structures, adaptive moving average zones, point-based pullback depth modeling, order-flow softening filters, and objective candle rejections.

This document details exactly how the engine identifies market structure, filters out low-probability environments, and confirms a trade entry.

---

## Architecture Overview

The confirmation of any trade follows a strict, sequential pipeline:

```
  [1m Price Feed] ──► [Regime Identification] (Checks for Low Volatility/Chop)
                            │
                            ▼
               [Pivot & Fractal Extraction] (Identifies HH, HL, LH, LL)
                            │
                            ▼
               [Multi-Timeframe Validation] (5m Trend Alignment)
                            │
                            ▼
                [Breakout Strength Filter] (Candle Body-to-Range Check)
                            │
                            ▼
              [Adaptive Pullback Classification] (Point-Based Depth Score)
                            │
                            ▼
                 [Rejection Pattern Check] (Pin Bars, Engulfing, Multi-Wicks)
                            │
                            ▼
               [EMA 200 Proximity & Angle Filter] (Overhead Blockers)
                            │
                            ▼
                     [TRADE TRIGGER]
```

---

## 1. Pivot Detection & Adaptive Fractal Sizing

At the base of the MSC engine is the **Fractal Pivot Engine** (`getTrendMarketStructure`). It scans the $1\text{m}$ candle series to extract peaks (Swing Highs) and troughs (Swing Lows).

### Adaptive Lookback Sizing
To prevent noise in range-bound markets and avoid lagging behind in explosive trends, the lookup window size ($W$) adapts dynamically based on the current **Market Regime**:
*   **Strong Uptrend / Downtrend**: $W = 9$ candles (heavy smoothing to filter out minor pullbacks).
*   **High Volatility**: $W = 7$ candles (balanced sensitivity).
*   **Default / Range-bound**: $W = 5$ candles (ultra-responsive to capture quick pivot shifts).

A candle at index $i$ is confirmed as a **Swing High** if:
$$\text{High}_i > \text{High}_{i \pm j} \quad \forall \ j \in \left[1, \lfloor W/2 \rfloor\right]$$

And a **Swing Low** if:
$$\text{Low}_i < \text{Low}_{i \pm j} \quad \forall \ j \in \left[1, \lfloor W/2 \rfloor\right]$$

### Trend Structure Identification
The engine classifies consecutive pivots to define the structural trend:
*   **Bullish Structure (Uptrend)**: Confirmed when $\text{current\_HH} > \text{prev\_HH}$ AND $\text{current\_HL} > \text{prev\_HL}$ (Higher Highs and Higher Lows).
*   **Bearish Structure (Downtrend)**: Confirmed when $\text{current\_LL} < \text{prev\_LL}$ AND $\text{current\_LH} < \text{prev\_LH}$ (Lower Lows and Lower Highs).

---

## 2. Dynamic Point-Based Pullback Classification

When a trend is confirmed, the engine does not expect a uniform retracement. Instead, it scores current momentum and market conditions to dynamically classify the expected **Pullback Depth** into three tiers: **Shallow**, **Medium**, or **Deep**.

This scoring system calculates a **Depth Points** score:

```
Score = ADX_Influence + Slope_Influence + Acceleration_Influence + Spread_Influence - Stretch_Risk - Volatility_Surcharges
```

### Depth Score Rules:
1.  **ADX Trend Intensity**:
    *   $\text{ADX} \ge 35$: $+2$ points (extremely strong trend; shallow pullback highly probable).
    *   $\text{ADX} \ge 25$: $+1$ point (healthy trend; supports shallow-to-medium pullback).
2.  **EMA 20 Slope (over last 5 candles)**:
    *   Strong Slope ($\text{Slope} > 0.04\%$ for LONG or $< -0.04\%$ for SHORT): $+2$ points.
    *   Moderate Slope ($\text{Slope} > 0.015\%$ for LONG or $< -0.015\%$ for SHORT): $+1$ point.
3.  **Trend Acceleration** (change in slope over prior 5 candles):
    *   Accelerating in trade direction ($\text{Acceleration} > 0.005\%$ for LONG or $< -0.005\%$ for SHORT): $+1$ point.
4.  **Trend Momentum (EMA 20/50 Spread)**:
    *   Wide separation ($\text{Spread} \ge 0.4\%$): $+1$ point.
    *   Tight consolidation ($\text{Spread} < 0.15\%$): $-1$ point (forces a deeper retrace expectation).
5.  **Over-extension Stretch (Distance to EMA 200)**:
    *   Highly extended ($\text{Distance} > 2.5\%$): $-2$ points (elevated mean-reversion risk; deep pullback required).
    *   Moderately extended ($\text{Distance} > 1.2\%$): $-1$ point.
6.  **Relative Volatility (ATR relative to price)**:
    *   High Volatility ($\text{ATR} > 0.5\%$ of current price): $-1$ point (highly volatile assets require deeper breathing room).

### Dynamic Zones Assignment:

| Depth Score | Classified Depth | Active EMA Support Zone | Pullback Multiplier Limit | EMA Retrace Multiplier | Invalidation Multiplier (SL Space) |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **$\ge 3$** | **Shallow** | **20 / 50 EMA** | $0.70 \times \text{ATR}$ | $0.45 \times \text{ATR}$ | $0.40 \times \text{ATR}$ (Breathing room) |
| **$0$ to $2$** | **Medium** | **50 / 100 EMA** | $0.45 \times \text{ATR}$ | $0.30 \times \text{ATR}$ | $0.25 \times \text{ATR}$ (Moderate) |
| **$< 0$** | **Deep** | **100 / 200 EMA** | $0.25 \times \text{ATR}$ | $0.18 \times \text{ATR}$ | $0.15 \times \text{ATR}$ (Tight) |

---

## 3. Breakout Strength Verification

Before monitoring the retracement, the engine verifies the breakout itself to filter out false breakouts and "wick sweeps."

*   **Breakout Level**: Defined as the previous Higher High ($\text{prev\_HH}$) for a LONG breakout or previous Lower Low ($\text{prev\_LL}$) for a SHORT breakout.
*   **Body-to-Range Confirmation**: The candle that breaks and closes beyond the breakout level must have a high body-to-range ratio:
    $$\frac{\left|\text{Close} - \text{Open}\right|}{\text{High} - \text{Low}} \ge \text{min\_breakout\_body\_ratio} \quad (\text{Default: } 0.22)$$
    If the body is less than $22\%$ of the total range, the breakout is flagged as a "wick sweep" or false breakout, and the setup is **immediately blocked**.

---

## 4. Multi-Timeframe (5m) Trend Alignment

To trade in harmony with high-timeframe order flow, the engine aggregates $1\text{m}$ data into $5\text{m}$ candles:
*   **LONG entries**: Blocked if $5\text{m}$ EMA 5 is below $5\text{m}$ EMA 15.
*   **SHORT entries**: Blocked if $5\text{m}$ EMA 5 is above $5\text{m}$ EMA 15.

### High-Frequency Pressure Bypass
This filter is bypassed under **Extreme Real-Time Pressure**:
*   If $\text{ADX} \ge \text{hf\_momentum\_adx\_threshold}$ (Default: $30$), or
*   Order Book Imbalance or Taker Buy Ratio exceeds extreme scalping limits (e.g., Taker Buy Ratio $\ge 0.58$ for LONG or $\le 0.42$ for SHORT).

---

## 5. Entry Setups & Objective Rejection Patterns

Once a valid breakout is confirmed, the engine monitors two distinct entry setups:

### Setup A: Pullback & Retest
The price pulls back directly to the broken structural level ($\text{prev\_HH}$ or $\text{prev\_LL}$).
1.  **Volume Filter**: Volume during the pullback phase must be **declining** relative to the breakout volume, indicating low selling pressure on a LONG retest (or low buying pressure on a SHORT retest). High-volume pullbacks flag aggressive distribution/accumulation risk and are blocked.
2.  **Candle Rejection Confirmation**: The retest is validated ONLY if a clear candlestick rejection pattern occurs at the level (see patterns below).

### Setup B: Adaptive EMA Pushback Zone
The price retraces into the dynamically selected EMA support/resistance band (e.g. 20/50 EMA for Shallow pullbacks).
1.  **Touch Verification**: The low of the candle must penetrate the dynamic threshold:
    $$\text{Low} \le \text{first\_EMA} + 0.25 \times \text{ATR} \quad \text{and} \quad \text{High} \ge \text{first\_EMA} - 0.15 \times \text{ATR}$$
2.  **Candle Rejection Confirmation**: A confirming candle rejection pattern must print inside this EMA band.

---

### Objective Rejection Evaluation System
To prevent entry on weak indecision candles (such as small Dojis or spinning tops), the engine runs a rigorous geometric wick-and-body check on the current candle:

1.  **Classic Pin Bar**:
    *   *Bullish (LONG)*: Lower wick $\ge 50\%$ of the total candle range, and upper wick $\le 25\%$ of the range.
    *   *Bearish (SHORT)*: Upper wick $\ge 50\%$ of the total candle range, and lower wick $\le 25\%$ of the range.
2.  **Strong Close**:
    *   *Bullish (LONG)*: Candle closes in the upper $30\%$ of its total range.
    *   *Bearish (SHORT)*: Candle closes in the lower $30\%$ of its total range.
3.  **Engulfing Pattern**:
    *   *Bullish (LONG)*: Current candle is bullish, previous was bearish, and the current body completely engulfs the previous body.
    *   *Bearish (SHORT)*: Current candle is bearish, previous was bullish, and the current body completely engulfs the previous body.
4.  **Momentum Candle**:
    *   Candle body $\ge 70\%$ of the current $14$-period ATR, closing strongly in the trade direction.
5.  **Multi-Candle Wick Rejection**:
    *   Consecutive candles showing lower wicks $\ge 35\%$ of their ranges, with lows printing within $15\%$ of ATR of each other (indicating a firm double bottom or wick cluster support).
6.  **Indecision Override**:
    *   If the candle body is $< 15\%$ of the total range and does not meet Pin Bar criteria, it is classified as **Indecision** and explicitly **prevented** from triggering an entry.

---

## 6. EMA 200 Proximity & Angle Filter

The final layer of defense is the **EMA 200 overhead blocker**. Trading directly into a flat or counter-sloping high-period moving average often results in immediate rejection.

### Linear Regression Angle Analysis
The engine calculates a stable, lag-reduced slope of the last $20$ values of the EMA 200 using linear regression:
$$\text{Slope} = \frac{N\sum(xy) - \sum x\sum y}{N\sum(x^2) - (\sum x)^2}$$
This slope is normalized against the ATR to make it asset-agnostic:
$$\text{Normalized Slope} = \frac{\text{Slope}}{\text{ATR}} \times 100$$
$$\text{Angle} = \arctan\left(\frac{\text{Normalized Slope}}{10}\right) \times \frac{180}{\pi}$$

### Protective Filters:
1.  **Trend Alignment Blocker**:
    *   **LONG** trades are **blocked** if the EMA 200 angle is $< -12^\circ$ (strongly downward sloping, overhead hazard).
    *   **SHORT** trades are **blocked** if the EMA 200 angle is $> 12^\circ$ (strongly upward sloping, heavy dynamic support).
2.  **Adaptive Proximity Barrier**:
    Entering a trade too close to the EMA 200 is blocked. The proximity barrier is computed as:
    $$\text{Barrier} = \text{Proximity Multiplier} \times \text{ATR}$$
    *   **Flat / Ranging EMA 200** ($\left|\text{Angle}\right| \le 15^\circ$): Multiplier = $2.0 \times \text{ATR}$ (forces a wide safety zone to prevent magnetic chop crossings).
    *   **Normal Trending EMA 200**: Multiplier = $1.5 \times \text{ATR}$.
    *   **Strongly Aligned EMA 200** ($\text{Angle} \ge 30^\circ$ for LONG or $\le -30^\circ$ for SHORT): Multiplier = $0.5 \times \text{ATR}$ (allows very close entries as the moving average acts as a strong springboard).
    *   *Scalping Momentum Bypass*: If $\text{ADX} \ge 30$ or extreme order-book pressure is active, this proximity blocker is bypassed completely.

---

## 7. Regime Transition Cooldown Filter

During market transitions (e.g., switching from a *Strong Uptrend* to a *Range Bound* chop-zone), trend-following models are highly vulnerable to whipsaws and trend-reversal fakeouts. To eliminate this high-frequency slippage, the MSC engine implements a **Regime Transition Cooldown Gate (C20)**:

*   **Trigger Event**: Any change in the dominant calculated `MarketRegime`.
*   **Cooldown Duration**: Specified by `regime_change_cooldown_minutes` (Default: `15` minutes).
*   **Block Behavior**: Standard entry signal generation is immediately frozen/blocked for both manual and automatic systems during the cooldown window. This ensures that the engine only takes trades once the new market regime has stabilized and the technical indicator averages have re-converged.

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
[Retraced to level / EMA zone?] ─► No  ──► WAIT (No entry trigger yet)
            │ Yes
[Objective Rejection Confirmed?] ─► No  ──► WAIT (Indecision candle filtered)
            │ Yes
[Is EMA 200 overhead blocking?] ─► Yes ──► BLOCK (Avoid immediate overhead wall)
            │ No
      [EXECUTE TRADE]
```
