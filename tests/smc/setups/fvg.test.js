// tests/smc/setups/fvg.test.js
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { detectFVGSetup, isLongVCValid, isShortVCValid } = require('../../../core/smc/setups/fvg');

const FOUR_H_MS = 4 * 3_600_000;

function makeCtx({ bias, c1H, poi, ctx1H = { snrs: [], fvgs: [], rbs: [], swings: [], rejections: [] }, liquidity = [] }) {
  const c4H = [{ time: 0, open: 100, high: 100, low: 100, close: 100, volume: 1 }];
  return {
    candles1H: c1H, candles4H: c4H, candles1D: [],
    ctx1H, ctx4H: { liquidity }, ctx1D: { structure: [] },
    aligned: c1H.map(() => ({ bias_1D: bias, activePOI_4H: poi ? [poi] : [], contextSwings_4H: {} })),
  };
}

describe('isLongVCValid / isShortVCValid', () => {
  it('long: close выше fvg.high, wick касается зоны → valid', () => {
    const c = { open: 102, high: 103, low: 100.3, close: 102.5, volume: 1 };
    assert.equal(isLongVCValid(c, { high: 100.5, low: 99.5 }), true);
  });
  it('long: close внутри FVG → invalid (гэп залит триггером)', () => {
    const c = { open: 99, high: 101, low: 98, close: 100, volume: 1 };
    assert.equal(isLongVCValid(c, { high: 100.5, low: 99.5 }), false);
  });
  it('short: зеркально', () => {
    const c = { open: 98, high: 99.7, low: 97, close: 97.5, volume: 1 };
    assert.equal(isShortVCValid(c, { high: 100.5, low: 99.5 }), true);
  });
});

describe('detectFVGSetup', () => {
  it('intra-TF FVG_4H: long, нет 1H confluence → label FVG_4H', () => {
    const c1H = [{ time: FOUR_H_MS, open: 102, high: 103, low: 100.3, close: 102.5, volume: 1 }];
    const ctx = makeCtx({
      bias: 'bullish', c1H,
      poi: { kind: 'FVG', type: 'bullish', high: 100.5, low: 99.5, index: 0 },
      liquidity: [{ type: 'BSL', price: 110, taken: false }],
    });
    const out = detectFVGSetup(0, ctx);
    assert.ok(out);
    assert.equal(out.setupType, 'FVG_4H');
    assert.equal(out.side, 'long');
  });

  it('cross-TF: 1H SNR на триггерной свече → FVG_4H_SNR_1H', () => {
    const c1H = [{ time: FOUR_H_MS, open: 102, high: 103, low: 100.3, close: 102.5, volume: 1 }];
    const ctx = makeCtx({
      bias: 'bullish', c1H,
      poi: { kind: 'FVG', type: 'bullish', high: 100.5, low: 99.5, index: 0 },
      ctx1H: {
        snrs: [{ type: '+SNR', high: 101, low: 100, indexStart: 0, indexEnd: 0, valid: true }],
        fvgs: [], rbs: [], swings: [], rejections: [],
      },
      liquidity: [{ type: 'BSL', price: 110, taken: false }],
    });
    const out = detectFVGSetup(0, ctx);
    assert.ok(out);
    assert.equal(out.setupType, 'FVG_4H_SNR_1H');
  });

  it('neutral bias → null', () => {
    const c1H = [{ time: FOUR_H_MS, open: 102, high: 103, low: 100.3, close: 102.5, volume: 1 }];
    const ctx = makeCtx({
      bias: 'neutral', c1H,
      poi: { kind: 'FVG', type: 'bullish', high: 100.5, low: 99.5, index: 0 },
    });
    assert.equal(detectFVGSetup(0, ctx), null);
  });

  it('VC inside FVG → null', () => {
    const c1H = [{ time: FOUR_H_MS, open: 99, high: 101, low: 98, close: 100, volume: 1 }];
    const ctx = makeCtx({
      bias: 'bullish', c1H,
      poi: { kind: 'FVG', type: 'bullish', high: 100.5, low: 99.5, index: 0 },
    });
    assert.equal(detectFVGSetup(0, ctx), null);
  });

  it('FVG status=FF → null', () => {
    const c1H = [{ time: FOUR_H_MS, open: 102, high: 103, low: 100.3, close: 102.5, volume: 1 }];
    const ctx = makeCtx({
      bias: 'bullish', c1H,
      poi: { kind: 'FVG', type: 'bullish', high: 100.5, low: 99.5, index: 0, status: 'FF' },
    });
    assert.equal(detectFVGSetup(0, ctx), null);
  });
});
