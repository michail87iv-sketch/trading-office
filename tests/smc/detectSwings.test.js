// tests/smc/detectSwings.test.js
'use strict';
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { candle, resetTime } = require('./helpers');
const { detectSwings } = require('../../core/smc/detectSwings');

beforeEach(() => resetTime());

describe('detectSwings', () => {
  it('returns empty array for fewer than 2*N+1 candles', () => {
    const candles = [candle(10, 12, 9, 11), candle(11, 13, 10, 12), candle(12, 14, 11, 13)];
    assert.deepEqual(detectSwings(candles), []);
  });

  it('detects a swing high in the middle of a 5-candle sequence', () => {
    const candles = [
      candle(10, 11,  9, 10),  // 0
      candle(10, 12,  9, 11),  // 1
      candle(11, 15, 10, 13),  // 2: SWING HIGH (high=15 > all ±2 neighbors)
      candle(13, 13,  9, 10),  // 3
      candle(10, 11,  8,  9),  // 4
    ];
    const swings = detectSwings(candles);
    const highs = swings.filter(s => s.type === 'high');
    assert.equal(highs.length, 1);
    assert.equal(highs[0].index, 2);
    assert.equal(highs[0].price, 15);
    assert.equal(highs[0].strength, 'weak');
  });

  it('detects a swing low in the middle of a 5-candle sequence', () => {
    const candles = [
      candle(20, 21, 18, 19),  // 0
      candle(19, 20, 17, 18),  // 1
      candle(18, 19, 10, 11),  // 2: SWING LOW (low=10)
      candle(11, 15, 11, 14),  // 3
      candle(14, 18, 13, 17),  // 4
    ];
    const swings = detectSwings(candles);
    const lows = swings.filter(s => s.type === 'low');
    assert.equal(lows.length, 1);
    assert.equal(lows[0].index, 2);
    assert.equal(lows[0].price, 10);
  });

  it('does NOT detect a swing high when a neighbour shares the same high', () => {
    const candles = [
      candle(10, 11,  9, 10),  // 0
      candle(10, 15,  9, 12),  // 1: same high as index 2 → NOT a fractal high at 2
      candle(11, 15, 10, 13),  // 2
      candle(13, 13,  9, 10),  // 3
      candle(10, 11,  8,  9),  // 4
    ];
    const highs = detectSwings(candles).filter(s => s.type === 'high');
    assert.equal(highs.length, 0);
  });

  it('detects multiple swings in a longer sequence', () => {
    const candles = [
      candle(10, 11,  9, 10),  // 0
      candle(10, 12,  9, 11),  // 1
      candle(11, 20, 10, 18),  // 2: HIGH #1 (high=20)
      candle(18, 18,  9,  9),  // 3
      candle( 9, 10,  5,  6),  // 4: LOW #1  (low=5)
      candle( 6, 11,  6, 10),  // 5
      candle(10, 25,  9, 23),  // 6: HIGH #2 (high=25)
      candle(23, 23, 10, 11),  // 7
      candle(11, 12,  4,  5),  // 8: LOW #2  (low=4)
      candle( 5, 10,  5,  9),  // 9
      candle( 9, 11,  8, 10),  // 10
    ];
    const swings = detectSwings(candles);
    const highs = swings.filter(s => s.type === 'high').map(s => s.index);
    const lows  = swings.filter(s => s.type === 'low').map(s => s.index);
    assert.deepEqual(highs, [2, 6]);
    assert.deepEqual(lows,  [4, 8]);
  });

  it('respects custom N parameter', () => {
    const candles = [
      candle(10, 12,  9, 11),  // 0
      candle(11, 20, 10, 18),  // 1: HIGH with N=1 (20 > 12 and 20 > 13)
      candle(18, 13,  9, 10),  // 2
    ];
    const swings = detectSwings(candles, 1);
    const highs = swings.filter(s => s.type === 'high');
    assert.equal(highs.length, 1);
    assert.equal(highs[0].index, 1);
  });
});
