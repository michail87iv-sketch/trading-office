'use strict';

const { calcRSI, calcEMA } = require('./indicators');

/**
 * S1 signal logic — mirrors analyzeSymbol() in agents/scalper1.js.
 *
 * Simplified for backtesting (no volume-spike or fractal-level checks):
 *   1. RSI < rsiOversold  → 'long'
 *   2. RSI > rsiOverbought → 'short'
 *   3. If emaEnabled: long requires price > EMA, short requires price < EMA
 *
 * @param {Array<{time,open,high,low,close,volume}>} candles  full candle history up to this bar
 * @param {number} index   current bar index within candles
 * @param {Object} params
 * @param {number} params.rsiPeriod      default 14
 * @param {number} params.rsiOversold    default 30
 * @param {number} params.rsiOverbought  default 70
 * @param {boolean} params.emaEnabled    default true
 * @param {number} params.emaPeriod      default 50
 * @returns {'long'|'short'|null}
 */
function getSignal(candles, index, params = {}) {
  const {
    rsiPeriod     = 14,
    rsiOversold   = 30,
    rsiOverbought = 70,
    emaEnabled    = true,
    emaPeriod     = 50,
  } = params;

  // Need at least rsiPeriod + 1 candles ending at `index`
  const slice = candles.slice(0, index + 1);
  if (slice.length < rsiPeriod + 1) return null;

  const rsi = calcRSI(slice, rsiPeriod);
  if (rsi === null) return null;

  let direction = null;
  if (rsi < rsiOversold)        direction = 'long';
  else if (rsi > rsiOverbought) direction = 'short';
  else                          return null;

  // EMA trend filter
  if (emaEnabled && slice.length >= emaPeriod) {
    const price = slice[slice.length - 1].close;
    const ema   = calcEMA(slice, emaPeriod);
    if (ema !== null) {
      if (direction === 'long'  && price < ema) return null;
      if (direction === 'short' && price > ema) return null;
    }
  }

  return direction;
}

module.exports = { getSignal };
