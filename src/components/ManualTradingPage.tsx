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

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-8" id="manual-trading-panel">
      
      {/* LEFT COLUMN: Order Entry Panel (lg:col-span-8) */}
      <div className="lg:col-span-8 space-y-6">
        
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
