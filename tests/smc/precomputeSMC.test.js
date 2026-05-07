// tests/smc/precomputeSMC.test.js
'use strict';
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { candle, resetTime } = require('./helpers');
const { precomputeSMC } = require('../../core/smc/index');

beforeEach(() => resetTime());

describe('precomputeSMC', () => {
  it('returns all required keys in the SMCContext', () => {
    const candles = Array.from({ length: 20 }, (_, i) =>
      candle(10 + i, 12 + i, 9 + i, 11 + i)
    );
    const ctx = precomputeSMC(candles);
    for (const key of ['swings', 'structure', 'fvgs', 'snrs', 'rbs', 'liquidity', 'rejections']) {
      assert.ok(key in ctx, `missing key: ${key}`);
      assert.ok(Array.isArray(ctx[key]), `${key} is not an array`);
    }
  });

  it('returns empty arrays when candles array is too short', () => {
    const ctx = precomputeSMC([candle(10, 12, 9, 11)]);
    assert.deepEqual(ctx.swings, []);
    assert.deepEqual(ctx.structure, []);
    assert.deepEqual(ctx.fvgs, []);
  });

  it('detects at least one swing high in a V-pattern sequence', () => {
    const candles = [
      candle(10, 11,  9, 10),
      candle(10, 12,  9, 11),
      candle(11, 20, 10, 13),  // swing high (20)
      candle(13, 13,  9, 10),
      candle(10, 11,  8,  9),
      candle( 9, 10,  8,  9),
      candle( 9, 10,  8,  9),
      candle( 9, 10,  8,  9),
      candle( 9, 10,  8,  9),
    ];
    const ctx = precomputeSMC(candles);
    assert.ok(ctx.swings.some(s => s.type === 'high' && s.price === 20));
  });

  it('BOS is detected and appears in structure', () => {
    const candles = [
      candle(10, 11,  9, 10),
      candle(10, 12,  9, 11),
      candle(11, 15, 10, 13),  // swing high (15)
      candle(13, 13,  9, 10),
      candle(10, 11,  8,  9),
      candle( 9, 12,  9, 11),
      candle(11, 14, 10, 13),
      candle(13, 18, 12, 16),  // BOS
    ];
    const ctx = precomputeSMC(candles);
    assert.ok(ctx.structure.some(s => s.type === 'BOS'), 'expected BOS in structure');
  });

  // UPDATED: prior swing (not broken swing) becomes strong after Conf
  it('prior swing is marked strong after BOS + Conf, broken swing stays weak', () => {
    const candles = [
      candle(10, 11,  9, 10),  // 0
      candle(10, 12,  9, 11),  // 1
      candle(11, 20, 10, 13),  // 2: swing HIGH (20) ← broken → must stay weak
      candle(13, 13,  9, 10),  // 3
      candle(10, 11,  4,  5),  // 4: swing LOW (4) ← prior swing → must become strong after Conf
      candle( 5,  8,  5,  7),  // 5
      candle( 7, 22,  7, 22),  // 6: BOS
      candle(22, 23, 18, 19),  // 7
      candle(19, 22, 18, 21),  // 8
      candle(21, 30, 20, 28),  // 9: swing HIGH #2 (30) → Conf
      candle(28, 28, 22, 23),  // 10
      candle(23, 25, 21, 22),  // 11
    ];
    const ctx = precomputeSMC(candles);
    assert.ok(ctx.structure.some(s => s.type === 'Conf'), 'expected Conf');
    const brokenHigh = ctx.swings.find(s => s.type === 'high' && s.price === 20);
    const priorLow   = ctx.swings.find(s => s.type === 'low'  && s.price === 4);
    assert.ok(brokenHigh && brokenHigh.strength === 'weak',  'broken swing must stay weak');
    assert.ok(priorLow   && priorLow.strength   === 'strong', 'prior swing must be strong');
  });
});
