'use strict';

require('dotenv').config();

const axios  = require('axios');
const crypto = require('crypto');

// ─── Config ───────────────────────────────────────────────────────────────────

const BASE_URL     = 'https://api.bitget.com';
const API_KEY      = process.env.BITGET_API_KEY;
const SECRET_KEY   = process.env.BITGET_SECRET_KEY;
const PASSPHRASE   = process.env.BITGET_PASSPHRASE;
const PRODUCT_TYPE = 'USDT-FUTURES';
const MARGIN_COIN  = 'USDT';

if (!API_KEY)    throw new Error('BITGET_API_KEY is not set');
if (!SECRET_KEY) throw new Error('BITGET_SECRET_KEY is not set');
if (!PASSPHRASE) throw new Error('BITGET_PASSPHRASE is not set');

// ─── Contract specs cache ─────────────────────────────────────────────────────

/** symbol → { pricePlace, volumePlace, minTradeNum } */
let _contractSpecs = null;

async function loadContractSpecs() {
  if (_contractSpecs) return _contractSpecs;
  const list = await get('/api/v2/mix/market/contracts', { productType: PRODUCT_TYPE });
  _contractSpecs = {};
  for (const c of list) {
    _contractSpecs[c.symbol] = {
      pricePlace:  parseInt(c.pricePlace,  10),
      volumePlace: parseInt(c.volumePlace, 10),
      minTradeNum: parseFloat(c.minTradeNum),
    };
  }
  return _contractSpecs;
}

/**
 * Round a price to the correct number of decimal places for a given symbol.
 * Falls back to a magnitude-based heuristic if specs aren't loaded yet.
 */
function roundPrice(price, symbol) {
  const spec = _contractSpecs && _contractSpecs[symbol];
  if (spec) {
    const factor = Math.pow(10, spec.pricePlace);
    return Math.round(price * factor) / factor;
  }
  // Fallback heuristic (used before specs are loaded)
  if (price >= 10000) return Math.round(price * 10)       / 10;
  if (price >= 1000)  return Math.round(price * 10)       / 10;
  if (price >= 100)   return Math.round(price * 100)      / 100;
  if (price >= 10)    return Math.round(price * 100)      / 100;
  if (price >= 1)     return Math.round(price * 1000)     / 1000;
  if (price >= 0.1)   return Math.round(price * 10000)    / 10000;
  if (price >= 0.01)  return Math.round(price * 100000)   / 100000;
  return Math.round(price * 1000000) / 1000000;
}

/**
 * Round a quantity to the correct number of decimal places for a given symbol.
 */
function roundSize(size, symbol) {
  const spec = _contractSpecs && _contractSpecs[symbol];
  if (spec) {
    const factor = Math.pow(10, spec.volumePlace);
    return Math.ceil(size * factor) / factor;
  }
  // Fallback: 4 decimal places
  return Math.ceil(size * 10000) / 10000;
}

// ─── Symbol helpers ───────────────────────────────────────────────────────────

/**
 * Normalise to Bitget format: "BTC_USDT" → "BTCUSDT"
 * Already-normalised symbols pass through unchanged.
 */
function normalise(symbol) {
  return symbol.replace('_', '').toUpperCase();
}

// ─── Signing ──────────────────────────────────────────────────────────────────

/**
 * Bitget signature: Base64(HMAC-SHA256(secret, ts + METHOD + path+qs + body))
 */
function sign(timestamp, method, requestPath, body = '') {
  const message = timestamp + method.toUpperCase() + requestPath + body;
  return crypto.createHmac('sha256', SECRET_KEY).update(message).digest('base64');
}

function authHeaders(method, path, queryString = '', body = '') {
  const ts          = Date.now().toString();
  const requestPath = queryString ? `${path}?${queryString}` : path;
  const sig         = sign(ts, method, requestPath, body);
  return {
    'ACCESS-KEY':        API_KEY,
    'ACCESS-SIGN':       sig,
    'ACCESS-TIMESTAMP':  ts,
    'ACCESS-PASSPHRASE': PASSPHRASE,
    'Content-Type':      'application/json',
    'locale':            'en-US',
  };
}

function toQueryString(params) {
  return Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== null)
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
    .join('&');
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

