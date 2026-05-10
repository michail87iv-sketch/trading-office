// core/smc/setups/_helpers.js
'use strict';

const { getStopLossPrice, getTakeProfitPrice, getRiskRewardRatio } = require('../levels');

const MIN_RR_FLOOR = 1.5;
const RR_FALLBACK  = 2.0;
const SL_BUFFER    = 0.005;
const WICK_RATIO   = 0.5;

/**
 * Pick the closest non-taken liquidity in trade direction.
 * Long → BSL or EQH above entry. Short → SSL or EQL below entry.
 * If the closest yields RR < MIN_RR_FLOOR, return null so caller can fall back to fixed RR.
 * @returns {{ price, type } | null}
 */
function nearestLiquidityTarget(liquidity, side, entry, slPrice) {
  const wantLong  = side === 'long';
  const wantTypes = wantLong ? ['BSL', 'EQH'] : ['SSL', 'EQL'];
  const cmp = (a, b) => wantLong ? a - b : b - a;

  const candidates = liquidity
    .filter(l => !l.taken && wantTypes.includes(l.type))
    .filter(l => wantLong ? l.price > entry : l.price < entry)
    .sort((a, b) => cmp(a.price, b.price));

  for (const cand of candidates) {
    const rr = getRiskRewardRatio(entry, slPrice, cand.price);
    if (rr >= MIN_RR_FLOOR) return { price: cand.price, type: cand.type, rr };
  }
  return null;
}

/**
 * Compute SL + TP for a setup. TP priority:
 *   1) nearest non-taken liquidity giving RR >= 1.5
 *   2) fixed RR=2 fallback via getTakeProfitPrice
 */
function computeSlTp({ side, entry, zone, liquidity }) {
  const direction = side;
  const slPrice = getStopLossPrice({ direction, high: zone.high, low: zone.low }, { bufferPct: SL_BUFFER });

  const liqTarget = nearestLiquidityTarget(liquidity, side, entry, slPrice);
  if (liqTarget) {
    return { slPrice, tpPrice: liqTarget.price, rr: liqTarget.rr, target: { kind: 'liquidity', ...liqTarget } };
  }
  const tpPrice = getTakeProfitPrice(entry, slPrice, RR_FALLBACK);
  return { slPrice, tpPrice, rr: RR_FALLBACK, target: { kind: 'fixedRR' } };
}

/**
 * Check whether a 1H candle reacts at a 4H POI zone.
 * Same idea as detectRejection but cross-TF — 4H zone, 1H candle.
 * @returns {'bullish'|'bearish'|null}
 */
function reactionAt4HZone(c1H, zone) {
  const range = c1H.high - c1H.low;
  if (range === 0) return null;

  const lowerWick = Math.min(c1H.open, c1H.close) - c1H.low;
  if (c1H.low >= zone.low && c1H.low <= zone.high && c1H.close > zone.high) {
    if (lowerWick / range >= WICK_RATIO) return 'bullish';
  }

  const upperWick = c1H.high - Math.max(c1H.open, c1H.close);
  if (c1H.high >= zone.low && c1H.high <= zone.high && c1H.close < zone.low) {
    if (upperWick / range >= WICK_RATIO) return 'bearish';
  }

  return null;
}

/**
 * Detect Failure Pivot (FP) on 4H: a candle sweeps a recent swing high/low
 * but closes back on the same side. Long upper/lower wick required.
 * @returns {{ index, type, sweptLevel, sweptSwingIndex }[]}
 */
function detectFP(candles, swings, lookbackSwings = 20) {
  const fps = [];
  const highs = swings.filter(s => s.type === 'high');
  const lows  = swings.filter(s => s.type === 'low');

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const range = c.high - c.low;
    if (range === 0) continue;

    // Bearish FP: sweep recent swing high, close back below it.
    const recentHighs = highs.filter(s => s.index < i).slice(-lookbackSwings);
    for (const sh of recentHighs) {
      if (c.high > sh.price && c.close < sh.price) {
        const upperWick = c.high - Math.max(c.open, c.close);
        if (upperWick / range >= WICK_RATIO) {
          fps.push({ index: i, type: 'bearish', sweptLevel: sh.price, sweptSwingIndex: sh.index });
          break;
        }
      }
    }

    // Bullish FP: sweep recent swing low, close back above it.
    const recentLows = lows.filter(s => s.index < i).slice(-lookbackSwings);
    for (const sl of recentLows) {
      if (c.low < sl.price && c.close > sl.price) {
        const lowerWick = Math.min(c.open, c.close) - c.low;
        if (lowerWick / range >= WICK_RATIO) {
          fps.push({ index: i, type: 'bullish', sweptLevel: sl.price, sweptSwingIndex: sl.index });
          break;
        }
      }
    }
  }
  return fps;
}

/**
 * Find a 1H POI (SNR/FVG/RB) that the trigger candle reacts INSIDE (price in zone).
 * Used as cross-TF validator: 4H POI + 1H POI confluence.
 * @param {Object} ctx1H
 * @param {number} idx1H
 * @param {'long'|'short'} side
 * @param {'SNR'|'FVG'|'RB'} kind
 * @returns {Object | null}
 */
function find1HValidator(ctx1H, candles1H, idx1H, side, kind) {
  const c = candles1H[idx1H];
  if (!c) return null;

  if (kind === 'SNR') {
    for (const snr of ctx1H.snrs) {
      if (!snr.valid) continue;
      if (snr.indexStart > idx1H || snr.indexEnd > idx1H) continue;
      if (side === 'long'  && snr.type !== '+SNR') continue;
      if (side === 'short' && snr.type !== '-SNR') continue;
      if (c.low <= snr.high && c.high >= snr.low) return { kind: 'SNR', high: snr.high, low: snr.low };
    }
  } else if (kind === 'FVG') {
    for (const fvg of ctx1H.fvgs) {
      if (fvg.index >= idx1H) continue;
      if (fvg.status === 'FF') continue;
      if (side === 'long'  && fvg.type !== 'bullish') continue;
      if (side === 'short' && fvg.type !== 'bearish') continue;
      if (c.low <= fvg.high && c.high >= fvg.low) return { kind: 'FVG', high: fvg.high, low: fvg.low };
    }
  } else if (kind === 'RB') {
    for (const rb of ctx1H.rbs) {
      if (rb.index >= idx1H) continue;
      if (side === 'long'  && rb.type !== '+RB') continue;
      if (side === 'short' && rb.type !== '-RB') continue;
      if (c.low <= rb.high && c.high >= rb.low) return { kind: 'RB', high: rb.high, low: rb.low };
    }
  }
  return null;
}

module.exports = {
  MIN_RR_FLOOR, RR_FALLBACK, SL_BUFFER, WICK_RATIO,
  nearestLiquidityTarget, computeSlTp,
  reactionAt4HZone, detectFP, find1HValidator,
};
