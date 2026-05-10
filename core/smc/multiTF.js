// core/smc/multiTF.js
'use strict';

const { precomputeSMC } = require('./index');

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
  precomputeSMC(candles1D);

  return candles1H.map(() => ({
    bias_1D: 'neutral',
    activePOI_4H: [],
    contextSwings_4H: { lastStrongHigh: null, lastStrongLow: null },
  }));
}

module.exports = { alignTimeframes };