async function get(path, params = {}, auth = false) {
  const qs      = toQueryString(params);
  const url     = `${BASE_URL}${path}${qs ? '?' + qs : ''}`;
  const headers = auth
    ? authHeaders('GET', path, qs)
    : { 'Content-Type': 'application/json' };

  try {
    const { data } = await axios.get(url, { headers, timeout: 8000 });
    if (data.code !== '00000') {
      throw new Error(`Bitget API error ${data.code}: ${data.msg}`);
    }
    return data.data;
  } catch (err) {
    if (err.response) {
      throw new Error(
        `Bitget GET ${path} → HTTP ${err.response.status}: ` +
        JSON.stringify(err.response.data)
      );
    }
    throw err;
  }
}

async function post(path, body = {}) {
  const bodyStr = JSON.stringify(body);
  const headers = authHeaders('POST', path, '', bodyStr);

  try {
    const { data } = await axios.post(`${BASE_URL}${path}`, body, {
      headers,
      timeout: 10000,
    });
    if (data.code !== '00000') {
      throw new Error(`Bitget API error ${data.code}: ${data.msg}`);
    }
    return data.data;
  } catch (err) {
    if (err.response) {
      throw new Error(
        `Bitget POST ${path} → HTTP ${err.response.status}: ` +
        JSON.stringify(err.response.data)
      );
    }
    throw err;
  }
}

// ─── Interval mapping (MEXC names → Bitget granularity) ──────────────────────

const INTERVAL_MAP = {
  Min1:  '1m',
  Min5:  '5m',
  Min15: '15m',
  Min30: '30m',
  Min60: '1H',
  Hour4: '4H',
  Hour8: '8H',
  Day1:  '1D',
  Week1: '1W',
};

// ─── Public endpoints ─────────────────────────────────────────────────────────

/**
 * All USDT-futures tickers.
 * Returns objects shaped like MEXC's ticker so screener.js needs no changes:
 *   { symbol, lastPrice, amount24 }
 */
async function getAllTickers() {
  const data = await get('/api/v2/mix/market/tickers', { productType: PRODUCT_TYPE });
  if (!Array.isArray(data)) return [];
  return data.map((t) => ({
    ...t,
    lastPrice: t.lastPr,                           // MEXC compat alias
    amount24:  parseFloat(t.quoteVolume ?? 0),     // 24 h USDT volume
  }));
}

/**
 * Current last price for a symbol.
 * @returns {number}
 */
async function getPrice(symbol) {
  const sym  = normalise(symbol);
  const data = await get('/api/v2/mix/market/ticker', { symbol: sym, productType: PRODUCT_TYPE });
  const ticker = Array.isArray(data) ? data[0] : data;
  if (!ticker) throw new Error(`No ticker found for ${sym}`);
  return parseFloat(ticker.lastPr);
}

/**
 * OHLCV candlestick data.
 * @param {string} symbol
 * @param {string} interval - MEXC-style: Min1 | Min5 | Min15 | Min30 | Min60 | Hour4 | Hour8 | Day1 | Week1
 * @param {number} limit
 * @returns {Array<{time,open,high,low,close,vol}>}
 */
async function getKlines(symbol, interval = 'Min15', limit = 100) {
  const sym  = normalise(symbol);
  const gran = INTERVAL_MAP[interval] || interval;

  const data = await get('/api/v2/mix/market/candles', {
    symbol:      sym,
    productType: PRODUCT_TYPE,
    granularity: gran,
    limit:       String(limit),
  });

  // Each element: [timestamp_ms, open, high, low, close, baseVol, quoteVol]
  return (Array.isArray(data) ? data : []).map((c) => ({
    time:  parseInt(c[0]),
    open:  parseFloat(c[1]),
    high:  parseFloat(c[2]),
    low:   parseFloat(c[3]),
    close: parseFloat(c[4]),
    vol:   parseFloat(c[5]),
  }));
}

/**
 * Open interest (holding amount) for a symbol.
 * @returns {number}
 */
async function getOpenInterest(symbol) {
  const sym  = normalise(symbol);
  const data = await get('/api/v2/mix/market/ticker', { symbol: sym, productType: PRODUCT_TYPE });
  const ticker = Array.isArray(data) ? data[0] : data;
  if (!ticker) throw new Error(`No ticker for ${sym}`);
  return parseFloat(ticker.holdingAmount ?? 0);
}

/**
 * Current funding rate for a symbol.
 * @returns {number}
 */
async function getFundingRate(symbol) {
  const sym  = normalise(symbol);
  const data = await get('/api/v2/mix/market/current-fund-rate', { symbol: sym, productType: PRODUCT_TYPE });
  return parseFloat(data.fundingRate);
}

