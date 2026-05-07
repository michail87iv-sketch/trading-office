// tests/smc/detectFVG.test.js
'use strict';
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { candle, resetTime } = require('./helpers');
const { detectFVG } = require('../../core/smc/detectFVG');

beforeEach(() => resetTime());

describe('detectFVG', () => {
  it('detects a bullish FVG — gap between candle[i-2].high and candle[i].low', () => {
    const candles = [
      candle( 8, 10,  7,  9),   // 0: high=10
      candle( 9, 20,  9, 18),   // 1: impulse
      candle(18, 20, 15, 19),   // 2: low=15 > candle[0].high=10 → bullish FVG
      candle(19, 21, 16, 20),
      candle(20, 22, 17, 21),
    ];
    const fvgs = detectFVG(candles);
    assert.equal(fvgs.length, 1);
    assert.equal(fvgs[0].type, 'bullish');
    assert.equal(fvgs[0].low,  10);
    assert.equal(fvgs[0].high, 15);
    assert.equal(fvgs[0].mid,  12.5);
    assert.equal(fvgs[0].index, 2);
    assert.equal(fvgs[0].status, 'open');
    assert.equal(fvgs[0].ifvg, false);
  });

  it('detects a bearish FVG — gap between candle[i-2].low and candle[i].high', () => {
    const candles = [
      candle(22, 24, 20, 21),   // 0: low=20
      candle(21, 21,  8,  9),   // 1: impulse down
      candle(10, 15,  8,  9),   // 2: high=15 < candle[0].low=20 → bearish FVG
      candle( 9, 12,  7,  8),
      candle( 8, 10,  6,  7),
    ];
    const fvgs = detectFVG(candles);
    assert.equal(fvgs.length, 1);
    assert.equal(fvgs[0].type, 'bearish');
    assert.equal(fvgs[0].low,  15);
    assert.equal(fvgs[0].high, 20);
    assert.equal(fvgs[0].mid,  17.5);
  });

  it('updates status to IOFED when price first enters a bullish FVG', () => {
    const candles = [
      candle( 8, 10,  7,  9),   // 0
      candle( 9, 20,  9, 18),   // 1
      candle(18, 20, 15, 19),   // 2: FVG [10..15], mid=12.5
      candle(19, 21, 16, 20),   // 3: stays above
      candle(20, 21, 13, 14),   // 4: low=13, enters zone (13≤15), 13 > mid(12.5) → IOFED
    ];
    const fvgs = detectFVG(candles);
    assert.equal(fvgs[0].status, 'IOFED');
  });

  it('updates status to 0.5 when price reaches midpoint', () => {
    const candles = [
      candle( 8, 10,  7,  9),
      candle( 9, 20,  9, 18),
      candle(18, 20, 15, 19),   // 2: FVG [10..15], mid=12.5
      candle(19, 21, 16, 20),
      candle(20, 21, 12, 13),   // 4: low=12 ≤ mid(12.5) → 0.5
    ];
    const fvgs = detectFVG(candles);
    assert.equal(fvgs[0].status, '0.5');
  });

  it('updates status to FF and sets ifvg=true when fully filled', () => {
    const candles = [
      candle( 8, 10,  7,  9),
      candle( 9, 20,  9, 18),
      candle(18, 20, 15, 19),   // 2: FVG [10..15]
      candle(19, 21, 16, 20),
      candle(20, 21,  9, 10),   // 4: low=9 ≤ fvg.low(10) → FF + ifvg
    ];
    const fvgs = detectFVG(candles);
    assert.equal(fvgs[0].status, 'FF');
    assert.equal(fvgs[0].ifvg, true);
  });

  it('does not detect FVG when there is no gap', () => {
    const candles = [
      candle(10, 15,  9, 12),
      candle(12, 18, 11, 16),
      candle(16, 18, 14, 17),   // low=14 < high[0]=15 → no gap
    ];
    assert.equal(detectFVG(candles).length, 0);
  });

  // NEW: monotonic status — cannot revert once set
  it('does not revert status from 0.5 back to IOFED on a shallow retest', () => {
    const candles = [
      candle( 8, 10,  7,  9),   // 0
      candle( 9, 20,  9, 18),   // 1
      candle(18, 20, 15, 19),   // 2: FVG [10..15], mid=12.5
      candle(19, 21, 11, 13),   // 3: low=11 ≤ mid(12.5) → status becomes '0.5'
      candle(13, 16, 14, 15),   // 4: low=14, enters zone (14≤15) but > mid → must stay '0.5'
    ];
    const fvgs = detectFVG(candles);
    assert.equal(fvgs[0].status, '0.5');  // did NOT revert to IOFED
  });
});
