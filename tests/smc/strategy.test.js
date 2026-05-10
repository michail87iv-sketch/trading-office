// tests/smc/strategy.test.js
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const stratMod = require('../../core/backtest/strategySmcHunter');

describe('strategySmcHunter — module contract', () => {
  it('exports requiredTimeframes and buildStrategy', () => {
    assert.deepEqual(stratMod.requiredTimeframes, ['1H', '4H', '1D']);
    assert.equal(typeof stratMod.buildStrategy, 'function');
  });

  it('buildStrategy returns { precompute, signal }', () => {
    const s = stratMod.buildStrategy({});
    assert.equal(typeof s.precompute, 'function');
    assert.equal(typeof s.signal, 'function');
  });

  it('precompute on empty inputs returns valid shape', () => {
    const s = stratMod.buildStrategy({});
    const ctx = s.precompute('X', { '1H': [], '4H': [], '1D': [] });
    assert.equal(ctx.aligned.length, 0);
    assert.deepEqual(ctx.candles1H, []);
    assert.equal(s.signal(0, ctx), null);
  });

  it('signal: bias_1D=neutral на flat данных → null на всех индексах', () => {
    const s = stratMod.buildStrategy({});
    const c = (t, p) => ({ time: t, open: p, high: p + 0.5, low: p - 0.5, close: p, volume: 1 });
    const c1H = Array.from({ length: 100 }, (_, i) => c(i * 3.6e6, 100));
    const c4H = Array.from({ length: 25 },  (_, i) => c(i * 14.4e6, 100));
    const c1D = Array.from({ length: 5 },   (_, i) => c(i * 86.4e6, 100));
    const ctx = s.precompute('X', { '1H': c1H, '4H': c4H, '1D': c1D });
    assert.ok(ctx.aligned.every(r => r.bias_1D === 'neutral'));
    let signals = 0;
    for (let i = 0; i < c1H.length; i++) if (s.signal(i, ctx)) signals++;
    assert.equal(signals, 0);
  });
});