/**
 * Order book depth.
 * @returns {{ bids: [price, size][], asks: [price, size][] }}
 */
async function getOrderBook(symbol, limit = 10) {
  const sym  = normalise(symbol);
  const data = await get('/api/v2/mix/market/depth', {
    symbol:      sym,
    productType: PRODUCT_TYPE,
    limit:       String(limit),
  });
  return {
    bids: (data.bids || []).map(([p, s]) => [parseFloat(p), parseFloat(s)]),
    asks: (data.asks || []).map(([p, s]) => [parseFloat(p), parseFloat(s)]),
  };
}

// ─── Private endpoints ────────────────────────────────────────────────────────

/**
 * Futures wallet balance (USDT).
 * @returns {{ available: number, equity: number, unrealized: number }}
 */
async function getBalance() {
  const accounts = await get('/api/v2/mix/account/accounts', { productType: PRODUCT_TYPE }, true);
  const usdt = Array.isArray(accounts)
    ? accounts.find((a) => a.marginCoin === MARGIN_COIN)
    : accounts;
  if (!usdt) throw new Error('USDT account not found');
  return {
    available:  parseFloat(usdt.available),
    equity:     parseFloat(usdt.accountEquity ?? usdt.usdtEquity ?? 0),
    unrealized: parseFloat(usdt.unrealizedPL ?? 0),
  };
}

/**
 * Open futures positions.
 * @param {string} [symbol] - Optional filter
 * @returns {Array}
 */
async function getOpenPositions(symbol) {
  const params = { productType: PRODUCT_TYPE, marginCoin: MARGIN_COIN };
  if (symbol) params.symbol = normalise(symbol);
  const data = await get('/api/v2/mix/position/all-position', params, true);
  // Filter out empty positions
  return (Array.isArray(data) ? data : []).filter((p) => parseFloat(p.total ?? 0) > 0);
}

// ─── Leverage ─────────────────────────────────────────────────────────────────

async function setLeverage(symbol, leverage, holdSide) {
  const sym = normalise(symbol);
  // Some symbols have a lower max leverage than requested — step down gracefully
  const fallbacks = [...new Set([leverage, 25, 20, 10])];
  for (const lev of fallbacks) {
    try {
      await post('/api/v2/mix/account/set-leverage', {
        symbol:      sym,
        productType: PRODUCT_TYPE,
        marginCoin:  MARGIN_COIN,
        leverage:    String(lev),
        holdSide,
      });
      if (lev !== leverage) console.log(`[bitget] ${sym}: leverage ${leverage}x not supported, set to ${lev}x`);
      return lev;
    } catch (err) {
      const isMaxExceeded = err.message.includes('40797');
      if (isMaxExceeded && lev !== fallbacks[fallbacks.length - 1]) continue;
      throw err;
    }
  }
}

// ─── Order placement ──────────────────────────────────────────────────────────

/**
 * Place a market order on Bitget Futures.
 * size is in USDT (quote currency).
 * @returns {{ orderId: string }}
 */
async function placeOrder(symbol, direction, size, leverage = 10, marginMode = 'crossed', sl = null, tp = null) {
  const sym  = normalise(symbol);
  const side = direction === 'long' ? 'buy' : 'sell';

  await setLeverage(sym, leverage, direction);

  const body = {
    symbol:      sym,
    productType: PRODUCT_TYPE,
    marginMode,
    marginCoin:  MARGIN_COIN,
    size:        String(size),
    side,
    tradeSide:   'open',
    orderType:   'market',
    force:       'ioc',
  };
  if (sl) body.presetStopLossPrice    = String(sl);
  if (tp) body.presetStopSurplusPrice = String(tp);

  const result = await post('/api/v2/mix/order/place-order', body);
  return { orderId: result.orderId };
}

/**
 * Place a limit order on Bitget Futures.
 * size is in USDT (quote currency).
 * @returns {{ orderId: string }}
 */
async function placeLimitOrder(symbol, direction, size, price, leverage = 10, marginMode = 'crossed', sl = null, tp = null) {
  const sym  = normalise(symbol);
  const side = direction === 'long' ? 'buy' : 'sell';

  await setLeverage(sym, leverage, direction);

  const body = {
    symbol:      sym,
    productType: PRODUCT_TYPE,
    marginMode,
    marginCoin:  MARGIN_COIN,
    size:        String(size),
    price:       String(price),
    side,
    tradeSide:   'open',
    orderType:   'limit',
    force:       'gtc',
  };
  if (sl) body.presetStopLossPrice    = String(sl);
  if (tp) body.presetStopSurplusPrice = String(tp);

  const result = await post('/api/v2/mix/order/place-order', body);
  return { orderId: result.orderId };
}

