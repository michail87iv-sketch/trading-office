// tests/smc/setups/fp.test.js
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { detectFPSetup, isLongTrigger, isShortTrigger } = require('../../../core/smc/setups/fp');

const FOUR_H_MS = 4 * 3_600_000;

function makeCtx({ bias, c1H, candles4H, swings4H = [], ctx1H = { snrs: [], fvgs: [], rbs: [], swings: [], rejections: [] }, liquidity = [] }) {
  return {
    candles1H: c1H,
    candles4H,
    candles1D: [],
    ctx1H,
    ctx4H: { swings: swings4H, liquidity },
    ctx1D: { structure: [] },
    aligned: c1H.map(() => ({ bias_1D: bias, activePOI_4H: [], contextSwings_4H: {} })),
  };
}

describe('isLongTrigger / isShortTrigger', () => {
  it('long: low касается swept, close выше swept, длинный нижний фитиль', () => {
    const c = { open: 100, high: 101, low: 95, close: 99, volume: 1 };
    assert.equal(isLongTrigger(c, 96), true);
  });
  it('long: close ниже swept → false', () => {
    const c = { open: 100, high: 101, low: 95, close: 95.5, volume: 1 };
    assert.equal(isLongTrigger(c, 96), false);
  });
  it('short: зеркально', () => {
    const c = { open: 100, high: 105, low: 99, close: 101, volume: 1 };
    assert.equal(isShortTrigger(c, 104), true);
  });
});

describe('detectFPSetup', () => {
  it('long: bullish bias, recent 4H bullish FP, 1H trigger при swept-уровне → signal', () => {
    // 4H candles: c0 — обычная, c1 — FP (sweep low at 95, close back above)
    const candles4H = [
      { time: 0,         open: 100, high: 101, low: 96, close: 97, volume: 1 },
      { time: FOUR_H_MS, open: 97,  high: 100, low: 90, close: 99, volume: 1 }, // bullish FP, swept=96
    ];
    const swings4H = [{ index: 0, type: 'low', price: 96 }];
    // 1H candle сразу после закрытия c4H[1]: closes back above 96
    const c1H = [{ time: FOUR_H_MS * 2, open: 99, high: 100, low: 95, close: 99, volume: 1 }];
    const ctx = makeCtx({
      bias: 'bullish', c1H, candles4H, swings4H,
      liquidity: [{ type: 'BSL', price: 110, taken: false }],
    });
    const out = detectFPSetup(0, ctx);
    assert.ok(out, 'expected FP setup');
    assert.equal(out.side, 'long');
    assert.ok(['FP_4H', 'FP_4H_SNR_1H', 'FP_4H_FVG_1H', 'FP_4H_RB_1H'].includes(out.setupType));
    assert.equal(out.meta.fp.sweptLevel, 96);
    assert.ok(out.slPrice < 96);
  });

  it('neutral bias → null', () => {
    const candles4H = [
      { time: 0,         open: 100, high: 101, low: 96, close: 97, volume: 1 },
      { time: FOUR_H_MS, open: 97,  high: 100, low: 90, close: 99, volume: 1 },
    ];
    const swings4H = [{ index: 0, type: 'low', price: 96 }];
    const c1H = [{ time: FOUR_H_MS * 2, open: 99, high: 100, low: 95, close: 99, volume: 1 }];
    const ctx = makeCtx({ bias: 'neutral', c1H, candles4H, swings4H });
    assert.equal(detectFPSetup(0, ctx), null);
  });

  it('нет recent FP (давно был) → null', () => {
    const candles4H = Array.from({ length: 10 }, (_, i) => ({
      time: i * FOUR_H_MS, open: 100, high: 101, low: 99, close: 100, volume: 1,
    }));
    candles4H[0] = { time: 0, open: 100, high: 100, low: 90, close: 99, volume: 1 }; // FP at 0
    const swings4H = [{ index: -1, type: 'low', price: 96 }];
    const c1H = [{ time: 9 * FOUR_H_MS, open: 99, high: 100, low: 95, close: 99, volume: 1 }];
    const ctx = makeCtx({ bias: 'bullish', c1H, candles4H, swings4H });
    assert.equal(detectFPSetup(0, ctx), null);
  });
});
