import { Candlestick, MarketRegime, StrategyConfig } from "../../types.js";
import { IndicatorCalculator } from "../indicators.js";
import { OrderFlowStats, OrderBookStats, OpenInterestStats } from "../orderflow.js";

export interface SetupContext {
  candles1m: Candlestick[];
  currentPrice: number;
  currentRegime: MarketRegime;
  orderFlowStats: OrderFlowStats;
  orderBookStats: OrderBookStats;
  openInterestStats: OpenInterestStats;
  indicators: IndicatorCalculator;
  config: StrategyConfig;
}
