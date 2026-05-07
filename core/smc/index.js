// core/smc/index.js
'use strict';

const { detectSwings }    = require('./detectSwings');
const { detectStructure } = require('./detectStructure');
const { detectFVG }       = require('./detectFVG');
const { detectSNR }       = require('./detectSNR');
const { detectRB }        = require('./detectRB');
const { detectLiquidity } = require('./detectLiquidity');
const { detectRejection } = require('./detectRejection');

/**
 * Collect key levels for detectRB from swing prices and FVG borders.
 * @param {SwingPoint[]} swings
 * @param {FVG[]}        fvgs
 * @returns {KeyLevel[]}
 */
function buildKeyLevels(swings, fvgs) {
  const kls = [];
  for (const s of swings)   kls.push({ price: s.price });
  for (const f of fvgs)   { kls.push({ price: f.high }); kls.push({ price: f.low }); }
  return kls;
}

/**
 * Run all SMC detectors in dependency order and return the full SMCContext.
 *
 * Order: swings → structure → fvg → liquidity → snr → rb → rejection
 *
 * @param {Array} candles  OHLCV candle array (oldest → newest)
 * @returns {SMCContext}
 */
function precomputeSMC(candles) {
  if (!candles || candles.length === 0) {
    return { swings: [], structure: [], fvgs: [], snrs: [], rbs: [], liquidity: [], rejections: [] };
  }

  const swings     = detectSwings(candles);
  const structure  = detectStructure(candles, swings);   // mutates swings.strength
  const fvgs       = detectFVG(candles);
  const liquidity  = detectLiquidity(candles, swings);
  const snrs       = detectSNR(candles, liquidity, fvgs);
  const keyLevels  = buildKeyLevels(swings, fvgs);
  const rbs        = detectRB(candles, keyLevels);
  const rejections = detectRejection(candles, snrs, fvgs, rbs);

  return { swings, structure, fvgs, snrs, rbs, liquidity, rejections };
}

module.exports = { precomputeSMC };
