// tests/smc/detectSNR.test.js
'use strict';
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { candle, resetTime } = require('./helpers');
const { detectSNR } = require('../../core/smc/detectSNR');

beforeEach(() => resetTime());

describe('detectSNR', () => {
  it('detects a bullish +SNR — 3 consolidation candles then bullish breakout', () => {
    // Candles 0-2 consolidate in [9..15], candle 3 breaks out above (close=19 > 15)
    const candles = [
      candle(12, 15,  9, 11),   // 0: zone start → zHigh=15, zLow=9
      candle(11, 14, 10, 12),   // 1: stays in zone
      candle(12, 13,  9, 11),   // 2: stays in zone (j-i=3 ≥ 3 ✓)
      candle(11, 20, 11, 19),   // 3: bullish breakout (close=19 > zHigh=15)
      candle(19, 22, 18, 21),   // 4
    ];
    const snrs = detectSNR(candles, [], []);
    assert.equal(snrs.length, 1);
    assert.equal(snrs[0].type, '+SNR');
    assert.equal(snrs[0].indexStart, 0);
    assert.equal(snrs[0].indexEnd,   2);
    assert.equal(snrs[0].high, 15);
    assert.equal(snrs[0].low,   9);
    assert.equal(snrs[0].valid, false);
  });

  it('detects a bearish -SNR — 3 consolidation candles then bearish breakout', () => {
    // Candles 0-2 consolidate in [15..22], candle 3 breaks out below (close=9 < 15)
    const candles = [
      candle(18, 22, 15, 19),   // 0
      candle(19, 21, 16, 18),   // 1
      candle(18, 20, 15, 17),   // 2 (j-i=3 ≥ 3 ✓)
      candle(17, 18,  8,  9),   // 3: bearish breakout (close=9 < zLow=15)
      candle( 9, 10,  6,  7),   // 4
    ];
    const snrs = detectSNR(candles, [], []);
    assert.equal(snrs.length, 1);
    assert.equal(snrs[0].type, '-SNR');
    assert.equal(snrs[0].indexStart, 0);
    assert.equal(snrs[0].indexEnd,   2);
    assert.equal(snrs[0].high, 22);
    assert.equal(snrs[0].low,  15);
  });

  it('does NOT detect SNR when consolidation is fewer than 3 candles', () => {
    // Only 2 consolidation candles before breakout
    const candles = [
      candle(12, 15,  9, 11),   // 0
      candle(11, 14, 10, 12),   // 1 (j-i=2 < 3 → skip)
      candle(12, 20, 12, 19),   // 2: breakout too early
    ];
    assert.equal(detectSNR(candles, [], []).length, 0);
  });

  it('valid stays false when no retest occurs', () => {
    const candles = [
      candle(12, 15,  9, 11),
      candle(11, 14, 10, 12),
      candle(12, 13,  9, 11),
      candle(11, 20, 11, 19),   // breakout
      candle(19, 22, 18, 21),
      candle(21, 23, 19, 22),   // price keeps going up — no retest
    ];
    const snrs = detectSNR(candles, [], []);
    assert.equal(snrs[0].valid, false);
  });

  it('valid becomes true when retest sweeps SSL inside the zone', () => {
    // +SNR zone [9..15]. After breakout, price retests zone.
    // SSL at price=10 (inside zone) is taken → valid=true
    const candles = [
      candle(12, 15,  9, 11),   // 0
      candle(11, 14, 10, 12),   // 1
      candle(12, 13,  9, 11),   // 2
      candle(11, 20, 11, 19),   // 3: breakout
      candle(19, 22, 18, 21),   // 4
      candle(21, 23, 10, 12),   // 5: retest — low=10 enters zone [9..15]
    ];
    const liquidity = [{ type: 'SSL', price: 10, indices: [0], taken: true }];
    const snrs = detectSNR(candles, liquidity, []);
    assert.equal(snrs[0].valid, true);
  });

  it('valid becomes true when retest enters a zone that contains a FVG', () => {
    // +SNR zone [9..15]. FVG [10..12] is inside the zone. Price retests zone → valid=true
    const candles = [
      candle(12, 15,  9, 11),   // 0
      candle(11, 14, 10, 12),   // 1
      candle(12, 13,  9, 11),   // 2
      candle(11, 20, 11, 19),   // 3: breakout
      candle(19, 22, 18, 21),   // 4
      candle(21, 23, 11, 13),   // 5: retest — low=11 enters zone [9..15]
    ];
    // FVG with high=12, low=10 — fully inside zone [9..15]
    const fvgs = [{ index: 1, type: 'bullish', high: 12, low: 10, mid: 11, status: 'open', ifvg: false }];
    const snrs = detectSNR(candles, [], fvgs);
    assert.equal(snrs[0].valid, true);
  });
});
