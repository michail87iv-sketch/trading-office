'use strict';

const ind = require('./indicators');

// ─── Strategy signal factories ────────────────────────────────────────────────

const STRATEGIES = {

  ema_crossover: (params) => (candles, closes, i) => {
    const { fastEma, slowEma, rsiVals, rsiMin = 0, rsiMax = 100 } = params._cache;
    if (!fastEma[i] || !slowEma[i]) return null;
    const r = rsiVals ? rsiVals[i] : 50;
    if (r == null) return null;
    if (ind.crossOver(fastEma, slowEma, i) && r >= rsiMin && r <= rsiMax) return 'long';
    if (ind.crossUnder(fastEma, slowEma, i) && r <= (100 - rsiMin) && r >= (100 - rsiMax)) return 'short';
    return null;
  },

  rsi_reversion: (params) => (candles, closes, i) => {
    const { rsiVals, trendEma } = params._cache;
    if (!rsiVals[i] || !rsiVals[i - 1]) return null;
    const aboveTrend = !trendEma || trendEma[i] == null || closes[i] >= trendEma[i];
    const belowTrend = !trendEma || trendEma[i] == null || closes[i] <= trendEma[i];
    if (ind.crossOver(rsiVals, new Array(rsiVals.length).fill(params.oversold), i) && aboveTrend) return 'long';
    if (ind.crossUnder(rsiVals, new Array(rsiVals.length).fill(params.overbought), i) && belowTrend) return 'short';
    return null;
  },

  macd_momentum: (params) => (candles, closes, i) => {
    const { hist, trendEma } = params._cache;
    if (hist[i] == null || hist[i - 1] == null) return null;
    const aboveTrend = !trendEma || trendEma[i] == null || closes[i] >= trendEma[i];
    const belowTrend = !trendEma || trendEma[i] == null || closes[i] <= trendEma[i];
    if (hist[i] > 0 && hist[i - 1] <= 0 && aboveTrend) return 'long';
    if (hist[i] < 0 && hist[i - 1] >= 0 && belowTrend) return 'short';
    return null;
  },

  bollinger_reversion: (params) => (candles, closes, i) => {
    const { bb, rsiVals } = params._cache;
    if (!bb.lower[i] || !bb.upper[i] || !bb.lower[i - 1]) return null;
    const rsiOk = !rsiVals || rsiVals[i] != null;
    const rsiLow = rsiVals ? rsiVals[i] < (params.rsiOversold || 40) : true;
    const rsiHigh = rsiVals ? rsiVals[i] > (params.rsiOverbought || 60) : true;
    if (ind.crossOver(closes.map((v, j) => v), bb.lower, i) && rsiLow) return 'long';
    if (ind.crossUnder(closes.map((v, j) => v), bb.upper, i) && rsiHigh) return 'short';
    return null;
  },

  bollinger_breakout: (params) => (candles, closes, i) => {
    const { bb, volAvg } = params._cache;
    if (!bb.upper[i] || !bb.lower[i]) return null;
    const volSpike = !volAvg || volAvg[i] == null || candles[i].vol > volAvg[i] * (params.volMult || 1.5);
    if (closes[i] > bb.upper[i] && closes[i - 1] <= bb.upper[i - 1] && volSpike) return 'long';
    if (closes[i] < bb.lower[i] && closes[i - 1] >= bb.lower[i - 1] && volSpike) return 'short';
    return null;
  },

  ema_rsi_combo: (params) => (candles, closes, i) => {
    const { trendEma, rsiVals } = params._cache;
    if (!trendEma[i] || !rsiVals[i] || !rsiVals[i - 1]) return null;
    const threshold = params.rsiThreshold || 50;
    if (closes[i] > trendEma[i] && ind.crossOver(rsiVals, new Array(rsiVals.length).fill(threshold), i)) return 'long';
    if (closes[i] < trendEma[i] && ind.crossUnder(rsiVals, new Array(rsiVals.length).fill(threshold), i)) return 'short';
    return null;
  },

  atr_breakout: (params) => (candles, closes, i) => {
    const { atrVals, trendEma } = params._cache;
    if (!atrVals[i]) return null;
    const lb = params.lookback || 10;
    if (i < lb) return null;
    const recentHigh = Math.max(...candles.slice(i - lb, i).map(c => c.high));
    const recentLow  = Math.min(...candles.slice(i - lb, i).map(c => c.low));
    const mult       = params.atrMult || 0.5;
    const aboveTrend = !trendEma || trendEma[i] == null || closes[i] >= trendEma[i];
    const belowTrend = !trendEma || trendEma[i] == null || closes[i] <= trendEma[i];
    if (closes[i] > recentHigh + atrVals[i] * mult && aboveTrend) return 'long';
    if (closes[i] < recentLow  - atrVals[i] * mult && belowTrend) return 'short';
    return null;
  },

  stoch_rsi: (params) => (candles, closes, i) => {
    const { stochK, stochD, trendEma } = params._cache;
    if (!stochK[i] || !stochD[i] || !stochK[i - 1]) return null;
    const aboveTrend = !trendEma || trendEma[i] == null || closes[i] >= trendEma[i];
    const belowTrend = !trendEma || trendEma[i] == null || closes[i] <= trendEma[i];
    const ob = params.overbought || 80;
    const os = params.oversold   || 20;
    if (ind.crossOver(stochK, stochD, i) && stochK[i] < os && aboveTrend) return 'long';
    if (ind.crossUnder(stochK, stochD, i) && stochK[i] > ob && belowTrend) return 'short';
    return null;
  },
};

