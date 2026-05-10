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

function aggregateTF(candles, groupSize) {
  const out = [];
  for (let i = 0; i + groupSize <= candles.length; i += groupSize) {
    const slice = candles.slice(i, i + groupSize);
    out.push({
      time:  slice[0].time,
      open:  slice[0].open,
      high:  Math.max(...slice.map(c => c.high)),
      low:   Math.min(...slice.map(c => c.low)),
      close: slice[slice.length - 1].close,
      volume: slice.reduce((s, c) => s + (c.volume ?? c.vol ?? 0), 0),
    });
  }
  return out;
}

function makeAlignedSet(len1H, basePrice = 100) {
  const c1H = Array.from({ length: len1H }, (_, i) => ({
    time:  i * 3_600_000,
    open:  basePrice,
    high:  basePrice + 1,
    low:   basePrice - 1,
    close: basePrice,
    volume: 1,
  }));
  return { c1H, c4H: aggregateTF(c1H, 4), c1D: aggregateTF(c1H, 24) };
}

module.exports = { candle, resetTime, flatCandles, aggregateTF, makeAlignedSet };
