// core/smc/setups/rb.js
'use strict';
// RB setup: 1D bias + 4H RB POI + 1H reaction at zone + FH/FL on 1H within/near RB.
// FH/FL = recent 1H swing high (for short) or swing low (for long) inside or within
// 0.5% of the RB zone — confirms the RB has structural significance on the lower TF.

const { reactionAt4HZone, computeSlTp } = require('./_helpers');
const { lastClosedIndex } = require('../multiTF');

const FOUR_H_MS = 4 * 3_600_000;
const FHFL_NEARBY_PCT = 0.005;
const FHFL_LOOKBACK = 24;

function hasNearby1HSwing(swings1H, candles1H, idx1H, side, zone) {
  const wantType = side === 'long' ? 'low' : 'high';
  const tol = (zone.high + zone.low) / 2 * FHFL_NEARBY_PCT;
  const lo = zone.low - tol;
  const hi = zone.high + tol;

  for (const s of swings1H) {
    if (s.index >= idx1H) break;
    if (s.index < idx1H - FHFL_LOOKBACK) continue;
    if (s.type !== wantType) continue;
    if (s.price >= lo && s.price <= hi) return s;
  }
  return null;
}

function detectRBSetup(idx, ctx) {
  const { aligned, candles1H, candles4H, ctx4H, ctx1H } = ctx;
  const row = aligned[idx];
  if (row.bias_1D === 'neutral') return null;

  const c = candles1H[idx];
  const wantSide = row.bias_1D === 'bullish' ? 'long' : 'short';
  const wantType = wantSide === 'long' ? '+RB' : '-RB';

  const idx4H = lastClosedIndex(candles4H, c.time, FOUR_H_MS);
  if (idx4H < 0) return null;

  for (const poi of row.activePOI_4H) {
    if (poi.kind !== 'RB' || poi.type !== wantType) continue;

    const reaction = reactionAt4HZone(c, { high: poi.high, low: poi.low });
    if (reaction === null) continue;
    if (wantSide === 'long'  && reaction !== 'bullish') continue;
    if (wantSide === 'short' && reaction !== 'bearish') continue;

    const fhfl = hasNearby1HSwing(ctx1H.swings, candles1H, idx, wantSide, { high: poi.high, low: poi.low });
    if (!fhfl) continue;

    const entry = c.close;
    const { slPrice, tpPrice, rr, target } = computeSlTp({
      side: wantSide, entry,
      zone: { high: poi.high, low: poi.low },
      liquidity: ctx4H.liquidity,
    });

    return {
      setupType: 'RB_4H',
      side: wantSide, entry, slPrice, tpPrice,
      meta: { rr, target, poi: { kind: 'RB', type: poi.type, high: poi.high, low: poi.low, index: poi.index }, fhfl: { type: fhfl.type, price: fhfl.price, index: fhfl.index } },
    };
  }
  return null;
}

module.exports = { detectRBSetup };