// ─── Pre-compute indicator cache ──────────────────────────────────────────────

function buildCache(type, params, candles) {
  const closes = candles.map(c => c.close);
  const cache  = {};

  switch (type) {
    case 'ema_crossover':
      cache.fastEma = ind.ema(closes, params.fast  || 9);
      cache.slowEma = ind.ema(closes, params.slow  || 21);
      if (params.rsiPeriod) cache.rsiVals = ind.rsi(closes, params.rsiPeriod);
      break;

    case 'rsi_reversion':
      cache.rsiVals  = ind.rsi(closes, params.period || 14);
      if (params.trendPeriod) cache.trendEma = ind.ema(closes, params.trendPeriod);
      break;

    case 'macd_momentum':
      const m = ind.macd(closes, params.fast || 12, params.slow || 26, params.signal || 9);
      cache.hist = m.histogram;
      if (params.trendPeriod) cache.trendEma = ind.ema(closes, params.trendPeriod);
      break;

    case 'bollinger_reversion':
    case 'bollinger_breakout':
      cache.bb = ind.bollingerBands(closes, params.period || 20, params.mult || 2.0);
      if (params.rsiPeriod) cache.rsiVals = ind.rsi(closes, params.rsiPeriod);
      if (type === 'bollinger_breakout' && params.volPeriod) {
        cache.volAvg = ind.sma(candles.map(c => c.vol), params.volPeriod);
      }
      break;

    case 'ema_rsi_combo':
      cache.trendEma = ind.ema(closes, params.emaPeriod || 50);
      cache.rsiVals  = ind.rsi(closes, params.rsiPeriod || 14);
      break;

    case 'atr_breakout':
      cache.atrVals  = ind.atr(candles, params.period || 14);
      if (params.trendPeriod) cache.trendEma = ind.ema(closes, params.trendPeriod);
      break;

    case 'stoch_rsi':
      const sr = ind.stochRsi(closes, params.rsiPeriod || 14, params.stochPeriod || 14, params.kSmooth || 3, params.dSmooth || 3);
      cache.stochK   = sr.k;
      cache.stochD   = sr.d;
      if (params.trendPeriod) cache.trendEma = ind.ema(closes, params.trendPeriod);
      break;
  }

  params._cache = cache;
  return closes;
}

// ─── Core simulation ──────────────────────────────────────────────────────────

const FEE_RT = 0.001; // 0.1% round-trip (taker fee × 2)

