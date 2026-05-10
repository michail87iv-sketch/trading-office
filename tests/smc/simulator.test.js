// tests/smc/simulator.test.js
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { TradeSimulator } = require('../../core/backtest/simulator');

function bar(time, open, high, low, close) {
  return { time, open, high, low, close, volume: 1 };
}

describe('TradeSimulator — абсолютные цены SL/TP', () => {
  it('long с tpPrice выходит на tpPrice, не на high', () => {
    const sim = new TradeSimulator({
      leverage: 5, riskPct: 1, tp: 5, sl: 2, maxTrades: 1, initialCapital: 100, feeRate: 0, cooldownMin: 0,
    });
    sim.processCandle(bar(0, 100, 101, 99, 100), { direction: 'long', tpPrice: 110, slPrice: 99 });
    sim.processCandle(bar(60_000, 100, 112, 100, 111), null);
    const r = sim.getResults();
    assert.equal(r.trades.length, 1);
    assert.equal(r.trades[0].exit, 110);
    assert.equal(r.trades[0].reason, 'TP');
  });

  it('short с slPrice выходит на slPrice', () => {
    const sim = new TradeSimulator({
      leverage: 5, riskPct: 1, tp: 5, sl: 2, maxTrades: 1, initialCapital: 100, feeRate: 0, cooldownMin: 0,
    });
    sim.processCandle(bar(0, 100, 101, 99, 100), { direction: 'short', tpPrice: 90, slPrice: 105 });
    sim.processCandle(bar(60_000, 100, 106, 99, 102), null);
    const r = sim.getResults();
    assert.equal(r.trades.length, 1);
    assert.equal(r.trades[0].exit, 105);
    assert.equal(r.trades[0].reason, 'SL');
  });

  it('старый интерфейс (signal=string) работает как раньше', () => {
    const sim = new TradeSimulator({
      leverage: 5, riskPct: 1, tp: 1, sl: 1, maxTrades: 1, initialCapital: 100, feeRate: 0, cooldownMin: 0,
    });
    sim.processCandle(bar(0, 100, 101, 99, 100), 'long');
    sim.processCandle(bar(60_000, 100, 102, 100, 101.5), null);
    const r = sim.getResults();
    assert.equal(r.trades.length, 1);
    assert.equal(r.trades[0].exit, 101);
  });

  it('частичный override: только slPrice — tp остаётся в %', () => {
    const sim = new TradeSimulator({
      leverage: 5, riskPct: 1, tp: 1, sl: 5, maxTrades: 1, initialCapital: 100, feeRate: 0, cooldownMin: 0,
    });
    sim.processCandle(bar(0, 100, 101, 99, 100), { direction: 'long', slPrice: 99 });
    sim.processCandle(bar(60_000, 100, 102, 100, 101.5), null);
    const r = sim.getResults();
    assert.equal(r.trades.length, 1);
    assert.equal(r.trades[0].exit, 101);
  });
});
