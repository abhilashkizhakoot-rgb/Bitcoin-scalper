/**
 * Pure Mathematical Technical Indicators & Multi-Timeframe Series Aggregators
 * Encapsulates all algorithmic indicators with bounded in-memory caching.
 */

import { Candlestick } from "../types.js";

export interface VolumeProfileResult {
  poc: number;
  vah: number;
  val: number;
  hvns: number[];
  lvns: number[];
  bins: { price: number; volume: number }[];
}

export interface BollingerBandsResult {
  middle: number;
  upper: number;
  lower: number;
}

export class IndicatorCalculator {
  private emaCache = new Map<string, number[]>();
  private rsiCache = new Map<string, number[]>();
  private atrCache = new Map<string, number[]>();
  private adxCache = new Map<string, number[]>();
  private aggCandlesCache = new Map<string, Candlestick[]>();
  private volumeProfileCache = new Map<string, VolumeProfileResult>();

  public clearCaches() {
    this.emaCache.clear();
    this.rsiCache.clear();
    this.atrCache.clear();
    this.adxCache.clear();
    this.aggCandlesCache.clear();
    this.volumeProfileCache.clear();
  }

  public calculateEMA(data: number[], period: number): number[] {
    if (data.length === 0) return [];
    const key = `${data.length}_${data[data.length - 1]}_${data[0]}_${period}`;
    if (this.emaCache.has(key)) {
      return this.emaCache.get(key)!;
    }
    if (this.emaCache.size > 250) {
      this.emaCache.clear();
    }

    const ema: number[] = [];
    const k = 2 / (period + 1);
    let sum = 0;
    const initialCount = Math.min(period, data.length);
    for (let i = 0; i < initialCount; i++) {
      sum += data[i];
    }
    ema[initialCount - 1] = sum / initialCount;
    for (let i = initialCount; i < data.length; i++) {
      ema[i] = data[i] * k + ema[i - 1] * (1 - k);
    }
    this.emaCache.set(key, ema);
    return ema;
  }

  public calculateSMA(data: number[], period: number): number[] {
    if (data.length === 0) return [];
    const sma: number[] = [];
    for (let i = 0; i < data.length; i++) {
      if (i < period - 1) {
        sma.push(data[i]);
      } else {
        const slice = data.slice(i - period + 1, i + 1);
        const sum = slice.reduce((a, b) => a + b, 0);
        sma.push(sum / period);
      }
    }
    return sma;
  }

  public calculateRSI(data: number[], period = 14): number[] {
    if (data.length === 0) return [];
    const key = `${data.length}_${data[data.length - 1]}_${data[0]}_${period}`;
    if (this.rsiCache.has(key)) {
      return this.rsiCache.get(key)!;
    }
    if (this.rsiCache.size > 250) {
      this.rsiCache.clear();
    }

    const rsi: number[] = [];
    if (data.length <= period) return rsi;

    let avgGain = 0;
    let avgLoss = 0;

    for (let i = 1; i <= period; i++) {
      const change = data[i] - data[i - 1];
      if (change > 0) avgGain += change;
      else avgLoss -= change;
    }

    avgGain /= period;
    avgLoss /= period;
    rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

    for (let i = period + 1; i < data.length; i++) {
      const change = data[i] - data[i - 1];
      const gain = change > 0 ? change : 0;
      const loss = change < 0 ? -change : 0;

      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;

      rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    }

    this.rsiCache.set(key, rsi);
    return rsi;
  }

