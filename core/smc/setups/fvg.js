// core/smc/setups/fvg.js
'use strict';
// FVG setup family: 4H FVG as POI. Trigger candle (1H) reacts at FVG zone with
// VC-not-inside-FVG rule: close must be OUTSIDE the FVG in trade direction; wick
// may enter the FVG (that's the reaction).
// Variants:
//   FVG_4H               — intra-TF
//   FVG_4H_SNR_1H        — confluence with 1H valid SNR at trigger candle
//   FVG_4H_FVG_1H        — confluence with 1H open FVG
//   FVG_4H_RB_1H         — confluence with 1H RB

const { computeSlTp, find1HValidator, WICK_RATIO } = require('./_helpers');
const { lastClosedIndex } = require('../multiTF');

const FOUR_H_MS = 4 * 3_600_000;

// VC-not-inside-FVG: long → close >= fvg.high (above the gap); wick may dip into fvg.
function isLongVCValid(c, fvg) {
  const range = c.high - c.low;
  if (range === 0) return false;
  if (c.close < fvg.high) return false;
  if (c.low > fvg.high) return false; // wick must touch the gap zone
  if (c.low < fvg.low - 0.5 * (fvg.high - fvg.low)) return false; // not too far below
  const lowerWick = Math.min(c.open, c.close) - c.low;
  return lowerWick / range >= WICK_RATIO;
}

function isShortVCValid(c, fvg) {
  const range = c.high - c.low;
  if (range === 0) return false;
  if (c.close > fvg.low) return false;
  if (c.high < fvg.low) return false;
  if (c.high > fvg.high + 0.5 * (fvg.high - fvg.low)) return false;
  const upperWick = c.high - Math.max(c.open, c.close);
  return upperWick / range >= WICK_RATIO;
}

function buildSetup({ wantSide, c, fvg, ctx, validator, label }) {
  const entry = c.close;
  const { slPrice, tpPrice, rr, target } = computeSlTp({
    side: wantSide, entry,
    zone: { high: fvg.high, low: fvg.low },
    liquidity: ctx.ctx4H.liquidity,
  });
  return {
    setupType: label,
    side: wantSide, entry, slPrice, tpPrice,
    meta: { rr, target, poi: { kind: 'FVG', type: fvg.type, high: fvg.high, low: fvg.low, index: fvg.index }, validator },
  };
}

// Try the cross-TF variants first (more specific), then fall back to intra-TF.
function detectFVGSetup(idx, ctx) {
  const { aligned, candles1H, candles4H, ctx1H } = ctx;
  const row = aligned[idx];
  if (row.bias_1D === 'neutral') return null;

  const c = candles1H[idx];
  const wantSide = row.bias_1D === 'bullish' ? 'long' : 'short';
  const wantType = wantSide === 'long' ? 'bullish' : 'bearish';

  const idx4H = lastClosedIndex(candles4H, c.time, FOUR_H_MS);
  if (idx4H < 0) return null;

  for (const poi of row.activePOI_4H) {
    if (poi.kind !== 'FVG' || poi.type !== wantType) continue;
    if (poi.status === 'FF') continue;

    const vcValid = wantSide === 'long' ? isLongVCValid(c, poi) : isShortVCValid(c, poi);
    if (!vcValid) continue;

    // Cross-TF validators (priority by specificity: SNR > RB > FVG → just any single confluence)
    for (const kind of ['SNR', 'RB', 'FVG']) {
      const v = find1HValidator(ctx1H, candles1H, idx, wantSide, kind);
      if (v) return buildSetup({ wantSide, c, fvg: poi, ctx, validator: v, label: `FVG_4H_${kind}_1H` });
    }
    // Intra-TF fallback
    return buildSetup({ wantSide, c, fvg: poi, ctx, validator: null, label: 'FVG_4H' });
  }
  return null;
}

module.exports = { detectFVGSetup, isLongVCValid, isShortVCValid };
