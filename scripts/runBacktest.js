// scripts/runBacktest.js
// Phase 3 baseline backtest — strategySmcHunter on 14 symbols × 1 year.
'use strict';
require('dotenv').config();

const fs   = require('fs');
const path = require('path');

const { fetchCandles }  = require('../core/backtest/dataLoader');
const { TradeSimulator } = require('../core/backtest/simulator');

const STRATEGY_PATH = process.env.STRAT || '../core/backtest/strategySmcHunter';
const stratMod = require(STRATEGY_PATH);

const SYMBOLS = (process.env.SYMBOLS || [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT',
  'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT', 'LINKUSDT',
  'PEPEUSDT', 'SHIBUSDT', 'WIFUSDT', '1000BONKUSDT', 'FARTCOINUSDT',
].join(',')).split(',').map(s => s.trim()).filter(Boolean);

const DAYS  = parseInt(process.env.DAYS  || '365', 10);
const END   = process.env.END   ? new Date(process.env.END).toISOString()   : new Date().toISOString();
const START = process.env.START ? new Date(process.env.START).toISOString() : new Date(Date.now() - DAYS * 86400_000).toISOString();

const SIM_PARAMS = {
  leverage:       10,
  riskPct:        1.0,
  maxTrades:      3,
  initialCapital: 100,
  feeRate:        0.0006,
  cooldownMin:    0,
  // tp/sl % required by simulator constructor but won't be used —
  // strategy returns absolute slPrice/tpPrice per signal.
  tp:             1,
  sl:             1,
};

const RUNS_DIR = path.resolve(__dirname, '../runs');

function pct(n, d) { return d === 0 ? 0 : +(n / d * 100).toFixed(2); }
function safeNum(n) { return Number.isFinite(n) ? +n.toFixed(4) : 0; }

function dailyPnls(equityCurve, trades) {
  // Bucket realised PnL by day from trades.closedAt.
  const buckets = new Map();
  for (const t of trades) {
    const day = new Date(t.closedAt).toISOString().slice(0, 10);
    buckets.set(day, (buckets.get(day) || 0) + t.pnl);
  }
  return [...buckets.values()];
}

function sharpe(daily) {
  if (daily.length < 2) return 0;
  const mean = daily.reduce((s, x) => s + x, 0) / daily.length;
  const variance = daily.reduce((s, x) => s + (x - mean) ** 2, 0) / daily.length;
  const sd = Math.sqrt(variance);
  if (sd === 0) return 0;
  return +((mean / sd) * Math.sqrt(365)).toFixed(3);
}

function distributionBySetup(trades) {
  const dist = {};
  for (const t of trades) {
    const k = t.setupType || 'UNKNOWN';
    if (!dist[k]) dist[k] = { count: 0, wins: 0, pnl: 0 };
    dist[k].count++;
    if (t.pnl > 0) dist[k].wins++;
    dist[k].pnl += t.pnl;
  }
  for (const k of Object.keys(dist)) {
    dist[k].pnl     = +dist[k].pnl.toFixed(4);
    dist[k].winRate = pct(dist[k].wins, dist[k].count);
  }
  return dist;
}

async function loadCandlesByTF(symbol, tfs) {
  const out = {};
  for (const tf of tfs) {
    out[tf] = await fetchCandles(symbol, tf, START, END);
  }
  return out;
}

async function runOne(symbol) {
  const tfs = stratMod.requiredTimeframes ?? ['1H'];
  const candlesByTF = await loadCandlesByTF(symbol, tfs);
  const c1H = candlesByTF['1H'] || [];
  if (c1H.length < 100) {
    return { symbol, skipped: true, reason: `not enough 1H candles (${c1H.length})` };
  }

  const { precompute, signal } = stratMod.buildStrategy({});
  const ctx = precompute(symbol, candlesByTF);

  const sim = new TradeSimulator(SIM_PARAMS);
  const setupBySymbol = []; // remember setupType per opened trade for later attribution

  for (let i = 0; i < c1H.length; i++) {
    const candle = c1H[i];
    const sig = signal(i, ctx);
    if (sig) {
      sim.processCandle(candle, {
        direction: sig.side,
        slPrice:   sig.slPrice,
        tpPrice:   sig.tpPrice,
        setupType: sig.setupType,
        meta:      sig.meta,
      });
    } else {
      sim.processCandle(candle, null);
    }
  }
  const last = c1H[c1H.length - 1];
  if (last && sim.openTrades.length) sim.closeAll(last.close, last.time);
  const results = sim.getResults();
  return {
    symbol,
    candlesProcessed: c1H.length,
    stats: results.stats,
    trades: results.trades,
    sharpe: sharpe(dailyPnls(results.equityCurve, results.trades)),
  };
}

(async () => {
  fs.mkdirSync(RUNS_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outFile = path.join(RUNS_DIR, `phase3-baseline-${ts}.json`);

  const perSymbol = [];
  let total = { trades: 0, wins: 0, pnl: 0, dailyPnls: [] };

  for (const symbol of SYMBOLS) {
    process.stdout.write(`[${symbol}] loading… `);
    try {
      const r = await runOne(symbol);
      if (r.skipped) {
        console.log(`SKIP — ${r.reason}`);
        perSymbol.push(r);
        continue;
      }
      console.log(`done. trades=${r.stats.totalTrades} pnl=${r.stats.totalPnl} winRate=${r.stats.winRate}`);
      perSymbol.push(r);
      total.trades += r.stats.totalTrades;
      total.wins   += r.stats.wins;
      total.pnl    += r.stats.totalPnl;
      total.dailyPnls.push(...dailyPnls([], r.trades));
    } catch (err) {
      console.log(`FAIL — ${err.message}`);
      perSymbol.push({ symbol, error: err.message });
    }
  }

  // Aggregate distribution by setupType (across all symbols).
  const allTrades = perSymbol.flatMap(s => (s.trades || []));
  const dist = distributionBySetup(allTrades);

  const summary = {
    runId:      ts,
    period:     { start: START, end: END },
    symbols:    SYMBOLS,
    simParams:  SIM_PARAMS,
    aggregate: {
      totalTrades: total.trades,
      wins:        total.wins,
      winRate:     pct(total.wins, total.trades),
      totalPnl:    safeNum(total.pnl),
      sharpe:      sharpe(total.dailyPnls),
      distribution: dist,
    },
    perSymbol,
  };

  fs.writeFileSync(outFile, JSON.stringify(summary, null, 2));
  console.log('---');
  console.log(`Wrote ${outFile}`);
  console.log(`Aggregate: trades=${summary.aggregate.totalTrades} winRate=${summary.aggregate.winRate}% pnl=${summary.aggregate.totalPnl} sharpe=${summary.aggregate.sharpe}`);
  console.log('Distribution by setupType:');
  for (const [k, v] of Object.entries(dist)) {
    console.log(`  ${k.padEnd(20)} count=${v.count} winRate=${v.winRate}% pnl=${v.pnl}`);
  }
})().catch(err => { console.error(err); process.exit(1); });
