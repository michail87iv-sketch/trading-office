'use strict';

const axios = require('axios');
const fs    = require('fs');
const path  = require('path');

const BASE_URL  = 'https://api.bitget.com';
const CACHE_DIR = path.resolve(__dirname, '../../data/backtest-cache');

// Bitget spot granularity strings
const TF_MAP = {
  '1m':  '1min',
  '1min':'1min',
  '3m':  '3min',
  '3min':'3min',
  '5m':  '5min',
  '5min':'5min',
  '15m': '15min',
  '15min':'15min',
  '30m': '30min',
  '30min':'30min',
  '1h':  '1h',
  '1H':  '1h',
  '4h':  '4h',
  '4H':  '4h',
  '6h':  '6h',
  '6H':  '6h',
  '12h': '12h',
  '12H': '12h',
  '1d':  '1day',
  '1D':  '1day',
  '1day':'1day',
  '1w':  '1week',
  '1W':  '1week',
};

// Milliseconds per candle
const TF_MS = {
  '1min':  60_000,
  '3min':  180_000,
  '5min':  300_000,
  '15min': 900_000,
  '30min': 1_800_000,
  '1h':    3_600_000,
  '4h':    14_400_000,
  '6h':    21_600_000,
  '12h':   43_200_000,
  '1day':  86_400_000,
  '1week': 604_800_000,
};

// history-candles endpoint has a max limit of 200
const PAGE_LIMIT = 200;

function cacheFile(symbol, granularity, startMs, endMs) {
  return path.join(CACHE_DIR, `${symbol}_${granularity}_${startMs}_${endMs}.json`);
}

function parseDate(d) {
  if (typeof d === 'number') return d;
  return new Date(d).getTime();
}

/**
 * Fetch one page from Bitget spot history-candles.
 * Returns the last PAGE_LIMIT candles ending at or before endTime.
 * @returns {Array} raw candle rows [[ts, o, h, l, c, vol, ...], ...]
 */
async function fetchPage(symbol, granularity, startMs, endMs) {
  const res = await axios.get(`${BASE_URL}/api/v2/spot/market/history-candles`, {
    params: {
      symbol,
      granularity,
      startTime: String(startMs),
      endTime:   String(endMs),
      limit:     String(PAGE_LIMIT),
    },
    timeout: 15_000,
  });

  if (res.data.code !== '00000') {
    throw new Error(`Bitget API error ${res.data.code}: ${res.data.msg}`);
  }

  return res.data.data || [];
}

/**
 * Convert raw Bitget spot candle to a structured object.
 * Format: [timestamp, open, high, low, close, baseVolume, quoteVolume, ...]
 */
function normalize(raw) {
  return {
    time:   parseInt(raw[0], 10),
    open:   parseFloat(raw[1]),
    high:   parseFloat(raw[2]),
    low:    parseFloat(raw[3]),
    close:  parseFloat(raw[4]),
    volume: parseFloat(raw[5]),
  };
}

/**
 * Fetch all candles for a symbol/timeframe in [startDate, endDate].
 * Uses Bitget spot history-candles (up to ~1 year of history).
 * Results are cached to disk; repeated calls read from cache.
 *
 * @param {string}        symbol    e.g. 'BTCUSDT'
 * @param {string}        timeframe e.g. '1H', '4H', '1D'
 * @param {string|number} startDate ISO date string or unix ms
 * @param {string|number} endDate   ISO date string or unix ms
 * @returns {Promise<Array<{time,open,high,low,close,volume}>>} sorted oldest→newest
 */
async function fetchCandles(symbol, timeframe, startDate, endDate) {
  const granularity = TF_MAP[timeframe];
  if (!granularity) {
    throw new Error(
      `Unknown timeframe "${timeframe}". Valid: ${Object.keys(TF_MAP).join(', ')}`
    );
  }

  const startMs = parseDate(startDate);
  const endMs   = parseDate(endDate);

  if (isNaN(startMs) || isNaN(endMs)) throw new Error('Invalid startDate or endDate');
  if (endMs <= startMs) throw new Error('endDate must be after startDate');

  // Cache check
  const cfile = cacheFile(symbol, granularity, startMs, endMs);
  if (fs.existsSync(cfile)) {
    const cached = JSON.parse(fs.readFileSync(cfile, 'utf8'));
    console.log(`[dataLoader] Cache hit: ${path.basename(cfile)} (${cached.length} candles)`);
    return cached;
  }

  console.log(
    `[dataLoader] Fetching ${symbol} ${granularity} ` +
    `${new Date(startMs).toISOString()} → ${new Date(endMs).toISOString()}`
  );

  const stepMs = TF_MS[granularity];
  const allRaw = [];
  // Paginate BACKWARD: each page returns the 200 newest candles within [startMs, curEnd]
  // After each page, shift curEnd to just before the oldest candle of that page
  let curEnd = endMs;

  while (curEnd > startMs) {
    const page = await fetchPage(symbol, granularity, startMs, curEnd);

    if (!page.length) break;

    allRaw.push(...page);

    // page is ascending; oldest candle is page[0]
    const oldestTs = parseInt(page[0][0], 10);

    // Stop if we've reached the start of the range
    if (oldestTs <= startMs) break;

    // If a full page was returned there might be more data earlier
    if (page.length < PAGE_LIMIT) break;

    // Shift the window backward past the oldest candle
    curEnd = oldestTs - stepMs;

    await new Promise(r => setTimeout(r, 200));
  }

  // Deduplicate by timestamp
  const seen   = new Set();
  const unique = [];
  for (const c of allRaw) {
    if (!seen.has(c[0])) { seen.add(c[0]); unique.push(c); }
  }

  // Sort ascending (oldest → newest)
  unique.sort((a, b) => parseInt(a[0], 10) - parseInt(b[0], 10));

  // Drop any candles outside [startMs, endMs]
  const inRange = unique.filter(c => {
    const ts = parseInt(c[0], 10);
    return ts >= startMs && ts <= endMs;
  });

  const candles = inRange.map(normalize);

  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(cfile, JSON.stringify(candles));
  console.log(`[dataLoader] Cached ${candles.length} candles → ${path.basename(cfile)}`);

  return candles;
}

module.exports = { fetchCandles };
