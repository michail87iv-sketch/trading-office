// tests/smc/helpers.js
'use strict';

let _t = 1000;
function candle(o, h, l, c, vol = 1000, time) {
  return { time: time ?? (_t += 14400000), open: o, high: h, low: l, close: c, vol, volume: vol };
}

function resetTime(start = 1000) { _t = start; }

function flatCandles(n, price = 100, vol = 500) {
  return Array.from({ length: n }, () => candle(price, price + 1, price - 1, price, vol));
}

module.exports = { candle, resetTime, flatCandles };