function simulate(candles, signalFn, tpPct, slPct, warmup = 50) {
  const trades  = [];
  let   trade   = null;

  for (let i = warmup + 1; i < candles.length; i++) {
    const c = candles[i];

    if (trade) {
      // ── Check exit on current bar ──
      let exit = null;
      if (trade.dir === 'long') {
        if (c.low  <= trade.sl) exit = { price: trade.sl, reason: 'sl' };
        else if (c.high >= trade.tp) exit = { price: trade.tp, reason: 'tp' };
      } else {
        if (c.high >= trade.sl) exit = { price: trade.sl, reason: 'sl' };
        else if (c.low  <= trade.tp) exit = { price: trade.tp, reason: 'tp' };
      }
      if (!exit && i === candles.length - 1) {
        exit = { price: c.close, reason: 'eod' };
      }

      if (exit) {
        const pnlPct = trade.dir === 'long'
          ? (exit.price - trade.entry) / trade.entry - FEE_RT
          : (trade.entry - exit.price) / trade.entry - FEE_RT;
        trades.push({
          dir:    trade.dir,
          entry:  trade.entry,
          exit:   exit.price,
          reason: exit.reason,
          pnlPct,
          win:    pnlPct > 0,
          openBar:  trade.openBar,
          closeBar: i,
        });
        trade = null;
      }

    } else {
      // ── Check entry on previous bar's signal ──
      const sig = signalFn(candles, candles.map(c => c.close), i - 1);
      if (!sig) continue;

      const entry = c.open; // enter at open of next bar
      const tp = sig === 'long'
        ? entry * (1 + tpPct / 100)
        : entry * (1 - tpPct / 100);
      const sl = sig === 'long'
        ? entry * (1 - slPct / 100)
        : entry * (1 + slPct / 100);

      trade = { dir: sig, entry, tp, sl, openBar: i };
    }
  }

  return trades;
}

// ─── Metrics ──────────────────────────────────────────────────────────────────

function calcMetrics(trades, capital = 100) {
  if (!trades.length) return null;

  const wins   = trades.filter(t => t.win);
  const losses = trades.filter(t => !t.win);

  const grossProfit = wins.reduce((s, t) => s + t.pnlPct, 0);
  const grossLoss   = Math.abs(losses.reduce((s, t) => s + t.pnlPct, 0));
  const profitFactor = grossLoss === 0 ? 99 : grossProfit / grossLoss;

  // Equity curve
  let equity = capital;
  let peak   = capital;
  let maxDD  = 0;
  const curve = [capital];
  for (const t of trades) {
    equity *= (1 + t.pnlPct);
    curve.push(equity);
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak;
    if (dd > maxDD) maxDD = dd;
  }

  const totalReturn = (equity - capital) / capital;

  // Annualised Sharpe (assuming each trade ~= 1 time unit)
  const returns = trades.map(t => t.pnlPct);
  const meanR   = returns.reduce((s, v) => s + v, 0) / returns.length;
  const stdR    = Math.sqrt(returns.reduce((s, v) => s + (v - meanR) ** 2, 0) / returns.length);
  const sharpe  = stdR === 0 ? 0 : (meanR / stdR) * Math.sqrt(252);

  return {
    trades:       trades.length,
    wins:         wins.length,
    losses:       losses.length,
    winRate:      +(wins.length / trades.length).toFixed(4),
    profitFactor: +profitFactor.toFixed(3),
    maxDD:        +maxDD.toFixed(4),
    totalReturn:  +totalReturn.toFixed(4),
    sharpe:       +sharpe.toFixed(3),
    avgWin:       wins.length ? +(grossProfit / wins.length * 100).toFixed(3) : 0,
    avgLoss:      losses.length ? +(grossLoss / losses.length * 100).toFixed(3) : 0,
    equity:       +equity.toFixed(2),
    curve,
  };
}

// ─── Walk-forward backtest ────────────────────────────────────────────────────

/**
 * Main entry point.
 * @param {object[]} candles  - full OHLCV array sorted oldest→newest
 * @param {object}   strategy - { type, params, tp, sl }
 * @param {object}   opts     - { walkForward, trainRatio, warmup }
 */