  public calculateATR(candles: Candlestick[], period = 14): number[] {
    if (candles.length === 0) return [];
    const last = candles[candles.length - 1];
    const first = candles[0];
    const key = `${candles.length}_${last.time}_${last.close}_${first.time}_${period}`;
    if (this.atrCache.has(key)) {
      return this.atrCache.get(key)!;
    }
    if (this.atrCache.size > 250) {
      this.atrCache.clear();
    }

    const atr: number[] = [];
    if (candles.length <= period) return atr;

    const tr: number[] = [candles[0].high - candles[0].low];
    for (let i = 1; i < candles.length; i++) {
      const h_l = candles[i].high - candles[i].low;
      const h_pc = Math.abs(candles[i].high - candles[i - 1].close);
      const l_pc = Math.abs(candles[i].low - candles[i - 1].close);
      tr.push(Math.max(h_l, h_pc, l_pc));
    }

    let sum = 0;
    for (let i = 0; i < period; i++) {
      sum += tr[i];
    }
    atr[period - 1] = sum / period;

    for (let i = period; i < candles.length; i++) {
      atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;
    }

    this.atrCache.set(key, atr);
    return atr;
  }

  public calculateADX(candles: Candlestick[], period = 14): number[] {
    if (candles.length === 0) return [];
    const last = candles[candles.length - 1];
    const first = candles[0];
    const key = `${candles.length}_${last.time}_${last.close}_${first.time}_${period}`;
    if (this.adxCache.has(key)) {
      return this.adxCache.get(key)!;
    }
    if (this.adxCache.size > 250) {
      this.adxCache.clear();
    }

    const adx: number[] = [];
    if (candles.length <= period * 2) {
      return Array(candles.length).fill(25);
    }

    const tr: number[] = [];
    const plusDM: number[] = [];
    const minusDM: number[] = [];

    for (let i = 1; i < candles.length; i++) {
      const highDiff = candles[i].high - candles[i - 1].high;
      const lowDiff = candles[i - 1].low - candles[i].low;

      const h_l = candles[i].high - candles[i].low;
      const h_pc = Math.abs(candles[i].high - candles[i - 1].close);
      const l_pc = Math.abs(candles[i].low - candles[i - 1].close);
      tr.push(Math.max(h_l, h_pc, l_pc));

      if (highDiff > lowDiff && highDiff > 0) {
        plusDM.push(highDiff);
      } else {
        plusDM.push(0);
      }

      if (lowDiff > highDiff && lowDiff > 0) {
        minusDM.push(lowDiff);
      } else {
        minusDM.push(0);
      }
    }

    let smoothedTR = 0;
    let smoothedPlusDM = 0;
    let smoothedMinusDM = 0;

    for (let i = 0; i < period; i++) {
      smoothedTR += tr[i];
      smoothedPlusDM += plusDM[i];
      smoothedMinusDM += minusDM[i];
    }

    const dxList: number[] = [];
    const getDX = (trS: number, pdmS: number, mdmS: number) => {
      if (trS === 0) return 0;
      const plusDI = 100 * (pdmS / trS);
      const minusDI = 100 * (mdmS / trS);
      const diff = Math.abs(plusDI - minusDI);
      const sum = plusDI + minusDI;
      return sum === 0 ? 0 : 100 * (diff / sum);
    };

    dxList.push(getDX(smoothedTR, smoothedPlusDM, smoothedMinusDM));

    for (let i = period; i < tr.length; i++) {
      smoothedTR = smoothedTR - (smoothedTR / period) + tr[i];
      smoothedPlusDM = smoothedPlusDM - (smoothedPlusDM / period) + plusDM[i];
      smoothedMinusDM = smoothedMinusDM - (smoothedMinusDM / period) + minusDM[i];
      dxList.push(getDX(smoothedTR, smoothedPlusDM, smoothedMinusDM));
    }

    let adxSum = 0;
    for (let i = 0; i < period; i++) {
      adxSum += dxList[i];
    }

    for (let i = 0; i < period + period; i++) {
      adx.push(25);
    }

    let smoothedADX = adxSum / period;
    adx.push(smoothedADX);

    for (let i = period; i < dxList.length; i++) {
      smoothedADX = (smoothedADX * (period - 1) + dxList[i]) / period;
      adx.push(smoothedADX);
    }

    while (adx.length < candles.length) {
      adx.unshift(25);
    }

    this.adxCache.set(key, adx);
    return adx;
  }