/**
 * Get order status.
 * Maps Bitget string states → numeric states used by hunter.js:
 *   1=new/live, 2=filled, 3=partial, 4=cancelled
 * @returns {{ state: number, dealVol: number, vol: number }}
 */
async function getOrderStatus(symbol, orderId) {
  const sym  = normalise(symbol);
  const data = await get('/api/v2/mix/order/detail', {
    symbol:      sym,
    productType: PRODUCT_TYPE,
    orderId,
  }, true);

  const stateMap = { live: 1, partially_filled: 3, filled: 2, cancelled: 4 };
  return {
    state:   stateMap[data.state] ?? 1,
    dealVol: parseFloat(data.baseVolume ?? 0),
    vol:     parseFloat(data.size ?? 0),
  };
}

/**
 * Cancel a pending order.
 */
async function cancelOrder(symbol, orderId) {
  const sym = normalise(symbol);
  await post('/api/v2/mix/order/cancel-order', {
    symbol:      sym,
    productType: PRODUCT_TYPE,
    orderId,
  });
}

/**
 * Close a fraction of an open position at market price.
 */
async function closePositionPartial(symbol, fraction = 0.5) {
  const sym       = normalise(symbol);
  const positions = await getOpenPositions(sym);
  if (!positions.length) return { closed: 0, vol: 0 };

  let totalVol = 0;
  for (const pos of positions) {
    const vol       = Math.max(1, Math.floor(parseFloat(pos.total) * fraction));
    const closeSide = pos.holdSide === 'long' ? 'sell' : 'buy';

    await post('/api/v2/mix/order/place-order', {
      symbol:      sym,
      productType: PRODUCT_TYPE,
      marginMode:  pos.marginMode,
      marginCoin:  MARGIN_COIN,
      size:        String(vol),
      side:        closeSide,
      tradeSide:   'close',
      orderType:   'market',
      force:       'ioc',
    });
    totalVol += vol;
  }
  return { closed: positions.length, vol: totalVol };
}

/**
 * Set a single TP + SL on an existing open position (closes 100% each).
 * Used by scalpers that have one TP target.
 *
 * @param {string} symbol
 * @param {string} holdSide - 'long' | 'short'
 * @param {number} sl       - stop-loss trigger price
 * @param {number} tp       - take-profit trigger price
 */
async function setPositionSingleTPSL(symbol, holdSide, sl, tp) {
  const sym = normalise(symbol);

  // SL — full position
  await post('/api/v2/mix/order/place-tpsl-order', {
    symbol:       sym,
    productType:  PRODUCT_TYPE,
    marginCoin:   MARGIN_COIN,
    planType:     'pos_loss',
    triggerPrice: String(sl),
    triggerType:  'mark_price',
    holdSide,
  });

  // TP — full position
  await post('/api/v2/mix/order/place-tpsl-order', {
    symbol:       sym,
    productType:  PRODUCT_TYPE,
    marginCoin:   MARGIN_COIN,
    planType:     'pos_profit',
    triggerPrice: String(tp),
    triggerType:  'mark_price',
    holdSide,
  });

  console.log(`[bitget] setPositionSingleTPSL ${sym} ${holdSide}: SL=${sl} TP=${tp}`);
}

/**
 * Set TP/SL on an existing open position.
 * - SL closes 100% of the position (no size = full position)
 * - TP1 closes 50% (first half)
 * - TP2 closes remaining 50% (second half)
 *
 * @param {string} symbol
 * @param {string} holdSide - 'long' | 'short'
 * @param {number} sl       - stop-loss trigger price
 * @param {number} tp1      - first take-profit trigger price (50%)
 * @param {number} tp2      - second take-profit trigger price (remaining 50%)
 */
