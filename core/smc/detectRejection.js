// core/smc/detectRejection.js
'use strict';

const MIN_WICK_RATIO = 0.5;

function collectPOIs(snrs, fvgs, rbs) {
  const pois = [];
  for (const s of snrs) {
    if (s.valid) pois.push({ low: s.low, high: s.high, type: s.type, index: s.indexStart });
  }
  for (const f of fvgs) {
    if (f.status !== 'FF') pois.push({ low: f.low, high: f.high, type: 'FVG', index: f.index });
  }
  for (const r of rbs) {
    pois.push({ low: r.low, high: r.high, type: r.type, index: r.index });
  }
  return pois;
}

/**
 * Detect rejection candles — long-wick candles that test a POI and close beyond it.
 * Wick must be ≥ MIN_WICK_RATIO × candle range.
 *
 * @param {Array}  candles  OHLCV candles
 * @param {SNR[]}  snrs     Output of detectSNR()
 * @param {FVG[]}  fvgs     Output of detectFVG()
 * @param {RB[]}   rbs      Output of detectRB()
 * @returns {Rejection[]}
 */
function detectRejection(candles, snrs, fvgs, rbs) {
  const pois       = collectPOIs(snrs, fvgs, rbs);
  const rejections = [];

  for (let i = 0; i < candles.length; i++) {
    const c     = candles[i];
    const range = c.high - c.low;
    if (range === 0) continue;

    for (const poi of pois) {
      if (poi.index >= i) continue;

      // --- Bullish rejection ---
      const lowerWick = Math.min(c.open, c.close) - c.low;
      if (c.low >= poi.low && c.low <= poi.high && c.close > poi.high) {
        if (lowerWick / range >= MIN_WICK_RATIO) {
          rejections.push({
            index: i, type: 'bullish',
            wickExtreme: c.low, close: c.close,
            poiType: poi.type, poiIndex: poi.index,
          });
          break;
        }
      }

      // --- Bearish rejection ---
      const upperWick = c.high - Math.max(c.open, c.close);
      if (c.high >= poi.low && c.high <= poi.high && c.close < poi.low) {
        if (upperWick / range >= MIN_WICK_RATIO) {
          rejections.push({
            index: i, type: 'bearish',
            wickExtreme: c.high, close: c.close,
            poiType: poi.type, poiIndex: poi.index,
          });
          break;
        }
      }
    }
  }

  return rejections;
}

module.exports = { detectRejection };
