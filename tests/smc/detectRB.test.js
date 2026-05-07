// tests/smc/detectRB.test.js
'use strict';
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { candle, resetTime } = require('./helpers');
const { detectRB } = require('../../core/smc/detectRB');

beforeEach(() => resetTime());

describe('detectRB', () => {
  it('detects a +RB — bearish→bullish pair where wick tests KL and both close above KL', () => {
    // KL at price=10 (e.g. swing low)
    // Candle 0: bearish, low=10 (wick tests KL), close=12 (above KL) ✓
    // Candle 1: bullish, close=16 (above KL) ✓
    const candles = [
      candle(14, 15, 10, 12),   // 0: bearish (close=12 < open=14), wick=10 tests KL
      candle(12, 17, 12, 16),   // 1: bullish (close=16 > open=12)
      candle(16, 18, 15, 17),   // 2
    ];
    const keyLevels = [{ price: 10 }];
    const rbs = detectRB(candles, keyLevels);
    assert.equal(rbs.length, 1);
    assert.equal(rbs[0].type, '+RB');
    assert.equal(rbs[0].index, 0);
    assert.equal(rbs[0].klPrice, 10);
    assert.equal(rbs[0].low,  10);   // min(a.low, b.low)
    assert.equal(rbs[0].high, 17);   // max(a.high, b.high)
  });

  it('detects a -RB — bullish→bearish pair where wick tests KL and both close below KL', () => {
    // KL at price=20
    // Candle 0: bullish, high=20 (wick tests KL), close=17 (below KL) ✓
    // Candle 1: bearish, close=14 (below KL) ✓
    const candles = [
      candle(15, 20, 14, 17),   // 0: bullish (close=17 > open=15), wick=20 tests KL
      candle(17, 18, 13, 14),   // 1: bearish (close=14 < open=17)
      candle(14, 15, 12, 13),   // 2
    ];
    const keyLevels = [{ price: 20 }];
    const rbs = detectRB(candles, keyLevels);
    assert.equal(rbs.length, 1);
    assert.equal(rbs[0].type, '-RB');
    assert.equal(rbs[0].klPrice, 20);
  });

  it('does NOT detect RB when no keyLevels provided', () => {
    const candles = [
      candle(14, 15, 10, 12),
      candle(12, 17, 12, 16),
    ];
    assert.equal(detectRB(candles, []).length, 0);
  });

  it('does NOT detect RB when wick does not reach KL', () => {
    // KL at price=5, candles range from 10-20 → wick never reaches KL
    const candles = [
      candle(15, 16, 12, 13),   // bearish, low=12 far from KL=5
      candle(13, 18, 13, 17),   // bullish
    ];
    const keyLevels = [{ price: 5 }];
    assert.equal(detectRB(candles, keyLevels).length, 0);
  });

  it('does NOT detect +RB when a body closes below KL', () => {
    // KL at 10. Bearish candle has close=9 < KL — body is NOT above KL → invalid
    const candles = [
      candle(14, 15,  8,  9),   // 0: bearish, wick=8 (tests KL=10) but close=9 < KL!
      candle( 9, 17,  9, 16),   // 1: bullish, close=16 > KL
    ];
    const keyLevels = [{ price: 10 }];
    assert.equal(detectRB(candles, keyLevels).length, 0);
  });
});
