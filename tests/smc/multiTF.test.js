// tests/smc/multiTF.test.js
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { makeAlignedSet, aggregateTF } = require('./helpers');
const { alignTimeframes } = require('../../core/smc/multiTF');

describe('alignTimeframes — output shape', () => {
  it('возвращает массив длины candles1H.length', () => {
    const { c1H, c4H, c1D } = makeAlignedSet(48);
    const out = alignTimeframes(c1H, c4H, c1D);
    assert.equal(out.length, 48);
  });

  it('каждая запись содержит ключи bias_1D, activePOI_4H, contextSwings_4H', () => {
    const { c1H, c4H, c1D } = makeAlignedSet(48);
    const out = alignTimeframes(c1H, c4H, c1D);
    for (const row of out) {
      assert.ok('bias_1D'         in row);
      assert.ok('activePOI_4H'    in row);
      assert.ok('contextSwings_4H' in row);
      assert.ok(Array.isArray(row.activePOI_4H));
    }
  });

  it('на flat-данных без структуры bias_1D = neutral, activePOI_4H = []', () => {
    const { c1H, c4H, c1D } = makeAlignedSet(48);
    const out = alignTimeframes(c1H, c4H, c1D);
    assert.equal(out[0].bias_1D, 'neutral');
    assert.deepEqual(out[0].activePOI_4H, []);
  });
});

describe('alignTimeframes — bias_1D', () => {
  it('1D с bullish BOS даёт bias_1D=bullish независимо от 4H', () => {
    const c1D = [];
    let t = 0;
    const step1D = 24 * 3_600_000;
    for (let i = 0; i < 10; i++) c1D.push({ time: t += step1D, open: 100, high: 101, low:  99, close: 100, volume: 1 });
    c1D.push({ time: t += step1D, open: 100, high: 110, low: 100, close: 108, volume: 1 });
    c1D.push({ time: t += step1D, open: 108, high: 120, low: 105, close: 118, volume: 1 });
    c1D.push({ time: t += step1D, open: 118, high: 119, low: 110, close: 112, volume: 1 });
    for (let i = 0; i < 6; i++) c1D.push({ time: t += step1D, open: 112, high: 115, low: 105, close: 110, volume: 1 });
    for (let i = 0; i < 11; i++) c1D.push({ time: t += step1D, open: 110, high: 130, low: 110, close: 128, volume: 1 });
    const c1H = Array.from({ length: 30 * 24 }, (_, i) => ({
      time: i * 3_600_000, open: 100, high: 101, low: 99, close: 100, volume: 1,
    }));
    const c4H = aggregateTF(c1H, 4);
    const out = alignTimeframes(c1H, c4H, c1D);
    assert.equal(out[out.length - 1].bias_1D, 'bullish');
  });

  it('flat 1D → bias_1D=neutral', () => {
    const { c1H, c4H, c1D } = makeAlignedSet(48);
    const out = alignTimeframes(c1H, c4H, c1D);
    assert.equal(out[out.length - 1].bias_1D, 'neutral');
  });
});
