// core/smc/detectSNR.js
'use strict';

/**
 * Detect Supply/Demand zones (SNR — Support/Negative Resistance).
 *
 * A zone forms when ≥3 consecutive candles consolidate (closes stay within
 * expanding zone boundaries), followed by a breakout candle.
 * +SNR: bullish breakout (close > zone high).
 * -SNR: bearish breakout (close < zone low).
 *
 * valid=true ONLY when a subsequent retest candle enters the zone AND:
 *   (a) a SSL/BSL within the zone is taken, OR
 *   (b) a FVG overlaps the zone boundaries.
 *
 * @param {Array}      candles    OHLCV candles
 * @param {LiqLevel[]} liquidity  Output of detectLiquidity()
 * @param {FVG[]}      fvgs       Output of detectFVG()
 * @returns {SNR[]}
 */
function detectSNR(candles, liquidity, fvgs) {
  const snrs = [];
  let i = 0;

  while (i < candles.length - 1) {
    let zHigh = candles[i].high;
    let zLow  = candles[i].low;
    let found = false;

    for (let j = i + 1; j < candles.length; j++) {
      const c       = candles[j];
      const consLen = j - i;  // number of candles in zone: i..(j-1)

      if (c.close > zHigh) {
        // Bullish breakout
        if (consLen >= 3) {
          snrs.push({ indexStart: i, indexEnd: j - 1, type: '+SNR',
                      high: zHigh, low: zLow, valid: false });
          i = j;
          found = true;
        }
        break;
      } else if (c.close < zLow) {
        // Bearish breakout
        if (consLen >= 3) {
          snrs.push({ indexStart: i, indexEnd: j - 1, type: '-SNR',
                      high: zHigh, low: zLow, valid: false });
          i = j;
          found = true;
        }
        break;
      } else {
        // Candle stays inside zone — expand boundaries with its wicks
        zHigh = Math.max(zHigh, c.high);
        zLow  = Math.min(zLow,  c.low);
      }
    }

    if (!found) i++;
  }

  // Validity check: retest + liquidity sweep OR FVG overlap
  for (const snr of snrs) {
    for (let k = snr.indexEnd + 2; k < candles.length; k++) {
      const c = candles[k];
      // Is this a retest? (candle enters the zone)
      const inZone =
        snr.type === '+SNR'
          ? c.low  <= snr.high && c.low  >= snr.low
          : c.high >= snr.low  && c.high <= snr.high;

      if (!inZone) continue;

      // (a) SSL/BSL swept inside or at zone boundaries
      const liquiditySweep = liquidity.some(liq =>
        liq.price >= snr.low && liq.price <= snr.high && liq.taken
      );

      // (b) FVG that overlaps the zone
      const fvgInsideZone = fvgs.some(fvg =>
        fvg.high >= snr.low && fvg.low <= snr.high
      );

      if (liquiditySweep || fvgInsideZone) {
        snr.valid = true;
        break;
      }
    }
  }

  return snrs;
}

module.exports = { detectSNR };
