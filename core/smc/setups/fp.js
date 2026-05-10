// core/smc/setups/fp.js
'use strict';
// FP (Failure Pivot) setup: a 4H sweep+reversal candle. After the FP forms on 4H,
// strategy looks for a 1H entry on the same side. Optional 1H confluence
// (SNR/FVG/RB) at the trigger candle yields cross-TF variants:
//   FP_4H               — intra-TF
//   FP_4H_SNR_1H, FP_4H_FVG_1H, FP_4H_RB_1H

const { computeSlTp, find1HValidator, detectFP, reactionAt4HZone, WICK_RATIO } = require('./_helpers');
const { lastClosedIndex } = require('../multiTF');

const FOUR_H_MS = 4 * 3_600_000;
const FP_RECENCY_BARS_4H = 3;
const SL_BUFFER_FRAC = 0.005;

// We re-derive 4H FPs once from the 4H ctx and stash them on the strategy's ctx.
function ensureFPs(ctx) {
  if (ctx._fps4H) return ctx._fps4H;
  ctx._fps4H = detectFP(ctx.candles4H, ctx.ctx4H.swings);
  return ctx._fps4H;
}

function buildSetup({ wantSide, c, fp, swept, ctx, validator, label }) {
  const entry = c.close;
  // SL: just beyond the swept level (same side, with buffer)
  const slPrice = wantSide === 'long'
    ? +(swept * (1 - SL_BUFFER_FRAC)).toFixed(8)
    : +(swept * (1 + SL_BUFFER_FRAC)).toFixed(8);
  const zone = wantSide === 'long' ? { high: swept, low: slPrice } : { high: slPrice, low: swept };
  const { tpPrice, rr, target } = computeSlTp({
    side: wantSide, entry, zone,
    liquidity: ctx.ctx4H.liquidity,
  });

  return {
    setupType: label,
    side: wantSide, entry, slPrice, tpPrice,
    meta: { rr, target, fp: { type: fp.type, sweptLevel: fp.sweptLevel, index: fp.index }, validator },
  };
}

// Trigger: a 1H rejection candle in the FP direction whose wick swept the FP level
// and closed back. We use the 4H FP candle's swept level as a soft anchor.
function isLongTrigger(c, sweptLevel) {
  const range = c.high - c.low;
  if (range === 0) return false;
  if (c.low > sweptLevel) return false; // didn't touch the swept zone
  if (c.close < sweptLevel) return false; // failed to close back above
  const lowerWick = Math.min(c.open, c.close) - c.low;
  return lowerWick / range >= WICK_RATIO;
}

function isShortTrigger(c, sweptLevel) {
  const range = c.high - c.low;
  if (range === 0) return false;
  if (c.high < sweptLevel) return false;
  if (c.close > sweptLevel) return false;
  const upperWick = c.high - Math.max(c.open, c.close);
  return upperWick / range >= WICK_RATIO;
}

function detectFPSetup(idx, ctx) {
  const { aligned, candles1H, candles4H, ctx1H } = ctx;
  const row = aligned[idx];
  if (row.bias_1D === 'neutral') return null;

  const c = candles1H[idx];
  const wantSide = row.bias_1D === 'bullish' ? 'long' : 'short';
  const wantType = wantSide === 'long' ? 'bullish' : 'bearish';

  const idx4H = lastClosedIndex(candles4H, c.time, FOUR_H_MS);
  if (idx4H < 0) return null;

  const fps = ensureFPs(ctx);
  const recentFP = [...fps].reverse().find(fp =>
    fp.type === wantType &&
    fp.index <= idx4H &&
    fp.index >= idx4H - FP_RECENCY_BARS_4H,
  );
  if (!recentFP) return null;

  const triggerOK = wantSide === 'long'
    ? isLongTrigger(c, recentFP.sweptLevel)
    : isShortTrigger(c, recentFP.sweptLevel);
  if (!triggerOK) return null;

  for (const kind of ['SNR', 'RB', 'FVG']) {
    const v = find1HValidator(ctx1H, candles1H, idx, wantSide, kind);
    if (v) return buildSetup({ wantSide, c, fp: recentFP, swept: recentFP.sweptLevel, ctx, validator: v, label: `FP_4H_${kind}_1H` });
  }
  return buildSetup({ wantSide, c, fp: recentFP, swept: recentFP.sweptLevel, ctx, validator: null, label: 'FP_4H' });
}

module.exports = { detectFPSetup, isLongTrigger, isShortTrigger };
