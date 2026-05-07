// tests/smc/detectStructure.test.js
'use strict';
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { candle, resetTime } = require('./helpers');
const { detectSwings } = require('../../core/smc/detectSwings');
const { detectStructure } = require('../../core/smc/detectStructure');

beforeEach(() => resetTime());

describe('detectStructure', () => {
  it('returns empty array when no swings provided', () => {
    const candles = Array.from({ length: 10 }, () => candle(10, 11, 9, 10));
    assert.deepEqual(detectStructure(candles, []), []);
  });

  it('detects a bullish BOS — close above swing high', () => {
    const candles = [
      candle(10, 11,  9, 10),  // 0
      candle(10, 12,  9, 11),  // 1
      candle(11, 15, 10, 13),  // 2: swing high (15)
      candle(13, 13,  9, 10),  // 3
      candle(10, 11,  8,  9),  // 4
      candle( 9, 12,  9, 11),  // 5
      candle(11, 14, 10, 13),  // 6
      candle(13, 18, 12, 16),  // 7: BOS — close=16 > swingHigh=15
    ];
    const swings = detectSwings(candles);
    const structure = detectStructure(candles, swings);
    const bos = structure.filter(s => s.type === 'BOS' && s.direction === 'bullish');
    assert.equal(bos.length, 1);
    assert.equal(bos[0].index, 7);
    assert.equal(bos[0].brokenSwingPrice, 15);
  });

  it('detects a bearish BOS — close below swing low', () => {
    const candles = [
      candle(20, 21, 18, 19),  // 0
      candle(19, 20, 17, 18),  // 1
      candle(18, 19, 10, 12),  // 2: swing low (10)
      candle(12, 15, 11, 14),  // 3
      candle(14, 18, 13, 17),  // 4
      candle(17, 18, 12, 13),  // 5
      candle(13, 14, 11, 12),  // 6
      candle(12, 13,  9,  8),  // 7: BOS — close=8 < swingLow=10
    ];
    const swings = detectSwings(candles);
    const structure = detectStructure(candles, swings);
    const bos = structure.filter(s => s.type === 'BOS' && s.direction === 'bearish');
    assert.equal(bos.length, 1);
    assert.equal(bos[0].brokenSwingPrice, 10);
  });

  it('detects a FakeBOS — wick breaks but close stays inside', () => {
    const candles = [
      candle(10, 11,  9, 10),
      candle(10, 12,  9, 11),
      candle(11, 15, 10, 13),  // 2: swing high (15)
      candle(13, 13,  9, 10),
      candle(10, 11,  8,  9),
      candle( 9, 12,  9, 11),
      candle(11, 14, 10, 13),
      candle(13, 16, 12, 14),  // 7: high=16 > 15, BUT close=14 < 15 → FakeBOS
    ];
    const swings = detectSwings(candles);
    const structure = detectStructure(candles, swings);
    const fakeBos = structure.filter(s => s.type === 'FakeBOS');
    assert.equal(fakeBos.length, 1);
    assert.equal(fakeBos[0].direction, 'bullish');
  });

  // Conf = new swing HIGH forms above BOS price (not just "next candle doesn't revert")
  it('detects Conf — new swing HIGH forms above BOS price after bullish BOS', () => {
    // swing HIGH at 2 (price=20) → BOS at 6 (close=22) → new swing HIGH at 9 (price=30) → Conf
    const candles = [
      candle(10, 11,  9, 10),  // 0
      candle(10, 12,  9, 11),  // 1
      candle(11, 20, 10, 13),  // 2: swing HIGH (20) ← to be broken
      candle(13, 13,  9, 10),  // 3
      candle(10, 11,  4,  5),  // 4: swing LOW (4)  ← prior swing (departure point)
      candle( 5,  8,  5,  7),  // 5
      candle( 7, 22,  7, 22),  // 6: BOS (close=22 > 20)
      candle(22, 23, 18, 19),  // 7: pullback
      candle(19, 22, 18, 21),  // 8
      candle(21, 30, 20, 28),  // 9: swing HIGH #2 (high=30) — Conf trigger
      candle(28, 28, 22, 23),  // 10
      candle(23, 25, 21, 22),  // 11
    ];
    const swings = detectSwings(candles);
    const structure = detectStructure(candles, swings);
    const conf = structure.filter(s => s.type === 'Conf');
    assert.equal(conf.length, 1);
    assert.equal(conf[0].direction, 'bullish');
    assert.ok(conf[0].price > 22, 'Conf price should be above BOS price (22)');
  });

  // strong = PRIOR swing (departure point), NOT the broken swing
  it('marks the PRIOR swing low as strong after bullish BOS + Conf', () => {
    // swing HIGH at index 2 (price=20) = broken → stays weak
    // swing LOW at index 4 (price=4) = departure point → should become strong after Conf
    const candles = [
      candle(10, 11,  9, 10),
      candle(10, 12,  9, 11),
      candle(11, 20, 10, 13),  // 2: broken swing HIGH (20) → stays weak
      candle(13, 13,  9, 10),
      candle(10, 11,  4,  5),  // 4: PRIOR swing LOW (4) → should be strong
      candle( 5,  8,  5,  7),
      candle( 7, 22,  7, 22),  // 6: BOS
      candle(22, 23, 18, 19),
      candle(19, 22, 18, 21),
      candle(21, 30, 20, 28),  // 9: swing HIGH #2 → Conf
      candle(28, 28, 22, 23),
      candle(23, 25, 21, 22),
    ];
    const swings = detectSwings(candles);
    detectStructure(candles, swings);

    const brokenHigh = swings.find(s => s.type === 'high' && s.price === 20);
    const priorLow   = swings.find(s => s.type === 'low'  && s.price === 4);
    assert.ok(brokenHigh, 'swing high at 20 must exist');
    assert.ok(priorLow,   'swing low at 4 must exist');
    assert.equal(brokenHigh.strength, 'weak',   'broken swing should stay weak');
    assert.equal(priorLow.strength,   'strong',  'prior (departure) swing should become strong');
  });
});
