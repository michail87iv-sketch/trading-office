'use strict';

const { fetchCandles }          = require('./dataLoader');
const { calcRSI, calcEMA }      = require('./indicators');
const { getSignal }             = require('./strategyS1');
const { TradeSimulator }        = require('./simulator');
const { runBacktest, runGridSearch } = require('./runner');

module.exports = { fetchCandles, calcRSI, calcEMA, getSignal, TradeSimulator, runBacktest, runGridSearch };