function backtest(candles, strategy, opts = {}) {
  const { type, params, tp = 1.5, sl = 0.8 } = strategy;
  const { walkForward = true, trainRatio = 0.7, warmup = 60 } = opts;

  if (!STRATEGIES[type]) throw new Error(`Unknown strategy type: ${type}`);

  // Build indicator cache on full dataset
  const closes = buildCache(type, params, candles);

  // Split for walk-forward
  const splitIdx   = walkForward ? Math.floor(candles.length * trainRatio) : 0;
  const testCandles = walkForward ? candles.slice(splitIdx) : candles;

  // Re-build cache on test portion (avoid lookahead in indicator calc)
  const testParams = { ...params };
  buildCache(type, testParams, testCandles);
  const signalFn = STRATEGIES[type](testParams);

  const trades  = simulate(testCandles, signalFn, tp, sl, warmup);
  const metrics = calcMetrics(trades);

  // Also run on full set for total picture
  const allSignalFn = STRATEGIES[type](params);
  const allTrades   = simulate(candles, allSignalFn, tp, sl, warmup);
  const fullMetrics = calcMetrics(allTrades);

  return {
    strategy,
    metrics,          // walk-forward test period
    fullMetrics,      // full dataset
    trades,           // test period trades
    splitIdx,
    candles: candles.length,
    testCandles: testCandles.length,
  };
}

// ─── Strategy defaults (for researcher) ──────────────────────────────────────

const STRATEGY_DEFAULTS = {
  ema_crossover:       { fast: 9, slow: 21, rsiPeriod: 14, rsiMin: 40, rsiMax: 60 },
  rsi_reversion:       { period: 14, oversold: 30, overbought: 70, trendPeriod: 50 },
  macd_momentum:       { fast: 12, slow: 26, signal: 9, trendPeriod: 50 },
  bollinger_reversion: { period: 20, mult: 2.0, rsiPeriod: 14, rsiOversold: 35, rsiOverbought: 65 },
  bollinger_breakout:  { period: 20, mult: 2.0, volPeriod: 20, volMult: 1.5 },
  ema_rsi_combo:       { emaPeriod: 50, rsiPeriod: 14, rsiThreshold: 50 },
  atr_breakout:        { period: 14, lookback: 10, atrMult: 0.5, trendPeriod: 50 },
  stoch_rsi:           { rsiPeriod: 14, stochPeriod: 14, kSmooth: 3, dSmooth: 3, oversold: 20, overbought: 80, trendPeriod: 50 },
};

const STRATEGY_PARAM_RANGES = {
  ema_crossover:       { fast: [3,20], slow: [15,100], rsiPeriod: [7,21], rsiMin: [30,50], rsiMax: [50,70] },
  rsi_reversion:       { period: [7,21], oversold: [20,40], overbought: [60,80], trendPeriod: [20,200] },
  macd_momentum:       { fast: [6,15], slow: [18,30], signal: [5,12], trendPeriod: [20,200] },
  bollinger_reversion: { period: [10,30], mult: [1.5,3.0], rsiPeriod: [7,21], rsiOversold: [25,45], rsiOverbought: [55,75] },
  bollinger_breakout:  { period: [10,30], mult: [1.5,3.0], volPeriod: [10,30], volMult: [1.2,3.0] },
  ema_rsi_combo:       { emaPeriod: [20,200], rsiPeriod: [7,21], rsiThreshold: [40,60] },
  atr_breakout:        { period: [7,21], lookback: [5,20], atrMult: [0.3,2.0], trendPeriod: [20,200] },
  stoch_rsi:           { rsiPeriod: [7,21], stochPeriod: [7,21], kSmooth: [2,5], dSmooth: [2,5], oversold: [15,30], overbought: [70,85], trendPeriod: [20,200] },
};

const STRATEGY_TYPES = Object.keys(STRATEGIES);

const { fetchCandles }     = require('./backtest/dataLoader');
const { calcRSI, calcEMA }          = require('./backtest/indicators');
const { getSignal }                 = require('./backtest/strategyS1');
const { TradeSimulator }            = require('./backtest/simulator');
const { runBacktest, runGridSearch } = require('./backtest/runner');

module.exports = {
  backtest, calcMetrics, STRATEGY_DEFAULTS, STRATEGY_PARAM_RANGES, STRATEGY_TYPES,
  fetchCandles, calcRSI, calcEMA, getSignal, TradeSimulator, runBacktest, runGridSearch,
};
