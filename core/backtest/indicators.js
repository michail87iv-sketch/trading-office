'use strict';

/**
 * Backtest indicators — thin wrappers around core/indicators.js
 * plus the scalar calcRSI/calcEMA API that matches scalper1.js's convention.
 *
 * calcRSI(candles, period) → single RSI number (or null if not enough data)
 * calcEMA(candles, period) → single EMA number (or null if not enough data)
 */

const ind = require('../indicators');

/**
 * Wilder-smoothed RSI — exact copy of scalper1.js's calcRSI.
 * Accepts a candle slice (objects with .close) or an array of close prices.
 * @param {Array} candles
 * @param {number} period
 * @returns {number|null}
 */
function calcRSI(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const closes = candles.map((c) => (typeof c === 'number' ? c : c.close));

  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) avgGain += d; else avgLoss -= d;
  }
  avgGain /= period;
  avgLoss /= period;

  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
  }

  if (avgLoss === 0) return 100;
  return +(100 - 100 / (1 + avgGain / avgLoss)).toFixed(1);
}

/**
 * Standard EMA — returns the last EMA value from a candle slice.
 * Accepts a candle slice (objects with .close) or an array of close prices.
 * @param {Array} candles
 * @param {number} period
 * @returns {number|null}
 */
function calcEMA(candles, period) {
  const closes = candles.map((c) => (typeof c === 'number' ? c : c.close));
  const arr    = ind.ema(closes, period);
  return arr[arr.length - 1];
}

module.exports = { calcRSI, calcEMA };