async function setPositionTPSL(symbol, holdSide, sl, tp1, tp2) {
  const sym = normalise(symbol);

  // Fetch live position to get the actual contract size
  const positions = await getOpenPositions(sym);
  const pos = positions.find((p) => p.holdSide === holdSide);
  if (!pos) throw new Error(`No ${holdSide} position found for ${sym}`);

  const totalContracts = parseFloat(pos.total);
  const halfSize       = Math.max(1, Math.floor(totalContracts / 2));

  // SL — covers entire position (omit size so exchange closes all remaining)
  await post('/api/v2/mix/order/place-tpsl-order', {
    symbol:       sym,
    productType:  PRODUCT_TYPE,
    marginCoin:   MARGIN_COIN,
    planType:     'pos_loss',
    triggerPrice: String(sl),
    triggerType:  'mark_price',
    holdSide,
  });

  // TP1 — closes first 50%
  await post('/api/v2/mix/order/place-tpsl-order', {
    symbol:       sym,
    productType:  PRODUCT_TYPE,
    marginCoin:   MARGIN_COIN,
    planType:     'pos_profit',
    triggerPrice: String(tp1),
    triggerType:  'mark_price',
    holdSide,
    size:         String(halfSize),
  });

  // TP2 — closes remaining 50%
  await post('/api/v2/mix/order/place-tpsl-order', {
    symbol:       sym,
    productType:  PRODUCT_TYPE,
    marginCoin:   MARGIN_COIN,
    planType:     'pos_profit',
    triggerPrice: String(tp2),
    triggerType:  'mark_price',
    holdSide,
    size:         String(halfSize),
  });

  console.log(`[bitget] setPositionTPSL ${sym} ${holdSide}: SL=${sl} TP1=${tp1}(${halfSize}lots) TP2=${tp2}(${halfSize}lots)`);
}

/**
 * Fetch the realized PnL for the most recently closed position of a symbol.
 * Uses Bitget's position history endpoint so the PnL is the actual exchange value,
 * not an estimate from current market price.
 *
 * @param {string} symbol
 * @param {number} [openedAtMs] - Trade open timestamp in ms; used as startTime filter
 * @returns {number|null} Realized PnL in USDT, or null if not found / on error
 */
async function getClosedPositionPnl(symbol, openedAtMs) {
  const sym = normalise(symbol);
  const startTime = openedAtMs ? String(openedAtMs) : String(Date.now() - 24 * 60 * 60 * 1000);

  async function query() {
    const data = await get('/api/v2/mix/position/history-position', {
      productType: PRODUCT_TYPE,
      symbol:      sym,
      startTime,
      endTime:     String(Date.now()),
    }, true);
    const list = Array.isArray(data?.list) ? data.list
               : Array.isArray(data)       ? data
               : [];
    if (!list.length) return null;
    list.sort((a, b) => parseInt(b.uTime || b.cTime || 0) - parseInt(a.uTime || a.cTime || 0));
    const pnl = parseFloat(list[0].achievedProfits ?? 0);
    return pnl !== 0 ? pnl : null; // 0 = not yet settled by Bitget
  }

  try {
    // First attempt immediately
    let pnl = await query();
    if (pnl !== null) return pnl;
    // Bitget history not settled yet — wait 2 s and retry once
    await new Promise(r => setTimeout(r, 2000));
    return await query();
  } catch (err) {
    console.error(`[bitget] getClosedPositionPnl ${sym}:`, err.message);
    return null;
  }
}

/**
 * Close all open positions for a symbol at market price.
 */
async function closePosition(symbol) {
  const sym       = normalise(symbol);
  const positions = await getOpenPositions(sym);
  if (!positions.length) return { closed: 0 };

  let closed = 0;
  for (const pos of positions) {
    const closeSide = pos.holdSide === 'long' ? 'sell' : 'buy';

    await post('/api/v2/mix/order/place-order', {
      symbol:      sym,
      productType: PRODUCT_TYPE,
      marginMode:  pos.marginMode,
      marginCoin:  MARGIN_COIN,
      size:        String(pos.total),
      side:        closeSide,
      tradeSide:   'close',
      orderType:   'market',
      force:       'ioc',
    });
    closed++;
  }
  return { closed };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  normalise,
  loadContractSpecs,
  roundPrice,
  roundSize,
  getAllTickers,
  getPrice,
  getKlines,
  getOpenInterest,
  getFundingRate,
  getOrderBook,
  getBalance,
  getOpenPositions,
  placeOrder,
  placeLimitOrder,
  getOrderStatus,
  cancelOrder,
  closePosition,
  closePositionPartial,
  setPositionSingleTPSL,
  setPositionTPSL,
  getClosedPositionPnl,
};
