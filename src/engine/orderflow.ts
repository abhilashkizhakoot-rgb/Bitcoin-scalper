/**
 * Order Flow Microstructure Analytics
 * Evaluates taker volume imbalances, cumulative volume delta (CVD), order book depth,
 * and passive absorption dynamics.
 */

import { Candlestick } from "../types.js";

export interface OrderFlowStats {
  takerBuyVolume: number;
  takerSellVolume: number;
  takerBuyRatio: number;
  netCVD: number;
  lastUpdateSecs: number;
}

export interface OrderBookStats {
  bidDepthBTC: number;
  askDepthBTC: number;
  imbalanceRatio: number;
  lastUpdateSecs: number;
}

export interface OpenInterestStats {
  currentOI: number;
  prevOI_1m: number;
  prevOI_5m: number;
  oiChange1m: number;
  oiChangePct1m: number;
  oiChange5m: number;
  oiChangePct5m: number;
  lastUpdateSecs: number;
}

export interface AbsorptionResult {
  isAbsorption: boolean;
  type: string;
  description: string;
}

export function detectOrderFlowAbsorption(
  direction: "LONG" | "SHORT",
  candles1m: Candlestick[],
  currentPrice: number,
  orderFlowStats: OrderFlowStats,
  orderBookStats: OrderBookStats
): AbsorptionResult {
  const lastIdx = candles1m.length - 1;
  if (lastIdx < 1) return { isAbsorption: false, type: "", description: "Insufficient candle data" };

  const currentCandle = candles1m[lastIdx];
  const prevCandle = candles1m[lastIdx - 1];

  const candleRange = Math.max(0.001, currentCandle.high - currentCandle.low);
  const candleBody = Math.abs(currentCandle.close - currentCandle.open);
  const lowerWick = Math.min(currentCandle.open, currentCandle.close) - currentCandle.low;
  const upperWick = currentCandle.high - Math.max(currentCandle.open, currentCandle.close);

  const takerBuyRatio = orderFlowStats.takerBuyRatio;
  const obImbalance = orderBookStats.imbalanceRatio;
  const netCVD = orderFlowStats.netCVD;

  if (direction === "LONG") {
    // 1. Seller Exhaustion / Passive Buyer Absorption:
    const hasHeavySellAggression = takerBuyRatio <= 0.46 || obImbalance <= -0.25 || netCVD < 0;
    const priceHoldingSupport = (lowerWick / candleRange >= 0.30) || (currentCandle.close >= prevCandle.low && candleBody <= 0.35 * candleRange);
    const isReboundStarting = currentCandle.close >= currentCandle.open || (lowerWick >= candleBody);

    if (hasHeavySellAggression && priceHoldingSupport && isReboundStarting) {
      return {
        isAbsorption: true,
        type: "Bullish Passive Limit Absorption",
        description: `Bullish Order Flow Absorption: Heavy market selling (Taker Buy ${(takerBuyRatio * 100).toFixed(0)}%, Imbalance ${(obImbalance * 100).toFixed(0)}%) absorbed by passive buyers at $${currentCandle.low.toFixed(2)} (Lower Wick: ${((lowerWick / candleRange) * 100).toFixed(0)}%).`
      };
    }

    // 2. Aggressive Buyer Accumulation:
    const hasAggressiveBuying = takerBuyRatio >= 0.58 && obImbalance >= 0.20;
    if (hasAggressiveBuying && lowerWick >= 0.20 * candleRange) {
      return {
        isAbsorption: true,
        type: "Bullish Aggressive Accumulation",
        description: `Bullish Accumulation Surge: Strong institutional taker flow (${(takerBuyRatio * 100).toFixed(0)}% buys, ${(obImbalance * 100).toFixed(0)}% bid wall) driving early inflection at $${currentPrice.toFixed(2)}.`
      };
    }
  } else {
    // SHORT
    // 1. Buyer Exhaustion / Passive Seller Absorption:
    const hasHeavyBuyAggression = takerBuyRatio >= 0.54 || obImbalance >= 0.25 || netCVD > 0;
    const priceHoldingResistance = (upperWick / candleRange >= 0.30) || (currentCandle.close <= prevCandle.high && candleBody <= 0.35 * candleRange);
    const isReboundStarting = currentCandle.close <= currentCandle.open || (upperWick >= candleBody);

    if (hasHeavyBuyAggression && priceHoldingResistance && isReboundStarting) {
      return {
        isAbsorption: true,
        type: "Bearish Passive Limit Absorption",
        description: `Bearish Order Flow Absorption: Heavy market buying (Taker Buy ${(takerBuyRatio * 100).toFixed(0)}%, Imbalance ${(obImbalance * 100).toFixed(0)}%) absorbed by passive sell limit walls at $${currentCandle.high.toFixed(2)} (Upper Wick: ${((upperWick / candleRange) * 100).toFixed(0)}%).`
      };
    }

    // 2. Aggressive Seller Distribution:
    const hasAggressiveSelling = takerBuyRatio <= 0.42 && obImbalance <= -0.20;
    if (hasAggressiveSelling && upperWick >= 0.20 * candleRange) {
      return {
        isAbsorption: true,
        type: "Bearish Aggressive Distribution",
        description: `Bearish Distribution Surge: Strong institutional taker sell flow (${(takerBuyRatio * 100).toFixed(0)}% buys, ${(obImbalance * 100).toFixed(0)}% ask wall) driving early breakdown at $${currentPrice.toFixed(2)}.`
      };
    }
  }

  return { isAbsorption: false, type: "", description: "No order flow absorption detected" };
}
