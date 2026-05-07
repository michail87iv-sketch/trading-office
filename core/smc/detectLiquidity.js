// core/smc/detectLiquidity.js
'use strict';

const EQ_THRESHOLD = 0.001; // 0.1%

/**
 * Map swing points to liquidity levels (BSL/SSL) and detect equal highs/lows (EQH/EQL).
 * Marks taken=true when a subsequent candle sweeps through the level and closes back.
 *
 * @param {Array}        candles  OHLCV candles
 * @param {SwingPoint[]} swings   Output of detectSwings()
 * @returns {LiqLevel[]}
 */
function detectLiquidity(candles, swings) {
  const levels = [];

  for (const s of swings) {
    levels.push({
      type:    s.type === 'high' ? 'BSL' : 'SSL',
      price:   s.price,
      indices: [s.index],
      taken:   false,
    });
  }

  // Merge into EQH/EQL where two levels of the same type are within threshold
  const merged = [];
  const used   = new Set();
  for (let i = 0; i < levels.length; i++) {
    if (used.has(i)) continue;
    const group = [i];
    for (let j = i + 1; j < levels.length; j++) {
      if (used.has(j)) continue;
      if (levels[i].type !== levels[j].type) continue;
      if (Math.abs(levels[i].price - levels[j].price) / levels[i].price <= EQ_THRESHOLD) {
        group.push(j);
        used.add(j);
      }
    }
    if (group.length >= 2) {
      const eqType = levels[i].type === 'BSL' ? 'EQH' : 'EQL';
      merged.push({
        type:    eqType,
        price:   levels[i].price,
        indices: group.flatMap(gi => levels[gi].indices),
        taken:   false,
      });
      used.add(i);
    } else {
      merged.push(levels[i]);
      used.add(i);
    }
  }

  // Sweep check
  for (const liq of merged) {
    const lastIdx = Math.max(...liq.indices);
    for (let i = lastIdx + 1; i < candles.length; i++) {
      const c = candles[i];
      if (liq.type === 'BSL' || liq.type === 'EQH') {
        if (c.high > liq.price && c.close < liq.price) { liq.taken = true; break; }
      } else {
        if (c.low < liq.price && c.close > liq.price) { liq.taken = true; break; }
      }
    }
  }

  return merged;
}

module.exports = { detectLiquidity };
