'use strict';

const fs   = require('fs');
const path = require('path');

const { fetchCandles }  = require('./dataLoader');
const { getSignal }     = require('./strategyS1');
const { TradeSimulator } = require('./simulator');

const RESULTS_DIR = path.resolve(__dirname, '../../data/backtest-results');

// Default simulator params (mirrors scalper1.js DEFAULTS)
const SIM_DEFAULTS = {
  leverage:     15,
  riskPct:      1.5,
  tp:           0.7,
  sl:           0.4,
  maxTrades:    3,
  feeRate:      0.0006,
  cooldownMin:  30,
};

// Default strategy params
const STRATEGY_DEFAULTS = {
  rsiPeriod:     14,
  rsiOversold:   30,
  rsiOverbought: 70,
  emaEnabled:    true,
  emaPeriod:     50,
};

function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function saveResult(filename, data) {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  fs.writeFileSync(path.join(RESULTS_DIR, filename), JSON.stringify(data));
}

/**
 * Run strategy + simulator on a pre-loaded candle array.
 * Kept internal so grid search can reuse the same candle array without re-fetching.
 */
function _simulate(candles, params) {
  const simParams      = { ...SIM_DEFAULTS,      ...params };
  const strategyParams = { ...STRATEGY_DEFAULTS, ...params };

  const tradeLimit = simParams.tradeLimit > 0 ? simParams.tradeLimit : 0;

  const sim = new TradeSimulator({
    leverage:       simParams.leverage,
    riskPct:        simParams.riskPct,
    tp:             simParams.tp,
    sl:             simParams.sl,
    maxTrades:      simParams.maxTrades,
    feeRate:        simParams.feeRate,
    cooldownMin:    simParams.cooldownMin,
    initialCapital: simParams.initialCapital,
    tradeLimit,
  });

  for (let i = 0; i < candles.length; i++) {
    const signal = getSignal(candles, i, strategyParams);
    sim.processCandle(candles[i], signal);
    // Early exit once trade limit is reached and all open positions are closed
    if (tradeLimit > 0 && sim.trades.length >= tradeLimit && sim.openTrades.length === 0) break;
  }

  // Close any positions still open at the last bar's close price
  const last = candles[candles.length - 1];
  if (last) sim.closeAll(last.close, last.time);

  return sim.getResults();
}

/**
 * Run a single backtest.
 *
 * @param {Object} config
 * @param {string}  config.symbol         e.g. 'BTCUSDT'
 * @param {string}  config.timeframe      e.g. '1H'
 * @param {string}  config.startDate      ISO date string
 * @param {string}  config.endDate        ISO date string
 * @param {Object}  [config.params={}]    strategy + simulator overrides
 * @param {number}  [config.initialCapital=5]
 * @returns {Promise<{id, symbol, timeframe, startDate, endDate, params, ...results}>}
 */
async function runBacktest(config) {
  const {
    symbol,
    timeframe,
    startDate,
    endDate,
    params         = {},
    initialCapital = 5,
  } = config;

  const id        = makeId();
  const mergedParams = { ...params, initialCapital };
  const filename  = `${id}.json`;

  const candles = await fetchCandles(symbol, timeframe, startDate, endDate);
  if (!candles.length) throw new Error(`No candles returned for ${symbol} ${timeframe}`);

  const results = _simulate(candles, mergedParams);

  const output = {
    id,
    status:   'done',
    symbol,
    timeframe,
    startDate,
    endDate,
    params:   mergedParams,
    candleCount: candles.length,
    ...results,
  };

  saveResult(filename, output);
  console.log(`[runner] backtest ${id} done — ${results.stats.totalTrades} trades, PnL ${results.stats.totalPnl}`);
  return output;
}

/**
 * Generate all param combinations from a paramRanges spec.
 *
 * @param {Object} paramRanges  e.g. { rsiPeriod: {min:10,max:20,step:2}, rsiOversold: {min:20,max:35,step:5} }
 * @returns {Array<Object>}
 */
function _buildGrid(paramRanges) {
  const keys   = Object.keys(paramRanges);
  const values = keys.map(() => []);

  for (let ki = 0; ki < keys.length; ki++) {
    const k = keys[ki];
    const { min, max, step = 1 } = paramRanges[k];
    const vals = [];
    for (let v = min; v <= max + 1e-9; v += step) vals.push(+v.toFixed(10));
    values[ki] = vals;
  }

  // Cartesian product
  let combos = [{}];
  for (let ki = 0; ki < keys.length; ki++) {
    const next = [];
    for (const existing of combos) {
      for (const val of values[ki]) {
        next.push({ ...existing, [keys[ki]]: val });
      }
    }
    combos = next;
  }
  return combos;
}

/**
 * Run a grid search over param combinations.
 *
 * @param {Object} config
 * @param {string}  config.symbol
 * @param {string}  config.timeframe
 * @param {string}  config.startDate
 * @param {string}  config.endDate
 * @param {Object}  config.paramRanges   e.g. { rsiPeriod: {min:10,max:20,step:2} }
 * @param {number}  [config.initialCapital=5]
 * @returns {Promise<{id, results[]}>}
 */
async function runGridSearch(config) {
  const {
    symbol,
    timeframe,
    startDate,
    endDate,
    paramRanges    = {},
    initialCapital = 5,
  } = config;

  const id      = makeId();
  const combos  = _buildGrid(paramRanges);
  console.log(`[runner] grid ${id}: ${combos.length} combinations for ${symbol} ${timeframe}`);

  // Fetch candles once — all runs share the same data (cache ensures no double-download)
  const candles = await fetchCandles(symbol, timeframe, startDate, endDate);
  if (!candles.length) throw new Error(`No candles returned for ${symbol} ${timeframe}`);

  const gridResults = [];
  for (let i = 0; i < combos.length; i++) {
    const params       = { ...combos[i], initialCapital };
    const results      = _simulate(candles, params);
    const runId        = makeId();
    gridResults.push({
      id:     runId,
      params,
      stats:  results.stats,
    });
    // Save individual run result too (lightweight — no equityCurve/trades)
    if ((i + 1) % 10 === 0) {
      console.log(`[runner] grid ${id}: ${i + 1}/${combos.length} done`);
    }
  }

  // Sort by winRate descending, break ties by totalPnl
  gridResults.sort((a, b) => {
    const wDiff = b.stats.winRate - a.stats.winRate;
    return wDiff !== 0 ? wDiff : b.stats.totalPnl - a.stats.totalPnl;
  });

  const output = {
    id,
    status:    'done',
    symbol,
    timeframe,
    startDate,
    endDate,
    paramRanges,
    candleCount: candles.length,
    totalRuns:   gridResults.length,
    results:     gridResults,
  };

  saveResult(`grid_${id}.json`, output);
  console.log(`[runner] grid ${id} done — ${gridResults.length} runs, best winRate: ${gridResults[0]?.stats.winRate}`);
  return output;
}

module.exports = { runBacktest, runGridSearch };
