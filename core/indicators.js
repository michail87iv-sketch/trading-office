'use strict';

/**
 * Technical indicators — all return arrays equal in length to input.
 * Warm-up positions are filled with null.
 * All implementations match TradingView's default calculations.
 */

// ─── Moving averages ──────────────────────────────────────────────────────────

function sma(values, period) {
  return values.map((_, i) => {
    if (i < period - 1) return null;
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += values[j];
    return sum / period;
  });
}

function ema(values, period) {
  const k      = 2 / (period + 1);
  const result = new Array(values.length).fill(null);
  let prev     = null;

  for (let i = 0; i < values.length; i++) {
    if (values[i] == null) continue;
    if (prev === null) {
      if (i < period - 1) continue;
      // Seed with SMA of first `period` values
      let sum = 0;
      for (let j = i - period + 1; j <= i; j++) sum += values[j];
      prev = sum / period;
    } else {
      prev = values[i] * k + prev * (1 - k);
    }
    result[i] = prev;
  }
  return result;
}

// ─── RSI (Wilder's smoothing — matches TradingView) ───────────────────────────

function rsi(values, period) {
  const result = new Array(values.length).fill(null);
  if (values.length <= period) return result;

  let avgGain = 0;
  let avgLoss = 0;

  // Seed with simple averages over first `period` changes
  for (let i = 1; i <= period; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) avgGain += diff;
    else avgLoss -= diff;
  }
  avgGain /= period;
  avgLoss /= period;

  const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
  result[period] = 100 - 100 / (1 + rs);

  // Wilder smoothing
  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    const rs2 = avgLoss === 0 ? 100 : avgGain / avgLoss;
    result[i] = 100 - 100 / (1 + rs2);
  }
  return result;
}

// ─── MACD ─────────────────────────────────────────────────────────────────────

function macd(values, fast = 12, slow = 26, signal = 9) {
  const fastEma   = ema(values, fast);
  const slowEma   = ema(values, slow);
  const macdLine  = fastEma.map((v, i) => (v != null && slowEma[i] != null) ? v - slowEma[i] : null);
  const signalLine = ema(macdLine.map(v => v ?? 0), signal).map((v, i) => macdLine[i] != null ? v : null);
  const histogram = macdLine.map((v, i) => (v != null && signalLine[i] != null) ? v - signalLine[i] : null);
  return { macd: macdLine, signal: signalLine, histogram };
}

// ─── Bollinger Bands ──────────────────────────────────────────────────────────

function bollingerBands(values, period = 20, mult = 2.0) {
  const middle = sma(values, period);
  const upper  = new Array(values.length).fill(null);
  const lower  = new Array(values.length).fill(null);

  for (let i = period - 1; i < values.length; i++) {
    const slice = values.slice(i - period + 1, i + 1);
    const mean  = middle[i];
    const variance = slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period;
    const std   = Math.sqrt(variance);
    upper[i]    = mean + mult * std;
    lower[i]    = mean - mult * std;
  }
  return { upper, middle, lower };
}

// ─── ATR (Wilder's smoothing) ─────────────────────────────────────────────────

function atr(candles, period = 14) {
  const tr     = new Array(candles.length).fill(null);
  const result = new Array(candles.length).fill(null);

  for (let i = 1; i < candles.length; i++) {
    const { high, low } = candles[i];
    const prevClose     = candles[i - 1].close;
    tr[i] = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
  }

  // Seed
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += tr[i];
  let prev = sum / period;
  result[period] = prev;

  for (let i = period + 1; i < candles.length; i++) {
    prev = (prev * (period - 1) + tr[i]) / period;
    result[i] = prev;
  }
  return result;
}

// ─── VWAP (resets daily based on candle timestamps) ──────────────────────────

function vwap(candles) {
  const result = new Array(candles.length).fill(null);
  let cumTPV   = 0;
  let cumVol   = 0;
  let lastDay  = null;

  for (let i = 0; i < candles.length; i++) {
    const c   = candles[i];
    const day = new Date(c.time).toDateString();
    if (day !== lastDay) { cumTPV = 0; cumVol = 0; lastDay = day; }
    const typical = (c.high + c.low + c.close) / 3;
    cumTPV += typical * c.vol;
    cumVol += c.vol;
    result[i] = cumVol > 0 ? cumTPV / cumVol : c.close;
  }
  return result;
}

// ─── Stochastic RSI ──────────────────────────────────────────────────────────

function stochRsi(values, rsiPeriod = 14, stochPeriod = 14, kSmooth = 3, dSmooth = 3) {
  const rsiValues = rsi(values, rsiPeriod);
  const k_raw = new Array(values.length).fill(null);

  for (let i = stochPeriod - 1; i < values.length; i++) {
    const slice = rsiValues.slice(i - stochPeriod + 1, i + 1).filter(v => v != null);
    if (slice.length < stochPeriod) continue;
    const minR = Math.min(...slice);
    const maxR = Math.max(...slice);
    k_raw[i] = maxR === minR ? 0 : (rsiValues[i] - minR) / (maxR - minR) * 100;
  }

  const k = ema(k_raw.map(v => v ?? 0), kSmooth).map((v, i) => k_raw[i] != null ? v : null);
  const d = ema(k.map(v => v ?? 0), dSmooth).map((v, i) => k[i] != null ? v : null);
  return { k, d };
}

// ─── Crossover helpers ────────────────────────────────────────────────────────

/** Returns true if a crossed above b at index i */
function crossOver(a, b, i) {
  return a[i] != null && b[i] != null && a[i - 1] != null && b[i - 1] != null &&
    a[i] > b[i] && a[i - 1] <= b[i - 1];
}

/** Returns true if a crossed below b at index i */
function crossUnder(a, b, i) {
  return a[i] != null && b[i] != null && a[i - 1] != null && b[i - 1] != null &&
    a[i] < b[i] && a[i - 1] >= b[i - 1];
}

module.exports = { sma, ema, rsi, macd, bollingerBands, atr, vwap, stochRsi, crossOver, crossUnder };
