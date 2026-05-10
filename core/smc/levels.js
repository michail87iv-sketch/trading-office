// core/smc/levels.js
'use strict';

const DEFAULT_SL_BUFFER = 0.005; // 0.5%

/**
 * @param {Object} setup
 *   { kind: 'SNR'|'FVG'|'RB', direction: 'long'|'short', high, low, zone? }
 * @param {Object} [opts]
 *   { bufferPct: number }   default 0.005
 * @returns {number}  SL price
 */
function getStopLossPrice(setup, opts = {}) {
  const buffer = opts.bufferPct ?? DEFAULT_SL_BUFFER;
  const zoneHigh = setup.zone?.high ?? setup.high;
  const zoneLow  = setup.zone?.low  ?? setup.low;
  if (setup.direction === 'long')  return +(zoneLow  * (1 - buffer)).toFixed(8);
  if (setup.direction === 'short') return +(zoneHigh * (1 + buffer)).toFixed(8);
  throw new Error(`unknown direction: ${setup.direction}`);
}

function getTakeProfitPrice(entry, sl, rr) {
  if (entry === sl) throw new Error('entry equals sl — risk is zero');
  const risk = Math.abs(entry - sl);
  const isLong = entry > sl;
  const tp = isLong ? entry + risk * rr : entry - risk * rr;
  return +tp.toFixed(8);
}

function getRiskRewardRatio(entry, sl, tp) {
  const risk   = Math.abs(entry - sl);
  const reward = Math.abs(tp - entry);
  if (risk === 0) return 0;
  return +(reward / risk).toFixed(4);
}

module.exports = { getStopLossPrice, getTakeProfitPrice, getRiskRewardRatio };
