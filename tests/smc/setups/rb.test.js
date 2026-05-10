// tests/smc/setups/rb.test.js
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { detectRBSetup } = require('../../../core/smc/setups/rb');

const FOUR_H_MS = 4 * 3_600_000;

function makeCtx({ bias, c1H, poi, swings1H = [], liquidity = [] }) {
  const c4H = [{ time: 0, open: 100, high: 100, low: 100, close: 100, volume: 1 }];
  return {
    candles1H: c1H, candles4H: c4H, candles1D: [],
    ctx1H: { swings: swings1H, rejections: [] },
    ctx4H: { liquidity },
    ctx1D: { structure: [] },
    aligned: c1H.map(() => ({ bias_1D: bias, activePOI_4H: poi ? [poi] : [], contextSwings_4H: {} })),
  };
}

describe('detectRBSetup', () => {
  it('long: bullish + +RB + reaction + 1H low внутри/рядом → signal', () => {
    const c1H = [{ time: FOUR_H_MS, open: 102, high: 103, low: 100, close: 102.5, volume: 1 }];
    const ctx = makeCtx({
      bias: 'bullish', c1H,
      poi: { kind: 'RB', type: '+RB', high: 100.5, low: 99.5, index: 0 },
      swings1H: [{ index: -1, type: 'low', price: 100.0 }], // inside zone
      liquidity: [{ type: 'BSL', price: 110, taken: false }],
    });
    const out = detectRBSetup(0, ctx);
    assert.ok(out);
    assert.equal(out.setupType, 'RB_4H');
    assert.equal(out.side, 'long');
    assert.ok(out.meta.fhfl);
  });

  it('long, но без 1H FH/FL → no signal', () => {
    const c1H = [{ time: FOUR_H_MS, open: 102, high: 103, low: 100, close: 102.5, volume: 1 }];
    const ctx = makeCtx({
      bias: 'bullish', c1H,
      poi: { kind: 'RB', type: '+RB', high: 100.5, low: 99.5, index: 0 },
      swings1H: [],
    });
    assert.equal(detectRBSetup(0, ctx), null);
  });

  it('long, 1H low далеко от зоны (>0.5%) → no signal', () => {
    const c1H = [{ time: FOUR_H_MS, open: 102, high: 103, low: 100, close: 102.5, volume: 1 }];
    const ctx = makeCtx({
      bias: 'bullish', c1H,
      poi: { kind: 'RB', type: '+RB', high: 100.5, low: 99.5, index: 0 },
      swings1H: [{ index: -1, type: 'low', price: 95 }],
    });
    assert.equal(detectRBSetup(0, ctx), null);
  });

  it('short: bearish + -RB → signal', () => {
    const c1H = [{ time: FOUR_H_MS, open: 99, high: 100, low: 98, close: 98.5, volume: 1 }];
    const ctx = makeCtx({
      bias: 'bearish', c1H,
      poi: { kind: 'RB', type: '-RB', high: 100.5, low: 99.5, index: 0 },
      swings1H: [{ index: -1, type: 'high', price: 100.0 }],
      liquidity: [{ type: 'SSL', price: 90, taken: false }],
    });
    const out = detectRBSetup(0, ctx);
    assert.ok(out);
    assert.equal(out.side, 'short');
  });
});
