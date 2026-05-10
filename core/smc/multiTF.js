// core/smc/multiTF.js
'use strict';

const { precomputeSMC } = require('./index');

const ONE_DAY_MS = 24 * 3_600_000;
const FOUR_H_MS  = 4  * 3_600_000;

// Найти максимальный i, где candles[i].time + barLenMs <= asOfMs.
// Возвращает -1 если ни один бар ещё не закрыт.
function lastClosedIndex(candles, asOfMs, barLenMs) {
  let lo = 0, hi = candles.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].time + barLenMs <= asOfMs) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return ans;
}

function biasFromStructure(structure, upToIndex) {
  let bias = 'neutral';
  for (const ev of structure) {
    if (ev.index > upToIndex) break;
    if (ev.type === 'BOS')                                bias = ev.direction;
    else if (ev.type === 'FakeBOS' || ev.type === 'Conf') bias = 'neutral';
  }
  return bias;
}

/**
 * Project 4H/1D SMC context onto every 1H candle index.
 *
 * @param {Candle[]} candles1H
 * @param {Candle[]} candles4H
 * @param {Candle[]} candles1D
 * @returns {Array<{ bias_1D, activePOI_4H, contextSwings_4H }>}
 */
function alignTimeframes(candles1H, candles4H, candles1D) {
  precomputeSMC(candles4H);
  const ctx1D = precomputeSMC(candles1D);

  return candles1H.map(c1 => {
    const idx1D = lastClosedIndex(candles1D, c1.time, ONE_DAY_MS);
    const bias_1D = idx1D < 0 ? 'neutral' : biasFromStructure(ctx1D.structure, idx1D);
    return {
      bias_1D,
      activePOI_4H: [],
      contextSwings_4H: { lastStrongHigh: null, lastStrongLow: null },
    };
  });
}

module.exports = { alignTimeframes, lastClosedIndex, biasFromStructure };
