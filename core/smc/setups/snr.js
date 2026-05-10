// core/smc/setups/snr.js
'use strict';
// SNR setup (single-TF on 4H): 1D bias + 4H valid SNR + 1H reaction at the 4H zone.

const { reactionAt4HZone, computeSlTp } = require('./_helpers');
const { lastClosedIndex } = require('../multiTF');

const FOUR_H_MS = 4 * 3_600_000;

function detectSNRSetup(idx, ctx) {
  const { aligned, candles1H, candles4H, ctx4H } = ctx;
  const row = aligned[idx];
  if (row.bias_1D === 'neutral') return null;

  const c = candles1H[idx];
  const wantSide = row.bias_1D === 'bullish' ? 'long' : 'short';
  const wantType = wantSide === 'long' ? '+SNR' : '-SNR';

  const idx4H = lastClosedIndex(candles4H, c.time, FOUR_H_MS);
  if (idx4H < 0) return null;

  for (const poi of row.activePOI_4H) {
    if (poi.kind !== 'SNR' || poi.type !== wantType) continue;

    const reaction = reactionAt4HZone(c, { high: poi.high, low: poi.low });
    if (reaction === null) continue;
    if (wantSide === 'long'  && reaction !== 'bullish') continue;
    if (wantSide === 'short' && reaction !== 'bearish') continue;

    const entry = c.close;
    const { slPrice, tpPrice, rr, target } = computeSlTp({
      side: wantSide, entry,
      zone: { high: poi.high, low: poi.low },
      liquidity: ctx4H.liquidity,
    });

    return {
      setupType: 'SNR_4H',
      side: wantSide, entry, slPrice, tpPrice,
      meta: { rr, target, poi: { kind: 'SNR', type: poi.type, high: poi.high, low: poi.low, indexStart: poi.indexStart } },
    };
  }
  return null;
}

module.exports = { detectSNRSetup };
