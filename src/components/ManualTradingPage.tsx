/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from "react";
import { apiFetch } from "../utils/api.ts";
import { motion, AnimatePresence } from "motion/react";
import {
  TrendingUp,
  TrendingDown,
  Activity,
  DollarSign,
  AlertTriangle,
  XCircle,
  CheckCircle2,
  Lock,
  Percent,
  Sliders,
  Scale,
  Target,
  ShieldAlert,
  Info,
  Calculator,
} from "lucide-react";
import { Trade, TradeDirection, StrategyConfig } from "../types.js";
import { safeFormatTime, safeFormatNumber } from "../utils/format";

interface ManualTradingPageProps {
  status: {
    is_trading_active: boolean;
    current_price: number;
    current_regime: string;
    regime_confidence: number;
    critical_event_active: boolean;
    critical_event_keyword: string | null;
    protection_remaining_seconds: number | null;
    active_trade: Trade | null;
    account_balance_usdt: number;
  };
  config?: StrategyConfig | null;
  onRefresh: () => void;
}

export default function ManualTradingPage({ status, config, onRefresh }: ManualTradingPageProps) {
  const currentPrice = status.current_price;
  const balance = status.account_balance_usdt;
  const activeTrade = status.active_trade;

  // Left Column Tab selection
  const [leftSubTab, setLeftSubTab] = useState<"trade" | "calculator">("trade");

  // Candles data and Live ATR calculation state
  const [candles, setCandles] = useState<any[]>([]);
  const [liveAtr, setLiveAtr] = useState<number | null>(null);

  useEffect(() => {
    const fetchCandles = async () => {
      try {
        const res = await apiFetch("/api/market/candles");
        if (res.ok) {
          const data = await res.json();
          setCandles(data);
          if (Array.isArray(data) && data.length > 0) {
            const calculated = calculateATR(data, 14);
            setLiveAtr(calculated);
          }
        }
      } catch (e) {
        console.warn("Failed to fetch candles for ATR calculation", e);
      }
    };
    fetchCandles();
    const interval = setInterval(fetchCandles, 15000);
    return () => clearInterval(interval);
  }, []);

  function calculateATR(candlesList: any[], period = 14): number {
    if (!Array.isArray(candlesList) || candlesList.length < period + 1) return 150;
    const tr: number[] = [];
    for (let i = 1; i < candlesList.length; i++) {
      const high = Number(candlesList[i].high);
      const low = Number(candlesList[i].low);
      const prevClose = Number(candlesList[i - 1].close);
      const h_l = high - low;
      const h_pc = Math.abs(high - prevClose);
      const l_pc = Math.abs(low - prevClose);
      tr.push(Math.max(h_l, h_pc, l_pc));
    }
    let sum = 0;
    for (let i = 0; i < period; i++) {
      sum += tr[i];
    }
    const atr: number[] = [];
    atr[period - 1] = sum / period;
    for (let i = period; i < tr.length; i++) {
      atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;
    }
    const finalAtr = atr[atr.length - 1];
    return typeof finalAtr === "number" && !isNaN(finalAtr) ? finalAtr : 150;
  }

  // Calculator State
  const [calcRewardRatio, setCalcRewardRatio] = useState<string>("3.0");
  const [calcQuantity, setCalcQuantity] = useState<string>("0.01");
  const [calcPrice, setCalcPrice] = useState<string>("");
  const [calcDirection, setCalcDirection] = useState<"LONG" | "SHORT">("LONG");
  const [calcAtrSource, setCalcAtrSource] = useState<"auto" | "manual">("auto");
  const [calcAtrOverride, setCalcAtrOverride] = useState<string>("");
  const [calcSlMultiplier, setCalcSlMultiplier] = useState<string>(
    config?.risk_management?.stop_loss_atr_multiplier !== undefined
      ? config.risk_management.stop_loss_atr_multiplier.toString()
      : "1.8"
  );
  const [calcUseFees, setCalcUseFees] = useState<boolean>(true);

  // Initialize calcPrice and sync fields from config
  useEffect(() => {
    if (currentPrice && !calcPrice) {
      setCalcPrice(currentPrice.toString());
    }
  }, [currentPrice]);

  useEffect(() => {
    if (config?.risk_management?.stop_loss_atr_multiplier !== undefined) {
      setCalcSlMultiplier(config.risk_management.stop_loss_atr_multiplier.toString());
    }
  }, [config?.risk_management?.stop_loss_atr_multiplier]);

  // Form State
  const [direction, setDirection] = useState<"LONG" | "SHORT">("LONG");
  const [leverage, setLeverage] = useState<number>(config?.risk_management?.leverage || 20);
  const [quantityStr, setQuantityStr] = useState<string>(
    config?.risk_management?.default_quantity_btc !== undefined 
      ? config.risk_management.default_quantity_btc.toString() 
      : "0.001"
  );

  // Update leverage and default quantity when config loads or changes
  useEffect(() => {
    if (config?.risk_management) {
      if (config.risk_management.leverage !== undefined) {
        setLeverage(config.risk_management.leverage);
      }
      if (config.risk_management.default_quantity_btc !== undefined) {
        setQuantityStr(config.risk_management.default_quantity_btc.toString());
      }
    }
  }, [config?.risk_management?.default_quantity_btc, config?.risk_management?.leverage]);

  // Stop Loss State
  const [useSl, setUseSl] = useState<boolean>(true);
  const [slType, setSlType] = useState<"price" | "offset">("offset");
  const [slPriceStr, setSlPriceStr] = useState<string>("");
  const [slOffsetStr, setSlOffsetStr] = useState<string>("500");

  // Take Profit State
  const [useTp, setUseTp] = useState<boolean>(true);
  const [tpType, setTpType] = useState<"price" | "offset">("offset");
  const [tpPriceStr, setTpPriceStr] = useState<string>("");
  const [tpOffsetStr, setTpOffsetStr] = useState<string>("1000");

  // General Status State
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Initialize prices when currentPrice changes (only if fields are empty)
  useEffect(() => {
    if (currentPrice) {
      if (!slPriceStr) {
        setSlPriceStr(
          (direction === "LONG" ? currentPrice - 500 : currentPrice + 500).toFixed(2)
        );
      }
      if (!tpPriceStr) {
        setTpPriceStr(
          (direction === "LONG" ? currentPrice + 1000 : currentPrice - 1000).toFixed(2)
        );
      }
    }
  }, [currentPrice, direction]);

  // Handle preset quantities based on balance percentage
  const handleQuantityPct = (pct: number) => {
    if (!currentPrice || !balance) return;
    // Max position value = balance * leverage
    const maxPositionValue = balance * leverage;
    const targetPositionValue = maxPositionValue * (pct / 100);
    const qtyBtc = targetPositionValue / currentPrice;
    setQuantityStr(qtyBtc.toFixed(4));
  };

  // Calculations
  const quantity = parseFloat(quantityStr) || 0;
  const positionValue = quantity * currentPrice;
  const marginRequired = positionValue / leverage;
  
  const isPaper = !!config?.general?.is_paper_trading;
  const simulateFees = config?.risk_management?.simulate_paper_fees !== false;
  
  const execType = config?.risk_management?.default_order_execution || "TAKER";
  let baseRate = execType === "MAKER" ? 0.0002 : 0.0005;
  if (isPaper && !simulateFees) {
    baseRate = 0;
  }

  // Base Entry Fee (Before GST)
  const baseEntryFee = positionValue * baseRate;
  
  // Entry Fee with 18% GST (if enabled)
  const entryFeeGstMultiplier = (config?.risk_management?.delta_india_gst_enabled !== false && baseRate > 0) ? 1.18 : 1.0;
  const entryFee = baseEntryFee * entryFeeGstMultiplier;

  // Projected Exit Fee (without scalper offer vs with scalper offer)
  const exitFeeNormal = positionValue * baseRate * entryFeeGstMultiplier;
  const scalperOfferActive = config?.risk_management?.delta_scalper_offer_enabled !== false;
  const exitFeeWithScalper = scalperOfferActive ? 0 : exitFeeNormal;

  // Stop Loss computation
  let computedSlPrice = 0;
  if (useSl) {
    if (slType === "offset") {
      const offset = parseFloat(slOffsetStr) || 0;
      computedSlPrice = direction === "LONG" ? currentPrice - offset : currentPrice + offset;
    } else {
      computedSlPrice = parseFloat(slPriceStr) || 0;
    }
  }

  // Take Profit computation
  let computedTpPrice = 0;
  if (useTp) {
    if (tpType === "offset") {
      const offset = parseFloat(tpOffsetStr) || 0;
      computedTpPrice = direction === "LONG" ? currentPrice + offset : currentPrice - offset;
    } else {
      computedTpPrice = parseFloat(tpPriceStr) || 0;
    }
  }

  // Sl Risk & Tp Reward
  const slPriceDistance = useSl ? Math.abs(currentPrice - computedSlPrice) : 0;
  const tpPriceDistance = useTp ? Math.abs(currentPrice - computedTpPrice) : 0;

  const slPct = useSl && currentPrice ? (slPriceDistance / currentPrice) * 100 : 0;
  const tpPct = useTp && currentPrice ? (tpPriceDistance / currentPrice) * 100 : 0;

  const slRiskUsdt = useSl ? slPriceDistance * quantity : 0;
  const tpRewardUsdt = useTp ? tpPriceDistance * quantity : 0;

  const riskOfBalancePct = balance ? (slRiskUsdt / balance) * 100 : 0;
  const riskRewardRatio = slRiskUsdt > 0 ? (tpRewardUsdt / slRiskUsdt).toFixed(2) : "N/A";

  // Form submission
  const handleSubmitOrder = async (e: React.FormEvent) => {
    e.preventDefault();
    if (activeTrade) {
      setErrorMsg("An active position already exists. You must close the current trade first.");
      return;
    }
    if (quantity <= 0) {
      setErrorMsg("Please enter a valid positive quantity.");
      return;
    }
    if (marginRequired > balance) {
      setErrorMsg("Insufficient balance for this order at selected leverage.");
      return;
    }

    setIsSubmitting(true);
    setErrorMsg(null);
    setSuccessMsg(null);

    try {
      const payload = {
        direction,
        quantity_btc: quantity,
        leverage,
        stop_loss_price: useSl ? computedSlPrice : null,
        take_profit_price: useTp ? computedTpPrice : null,
      };

      const response = await apiFetch("/api/trading/manual-entry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await response.json();

      if (response.ok && data.success) {
        setSuccessMsg(data.message || "Manual position opened successfully!");
        onRefresh();
      } else {
        setErrorMsg(data.message || "Failed to place manual order.");
      }
    } catch (err) {
      setErrorMsg("Network error connecting to trading backend.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleForceExit = async () => {
    if (!activeTrade) return;
    if (!confirm("Are you sure you want to execute an emergency market close for this position?")) return;

    try {
      const res = await apiFetch("/api/trading/force-exit", { method: "POST" });
      const data = await res.json();
      if (res.ok && data.executed) {
        setSuccessMsg("Position closed at market price successfully.");
        onRefresh();
      } else {
        setErrorMsg(data.message || "No active trade to exit.");
      }
    } catch (e) {
      setErrorMsg("Failed to send exit command to server.");
    }
  };

  // Calculator Computations
  const cPrice = parseFloat(calcPrice) || currentPrice || 63000;
  const cQty = parseFloat(calcQuantity) || 0.01;
  const cAtr = calcAtrSource === "manual" && calcAtrOverride ? parseFloat(calcAtrOverride) || 26.86 : (liveAtr || 26.86);
  const cSlMult = parseFloat(calcSlMultiplier) || 1.8;
  const cRewardRatio = parseFloat(calcRewardRatio) || 3.0;

  // Stop loss calculations (reproducing exact trading engine logic)
  const cRawSlDistance = cAtr * cSlMult;
  const cUsdFloor = config?.risk_management?.min_stop_loss_distance_usd !== undefined ? config.risk_management.min_stop_loss_distance_usd : 80;
  const cPctFloorVal = config?.risk_management?.min_stop_loss_distance_pct !== undefined ? config.risk_management.min_stop_loss_distance_pct : 0.12;
  const cMinSlDistance = Math.max(cUsdFloor, cPrice * (cPctFloorVal / 100));
  const cFinalSlDistance = Math.max(cRawSlDistance, cMinSlDistance);

  // Stop Loss Price
  const cStopLossPrice = calcDirection === "LONG" ? cPrice - cFinalSlDistance : cPrice + cFinalSlDistance;

  // Fee calculation matching exact server fee calculation
  const cNotionalValue = cPrice * cQty;
  const cExecType = config?.risk_management?.default_order_execution || "TAKER";
  let cBaseRate = cExecType === "MAKER" ? 0.0002 : 0.0005;
  if (isPaper && !simulateFees) {
    cBaseRate = 0;
  }
  const cEntryFeeGstMultiplier = (config?.risk_management?.delta_india_gst_enabled !== false && cBaseRate > 0) ? 1.18 : 1.0;
  const cEntryFee = cNotionalValue * cBaseRate * cEntryFeeGstMultiplier;
  const cExitFeeNormal = cNotionalValue * cBaseRate * cEntryFeeGstMultiplier;
  const cScalperOfferActive = config?.risk_management?.delta_scalper_offer_enabled !== false;
  const cExitFee = cScalperOfferActive ? 0 : cExitFeeNormal;
  const cTotalFees = cEntryFee + cExitFee;

  // Take Profit Distance calculated based on Reward Ratio (R:R)
  const cTakeProfitDistance = cFinalSlDistance * cRewardRatio;

  // Take Profit Price
  const cTakeProfitPrice = calcDirection === "LONG" ? cPrice + cTakeProfitDistance : cPrice - cTakeProfitDistance;

  // Gross profit
  const cRequiredGrossProfit = cTakeProfitDistance * cQty;

  // Expected Net Profit calculated automatically
  const cExpectedProfit = calcUseFees ? (cRequiredGrossProfit - cTotalFees) : cRequiredGrossProfit;

  // Required reward ratio matches selected reward ratio
  const cRequiredRewardRatio = cRewardRatio;

  // Gross Loss and Net Loss at Stop Loss
  const cGrossLoss = cFinalSlDistance * cQty;
  const cNetLoss = cGrossLoss + cTotalFees;

  // Copy calculated values to manual order entry form
  const handleApplyCalcToForm = () => {
    setDirection(calcDirection);
    setQuantityStr(cQty.toString());
    setUseSl(true);
    setSlType("price");
    setSlPriceStr(cStopLossPrice.toFixed(2));
    setUseTp(true);
    setTpType("price");
    setTpPriceStr(cTakeProfitPrice.toFixed(2));
    setLeftSubTab("trade");
    setSuccessMsg(`Applied calculator settings! Quantity: ${cQty} BTC, SL: ${cStopLossPrice.toFixed(2)}, TP: ${cTakeProfitPrice.toFixed(2)}.`);
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-8" id="manual-trading-panel">
      
      {/* LEFT COLUMN: Order Entry Panel (lg:col-span-8) */}
      <div className="lg:col-span-8 space-y-6">
        
        {/* SUB-TABS SELECTOR */}
        <div className="flex items-center gap-4 border-b border-slate-200 pb-2">
          <button
            type="button"
            onClick={() => setLeftSubTab("trade")}
            className={`pb-2.5 text-xs font-bold uppercase tracking-wider transition-all border-b-2 cursor-pointer ${
              leftSubTab === "trade"
                ? "border-indigo-600 text-indigo-600"
                : "border-transparent text-slate-400 hover:text-slate-600"
            }`}
          >
            Execute Trades
          </button>
          <button
            type="button"
            onClick={() => setLeftSubTab("calculator")}
            className={`pb-2.5 text-xs font-bold uppercase tracking-wider transition-all border-b-2 cursor-pointer ${
              leftSubTab === "calculator"
                ? "border-indigo-600 text-indigo-600"
                : "border-transparent text-slate-400 hover:text-slate-600"
            }`}
            id="btn-calculator-subtab"
          >
            Risk-Reward & ATR Calculator
          </button>
        </div>

        {leftSubTab === "trade" ? (
          <>
            {/* Dynamic Warning if Automated Trading is Active */}
            {status.is_trading_active && (
              <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex items-start gap-3">
                <AlertTriangle className="w-5 h-5 text-amber-600 mt-0.5 flex-shrink-0 animate-pulse" />
                <div className="text-xs text-amber-800">
                  <span className="font-bold">Automated Agent Scalper is currently ACTIVE.</span> Placing manual orders while the bot is active may result in overlapping margin usage or immediate automated exit triggers if system thresholds are violated. Consider turning off automated trading in the Strategy configuration or proceed with caution.
                </div>
              </div>
            )}

            {/* ORDER BOX CARD */}
            <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden">
              <div className="bg-slate-900 px-6 py-4 flex items-center justify-between text-white">
                <div className="flex items-center gap-2">
                  <Activity className="w-4 h-4 text-indigo-400" />
                  <h2 className="font-sans font-bold text-sm tracking-tight">EXECUTE MANUAL FUTURES TRADE</h2>
                </div>
                <div className="flex items-center gap-1.5 font-mono text-xs bg-indigo-950/80 px-2.5 py-1 rounded-lg border border-indigo-900/60">
                  <span className="text-slate-400">INDEX:</span>
                  <span className="text-indigo-400 font-bold">BTCUSD-FUTURES</span>
                </div>
              </div>

              <form onSubmit={handleSubmitOrder} className="p-6 space-y-6">
                
                {/* 1. DIRECTION SELECTOR (LONG vs SHORT) */}
                <div className="space-y-2">
                  <label className="text-[10px] font-mono font-bold text-slate-400 uppercase tracking-widest">Trade Direction</label>
                  <div className="grid grid-cols-2 gap-3">
                    <button
                      type="button"
                      onClick={() => setDirection("LONG")}
                      className={`py-3.5 px-5 rounded-xl border flex items-center justify-center gap-2.5 font-sans font-bold text-xs transition-all cursor-pointer ${
                        direction === "LONG"
                          ? "bg-emerald-500 border-emerald-500 text-white shadow-md shadow-emerald-500/10"
                          : "bg-slate-50 border-slate-200 text-slate-500 hover:bg-slate-100"
                      }`}
                      id="btn-manual-long"
                    >
                      <TrendingUp className="w-4 h-4" />
                      BUY / LONG FUTURES
                    </button>
                    <button
                      type="button"
                      onClick={() => setDirection("SHORT")}
                      className={`py-3.5 px-5 rounded-xl border flex items-center justify-center gap-2.5 font-sans font-bold text-xs transition-all cursor-pointer ${
                        direction === "SHORT"
                          ? "bg-rose-500 border-rose-500 text-white shadow-md shadow-rose-500/10"
                          : "bg-slate-50 border-slate-200 text-slate-500 hover:bg-slate-100"
                      }`}
                      id="btn-manual-short"
                    >
                      <TrendingDown className="w-4 h-4" />
                      SELL / SHORT FUTURES
                    </button>
                  </div>
                </div>

                {/* 2. LEVERAGE CONFIGURATION */}
                <div className="space-y-3 bg-slate-50 border border-slate-200/50 p-4 rounded-xl">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5 text-[10px] font-mono font-bold text-slate-400 uppercase tracking-widest">
                      <Scale className="w-3.5 h-3.5 text-indigo-500" />
                      <span>Adjust Position Leverage</span>
                    </div>
                    <span className="font-mono font-bold text-indigo-600 text-sm bg-indigo-50 px-2 py-0.5 rounded-md border border-indigo-100">{leverage}x</span>
                  </div>
                  <input
                    type="range"
                    min="1"
                    max="125"
                    value={leverage}
                    onChange={(e) => setLeverage(parseInt(e.target.value, 10))}
                    className="w-full h-1.5 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-indigo-600"
                  />
                  <div className="flex justify-between items-center text-[10px] text-slate-400 font-mono pt-1">
                    <span>1x (Unleveraged)</span>
                    <div className="flex gap-1.5">
                      {[5, 10, 20, 50, 100].map((val) => (
                        <button
                          key={val}
                          type="button"
                          onClick={() => setLeverage(val)}
                          className={`px-2 py-0.5 border rounded cursor-pointer transition-colors ${
                            leverage === val ? "bg-indigo-600 border-indigo-600 text-white font-bold" : "bg-white border-slate-200 hover:bg-slate-100 hover:text-slate-700"
                          }`}
                        >
                          {val}x
                        </button>
                      ))}
                    </div>
                    <span>125x (Max)</span>
                  </div>
                </div>

                {/* 3. QUANTITY BTC INPUT */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                  <div className="space-y-2">
                    <label className="text-[10px] font-mono font-bold text-slate-400 uppercase tracking-widest flex items-center gap-1">
                      <Percent className="w-3.5 h-3.5 text-slate-400" />
                      <span>Order Quantity (BTC)</span>
                    </label>
                    <div className="relative">
                      <input
                        type="number"
                        step="0.001"
                        min="0.001"
                        required
                        value={quantityStr}
                        onChange={(e) => setQuantityStr(e.target.value)}
                        className="w-full bg-slate-50 border border-slate-200 rounded-xl p-3 pr-14 text-sm font-mono text-slate-800 outline-none focus:ring-1 focus:ring-indigo-400 focus:border-indigo-400"
                        placeholder="0.1"
                      />
                      <div className="absolute right-3.5 top-3.5 text-xs font-mono font-bold text-slate-400 select-none">BTC</div>
                    </div>
                  </div>

                  {/* Dynamic Percentage of Balance presets */}
                  <div className="space-y-2 flex flex-col justify-end">
                    <label className="text-[10px] font-mono text-slate-400 uppercase tracking-widest">Use Margin Preset</label>
                    <div className="grid grid-cols-4 gap-2">
                      {[10, 25, 50, 100].map((pct) => (
                        <button
                          key={pct}
                          type="button"
                          onClick={() => handleQuantityPct(pct)}
                          className="py-2.5 text-center border border-slate-200 hover:bg-slate-50 rounded-lg text-xs font-mono font-semibold text-slate-600 transition-colors cursor-pointer"
                        >
                          {pct}%
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                {/* 4. RISK CONTROLS: STOP LOSS & TAKE PROFIT */}
                <div className="border-t border-slate-100 pt-5 space-y-4">
                  <h3 className="text-xs font-bold text-slate-700 uppercase tracking-wider font-sans flex items-center gap-1.5">
                    <Sliders className="w-4 h-4 text-indigo-500" />
                    Stop Loss & Take Profit Settings
                  </h3>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    
                    {/* STOP LOSS BOX */}
                    <div className="bg-slate-50 border border-slate-200/50 rounded-xl p-4 space-y-3">
                      <div className="flex items-center justify-between border-b border-slate-200/60 pb-2">
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={useSl}
                            onChange={(e) => setUseSl(e.target.checked)}
                            className="rounded border-slate-300 text-rose-500 focus:ring-0"
                          />
                          <span className="text-xs font-bold text-slate-700 uppercase tracking-wider">Stop Loss</span>
                        </label>
                        <span className="text-[10px] font-mono text-rose-500 font-bold uppercase">Risk Protection</span>
                      </div>

                      {useSl && (
                        <div className="space-y-3">
                          <div className="flex bg-white border border-slate-200 rounded-lg p-1 text-xs">
                            <button
                              type="button"
                              onClick={() => setSlType("offset")}
                              className={`flex-1 py-1 text-center rounded transition-colors cursor-pointer ${
                                slType === "offset" ? "bg-rose-50 text-rose-600 font-bold" : "text-slate-400"
                              }`}
                            >
                              Offset ($)
                            </button>
                            <button
                              type="button"
                              onClick={() => setSlType("price")}
                              className={`flex-1 py-1 text-center rounded transition-colors cursor-pointer ${
                                slType === "price" ? "bg-rose-50 text-rose-600 font-bold" : "text-slate-400"
                              }`}
                            >
                              Trigger Price
                            </button>
                          </div>

                          {slType === "offset" ? (
                            <div className="relative">
                              <input
                                type="number"
                                value={slOffsetStr}
                                onChange={(e) => setSlOffsetStr(e.target.value)}
                                className="w-full bg-white border border-slate-200 rounded-lg p-2 text-xs font-mono outline-none focus:ring-1 focus:ring-rose-400"
                                placeholder="500"
                              />
                              <div className="absolute right-3 top-2.5 text-[10px] font-mono text-slate-400 uppercase">USDT Offset</div>
                            </div>
                          ) : (
                            <div className="relative">
                              <input
                                type="number"
                                value={slPriceStr}
                                onChange={(e) => setSlPriceStr(e.target.value)}
                                className="w-full bg-white border border-slate-200 rounded-lg p-2 text-xs font-mono outline-none focus:ring-1 focus:ring-rose-400"
                                placeholder="Price in USDT"
                              />
                              <div className="absolute right-3 top-2.5 text-[10px] font-mono text-slate-400 uppercase">USDT Target</div>
                            </div>
                          )}

                          <div className="text-[10.5px] font-mono text-rose-600 flex justify-between">
                            <span>Trigger: ${safeFormatNumber(computedSlPrice)}</span>
                            <span>Distance: {slPct.toFixed(2)}%</span>
                          </div>
                        </div>
                      )}
                    </div>

                    {/* TAKE PROFIT BOX */}
                    <div className="bg-slate-50 border border-slate-200/50 rounded-xl p-4 space-y-3">
                      <div className="flex items-center justify-between border-b border-slate-200/60 pb-2">
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={useTp}
                            onChange={(e) => setUseTp(e.target.checked)}
                            className="rounded border-slate-300 text-emerald-500 focus:ring-0"
                          />
                          <span className="text-xs font-bold text-slate-700 uppercase tracking-wider">Take Profit</span>
                        </label>
                        <span className="text-[10px] font-mono text-emerald-500 font-bold uppercase">Target Reward</span>
                      </div>

                      {useTp && (
                        <div className="space-y-3">
                          <div className="flex bg-white border border-slate-200 rounded-lg p-1 text-xs">
                            <button
                              type="button"
                              onClick={() => setTpType("offset")}
                              className={`flex-1 py-1 text-center rounded transition-colors cursor-pointer ${
                                tpType === "offset" ? "bg-emerald-50 text-emerald-600 font-bold" : "text-slate-400"
                              }`}
                            >
                              Offset ($)
                            </button>
                            <button
                              type="button"
                              onClick={() => setTpType("price")}
                              className={`flex-1 py-1 text-center rounded transition-colors cursor-pointer ${
                                tpType === "price" ? "bg-emerald-50 text-emerald-600 font-bold" : "text-slate-400"
                              }`}
                            >
                              Trigger Price
                            </button>
                          </div>

                          {tpType === "offset" ? (
                            <div className="relative">
                              <input
                                type="number"
                                value={tpOffsetStr}
                                onChange={(e) => setTpOffsetStr(e.target.value)}
                                className="w-full bg-white border border-slate-200 rounded-lg p-2 text-xs font-mono outline-none focus:ring-1 focus:ring-emerald-400"
                                placeholder="1000"
                              />
                              <div className="absolute right-3 top-2.5 text-[10px] font-mono text-slate-400 uppercase">USDT Offset</div>
                            </div>
                          ) : (
                            <div className="relative">
                              <input
                                type="number"
                                value={tpPriceStr}
                                onChange={(e) => setTpPriceStr(e.target.value)}
                                className="w-full bg-white border border-slate-200 rounded-lg p-2 text-xs font-mono outline-none focus:ring-1 focus:ring-emerald-400"
                                placeholder="Price in USDT"
                              />
                              <div className="absolute right-3 top-2.5 text-[10px] font-mono text-slate-400 uppercase">USDT Target</div>
                            </div>
                          )}

                          <div className="text-[10.5px] font-mono text-emerald-600 flex justify-between">
                            <span>Trigger: ${safeFormatNumber(computedTpPrice)}</span>
                            <span>Distance: {tpPct.toFixed(2)}%</span>
                          </div>
                        </div>
                      )}
                    </div>

                  </div>
                </div>

                {/* ORDER SUBMISSION FEEDBACK MESSAGES */}
                <AnimatePresence>
                  {errorMsg && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: "auto" }}
                      exit={{ opacity: 0, height: 0 }}
                      className="bg-rose-50 border border-rose-100 rounded-xl p-3 flex items-start gap-2 text-rose-700 text-xs font-sans"
                    >
                      <XCircle className="w-4 h-4 text-rose-500 mt-0.5 flex-shrink-0" />
                      <div>
                        <span className="font-bold">Execution Denied:</span> {errorMsg}
                      </div>
                    </motion.div>
                  )}

                  {successMsg && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: "auto" }}
                      exit={{ opacity: 0, height: 0 }}
                      className="bg-emerald-50 border border-emerald-100 rounded-xl p-3 flex items-start gap-2 text-emerald-800 text-xs font-sans"
                    >
                      <CheckCircle2 className="w-4 h-4 text-emerald-600 mt-0.5 flex-shrink-0" />
                      <div>
                        <span className="font-bold">Success:</span> {successMsg}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>

                {/* SUBMIT BUTTON */}
                <div className="border-t border-slate-100 pt-5">
                  <button
                    type="submit"
                    disabled={isSubmitting || !!activeTrade}
                    className={`w-full py-3.5 rounded-xl font-sans font-bold text-sm text-center flex items-center justify-center gap-2 transition-all shadow-md cursor-pointer ${
                      activeTrade
                        ? "bg-slate-100 border border-slate-200 text-slate-400 cursor-not-allowed shadow-none"
                        : direction === "LONG"
                        ? "bg-emerald-600 hover:bg-emerald-500 text-white shadow-emerald-600/10"
                        : "bg-rose-600 hover:bg-rose-500 text-white shadow-rose-600/10"
                    }`}
                    id="btn-submit-manual-order"
                  >
                    {isSubmitting ? (
                      <span>Transmitting Order...</span>
                    ) : activeTrade ? (
                      <span className="flex items-center gap-1">
                        <Lock className="w-4 h-4" /> Position Locked (Exit Active Trade First)
                      </span>
                    ) : (
                      <span>
                        EXECUTE {direction === "LONG" ? "BUY / LONG" : "SELL / SHORT"} MARKET ORDER
                      </span>
                    )}
                  </button>
                </div>

              </form>
            </div>
          </>
        ) : (
          <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden" id="risk-reward-calculator-card">
            <div className="bg-slate-900 px-6 py-4 flex items-center justify-between text-white">
              <div className="flex items-center gap-2">
                <Calculator className="w-4 h-4 text-indigo-400" />
                <h2 className="font-sans font-bold text-sm tracking-tight">RISK-REWARD & ATR CALCULATOR</h2>
              </div>
              <div className="flex items-center gap-1.5 font-mono text-xs bg-indigo-950/80 px-2.5 py-1 rounded-lg border border-indigo-900/60">
                <span className="text-slate-400">MODE:</span>
                <span className="text-indigo-400 font-bold">FEE-ADJUSTED NET TARGETS</span>
              </div>
            </div>

            <div className="p-6 space-y-6">
              
              {/* DIRECTION SELECTOR (LONG vs SHORT) */}
              <div className="space-y-2">
                <label className="text-[10px] font-mono font-bold text-slate-400 uppercase tracking-widest">Target Direction</label>
                <div className="grid grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={() => setCalcDirection("LONG")}
                    className={`py-3 px-5 rounded-xl border flex items-center justify-center gap-2 font-sans font-bold text-xs transition-all cursor-pointer ${
                      calcDirection === "LONG"
                        ? "bg-emerald-500 border-emerald-500 text-white shadow-md shadow-emerald-500/10"
                        : "bg-slate-50 border-slate-200 text-slate-500 hover:bg-slate-100"
                    }`}
                  >
                    <TrendingUp className="w-4 h-4" />
                    LONG (BUY)
                  </button>
                  <button
                    type="button"
                    onClick={() => setCalcDirection("SHORT")}
                    className={`py-3 px-5 rounded-xl border flex items-center justify-center gap-2 font-sans font-bold text-xs transition-all cursor-pointer ${
                      calcDirection === "SHORT"
                        ? "bg-rose-500 border-rose-500 text-white shadow-md shadow-rose-500/10"
                        : "bg-slate-50 border-slate-200 text-slate-500 hover:bg-slate-100"
                    }`}
                  >
                    <TrendingDown className="w-4 h-4" />
                    SHORT (SELL)
                  </button>
                </div>
              </div>

              {/* Input Parameters */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                
                {/* Target Reward Ratio Input */}
                <div className="space-y-2">
                  <label className="text-[10px] font-mono font-bold text-slate-400 uppercase tracking-widest flex items-center gap-1">
                    <Target className="w-3.5 h-3.5 text-slate-400" />
                    <span>Target Reward Ratio (R:R)</span>
                  </label>
                  <div className="relative">
                    <input
                      type="number"
                      step="0.1"
                      min="0.1"
                      required
                      value={calcRewardRatio}
                      onChange={(e) => setCalcRewardRatio(e.target.value)}
                      className="w-full bg-slate-50 border border-slate-200 rounded-xl p-3 pr-14 text-sm font-mono text-slate-800 outline-none focus:ring-1 focus:ring-indigo-400"
                      placeholder="3.0"
                    />
                    <div className="absolute right-3.5 top-3.5 text-xs font-mono font-bold text-slate-400 select-none">R:R</div>
                  </div>
                </div>

                {/* Position Quantity BTC Input */}
                <div className="space-y-2">
                  <label className="text-[10px] font-mono font-bold text-slate-400 uppercase tracking-widest flex items-center gap-1">
                    <Percent className="w-3.5 h-3.5 text-slate-400" />
                    <span>Order Quantity (BTC)</span>
                  </label>
                  <div className="relative">
                    <input
                      type="number"
                      step="0.0001"
                      min="0.0001"
                      required
                      value={calcQuantity}
                      onChange={(e) => setCalcQuantity(e.target.value)}
                      className="w-full bg-slate-50 border border-slate-200 rounded-xl p-3 pr-14 text-sm font-mono text-slate-800 outline-none focus:ring-1 focus:ring-indigo-400"
                      placeholder="0.01"
                    />
                    <div className="absolute right-3.5 top-3.5 text-xs font-mono font-bold text-slate-400 select-none">BTC</div>
                  </div>
                </div>

                {/* Entry Price Input */}
                <div className="space-y-2">
                  <label className="text-[10px] font-mono font-bold text-slate-400 uppercase tracking-widest flex items-center gap-1">
                    <Sliders className="w-3.5 h-3.5 text-slate-400" />
                    <span>Entry Price (USDT)</span>
                  </label>
                  <div className="relative">
                    <input
                      type="number"
                      step="0.01"
                      min="1"
                      required
                      value={calcPrice}
                      onChange={(e) => setCalcPrice(e.target.value)}
                      className="w-full bg-slate-50 border border-slate-200 rounded-xl p-3 pr-14 text-sm font-mono text-slate-800 outline-none focus:ring-1 focus:ring-indigo-400"
                      placeholder="63947"
                    />
                    <div className="absolute right-3.5 top-3.5 text-xs font-mono font-bold text-slate-400 select-none">USDT</div>
                  </div>
                </div>

                {/* Stop Loss ATR Multiplier Input */}
                <div className="space-y-2">
                  <label className="text-[10px] font-mono font-bold text-slate-400 uppercase tracking-widest flex items-center gap-1">
                    <Scale className="w-3.5 h-3.5 text-slate-400" />
                    <span>Stop Loss ATR Multiplier</span>
                  </label>
                  <div className="relative">
                    <input
                      type="number"
                      step="0.1"
                      min="0.1"
                      required
                      value={calcSlMultiplier}
                      onChange={(e) => setCalcSlMultiplier(e.target.value)}
                      className="w-full bg-slate-50 border border-slate-200 rounded-xl p-3 pr-14 text-sm font-mono text-slate-800 outline-none focus:ring-1 focus:ring-indigo-400"
                      placeholder="1.8"
                    />
                    <div className="absolute right-3.5 top-3.5 text-xs font-mono font-bold text-slate-400 select-none">Mult</div>
                  </div>
                </div>

              </div>

              {/* Fee and ATR Toggles */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-5 pt-2">
                
                {/* Adjust for Fees Toggle */}
                <div className="bg-slate-50 border border-slate-200/50 rounded-xl p-4 flex items-center justify-between">
                  <div className="space-y-0.5">
                    <span className="text-xs font-bold text-slate-700 block">Deduct & Adjust Exchange Fees</span>
                    <span className="text-[10px] font-mono text-slate-400">Target net profit after paying maker/taker fees</span>
                  </div>
                  <input
                    type="checkbox"
                    checked={calcUseFees}
                    onChange={(e) => setCalcUseFees(e.target.checked)}
                    className="rounded border-slate-300 text-indigo-600 focus:ring-0 w-4 h-4 cursor-pointer"
                  />
                </div>

                {/* ATR Toggle & Manual override inputs */}
                <div className="bg-slate-50 border border-slate-200/50 rounded-xl p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-slate-700">Volatility (ATR) Source</span>
                    <div className="flex bg-white border border-slate-200 rounded-lg p-0.5 text-[10px]">
                      <button
                        type="button"
                        onClick={() => setCalcAtrSource("auto")}
                        className={`px-2 py-0.5 rounded transition-colors cursor-pointer ${
                          calcAtrSource === "auto" ? "bg-indigo-50 text-indigo-600 font-bold" : "text-slate-400"
                        }`}
                      >
                        Auto (Live)
                      </button>
                      <button
                        type="button"
                        onClick={() => setCalcAtrSource("manual")}
                        className={`px-2 py-0.5 rounded transition-colors cursor-pointer ${
                          calcAtrSource === "manual" ? "bg-indigo-50 text-indigo-600 font-bold" : "text-slate-400"
                        }`}
                      >
                        Manual
                      </button>
                    </div>
                  </div>

                  {calcAtrSource === "manual" ? (
                    <div className="relative">
                      <input
                        type="number"
                        step="0.0001"
                        value={calcAtrOverride}
                        onChange={(e) => setCalcAtrOverride(e.target.value)}
                        className="w-full bg-white border border-slate-200 rounded-lg p-1.5 text-xs font-mono outline-none focus:ring-1 focus:ring-indigo-400"
                        placeholder="e.g. 26.8612"
                      />
                      <div className="absolute right-3 top-2 text-[9px] font-mono text-slate-400 uppercase">Custom ATR</div>
                    </div>
                  ) : (
                    <div className="flex justify-between items-center text-xs font-mono text-indigo-600 bg-indigo-50/50 px-2 py-1.5 rounded border border-indigo-100/50">
                      <span>Live 14-period ATR:</span>
                      <span className="font-bold">${liveAtr ? liveAtr.toFixed(4) : "26.8612"}</span>
                    </div>
                  )}
                </div>

              </div>

              {/* CALCULATED OUTPUTS BLOCK */}
              <div className="bg-slate-50 border border-slate-200/60 rounded-2xl p-5 space-y-4">
                <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider font-sans flex items-center gap-1.5">
                  <Target className="w-4 h-4 text-indigo-500" />
                  Calculated Target Output Settings
                </h3>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  
                  {/* Left Column outputs */}
                  <div className="space-y-3.5 text-xs">
                    
                    <div className="flex justify-between text-slate-500">
                      <span>Calculated ATR (14):</span>
                      <span className="font-mono font-bold text-slate-800">${cAtr.toFixed(4)} USDT</span>
                    </div>

                    <div className="flex justify-between text-slate-500">
                      <span>Stop Loss Distance:</span>
                      <span className="font-mono font-bold text-rose-600">
                        ${cFinalSlDistance.toFixed(2)} USDT
                        {cFinalSlDistance === cMinSlDistance && (
                          <span className="text-[10px] text-slate-400 block text-right font-sans font-normal">(Enforced Min Floor)</span>
                        )}
                      </span>
                    </div>

                    <div className="flex justify-between text-slate-500">
                      <span>Take Profit Distance:</span>
                      <span className="font-mono font-bold text-emerald-600">${cTakeProfitDistance.toFixed(2)} USDT</span>
                    </div>

                    <div className="flex justify-between text-slate-500 pt-2 border-t border-slate-200/60">
                      <span className="font-semibold text-slate-700">Calculated Net Profit:</span>
                      <span className="font-mono font-bold text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-100">
                        ${cExpectedProfit.toFixed(2)} USDT
                      </span>
                    </div>

                    <div className="flex justify-between text-slate-500">
                      <span className="font-semibold text-slate-700">Selected Reward Ratio:</span>
                      <span className="font-mono font-bold text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded border border-indigo-100">
                        1 : {cRequiredRewardRatio.toFixed(2)}
                      </span>
                    </div>

                  </div>

                  {/* Right Column outputs */}
                  <div className="space-y-3.5 text-xs">
                    
                    <div className="flex justify-between text-slate-500">
                      <span>Stop Loss Target Price:</span>
                      <span className="font-mono font-bold text-rose-600 bg-rose-50 px-2 py-0.5 rounded border border-rose-100">
                        ${cStopLossPrice.toFixed(2)} USDT
                      </span>
                    </div>

                    <div className="flex justify-between text-slate-500">
                      <span>Take Profit Target Price:</span>
                      <span className="font-mono font-bold text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-100">
                        ${cTakeProfitPrice.toFixed(2)} USDT
                      </span>
                    </div>

                    <div className="bg-white rounded-xl p-3 border border-slate-200/50 space-y-1.5">
                      <div className="flex justify-between text-slate-500 text-[11px]">
                        <span>Entry Fee (estimated):</span>
                        <span className="font-mono text-slate-600">${cEntryFee.toFixed(4)} USDT</span>
                      </div>
                      <div className="flex justify-between text-slate-500 text-[11px]">
                        <span>Exit Fee (estimated):</span>
                        <span className="font-mono text-slate-600">${cExitFee.toFixed(4)} USDT</span>
                      </div>
                      <div className="flex justify-between text-slate-700 text-[11px] font-bold border-t border-slate-100 pt-1">
                        <span>Total Fees (Maker/Taker):</span>
                        <span className="font-mono">${cTotalFees.toFixed(4)} USDT</span>
                      </div>
                    </div>

                  </div>

                </div>

                {/* Net Outcomes Summary Banner */}
                <div className="bg-slate-900 rounded-xl p-4 text-white grid grid-cols-2 gap-4 text-center">
                  <div>
                    <span className="text-[10px] text-slate-400 font-mono uppercase">Estimated Outcome (TP)</span>
                    <p className="font-mono text-lg font-bold text-emerald-400 mt-0.5">
                      +${cExpectedProfit.toFixed(2)} Net
                    </p>
                    <span className="text-[9px] text-slate-400 block">
                      (${cRequiredGrossProfit.toFixed(4)} Gross)
                    </span>
                  </div>
                  <div className="border-l border-slate-800">
                    <span className="text-[10px] text-slate-400 font-mono uppercase">Maximum Loss (SL)</span>
                    <p className="font-mono text-lg font-bold text-rose-400 mt-0.5">
                      -${cNetLoss.toFixed(2)} Net
                    </p>
                    <span className="text-[9px] text-slate-400 block">
                      (${cGrossLoss.toFixed(4)} Gross)
                    </span>
                  </div>
                </div>

              </div>

              {/* ACTION BUTTON */}
              <div className="border-t border-slate-100 pt-5">
                <button
                  type="button"
                  onClick={handleApplyCalcToForm}
                  className="w-full py-3.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl font-sans font-bold text-sm text-center flex items-center justify-center gap-2 transition-all shadow-md shadow-indigo-600/10 cursor-pointer"
                >
                  <CheckCircle2 className="w-4 h-4" />
                  APPLY TO MANUAL ORDER ENTRY FORM
                </button>
              </div>

            </div>
          </div>
        )}

      </div>

      {/* RIGHT COLUMN: Real-time Analysis & Active Position Card (lg:col-span-4) */}
      <div className="lg:col-span-4 space-y-6">

        {/* PRICE METER GRAPHIC CARD */}
        <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm space-y-4">
          <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest font-mono">Real-Time Quote Feed</h3>
          
          <div className="bg-slate-950 text-white rounded-xl p-5 flex flex-col justify-between h-40 border border-slate-800 shadow-inner relative overflow-hidden">
            {/* Background grid lines effect */}
            <div className="absolute inset-0 opacity-10 bg-[linear-gradient(to_right,#80808012_1px,transparent_1px),linear-gradient(to_bottom,#80808012_1px,transparent_1px)] bg-[size:14px_24px]" />
            
            <div className="flex justify-between items-start relative z-10">
              <div>
                <span className="text-[10px] font-mono text-indigo-400 uppercase tracking-wider font-semibold">BTCUSD-FUTURES</span>
                <p className="text-xs text-slate-400 font-sans mt-0.5">Binance Spot Grounded Feed</p>
              </div>
              <span className="bg-emerald-500/15 text-emerald-400 border border-emerald-500/35 text-[9px] font-mono font-bold px-2 py-0.5 rounded uppercase">LIVE</span>
            </div>

            <div className="relative z-10 my-1">
              <span className="font-mono text-3xl font-extrabold tracking-tight">${safeFormatNumber(currentPrice, 2, 2)}</span>
            </div>

            <div className="flex justify-between items-center text-[10px] font-mono text-slate-400 border-t border-slate-800/80 pt-2.5 relative z-10">
              <span className="uppercase flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
                Websocket active
              </span>
              <span>Regime: <span className="text-indigo-400 font-bold">{status.current_regime}</span></span>
            </div>
          </div>
        </div>

        {/* ORDER SUMMARY / MARGIN ESTIMATOR CARD */}
        <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm space-y-4">
          <h3 className="text-xs font-bold text-slate-700 uppercase tracking-wider font-sans">Leveraged Margin Estimator</h3>
          
          <div className="space-y-3.5 text-xs">
            
            <div className="flex justify-between text-slate-500 pb-2.5 border-b border-slate-100">
              <span>Account Equity:</span>
              <span className="font-mono font-bold text-slate-800">${safeFormatNumber(balance, 2, 2)} USDT</span>
            </div>

            <div className="flex justify-between text-slate-500">
              <span>Position Size (BTC):</span>
              <span className="font-mono font-bold text-slate-800">{quantity} BTC</span>
            </div>

            <div className="flex justify-between text-slate-500">
              <span>Notional Value:</span>
              <span className="font-mono font-bold text-slate-800">${safeFormatNumber(positionValue, 2, 2)} USDT</span>
            </div>

            <div className="flex justify-between text-slate-500">
              <span>Initial Margin Required:</span>
              <span className="font-mono font-bold text-indigo-600">${safeFormatNumber(marginRequired, 2, 2)} USDT</span>
            </div>

            <div className="bg-slate-50 rounded-xl p-3 border border-slate-100 space-y-2 mt-2">
              <div className="flex justify-between text-slate-500 text-[11px]">
                <span>Order Execution Type:</span>
                <span className="font-semibold text-slate-700">{execType} ({execType === "MAKER" ? "0.02%" : "0.05%"})</span>
              </div>
              <div className="flex justify-between text-slate-500 text-[11px]">
                <span>Opening Leg Fee (with 18% GST):</span>
                <span className="font-mono text-slate-700">${entryFee.toFixed(4)} USDT</span>
              </div>
              {scalperOfferActive ? (
                <div className="flex justify-between text-emerald-600 text-[11px] font-medium bg-emerald-50/50 px-1.5 py-0.5 rounded">
                  <span>Closing Leg Fee (Scalper Offer &lt;30m):</span>
                  <span className="font-mono font-bold">FREE ($0.00)</span>
                </div>
              ) : (
                <div className="flex justify-between text-slate-500 text-[11px]">
                  <span>Closing Leg Fee (Projected):</span>
                  <span className="font-mono text-slate-700">${exitFeeNormal.toFixed(4)} USDT</span>
                </div>
              )}
              {config?.risk_management?.delta_india_gst_enabled !== false && baseRate > 0 && (
                <div className="text-[10px] text-slate-400 text-right">
                  *Includes 18% GST on Delta India brokerage
                </div>
              )}
            </div>

            <div className="border-t border-slate-100 pt-3.5 space-y-3">
              <div className="flex justify-between text-slate-500">
                <span>Stop Loss Distance:</span>
                <span className="font-mono text-rose-600">
                  {useSl ? `${slPct.toFixed(2)}% (${slType === "offset" ? `-$${slOffsetStr}` : `$${safeFormatNumber(computedSlPrice)}`})` : "None"}
                </span>
              </div>

              <div className="flex justify-between text-slate-500">
                <span>Take Profit Distance:</span>
                <span className="font-mono text-emerald-600">
                  {useTp ? `${tpPct.toFixed(2)}% (${tpType === "offset" ? `+$${tpOffsetStr}` : `$${safeFormatNumber(computedTpPrice)}`})` : "None"}
                </span>
              </div>

              {useSl && (
                <div className="flex justify-between text-slate-500">
                  <span>Balance At Risk:</span>
                  <span className={`font-mono font-bold ${riskOfBalancePct > 5 ? "text-rose-600" : "text-slate-800"}`}>
                    ${slRiskUsdt.toFixed(2)} USDT ({riskOfBalancePct.toFixed(2)}%)
                  </span>
                </div>
              )}

              {useSl && useTp && (
                <div className="flex justify-between text-slate-500 pt-1.5 border-t border-slate-50/50">
                  <span className="flex items-center gap-1 font-semibold text-slate-700">
                    <Target className="w-3.5 h-3.5 text-indigo-500" />
                    Risk-to-Reward (R:R):
                  </span>
                  <span className="font-mono font-bold text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded border border-indigo-100">1 : {riskRewardRatio}</span>
                </div>
              )}
            </div>

          </div>
        </div>

        {/* ACTIVE POSITION MONITORING CARD */}
        <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm space-y-4">
          <h3 className="text-xs font-bold text-slate-700 uppercase tracking-wider font-sans">Active Position Monitor</h3>

          {activeTrade ? (
            <div className="space-y-4">
              <div className="bg-slate-50 border border-slate-200/50 rounded-xl p-4 space-y-3.5">
                <div className="flex justify-between items-center pb-2.5 border-b border-slate-200/50">
                  <div className="flex items-center gap-2">
                    <span className={`px-2 py-0.5 text-[9px] font-mono font-bold rounded ${
                      activeTrade.direction === "LONG" ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700"
                    }`}>
                      {activeTrade.direction}
                    </span>
                    <span className="text-[11px] font-mono text-slate-400">ID: {activeTrade.id.substring(0, 10)}...</span>
                  </div>
                  <span className="text-[11px] font-mono font-bold text-slate-600">{activeTrade.leverage}x leverage</span>
                </div>

                <div className="grid grid-cols-2 gap-y-2 gap-x-4 text-xs">
                  <div>
                    <span className="text-slate-400">Entry Price:</span>
                    <p className="font-mono font-bold text-slate-800">${safeFormatNumber(activeTrade.entry_price)}</p>
                  </div>
                  <div>
                    <span className="text-slate-400">Current Price:</span>
                    <p className="font-mono font-bold text-slate-800">${safeFormatNumber(currentPrice)}</p>
                  </div>
                  <div>
                    <span className="text-slate-400">Quantity:</span>
                    <p className="font-mono font-bold text-slate-800">{activeTrade.quantity_btc} BTC</p>
                  </div>
                  <div>
                    <span className="text-slate-400">Position Value:</span>
                    <p className="font-mono font-bold text-slate-800">${safeFormatNumber(activeTrade.quantity_btc * currentPrice, 2, 2)} USDT</p>
                  </div>
                </div>

                {/* Unrealized P&L Display */}
                <div className="bg-white border border-slate-200 rounded-lg p-3 text-center shadow-inner">
                  <span className="text-[10px] text-slate-400 font-mono uppercase tracking-wider">Unrealized P&L</span>
                  <div className={`font-mono text-xl font-bold mt-1 ${
                    (activeTrade.pnl_usdt || 0) >= 0 ? "text-emerald-600" : "text-rose-600"
                  }`}>
                    {(activeTrade.pnl_usdt || 0) >= 0 ? "+" : ""}${(activeTrade.pnl_usdt || 0).toFixed(2)} USDT
                  </div>
                  <div className={`text-[11px] font-mono mt-0.5 ${
                    (activeTrade.pnl_pct || 0) >= 0 ? "text-emerald-500" : "text-rose-500"
                  }`}>
                    {(activeTrade.pnl_usdt || 0) >= 0 ? "+" : ""}{(activeTrade.pnl_pct || 0).toFixed(4)}%
                  </div>
                </div>

                <div className="text-[11px] font-mono text-slate-400 flex justify-between">
                  <span>Hold duration: {Math.floor((activeTrade.hold_duration_seconds || 0) / 60)}m {Math.floor((activeTrade.hold_duration_seconds || 0) % 60)}s</span>
                  {activeTrade.feature_snapshot && activeTrade.feature_snapshot.stop_loss_price && (
                    <span className="text-rose-500 font-semibold">SL: ${activeTrade.feature_snapshot.stop_loss_price}</span>
                  )}
                </div>
              </div>

              {/* EMERGENCY CLOSE BUTTON */}
              <button
                type="button"
                onClick={handleForceExit}
                className="w-full bg-rose-600 hover:bg-rose-500 text-white py-3 rounded-xl font-sans font-bold text-xs shadow-md shadow-rose-600/15 flex items-center justify-center gap-2 transition-all cursor-pointer"
                id="btn-emergency-close-manual"
              >
                <ShieldAlert className="w-4 h-4 animate-bounce" />
                EMERGENCY MARKET EXIT (CLOSE POSITION)
              </button>
            </div>
          ) : (
            <div className="border border-dashed border-slate-200 rounded-xl py-8 px-4 text-center flex flex-col items-center justify-center space-y-2">
              <Info className="w-5 h-5 text-slate-300" />
              <p className="text-xs text-slate-400 font-sans font-medium">No Active Futures Position</p>
              <p className="text-[10px] text-slate-400 font-sans max-w-[200px]">Configure your parameters on the left and click execute to open a position.</p>
            </div>
          )}
        </div>

      </div>

    </div>
  );
}
