// tests/smc/multiTF.test.js
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { makeAlignedSet } = require('./helpers');
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
