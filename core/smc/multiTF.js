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

function lastStrongSwing(swings, type, upToIndex) {
  let last = null;
  for (const s of swings) {
    if (s.index > upToIndex) break;
    if (s.type === type && s.strength === 'strong') last = s;
  }
  return last;
}

function activePOIs(ctx, upToIndex) {
  const out = [];
  for (const snr of ctx.snrs) {
    if (snr.indexEnd <= upToIndex && snr.valid) out.push({ kind: 'SNR', ...snr });
  }
  for (const fvg of ctx.fvgs) {
    if (fvg.index <= upToIndex) out.push({ kind: 'FVG', ...fvg });
  }
  for (const rb of ctx.rbs) {
    if (rb.index <= upToIndex) out.push({ kind: 'RB', ...rb });
  }
  return out;
}

// SMC convention: BOS sets bias; Conf reinforces (does NOT reset); FakeBOS resets;
// counter-direction BOS overwrites. Bias persists from a BOS through any number
// of Confs until a FakeBOS or opposite-direction BOS occurs.
function biasFromStructure(structure, upToIndex) {
  let bias = 'neutral';
  for (const ev of structure) {
    if (ev.index > upToIndex) break;
    if (ev.type === 'BOS')          bias = ev.direction;
    else if (ev.type === 'FakeBOS') bias = 'neutral';
    // 'Conf' deliberately ignored — it confirms the prior BOS, bias unchanged.
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
/**
 * Core alignment — works on already-computed contexts and the raw candle arrays.
 * Candles are still required for time-based index mapping between TFs.
 */
function alignFromCtx(ctx1H, ctx4H, ctx1D, candles1H, candles4H, candles1D) {
  return candles1H.map(c1 => {
    const idx1D = lastClosedIndex(candles1D, c1.time, ONE_DAY_MS);
    const idx4H = lastClosedIndex(candles4H, c1.time, FOUR_H_MS);
    const bias_1D = idx1D < 0 ? 'neutral' : biasFromStructure(ctx1D.structure, idx1D);
    return {
      bias_1D,
      activePOI_4H: idx4H < 0 ? [] : activePOIs(ctx4H, idx4H),
      contextSwings_4H: {
        lastStrongHigh: idx4H < 0 ? null : lastStrongSwing(ctx4H.swings, 'high', idx4H),
        lastStrongLow:  idx4H < 0 ? null : lastStrongSwing(ctx4H.swings, 'low',  idx4H),
      },
    };
  });
}

// Thin wrapper — kept for Phase 2 tests and any caller that hasn't pre-computed contexts.
function alignTimeframes(candles1H, candles4H, candles1D) {
  return alignFromCtx(
    precomputeSMC(candles1H),
    precomputeSMC(candles4H),
    precomputeSMC(candles1D),
    candles1H, candles4H, candles1D,
  );
}

module.exports = { alignTimeframes, alignFromCtx, lastClosedIndex, biasFromStructure };
