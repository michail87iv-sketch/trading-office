// tests/smc/setups/_helpers.test.js
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  nearestLiquidityTarget, computeSlTp, reactionAt4HZone, detectFP,
} = require('../../../core/smc/setups/_helpers');

describe('nearestLiquidityTarget', () => {
  const liq = [
    { type: 'BSL', price: 110, indices: [0], taken: false },
    { type: 'EQH', price: 105, indices: [1], taken: false },
    { type: 'BSL', price: 120, indices: [2], taken: true },
    { type: 'SSL', price: 90,  indices: [3], taken: false },
  ];

  it('long: ближайший BSL/EQH выше entry с RR >= 1.5', () => {
    const out = nearestLiquidityTarget(liq, 'long', 100, 99); // risk=1, RR floor=1.5 → need price >= 101.5
    assert.equal(out.price, 105);
  });

  it('skip if RR < 1.5', () => {
    const out = nearestLiquidityTarget([{ type: 'BSL', price: 100.5, taken: false }], 'long', 100, 99);
    assert.equal(out, null);
  });

  it('short: ближайший SSL/EQL ниже entry', () => {
    const out = nearestLiquidityTarget(liq, 'short', 100, 101);
    assert.equal(out.price, 90);
  });

  it('пропускает taken=true', () => {
    const out = nearestLiquidityTarget([
      { type: 'BSL', price: 102, taken: true },
      { type: 'BSL', price: 110, taken: false },
    ], 'long', 100, 99);
    assert.equal(out.price, 110);
  });
});

describe('computeSlTp', () => {
  it('long с близкой ликой → ликовый таргет', () => {
    const r = computeSlTp({
      side: 'long', entry: 100,
      zone: { high: 100, low: 99 },
      liquidity: [{ type: 'BSL', price: 105, taken: false }],
    });
    assert.ok(r.slPrice < 99); // под зоной + 0.5% buffer
    assert.equal(r.tpPrice, 105);
    assert.equal(r.target.kind, 'liquidity');
  });

  it('long без ликов → fallback fixed RR=2', () => {
    const r = computeSlTp({
      side: 'long', entry: 100,
      zone: { high: 100, low: 99 },
      liquidity: [],
    });
    assert.equal(r.target.kind, 'fixedRR');
    assert.ok(r.tpPrice > 100);
    assert.ok(Math.abs(r.rr - 2) < 0.01);
  });

  it('short зеркально', () => {
    const r = computeSlTp({
      side: 'short', entry: 100,
      zone: { high: 101, low: 100 },
      liquidity: [{ type: 'SSL', price: 95, taken: false }],
    });
    assert.ok(r.slPrice > 101);
    assert.equal(r.tpPrice, 95);
  });
});

describe('reactionAt4HZone', () => {
  it('bullish reaction: wick в зоне, close выше', () => {
    // low=100 в [99.5..100.5], close=102.5 > 100.5, нижний фитиль = 102-100 = 2, range = 3 → 0.66 ≥ 0.5
    const c = { open: 102, high: 103, low: 100, close: 102.5, volume: 1, time: 0 };
    const out = reactionAt4HZone(c, { high: 100.5, low: 99.5 });
    assert.equal(out, 'bullish');
  });

  it('bearish reaction: wick в зоне, close ниже', () => {
    // high=100 в [99.5..100.5], close=98.5 < 99.5, верхний фитиль = 100-99 = 1, range=2 → 0.5
    const c = { open: 99, high: 100, low: 98, close: 98.5, volume: 1, time: 0 };
    const out = reactionAt4HZone(c, { high: 100.5, low: 99.5 });
    assert.equal(out, 'bearish');
  });

  it('close внутри зоны → null (не реакция)', () => {
    const c = { open: 99, high: 101, low: 98, close: 99.8, volume: 1, time: 0 };
    const out = reactionAt4HZone(c, { high: 100.5, low: 99.5 });
    assert.equal(out, null);
  });

  it('фитиль слишком короткий → null', () => {
    const c = { open: 100, high: 100.4, low: 99.9, close: 100.3, volume: 1, time: 0 };
    const out = reactionAt4HZone(c, { high: 100.2, low: 100 });
    assert.equal(out, null);
  });
});

describe('detectFP', () => {
  it('bearish FP: фитилем пробил swing high, закрылся ниже', () => {
    const candles = [
      { time: 0, open: 100, high: 105, low: 99, close: 104, volume: 1 },
      { time: 1, open: 104, high: 110, low: 100, close: 102, volume: 1 }, // sweep + fail
    ];
    const swings = [{ index: 0, type: 'high', price: 105 }];
    const fps = detectFP(candles, swings, 5);
    assert.equal(fps.length, 1);
    assert.equal(fps[0].type, 'bearish');
    assert.equal(fps[0].sweptLevel, 105);
  });

  it('bullish FP: фитилем пробил swing low, закрылся выше', () => {
    const candles = [
      { time: 0, open: 100, high: 101, low: 95, close: 96, volume: 1 },
      { time: 1, open: 96, high: 100, low: 90, close: 98, volume: 1 },
    ];
    const swings = [{ index: 0, type: 'low', price: 95 }];
    const fps = detectFP(candles, swings, 5);
    assert.equal(fps.length, 1);
    assert.equal(fps[0].type, 'bullish');
    assert.equal(fps[0].sweptLevel, 95);
  });

  it('просто пробой без long-wick → не FP', () => {
    const candles = [
      { time: 0, open: 100, high: 105, low: 99, close: 104, volume: 1 },
      { time: 1, open: 104, high: 110, low: 103, close: 109, volume: 1 }, // bullish breakout, не FP
    ];
    const swings = [{ index: 0, type: 'high', price: 105 }];
    const fps = detectFP(candles, swings, 5);
    assert.equal(fps.length, 0);
  });
});
