// core/smc/detectRB.js
'use strict';

const DOJI_RATIO = 0.1;

function isBullish(c) { return c.close > c.open; }
function isBearish(c) { return c.close < c.open; }
function isDoji(c) {
  const range = c.high - c.low;
  return range === 0 || Math.abs(c.close - c.open) / range < DOJI_RATIO;
}

/**
 * Detect Rejection Blocks — two-candle formations anchored to a Key Level.
 *
 * A RB is registered only when ALL three conditions are met:
 *   1. Two consecutive candles in opposite directions (bearish→bullish or bullish→bearish).
 *   2. At least one candle tests the KL with a wick.
 *   3. Both candles' closes are on the correct side of the KL
 *      (+RB: both close > klPrice; -RB: both close < klPrice).
 *
 * @param {Array}      candles    OHLCV candles
 * @param {KeyLevel[]} keyLevels  Array of { price } — swings + FVG borders
 * @returns {RB[]}
 */
function detectRB(candles, keyLevels = []) {
  const rbs = [];

  for (let i = 0; i < candles.length - 1; i++) {
    const a = candles[i];
    const b = candles[i + 1];
    if (isDoji(a) || isDoji(b)) continue;

    // +RB: bearish then bullish
    if (isBearish(a) && isBullish(b)) {
      for (const kl of keyLevels) {
        const klP = kl.price;
        // Both closes above KL
        if (a.close < klP || b.close < klP) continue;
        // At least one wick dips to or below KL
        if (a.low > klP && b.low > klP) continue;
        rbs.push({
          index: i, type: '+RB',
          low:  Math.min(a.low,  b.low),
          high: Math.max(a.high, b.high),
          klPrice: klP,
        });
        break;
      }
    }
    // -RB: bullish then bearish
    else if (isBullish(a) && isBearish(b)) {
      for (const kl of keyLevels) {
        const klP = kl.price;
        // Both closes below KL
        if (a.close > klP || b.close > klP) continue;
        // At least one wick rises to or above KL
        if (a.high < klP && b.high < klP) continue;
        rbs.push({
          index: i, type: '-RB',
          low:  Math.min(a.low,  b.low),
          high: Math.max(a.high, b.high),
          klPrice: klP,
        });
        break;
      }
    }
  }

  return rbs;
}

module.exports = { detectRB };