  public calculateBollingerBands(data: number[], period = 20, multiplier = 2): BollingerBandsResult {
    if (data.length < period) {
      const lastPrice = data[data.length - 1] || 0;
      return { middle: lastPrice, upper: lastPrice, lower: lastPrice };
    }
    const lastElements = data.slice(data.length - period);
    const mean = lastElements.reduce((sum, val) => sum + val, 0) / period;
    const variance = lastElements.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / period;
    const stdDev = Math.sqrt(variance);
    return {
      middle: mean,
      upper: mean + multiplier * stdDev,
      lower: mean - multiplier * stdDev
    };
  }

  public calculateVWAP(candles: Candlestick[], multiplier = 1.5): void {
    if (candles.length === 0) return;
    let cumPV = 0;
    let cumVol = 0;

    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];
      const tp = (c.high + c.low + c.close) / 3;
      cumPV += tp * c.volume;
      cumVol += c.volume;

      const currentVwap = cumVol > 0 ? cumPV / cumVol : tp;
      c.vwap = currentVwap;

      let weightedVarianceSum = 0;
      for (let j = 0; j <= i; j++) {
        const c_j = candles[j];
        const tp_j = (c_j.high + c_j.low + c_j.close) / 3;
        weightedVarianceSum += c_j.volume * Math.pow(tp_j - currentVwap, 2);
      }
      const stdDev = cumVol > 0 ? Math.sqrt(weightedVarianceSum / cumVol) : 0;
      c.vwap_upper = currentVwap + multiplier * stdDev;
      c.vwap_lower = currentVwap - multiplier * stdDev;
    }
  }

  public aggregateCandles(candles1m: Candlestick[], intervalMinutes: number): Candlestick[] {
    if (intervalMinutes <= 1 || candles1m.length === 0) {
      return candles1m;
    }
    const last = candles1m[candles1m.length - 1];
    const key = `${candles1m.length}_${last.time}_${last.close}_${intervalMinutes}`;
    if (this.aggCandlesCache.has(key)) {
      return this.aggCandlesCache.get(key)!;
    }
    if (this.aggCandlesCache.size > 200) {
      this.aggCandlesCache.clear();
    }

    const aggregated: Candlestick[] = [];
    const groups: Record<number, Candlestick[]> = {};
    const keys: number[] = [];

    for (const candle of candles1m) {
      const intervalSec = intervalMinutes * 60;
      const bucketTime = Math.floor(candle.time / intervalSec) * intervalSec;
      if (!groups[bucketTime]) {
        groups[bucketTime] = [];
        keys.push(bucketTime);
      }
      groups[bucketTime].push(candle);
    }

    keys.sort((a, b) => a - b);

    for (const key of keys) {
      const group = groups[key];
      const open = group[0].open;
      const close = group[group.length - 1].close;
      const high = Math.max(...group.map(c => c.high));
      const low = Math.min(...group.map(c => c.low));
      const volume = group.reduce((sum, c) => sum + c.volume, 0);

      aggregated.push({
        time: key,
        open,
        high,
        low,
        close,
        volume
      });
    }

    this.aggCandlesCache.set(key, aggregated);
    return aggregated;
  }

  public calculateAccurateRelativeVolume(candles: Candlestick[]): number {
    if (!candles || candles.length < 2) return 1.0;
    const lastIdx = candles.length - 1;
    const currentCandle = candles[lastIdx];
    const volumes = candles.map((c) => c.volume || 0);

    const endPrevIdx = lastIdx;
    const startPrevIdx = Math.max(0, endPrevIdx - 20);
    const prevVolumes = volumes.slice(startPrevIdx, endPrevIdx);

    if (prevVolumes.length === 0) return 1.0;
    const sumPrevVolumes = prevVolumes.reduce((a, b) => a + b, 0);
    const avgPrevVolume = sumPrevVolumes / prevVolumes.length;
    if (avgPrevVolume <= 0) return 1.0;

    const lastClosedVol = volumes[lastIdx - 1] !== undefined ? volumes[lastIdx - 1] : volumes[lastIdx];
    const lastClosedRelVol = lastClosedVol / avgPrevVolume;

    const nowSecs = Math.floor(Date.now() / 1000);
    const candleStartSecs = currentCandle.time || nowSecs;
    const elapsedSeconds = Math.max(3, Math.min(60, nowSecs - candleStartSecs));
    
    const paceMultiplier = 60 / elapsedSeconds;
    const projectedCurrentVol = (currentCandle.volume || 0) * paceMultiplier;
    const projectedRelVol = projectedCurrentVol / avgPrevVolume;
    const rawCurrentRelVol = (currentCandle.volume || 0) / avgPrevVolume;

    const pacingRelVol = Math.min(4.0, Math.max(projectedRelVol, rawCurrentRelVol));
    const effectiveRelVolume = Math.max(lastClosedRelVol, pacingRelVol);

    return Number(Math.max(0.1, effectiveRelVolume).toFixed(2));
  }

  public calculateChoppinessIndex(candles: Candlestick[], period = 14): number {
    if (candles.length < period) return 50.0;
    const slice = candles.slice(-period);
    let sumTR = 0;
    for (let i = 0; i < slice.length; i++) {
      const high = slice[i].high;
      const low = slice[i].low;
      const prevClose = i > 0 ? slice[i - 1].close : slice[i].open;
      const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
      sumTR += tr;
    }
    const maxHigh = Math.max(...slice.map(c => c.high));
    const minLow = Math.min(...slice.map(c => c.low));
    const range = maxHigh - minLow;
    if (range <= 0) return 100.0;
    const chop = 100 * (Math.log10(sumTR / range) / Math.log10(period));
    return Math.max(0, Math.min(100, Number(chop.toFixed(2))));
  }

  public calculateEfficiencyRatio(candles: Candlestick[], period = 10): number {
    if (candles.length <= period) return 1.0;
    const slice = candles.slice(-period - 1);
    const netChange = Math.abs(slice[slice.length - 1].close - slice[0].close);
    let sumPath = 0;
    for (let i = 1; i < slice.length; i++) {
      sumPath += Math.abs(slice[i].close - slice[i - 1].close);
    }
    if (sumPath === 0) return 0.0;
    return Number((netChange / sumPath).toFixed(3));
  }

  public calculateAverageWickRatio(candles: Candlestick[], period = 10): number {
    if (candles.length < period) return 0.5;
    const slice = candles.slice(-period);
    let totalWickRatio = 0;
    for (const c of slice) {
      const range = c.high - c.low;
      if (range <= 0) {
        totalWickRatio += 1.0;
        continue;
      }
      const body = Math.abs(c.close - c.open);
      const wick = range - body;
      totalWickRatio += wick / range;
    }
    return Number((totalWickRatio / slice.length).toFixed(3));
  }

  public calculateVolumeProfile(candles: Candlestick[], numBins: number = 24, fallbackPrice = 0): VolumeProfileResult {
    if (candles.length === 0) {
      return { poc: fallbackPrice, vah: fallbackPrice, val: fallbackPrice, hvns: [], lvns: [], bins: [] };
    }

    const highs = candles.map(c => c.high);
    const lows = candles.map(c => c.low);
    const maxPrice = Math.max(...highs);
    const minPrice = Math.min(...lows);
    const priceRange = maxPrice - minPrice;

    if (priceRange === 0) {
      return { poc: minPrice, vah: minPrice, val: minPrice, hvns: [minPrice], lvns: [], bins: [] };
    }

    const binSize = priceRange / numBins;
    const bins = Array.from({ length: numBins }, (_, i) => ({
      price: minPrice + (i + 0.5) * binSize,
      volume: 0
    }));

    let totalVolume = 0;
    for (const c of candles) {
      const cRange = c.high - c.low;
      const cVol = c.volume;
      totalVolume += cVol;
      if (cRange === 0) {
        const idx = Math.min(numBins - 1, Math.max(0, Math.floor((c.close - minPrice) / binSize)));
        bins[idx].volume += cVol;
      } else {
        const startIdx = Math.min(numBins - 1, Math.max(0, Math.floor((c.low - minPrice) / binSize)));
        const endIdx = Math.min(numBins - 1, Math.floor((c.high - minPrice) / binSize));
        if (startIdx === endIdx) {
          bins[startIdx].volume += cVol;
        } else {
          for (let idx = startIdx; idx <= endIdx; idx++) {
            const binMin = minPrice + idx * binSize;
            const binMax = binMin + binSize;
            const overlapMin = Math.max(c.low, binMin);
            const overlapMax = Math.min(c.high, binMax);
            const overlap = overlapMax - overlapMin;
            if (overlap > 0) {
              bins[idx].volume += cVol * (overlap / cRange);
            }
          }
        }
      }
    }

    let maxVol = 0;
    let pocIdx = 0;
    for (let idx = 0; idx < numBins; idx++) {
      if (bins[idx].volume > maxVol) {
        maxVol = bins[idx].volume;
        pocIdx = idx;
      }
    }
    const poc = bins[pocIdx].price;

    const valueAreaThreshold = totalVolume * 0.70;
    let valueAreaVolume = bins[pocIdx].volume;
    let leftIdx = pocIdx;
    let rightIdx = pocIdx;

    while (valueAreaVolume < valueAreaThreshold && (leftIdx > 0 || rightIdx < numBins - 1)) {
      const leftVol = leftIdx > 0 ? bins[leftIdx - 1].volume : -1;
      const rightVol = rightIdx < numBins - 1 ? bins[rightIdx + 1].volume : -1;

      if (leftVol >= rightVol && leftIdx > 0) {
        leftIdx--;
        valueAreaVolume += leftVol;
      } else if (rightIdx < numBins - 1) {
        rightIdx++;
        valueAreaVolume += rightVol;
      } else if (leftIdx > 0) {
        leftIdx--;
        valueAreaVolume += leftVol;
      } else {
        break;
      }
    }

    const val = bins[leftIdx].price - binSize * 0.5;
    const vah = bins[rightIdx].price + binSize * 0.5;

    const hvns: number[] = [];
    const lvns: number[] = [];
    const windowSize = 2;

    for (let idx = windowSize; idx < numBins - windowSize; idx++) {
      const currentVol = bins[idx].volume;
      let isPeak = true;
      let isTrough = true;

      for (let offset = -windowSize; offset <= windowSize; offset++) {
        if (offset === 0) continue;
        const neighborVol = bins[idx + offset].volume;
        if (neighborVol >= currentVol) isPeak = false;
        if (neighborVol <= currentVol) isTrough = false;
      }

      if (isPeak && currentVol > totalVolume * 0.03) {
        hvns.push(bins[idx].price);
      }
      if (isTrough && currentVol < totalVolume * 0.015) {
        lvns.push(bins[idx].price);
      }
    }

    return { poc, vah, val, hvns, lvns, bins };
  }

  public getVolumeProfileCached(candles: Candlestick[], id: string, numBins: number = 24, fallbackPrice = 0): VolumeProfileResult {
    if (candles.length === 0) {
      return { poc: fallbackPrice, vah: fallbackPrice, val: fallbackPrice, hvns: [], lvns: [], bins: [] };
    }
    const last = candles[candles.length - 1];
    const priceBucket = Math.round(last.close / 10) * 10;
    const key = `${id}_${candles.length}_${last.time}_${priceBucket}_${numBins}`;
    if (this.volumeProfileCache.has(key)) {
      return this.volumeProfileCache.get(key)!;
    }
    if (this.volumeProfileCache.size > 200) {
      this.volumeProfileCache.clear();
    }
    const profile = this.calculateVolumeProfile(candles, numBins, fallbackPrice);
    this.volumeProfileCache.set(key, profile);
    return profile;
  }
}

export const indicators = new IndicatorCalculator();
