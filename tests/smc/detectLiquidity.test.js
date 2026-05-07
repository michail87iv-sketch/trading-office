// tests/smc/detectLiquidity.test.js
'use strict';
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { candle, resetTime } = require('./helpers');
const { detectSwings } = require('../../core/smc/detectSwings');
const { detectLiquidity } = require('../../core/smc/detectLiquidity');

beforeEach(() => resetTime());

describe('detectLiquidity', () => {
  it('creates BSL from a swing high', () => {
    const candles = [
      candle(10, 11,  9, 10),
      candle(10, 12,  9, 11),
      candle(11, 20, 10, 13),  // 2: swing high (20)
      candle(13, 13,  9, 10),
      candle(10, 11,  8,  9),
    ];
    const swings = detectSwings(candles);
    const liq = detectLiquidity(candles, swings);
    const bsl = liq.filter(l => l.type === 'BSL');
    assert.equal(bsl.length, 1);
    assert.equal(bsl[0].price, 20);
    assert.equal(bsl[0].taken, false);
  });

  it('creates SSL from a swing low', () => {
    const candles = [
      candle(20, 21, 18, 19),
      candle(19, 20, 17, 18),
      candle(18, 19,  5, 12),  // 2: swing low (5)
      candle(12, 15, 11, 14),
      candle(14, 18, 13, 17),
    ];
    const swings = detectSwings(candles);
    const liq = detectLiquidity(candles, swings);
    const ssl = liq.filter(l => l.type === 'SSL');
    assert.equal(ssl.length, 1);
    assert.equal(ssl[0].price, 5);
    assert.equal(ssl[0].taken, false);
  });

  it('marks BSL as taken when a candle sweeps above and closes back below', () => {
    const candles = [
      candle(10, 11,  9, 10),
      candle(10, 12,  9, 11),
      candle(11, 20, 10, 13),  // 2: swing high = BSL at 20
      candle(13, 13,  9, 10),
      candle(10, 11,  8,  9),
      candle( 9, 23,  9, 11),  // 5: high=23 sweeps BSL (>20), close=11 back below → taken
    ];
    const swings = detectSwings(candles);
    const liq = detectLiquidity(candles, swings);
    const bsl = liq.filter(l => l.type === 'BSL');
    assert.equal(bsl[0].taken, true);
  });

  it('detects EQH when two swing highs are within 0.1% threshold', () => {
    const candles = [
      candle(10, 11,  9, 10),
      candle(10, 12,  9, 11),
      candle(11, 20.00, 10, 13),  // 2: swing high 20.00
      candle(13, 13,    9, 10),
      candle(10, 11,    8,  9),
      candle( 9, 12,    9, 11),
      candle(11, 20.01, 10, 13), // 6: swing high 20.01 — EQH (diff=0.05% < 0.1%)
      candle(13, 13,    9, 10),
      candle(10, 11,    8,  9),
    ];
    const swings = detectSwings(candles);
    const liq = detectLiquidity(candles, swings);
    const eqh = liq.filter(l => l.type === 'EQH');
    assert.equal(eqh.length, 1);
    assert.equal(eqh[0].indices.length, 2);
  });
});
