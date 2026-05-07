// core/smc/detectFVG.js
'use strict';

const STATUS_RANK = { 'open': 0, 'IOFED': 1, '0.5': 2, 'FF': 3 };

function setStatus(fvg, newStatus) {
  if (STATUS_RANK[newStatus] > STATUS_RANK[fvg.status]) {
    fvg.status = newStatus;
    if (newStatus === 'FF') fvg.ifvg = true;
  }
}

/**
 * Detect Fair Value Gaps (FVG) and track fill status monotonically.
 * Status can only increase: open → IOFED → 0.5 → FF.
 *
 * Bullish FVG: candles[i-2].high < candles[i].low
 * Bearish FVG: candles[i-2].low  > candles[i].high
 *
 * @param {Array} candles  OHLCV candles
 * @returns {FVG[]}
 */
function detectFVG(candles) {
  const fvgs = [];

  // Pass 1: detect FVG formation
  for (let i = 2; i < candles.length; i++) {
    const prev2 = candles[i - 2];
    const curr  = candles[i];

    if (prev2.high < curr.low) {
      const low  = prev2.high;
      const high = curr.low;
      fvgs.push({
        index: i, type: 'bullish',
        high, low, mid: +((high + low) / 2).toFixed(10),
        status: 'open', ifvg: false,
      });
    } else if (prev2.low > curr.high) {
      const low  = curr.high;
      const high = prev2.low;
      fvgs.push({
        index: i, type: 'bearish',
        high, low, mid: +((high + low) / 2).toFixed(10),
        status: 'open', ifvg: false,
      });
    }
  }

  // Pass 2: update status based on subsequent candles (monotonic via setStatus)
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    for (const fvg of fvgs) {
      if (fvg.index >= i) continue;
      if (fvg.status === 'FF') continue;

      if (fvg.type === 'bullish') {
        if (c.low <= fvg.high) {
          setStatus(fvg, 'IOFED');
          if (c.low <= fvg.mid)  setStatus(fvg, '0.5');
          if (c.low <= fvg.low)  setStatus(fvg, 'FF');
        }
      } else {
        if (c.high >= fvg.low) {
          setStatus(fvg, 'IOFED');
          if (c.high >= fvg.mid)  setStatus(fvg, '0.5');
          if (c.high >= fvg.high) setStatus(fvg, 'FF');
        }
      }
    }
  }

  return fvgs;
}

module.exports = { detectFVG };
