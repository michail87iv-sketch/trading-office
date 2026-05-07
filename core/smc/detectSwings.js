// core/smc/detectSwings.js
'use strict';

/**
 * Detect fractal swing highs and lows (N-bar fractal rule).
 * A swing high at index i: candles[i].high is strictly greater than
 * the highs of the N candles on each side.
 *
 * @param {Array}  candles  Array of {high, low, ...} candle objects
 * @param {number} N        Look-around window (default 2)
 * @returns {SwingPoint[]}  Sorted by index ascending
 */
function detectSwings(candles, N = 2) {
  if (candles.length < 2 * N + 1) return [];

  const swings = [];
  for (let i = N; i < candles.length - N; i++) {
    const hi = candles[i].high;
    const lo = candles[i].low;
    let isHigh = true;
    let isLow  = true;

    for (let j = 1; j <= N; j++) {
      if (candles[i - j].high >= hi) isHigh = false;
      if (candles[i + j].high >= hi) isHigh = false;
      if (candles[i - j].low  <= lo) isLow  = false;
      if (candles[i + j].low  <= lo) isLow  = false;
    }

    if (isHigh) swings.push({ index: i, type: 'high', price: hi, strength: 'weak' });
    if (isLow)  swings.push({ index: i, type: 'low',  price: lo, strength: 'weak' });
  }

  return swings;
}

module.exports = { detectSwings };
