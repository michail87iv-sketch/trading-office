// tests/smc/levels.test.js
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { getStopLossPrice, getTakeProfitPrice, getRiskRewardRatio } = require('../../core/smc/levels');

describe('getStopLossPrice', () => {
  it('long на +SNR [100..105] с buffer 0.5% → 99.50', () => {
    const sl = getStopLossPrice({
      kind: 'SNR', type: '+SNR', direction: 'long', high: 105, low: 100,
    });
    assert.equal(sl, 99.5);
  });

  it('short на -SNR [100..105] с buffer 0.5% → 105.525', () => {
    const sl = getStopLossPrice({
      kind: 'SNR', type: '-SNR', direction: 'short', high: 105, low: 100,
    });
    assert.equal(sl, 105.525);
  });

  it('long на bullish FVG [200..210] с buffer 1% → 198', () => {
    const sl = getStopLossPrice({
      kind: 'FVG', type: 'bullish', direction: 'long', high: 210, low: 200,
    }, { bufferPct: 0.01 });
    assert.equal(sl, 198);
  });

  it('явная zone в setup побеждает high/low', () => {
    const sl = getStopLossPrice({
      kind: 'RB', direction: 'long', high: 999, low: 999,
      zone: { high: 50, low: 48 },
    });
    assert.equal(sl, +(48 * 0.995).toFixed(8));
  });
});

describe('getTakeProfitPrice', () => {
  it('long entry=100 sl=99 rr=2.5 → tp=102.5', () => {
    assert.equal(getTakeProfitPrice(100, 99, 2.5), 102.5);
  });
  it('short entry=100 sl=101 rr=2.5 → tp=97.5', () => {
    assert.equal(getTakeProfitPrice(100, 101, 2.5), 97.5);
  });
  it('бросает если entry == sl', () => {
    assert.throws(() => getTakeProfitPrice(100, 100, 2));
  });
});

describe('getRiskRewardRatio', () => {
  it('long: entry=100 sl=99 tp=102.5 → 2.5', () => {
    assert.equal(getRiskRewardRatio(100, 99, 102.5), 2.5);
  });
  it('short: entry=100 sl=101 tp=97.5 → 2.5', () => {
    assert.equal(getRiskRewardRatio(100, 101, 97.5), 2.5);
  });
});
