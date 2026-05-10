// tests/smc/simulator-regression.test.js
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { TradeSimulator } = require('../../core/backtest/simulator');

function bar(time, close) {
  return { time, open: close, high: close + 0.5, low: close - 0.5, close, volume: 1 };
}

function makeRun() {
  const sim = new TradeSimulator({
    leverage: 10, riskPct: 1.5, tp: 0.7, sl: 0.4, maxTrades: 2,
    initialCapital: 100, feeRate: 0.0006, cooldownMin: 30,
  });
  let price = 100;
  for (let i = 0; i < 200; i++) {
    price += (i % 20 < 10) ? 0.3 : -0.3;
    const t = i * 60_000;
    let sig = null;
    if (i % 17 === 0) sig = 'long';
    if (i % 23 === 0) sig = 'short';
    sim.processCandle(bar(t, +price.toFixed(4)), sig);
  }
  return sim.getResults();
}

describe('TradeSimulator — regression на строковом интерфейсе', () => {
  // SNAPSHOT (Phase 2, post-Task 7): totalTrades=11, totalPnl=10.0097, winRate=0.6364
  // If these change after a simulator.js edit — that's a REGRESSION on the legacy string-signal path.
  it('детерминированный прогон даёт стабильные totals (snapshot)', () => {
    const r = makeRun();
    assert.equal(r.stats.totalTrades, 11);
    assert.equal(r.stats.totalPnl,    10.0097);
    assert.equal(r.stats.winRate,     0.6364);
    for (const t of r.trades) {
      assert.ok(['TP', 'SL'].includes(t.reason));
      assert.ok(t.exit > 0 && t.entry > 0);
      assert.ok(['long', 'short'].includes(t.direction));
    }
  });

  it('второй прогон с теми же входами даёт идентичный результат (детерминизм)', () => {
    const a = makeRun();
    const b = makeRun();
    assert.equal(a.stats.totalTrades, b.stats.totalTrades);
    assert.equal(a.stats.totalPnl,    b.stats.totalPnl);
    assert.equal(a.stats.winRate,     b.stats.winRate);
    assert.deepEqual(a.trades.map(t => [t.exit, t.reason]), b.trades.map(t => [t.exit, t.reason]));
  });
});
