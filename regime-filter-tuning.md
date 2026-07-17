# Regime Filter Tuning Guide

This guide explains how the **Compression & Slope Intercept Gate** works inside the regime classification engine and provides concrete instructions on how to calibrate the parameters if a strong trending market (especially a strong downtrend) is being misclassified as `RANGE_BOUND`.

---

## 1. How the Cascading Engine Works

The regime classification method runs on a top-down evaluation cascade of four steps:

```
┌──────────────────────────────────────────────────────────┐
│ Step 1: Volatility Extremes Check                        │
│ (Triggers HIGH_VOLATILITY or LOW_VOLATILITY via ATR)     │
└────────────────────────────┬─────────────────────────────┘
                             │ (Passed)
                             ▼
┌──────────────────────────────────────────────────────────┐
│ Step 2: Compression Intercept (NEW)                      │
│ If Macro Slope is FLAT && Ribbon Compression is TIGHT:    │
│ ──► Forcefully return RANGE_BOUND (Bypasses trend checks)│
└────────────────────────────┬─────────────────────────────┘
                             │ (Passed / Not Flat & Tight)
                             ▼
┌──────────────────────────────────────────────────────────┐
│ Step 3: Trend Alignment                                  │
│ (Checks EMA 9/21/50/100 stacking + ADX > threshold)      │
└────────────────────────────┬─────────────────────────────┘
                             │ (No Trend Aligned)
                             ▼
┌──────────────────────────────────────────────────────────┐
│ Step 4: Fallback                                         │
│ ──► Default to RANGE_BOUND                               │
└──────────────────────────────────────────────────────────┘
```

---

## 2. Diagnosing and Fixing Misclassification

If a **strong downtrend** is being misclassified as `RANGE_BOUND`, it is caused by one of two scenarios:

### Scenario A: The trend is getting caught by the Step 2 Compression Intercept
Because the slope or ribbon spread calculations are too permissive, the engine mistakenly flags the active trend as "flat and compressed" and intercepts it before checking trend alignment.

#### How to Tune:
1. **Reduce the Regime Macro Slope Threshold (`regime_macro_slope_threshold`)**
   - *Default*: `0.0005` (0.05% change over lookback).
   - *Adjustment*: Decrease this value to `0.0002` or `0.0001`.
   - *Why*: A lower threshold makes the flatness test much stricter. It ensures that even minor downward sloping EMAs are recognized as "sloping" (not flat), letting the trend proceed to Step 3.
2. **Reduce the Regime Ribbon Compression Threshold (`regime_ribbon_compression_threshold`)**
   - *Default*: `0.0015` (0.15% standard deviation normalized to price).
   - *Adjustment*: Decrease this value to `0.0010` or `0.0008`.
   - *Why*: A lower threshold requires the EMA 9, 21, and 50 to be extremely tightly bound/tangled to trigger. In a strong downtrend, these EMAs naturally fan out (creating standard deviation spread). A lower threshold prevents this fan-out from being misclassified as compressed.
3. **Adjust the Regime Macro Slope Lookback (`regime_macro_slope_lookback`)**
   - *Default*: `5` periods.
   - *Adjustment*: Increase this to `8` or `10` if you want to capture trend slope over a slightly longer, more stable window, or decrease to `3` to react faster to sudden slope changes.

---

### Scenario B: The trend fails the Step 3 Trend Alignment checks
If the trend successfully bypasses Step 2 but still gets labeled `RANGE_BOUND` in Step 4, it means the trend alignment filter is rejecting it.

#### How to Tune:
1. **Verify EMA Stacking**
   - In a strong downtrend, the engine expects `EMA 9 < EMA 21 < EMA 50 < EMA 100` (or similar relative stack configurations). If the fast EMAs are crossing over or tangled, it won't trigger `STRONG_DOWNTREND`.
2. **Lower ADX Thresholds**
   - If ADX is dipping during the downtrend below your `adx_threshold` or `trend_alignment_adx_threshold`, the engine treats the trend as lost or weak.
   - *Adjustment*: Lower the ADX threshold parameters (e.g. to `20` or `18`) to allow trend classification under weaker trend index values.

---

## 3. Configuration Interface

All parameters can be configured directly from the **Configuration Panel** in the UI under **General Settings** or updated via your `config.json` file:

- **Regime Macro Slope Lookback**: Lookback window (aggregated periods) to measure the EMA trend angle.
- **Regime Macro Slope Threshold**: The maximum slope percentage change below which a trend is considered flat.
- **Regime Ribbon Compression Threshold**: The maximum standard deviation between EMA 9, 21, and 50 below which they are considered compressed.
