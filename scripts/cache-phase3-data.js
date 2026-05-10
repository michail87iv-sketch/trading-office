// scripts/cache-phase3-data.js
// Cache 1H/4H/1D for the Phase 3 baseline universe (14 symbols × 3 TF × 1 year).
'use strict';
require('dotenv').config();

const { fetchCandles } = require('../core/backtest/dataLoader');

// 9 majors + 5 meme — picked by liquidity on Bitget USDT-perp.
// Memes via existing 1H cache presence: PEPE, SHIB, WIF, 1000BONK, FARTCOIN.
const SYMBOLS = [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT',
  'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT', 'LINKUSDT',
  'PEPEUSDT', 'SHIBUSDT', 'WIFUSDT', '1000BONKUSDT', 'FARTCOINUSDT',
];
const TIMEFRAMES = ['1H', '4H', '1D'];
const START_DATE = new Date(Date.now() - 365 * 24 * 3600 * 1000).toISOString();
const END_DATE   = new Date().toISOString();

async function main() {
  const total = SYMBOLS.length * TIMEFRAMES.length;
  let done = 0;
  for (const tf of TIMEFRAMES) {
    for (const sym of SYMBOLS) {
      try {
        const candles = await fetchCandles(sym, tf, START_DATE, END_DATE);
        console.log(`[${++done}/${total}] ${sym} ${tf}: ${candles.length} candles`);
      } catch (err) {
        console.error(`[${++done}/${total}] ${sym} ${tf}: ERROR — ${err.message}`);
      }
      await new Promise(r => setTimeout(r, 300));
    }
  }
  console.log('Done.');
}

main().catch(err => { console.error(err); process.exit(1); });
