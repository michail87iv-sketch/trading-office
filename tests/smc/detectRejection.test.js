// tests/smc/detectRejection.test.js
'use strict';
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { candle, resetTime } = require('./helpers');
const { detectRejection } = require('../../core/smc/detectRejection');

beforeEach(() => resetTime());

function makeSNR(indexStart, low, high, type = '+SNR') {
  return { indexStart, indexEnd: indexStart, type, low, high, valid: true };
}

describe('detectRejection', () => {
  it('detects a bullish rejection — wick into SNR zone, close above zone', () => {
    // SNR zone [10..15]. Candle: open=17, high=20, low=11 (in zone), close=17 (above zone.high=15)
    // Lower wick = min(open,close)-low = 17-11=6, range=20-11=9 → 67% > 50% ✓
    const candles = [
      candle(17, 20, 11, 17),   // 0: wick=11 enters [10..15], close=17 > 15
    ];
    const snrs = [makeSNR(-1, 10, 15)];
    const rejections = detectRejection(candles, snrs, [], []);
    assert.equal(rejections.length, 1);
    assert.equal(rejections[0].type, 'bullish');
    assert.equal(rejections[0].index, 0);
    assert.equal(rejections[0].wickExtreme, 11);
    assert.equal(rejections[0].poiType, '+SNR');
  });

  it('detects a bearish rejection — wick into FVG zone, close below zone', () => {
    // FVG zone [20..25]. Candle: open=18, high=22 (in zone), low=15, close=18 (below zone.low=20)
    // Upper wick = high-max(open,close) = 22-18=4, range=22-15=7 → 57% > 50% ✓
    const candles = [
      candle(18, 22, 15, 18),
    ];
    const fvgs = [{ index: -1, type: 'bearish', low: 20, high: 25, mid: 22.5, status: 'open', ifvg: false }];
    const rejections = detectRejection(candles, [], fvgs, []);
    assert.equal(rejections.length, 1);
    assert.equal(rejections[0].type, 'bearish');
    assert.equal(rejections[0].wickExtreme, 22);
    assert.equal(rejections[0].poiType, 'FVG');
  });

  it('does NOT detect rejection if wick ratio is below 50%', () => {
    // SNR zone [13..15]. Candle: open=17, high=20, low=14, close=16
    // low=14 is inside zone, close=16 is above zone.high=15 ✓
    // But lower wick = min(17,16)-14=2, range=20-14=6 → 33% < 50% → NO rejection
    const candles = [
      candle(17, 20, 14, 16),
    ];
    const snrs = [makeSNR(-1, 13, 15)];
    assert.equal(detectRejection(candles, snrs, [], []).length, 0);
  });

  it('does NOT detect rejection if close is inside the POI zone', () => {
    // Candle wicks into zone AND close stays inside zone — not a rejection
    const candles = [
      candle(17, 20, 11, 13),   // close=13 inside SNR zone [10..15]
    ];
    const snrs = [makeSNR(-1, 10, 15)];
    assert.equal(detectRejection(candles, snrs, [], []).length, 0);
  });
});
