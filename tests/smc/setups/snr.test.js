// tests/smc/setups/snr.test.js
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { detectSNRSetup } = require('../../../core/smc/setups/snr');

const FOUR_H_MS = 4 * 3_600_000;

function makeCtx({ bias, c1H, idx, poi, liquidity = [] }) {
  // 4H candle indexed s.t. lastClosedIndex(c4H, c1H[idx].time, 4h) >= 0
  const c4H = [{ time: 0, open: 100, high: 100, low: 100, close: 100, volume: 1 }];
  return {
    candles1H: c1H,
    candles4H: c4H,
    candles1D: [],
    ctx1H: { swings: [], rejections: [] },
    ctx4H: { liquidity },
    ctx1D: { structure: [] },
    aligned: c1H.map(() => ({
      bias_1D: bias,
      activePOI_4H: poi ? [poi] : [],
      contextSwings_4H: { lastStrongHigh: null, lastStrongLow: null },
    })),
  };
}

describe('detectSNRSetup', () => {
  it('long: bullish bias + +SNR + 1H bullish reaction → long signal', () => {
    const c1H = [
      { time: FOUR_H_MS,         open: 102, high: 103, low: 100, close: 102.5, volume: 1 },
    ];
    const ctx = makeCtx({
      bias: 'bullish', c1H, idx: 0,
      poi: { kind: 'SNR', type: '+SNR', high: 100.5, low: 99.5, indexStart: 0, indexEnd: 0, valid: true },
      liquidity: [{ type: 'BSL', price: 110, taken: false }],
    });
    const out = detectSNRSetup(0, ctx);
    assert.ok(out, 'expected setup');
    assert.equal(out.setupType, 'SNR_4H');
    assert.equal(out.side, 'long');
    assert.equal(out.entry, 102.5);
    assert.ok(out.slPrice < 99.5);
    assert.ok(out.tpPrice >= 110);
  });

  it('neutral bias → no signal', () => {
    const c1H = [{ time: FOUR_H_MS, open: 102, high: 103, low: 100, close: 102.5, volume: 1 }];
    const ctx = makeCtx({
      bias: 'neutral', c1H, idx: 0,
      poi: { kind: 'SNR', type: '+SNR', high: 100.5, low: 99.5, indexStart: 0, indexEnd: 0, valid: true },
    });
    assert.equal(detectSNRSetup(0, ctx), null);
  });

  it('side mismatch (bearish bias + +SNR) → no signal', () => {
    const c1H = [{ time: FOUR_H_MS, open: 102, high: 103, low: 100, close: 102.5, volume: 1 }];
    const ctx = makeCtx({
      bias: 'bearish', c1H, idx: 0,
      poi: { kind: 'SNR', type: '+SNR', high: 100.5, low: 99.5, indexStart: 0, indexEnd: 0, valid: true },
    });
    assert.equal(detectSNRSetup(0, ctx), null);
  });

  it('no reaction (close внутри зоны) → no signal', () => {
    const c1H = [{ time: FOUR_H_MS, open: 99, high: 101, low: 98, close: 99.8, volume: 1 }];
    const ctx = makeCtx({
      bias: 'bullish', c1H, idx: 0,
      poi: { kind: 'SNR', type: '+SNR', high: 100.5, low: 99.5, indexStart: 0, indexEnd: 0, valid: true },
    });
    assert.equal(detectSNRSetup(0, ctx), null);
  });

  it('short: bearish bias + -SNR + bearish reaction', () => {
    const c1H = [{ time: FOUR_H_MS, open: 99, high: 100, low: 98, close: 98.5, volume: 1 }];
    const ctx = makeCtx({
      bias: 'bearish', c1H, idx: 0,
      poi: { kind: 'SNR', type: '-SNR', high: 100.5, low: 99.5, indexStart: 0, indexEnd: 0, valid: true },
      liquidity: [{ type: 'SSL', price: 90, taken: false }],
    });
    const out = detectSNRSetup(0, ctx);
    assert.ok(out);
    assert.equal(out.side, 'short');
    assert.ok(out.tpPrice <= 95);
  });
});
