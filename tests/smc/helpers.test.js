// tests/smc/helpers.test.js
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { aggregateTF, makeAlignedSet } = require('./helpers');

describe('helpers — aggregateTF', () => {
  it('агрегирует 4 1H-свечи в одну 4H-свечу: high=max, low=min, open=first.open, close=last.close', () => {
    const c = [
      { time: 0,            open: 10, high: 12, low:  9, close: 11, volume: 1 },
      { time: 3600_000,     open: 11, high: 15, low: 10, close: 14, volume: 2 },
      { time: 7200_000,     open: 14, high: 14, low:  8, close:  9, volume: 3 },
      { time: 10800_000,    open:  9, high: 13, low:  9, close: 13, volume: 4 },
    ];
    const out = aggregateTF(c, 4);
    assert.equal(out.length, 1);
    assert.deepEqual(out[0], { time: 0, open: 10, high: 15, low: 8, close: 13, volume: 10 });
  });

  it('makeAlignedSet возвращает 1H/4H/1D массивы кратной длины (24 1H = 6 4H = 1 1D)', () => {
    const { c1H, c4H, c1D } = makeAlignedSet(48);
    assert.equal(c1H.length, 48);
    assert.equal(c4H.length, 12);
    assert.equal(c1D.length, 2);
    assert.equal(c4H[0].time, c1H[0].time);
    assert.equal(c1D[0].time, c1H[0].time);
  });
});
