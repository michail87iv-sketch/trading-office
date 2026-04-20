'use strict';

const cron   = require('node-cron');
const fs     = require('fs');
const path   = require('path');
const bitget        = require('../core/bitget');
const positionCache   = require('../core/positionCache');
const tradeRegistry   = require('../core/tradeRegistry');
const { sendSignal, sendTrade, sendAlert, registerCommand } = require('../core/telegram');
const { logSettingChange } = require('../core/archive');

// ─── Config ───────────────────────────────────────────────────────────────────

const AGENT       = 'SCALPER2';
const CAPITAL     = 3;
const COOLDOWN_MS = 45 * 60 * 1000;
const SCAN_DELAY  = 400;
const MONITOR_SEC = 30_000;

const BASE_SYMBOLS    = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT'];
const SETTINGS_FILE    = path.join(__dirname, '../.claude/memory/scalper_settings.json');
const OPEN_TRADES_FILE = path.join(__dirname, '../data/open_trades_s2.json');

function saveOpenTrades() {
  try {
    const arr = [];
    for (const [, t] of openTrades) {
      if (t.closing) continue;
      arr.push({ symbol: t.symbol, direction: t.direction, entry: t.entry, sl: t.sl, tp: t.tp, size: t.size, openedAt: t.openedAt });
    }
    fs.writeFileSync(OPEN_TRADES_FILE, JSON.stringify(arr, null, 2));
  } catch (err) { console.error('[s2] saveOpenTrades:', err.message); }
}

function loadOpenTrades() {
  try {
    if (!fs.existsSync(OPEN_TRADES_FILE)) return [];
    return JSON.parse(fs.readFileSync(OPEN_TRADES_FILE, 'utf8'));
  } catch { return []; }
}

// ─── Settings ─────────────────────────────────────────────────────────────────

const DEFAULTS = {
  leverage: 15, riskPct: 1.5, tp: 0.8, sl: 0.5, maxTrades: 3,
  marginMode: 'isolated',
  // VWAP
  vwapDeviation: 0.3, minImpulse: 0.5,
  // Trailing stop
  trailingStop: true, trailActivation: 1.0, trailDistance: 0.5,
  // Session filter
  sessionFilter: false, sessionFrom: '08:00', sessionUntil: '22:00', sessionTz: 'UTC',
};

function readAll() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch { return {}; }
}

function loadSettings() {
  const all = readAll();
  return { ...DEFAULTS, ...all.s2 };
}

function saveSettings() {
  const all = readAll();
  all.s2 = {
    leverage: cfg.leverage, riskPct: cfg.riskPct, tp: cfg.tp, sl: cfg.sl, maxTrades: cfg.maxTrades,
    marginMode: cfg.marginMode,
    vwapDeviation: cfg.vwapDeviation, minImpulse: cfg.minImpulse,
    trailingStop: cfg.trailingStop, trailActivation: cfg.trailActivation, trailDistance: cfg.trailDistance,
    sessionFilter: cfg.sessionFilter, sessionFrom: cfg.sessionFrom, sessionUntil: cfg.sessionUntil, sessionTz: cfg.sessionTz,
  };
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(all, null, 2));
}

let cfg = loadSettings();

const SET_KEYS = {
  // Core
  leverage:        { parse: parseFloat, min: 1,   max: 125,  label: 'Leverage'           },
  risk:            { field: 'riskPct',       parse: parseFloat, min: 0.1, max: 5,    label: 'Risk %'             },
  tp:              { parse: parseFloat, min: 0.1, max: 500,  label: 'TP %'               },
  sl:              { parse: parseFloat, min: 0.1, max: 500,  label: 'SL %'               },
  maxtrades:       { field: 'maxTrades',     parse: parseInt,   min: 1,   max: 50,   label: 'Max Trades'         },
  // VWAP
  vwapdeviation:   { field: 'vwapDeviation', parse: parseFloat, min: 0.1, max: 5.0,  label: 'VWAP Deviation %'  },
  minimpulse:      { field: 'minImpulse',    parse: parseFloat, min: 0.1, max: 10.0, label: 'Min Impulse %'      },
  // Trailing stop
  trailingstop:    { field: 'trailingStop',    parse: (v) => v === '1' || v === 'true' || v === true, label: 'Trailing Stop'     },
  trailactivation: { field: 'trailActivation', parse: parseFloat, min: 0.1, max: 20,  label: 'Trail Activation %' },
  traildistance:   { field: 'trailDistance',   parse: parseFloat, min: 0.1, max: 10,  label: 'Trail Distance %'   },
  // Session filter
  sessionfilter:   { field: 'sessionFilter', parse: (v) => v === '1' || v === 'true' || v === true, label: 'Session Filter'    },
  sessionfrom:     { field: 'sessionFrom',   parse: String,                                          label: 'Session From'      },
  sessionuntil:    { field: 'sessionUntil',  parse: String,                                          label: 'Session Until'     },
  sessiontz:       { field: 'sessionTz',     parse: String, enum: ['UTC','UTC+1','UTC+2'],           label: 'Session Timezone'  },
  // Margin
  margin:          { field: 'marginMode',    parse: String, enum: ['isolated', 'crossed'],             label: 'Margin Mode'       },
};

function applySetting(key, rawValue) {
  const ALIASES = { riskpct: 'risk', maxtrades: 'maxtrades', trailingstop: 'trailingstop', marginmode: 'margin' };
  const lookup  = ALIASES[key.toLowerCase()] ?? key.toLowerCase();
  const def = SET_KEYS[lookup];
  if (!def) return { ok: false, error: `Unknown key. Use: ${Object.keys(SET_KEYS).join(', ')}` };
  const field = def.field ?? key.toLowerCase();
  const val   = def.parse(rawValue);
  if (typeof val === 'number') {
    if (isNaN(val) || (def.min != null && val < def.min) || (def.max != null && val > def.max))
      return { ok: false, error: `Value must be ${def.min}–${def.max}` };
  }
  if (def.enum && !def.enum.includes(val))
    return { ok: false, error: `Value must be one of: ${def.enum.join(', ')}` };
  // Cross-field: trailActivation must exceed trailDistance
  const nextActivation = field === 'trailActivation' ? val : cfg.trailActivation;
  const nextDistance   = field === 'trailDistance'   ? val : cfg.trailDistance;
  if ((field === 'trailActivation' || field === 'trailDistance') && nextActivation <= nextDistance)
    return { ok: false, error: `Trail Activation % (${nextActivation}) must be greater than Trail Distance % (${nextDistance})` };
  const oldValue = cfg[field];
  cfg[field] = val;
  logSettingChange(AGENT, field, oldValue, val);
  saveSettings();
  return { ok: true, label: def.label, value: val };
}

// ─── State ────────────────────────────────────────────────────────────────────

const openTrades = new Map();
const cooldowns  = new Map();
let   adminRef   = null;
let   enabled    = true;

// ─── Indicators ───────────────────────────────────────────────────────────────

function calcEMA(values, period) {
  if (values.length < period) return null;
  const k   = 2 / (period + 1);
  let   ema = values.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }
  return ema;
}

/**
 * VWAP over all provided candles.
 * Returns current VWAP value.
 */
function calcVWAP(candles) {
  let cumTPV = 0;
  let cumVol = 0;
  for (const c of candles) {
    const tp = (c.high + c.low + c.close) / 3;
    cumTPV  += tp * c.vol;
    cumVol  += c.vol;
  }
  if (cumVol === 0) return null;
  return cumTPV / cumVol;
}

/**
 * Detect VWAP cross on the last two candles:
 * Returns 'up' if previous close was below VWAP and current close is above,
 * 'down' for the opposite, null if no cross.
 */
function detectVWAPCross(candles, vwap) {
  if (candles.length < 2) return null;
  const prev = candles[candles.length - 2].close;
  const curr = candles[candles.length - 1].close;
  if (prev < vwap && curr > vwap) return 'up';
  if (prev > vwap && curr < vwap) return 'down';
  return null;
}

// ─── Session filter ───────────────────────────────────────────────────────────

/** Returns true if current time falls within the configured trading session. */
function isInSession() {
  if (!cfg.sessionFilter) return true;
  const offsetMin = { 'UTC': 0, 'UTC+1': 60, 'UTC+2': 120 }[cfg.sessionTz] ?? 0;
  // Shift UTC time by the tz offset to get "local" time
  const shifted = new Date(Date.now() + offsetMin * 60_000);
  const hhmm = shifted.toISOString().slice(11, 16); // 'HH:MM' in target tz
  // Handle sessions that don't cross midnight
  return hhmm >= cfg.sessionFrom && hhmm < cfg.sessionUntil;
}

// ─── Analysis ─────────────────────────────────────────────────────────────────

async function analyzeSymbol(symbol) {
  // Use 15m candles for VWAP + EMA signals
  const candles = await bitget.getKlines(symbol, 'Min15', 60);
  if (candles.length < 30) {
    console.log(`[s2] ${symbol}: skip — insufficient candles (${candles.length})`);
    return null;
  }

  const closes = candles.map((c) => c.close);
  const ema9   = calcEMA(closes, 9);
  const ema21  = calcEMA(closes, 21);
  const vwap   = calcVWAP(candles);

  if (!ema9 || !ema21 || !vwap) {
    console.log(`[s2] ${symbol}: skip — indicator calc failed (ema9=${ema9} ema21=${ema21} vwap=${vwap})`);
    return null;
  }

  const price = candles[candles.length - 1].close;

  // VWAP deviation band: skip if price is already too far from VWAP (move already happened)
  const distPct = Math.abs(price - vwap) / vwap * 100;
  if (distPct > cfg.vwapDeviation) {
    console.log(`[s2] ${symbol}: skip — price ${distPct.toFixed(2)}% from VWAP (>${cfg.vwapDeviation}% band)`);
    return null;
  }

  // Minimum impulse: last candle must have enough body to confirm momentum
  const lastCandle  = candles[candles.length - 1];
  const impulsePct  = Math.abs(lastCandle.close - lastCandle.open) / lastCandle.open * 100;
  if (impulsePct < cfg.minImpulse) {
    console.log(`[s2] ${symbol}: skip — candle impulse ${impulsePct.toFixed(2)}% < min ${cfg.minImpulse}%`);
    return null;
  }

  const cross = detectVWAPCross(candles, vwap);

  if (!cross) {
    console.log(`[s2] ${symbol}: skip — no VWAP cross (price=${price.toPrecision(5)} VWAP=${vwap.toPrecision(5)} EMA9=${ema9.toPrecision(5)} EMA21=${ema21.toPrecision(5)})`);
    return null;
  }

  // Long: VWAP cross up + EMA9 > EMA21 + price > both EMAs
  if (cross === 'up') {
    if (ema9 > ema21 && price > ema9 && price > ema21) {
      console.log(`[s2] ${symbol}: SIGNAL LONG | VWAP cross up | EMA9=${ema9.toPrecision(5)} EMA21=${ema21.toPrecision(5)} price=${price.toPrecision(5)}`);
      return buildSignal(symbol, 'long', price, vwap, ema9, ema21);
    }
    console.log(`[s2] ${symbol}: skip — VWAP cross UP but EMA/price filter fail (EMA9>EMA21=${ema9>ema21} price>EMA9=${price>ema9} price>EMA21=${price>ema21})`);
    return null;
  }

  // Short: VWAP cross down + EMA9 < EMA21 + price < both EMAs
  if (cross === 'down') {
    if (ema9 < ema21 && price < ema9 && price < ema21) {
      console.log(`[s2] ${symbol}: SIGNAL SHORT | VWAP cross down | EMA9=${ema9.toPrecision(5)} EMA21=${ema21.toPrecision(5)} price=${price.toPrecision(5)}`);
      return buildSignal(symbol, 'short', price, vwap, ema9, ema21);
    }
    console.log(`[s2] ${symbol}: skip — VWAP cross DOWN but EMA/price filter fail (EMA9<EMA21=${ema9<ema21} price<EMA9=${price<ema9} price<EMA21=${price<ema21})`);
    return null;
  }

  return null;
}

function buildSignal(symbol, direction, price, vwap, ema9, ema21) {
  const tpPct = cfg.tp / 100;
  const slPct = cfg.sl / 100;

  const entry = price;
  const sl    = bitget.roundPrice(direction === 'long'
    ? entry * (1 - slPct)
    : entry * (1 + slPct), symbol);
  const tp    = bitget.roundPrice(direction === 'long'
    ? entry * (1 + tpPct)
    : entry * (1 - tpPct), symbol);
  const rr    = +(tpPct / slPct).toFixed(2);

  return { symbol, direction, entry, sl, tp, rr, vwap: +vwap.toPrecision(6), ema9: +ema9.toPrecision(6), ema21: +ema21.toPrecision(6) };
}

// ─── Price rounding (match Bitget tick size by price magnitude) ───────────────

// ─── Sizing ───────────────────────────────────────────────────────────────────

const MIN_NOTIONAL = 5; // Bitget minimum order value in USDT

function calcSize(entry, sl) {
  const riskUsdt     = CAPITAL * (cfg.riskPct / 100);
  const slGap        = Math.abs(entry - sl);
  const contracts    = slGap > 0 ? riskUsdt / slGap : 0;
  const minContracts = MIN_NOTIONAL * 1.10 / entry; // 10% buffer — always clears $5 after rounding
  const raw          = Math.max(minContracts, contracts);
  // Round UP to 4 significant figures so we never fall below the minimum
  const exp = Math.pow(10, 3 - Math.floor(Math.log10(raw)));
  return Math.ceil(raw * exp) / exp;
}

// ─── Execution ────────────────────────────────────────────────────────────────

async function executeTrade(signal) {
  if (!enabled || adminRef?.emergencyStop || adminRef?.globalPaused) {
    console.warn('[s2] executeTrade ignored — agent disabled or stopped');
    return;
  }
  const { symbol, direction, entry, sl, tp } = signal;
  const size = bitget.roundSize(calcSize(entry, sl), symbol);

  // Market order — VWAP cross is time-sensitive
  const { orderId } = await bitget.placeOrder(symbol, direction, size, cfg.leverage, cfg.marginMode, sl, tp);

  const trade = { symbol, direction, entry, sl, tp, size, orderId, openedAt: Date.now(), trailActive: false };
  openTrades.set(symbol, trade);
  saveOpenTrades();
  cooldowns.set(symbol, Date.now());

  const status = adminRef?.agentStatus?.SCALPER2;
  if (status) status.trades = (status.trades || 0) + 1;

  await sendSignal({
    symbol, direction, entry, sl, tp, rr: signal.rr, tf: '15m', confidence: 0.68,
    setup: `S2/VWAP+EMA9/21 | VWAP:${signal.vwap} | ${cfg.leverage}x iso`,
    from:  AGENT,
  });
  await sendTrade({ agent: AGENT, action: 'open', symbol, direction, size, entry, sl, tp, pnl: null });

  console.log(`[s2] market order: ${symbol} ${direction} x${size} @ ~${entry} | SL ${sl} | TP ${tp}`);

  // Set TP/SL on the position immediately (market order fills synchronously)
  try {
    await bitget.setPositionSingleTPSL(symbol, direction, sl, tp);
    console.log(`[s2] TP/SL set on position: ${symbol} SL=${sl} TP=${tp}`);
  } catch (err) {
    console.error(`[s2] failed to set TP/SL ${symbol}:`, err.message);
    const { sendAlert: alert } = require('../core/telegram');
    await alert(`S2: failed to set TP/SL on ${symbol}: ${err.message}`).catch(() => {});
  }

  startMonitor(trade);
}

// ─── Trade monitor (with trailing stop) ──────────────────────────────────────

function startMonitor(trade) {
  const id = setInterval(async () => {
    try {
      await checkTrade(trade, id);
    } catch (err) {
      console.error(`[s2] monitor ${trade.symbol}:`, err.message);
    }
  }, MONITOR_SEC);
}

async function checkTrade(trade, intervalId) {
  const price  = await bitget.getPrice(trade.symbol);
  const isLong = trade.direction === 'long';

  // Trailing stop
  if (cfg.trailingStop) {
    const profitPct = isLong
      ? (price - trade.entry) / trade.entry * 100
      : (trade.entry - price) / trade.entry * 100;

    if (!trade.trailActive && profitPct >= cfg.trailActivation) {
      trade.trailActive = true;
      console.log(`[s2] trail activated ${trade.symbol} at +${profitPct.toFixed(2)}% profit`);
    }

    if (trade.trailActive) {
      // Trail SL at cfg.trailDistance% behind current price (only move in favourable direction)
      const newSl = isLong
        ? bitget.roundPrice(price * (1 - cfg.trailDistance / 100), trade.symbol)
        : bitget.roundPrice(price * (1 + cfg.trailDistance / 100), trade.symbol);
      if (isLong && newSl > trade.sl) trade.sl = newSl;
      if (!isLong && newSl < trade.sl) trade.sl = newSl;
    }
  }

  // If no valid SL/TP (e.g. recovered position with no TP/SL on exchange), skip price-based exit
  // and rely on syncPositions to detect closure. Without this guard, tp=0 causes tpHit=true always.
  if (!trade.sl || !trade.tp) return;

  const slHit = isLong ? price <= trade.sl : price >= trade.sl;
  const tpHit = isLong ? price >= trade.tp : price <= trade.tp;
  if (!slHit && !tpHit) return;

  if (trade.closing) { clearInterval(intervalId); return; }
  trade.closing = true;
  clearInterval(intervalId);

  // Try to close — position may already be closed by exchange TP/SL (code 22002)
  try {
    await bitget.closePosition(trade.symbol);
  } catch (err) {
    if (!err.message.includes('22002') && !err.message.includes('No position')) {
      trade.closing = false;
      console.error(`[s2] closePosition ${trade.symbol}:`, err.message);
      return;
    }
    console.log(`[s2] ${trade.symbol}: already closed by exchange, skipping market close`);
  }

  const reason    = tpHit ? 'TP hit' : 'SL hit';
  const exitPrice = tpHit ? trade.tp : trade.sl;

  // Fetch actual realized PnL from Bitget history; fall back to estimate
  let pnl = await bitget.getClosedPositionPnl(trade.symbol, trade.openedAt);
  if (pnl === null) {
    // Guard: exitPrice 0 means SL/TP unknown (recovered trade) — clamp to 0 to avoid notional-as-PnL
    if (!exitPrice) {
      pnl = 0;
    } else {
      pnl = +(trade.size * (isLong ? exitPrice - trade.entry : trade.entry - exitPrice)).toFixed(4);
    }
  } else {
    pnl = +pnl.toFixed(4);
  }

  await sendTrade({ agent: AGENT, action: 'close', symbol: trade.symbol, direction: trade.direction,
    size: trade.size, entry: trade.entry, sl: trade.sl, tp: trade.tp, exitPrice, reason, pnl });

  const status = adminRef?.agentStatus?.SCALPER2;
  if (status) status.pnl = +((status.pnl || 0) + pnl).toFixed(4);

  openTrades.delete(trade.symbol);
  saveOpenTrades();
  tradeRegistry.release(trade.symbol);

  if (slHit && !trade.trailActive)
    await sendAlert(`S2 SL hit: ${trade.symbol} ${trade.direction.toUpperCase()} | pnl: ${pnl}`);

  adminRef?.checkRisk?.().catch(() => {});
  console.log(`[s2] ${reason} ${trade.symbol} exit=${exitPrice} pnl ${pnl >= 0 ? '+' : ''}${pnl}`);
}

// ─── Position sync (detect Bitget SL/TP closures) ────────────────────────────

async function syncPositions() {
  if (openTrades.size === 0) return;

  for (const [symbol, trade] of openTrades) {
    if (trade.closing) continue;
    if (Date.now() - (trade.openedAt || 0) < 60_000) continue; // grace period for fill + TP/SL setup

    // BUG 1 fix: query per-symbol so an empty result reliably means the position is gone
    let symbolPositions;
    try {
      symbolPositions = await bitget.getOpenPositions(symbol);
    } catch (err) {
      console.error(`[s2] syncPositions fetch error for ${symbol}:`, err.message);
      continue;
    }

    const positionExists = symbolPositions.some((p) => p.holdSide === trade.direction);
    if (positionExists) continue; // still open on Bitget

    trade.closing = true;
    console.log(`[s2] sync: ${symbol} no longer on Bitget → closed externally`);

    try {
      // BUG 2 fix: fetch actual realized PnL from Bitget history
      let pnl = await bitget.getClosedPositionPnl(symbol, trade.openedAt);

      const price   = await bitget.getPrice(symbol);
      const isLong  = trade.direction === 'long';
      const slHit   = isLong ? price < trade.entry : price > trade.entry;
      const exitPrice = slHit ? trade.sl : trade.tp;
      const reason    = slHit ? 'SL hit' : 'TP hit';

      if (pnl === null) {
        // exitPrice can be 0 when trade was recovered without SL/TP data;
        // fall back to current market price to avoid computing notional as PnL
        const effectiveExit = exitPrice || price;
        pnl = +(trade.size * (isLong ? effectiveExit - trade.entry : trade.entry - effectiveExit)).toFixed(4);
      } else {
        pnl = +pnl.toFixed(4);
      }

      openTrades.delete(symbol);
      saveOpenTrades();
      tradeRegistry.release(symbol);

      const status = adminRef?.agentStatus?.SCALPER2;
      if (status) status.pnl = +((status.pnl || 0) + pnl).toFixed(4);

      await sendTrade({ agent: AGENT, action: 'close', symbol, direction: trade.direction,
        size: trade.size, entry: trade.entry, sl: trade.sl, tp: trade.tp, exitPrice, reason, pnl });

      if (slHit && !trade.trailActive) await sendAlert(`S2 SL hit (exchange): ${symbol} ${trade.direction.toUpperCase()} | exit: ${exitPrice} | pnl: ${pnl}`);

      adminRef?.checkRisk?.().catch(() => {});
      console.log(`[s2] sync: ${symbol} closed by exchange (${reason}) exit=${exitPrice} pnl=${pnl >= 0 ? '+' : ''}${pnl}`);
    } catch (err) {
      console.error(`[s2] syncPositions ${symbol}:`, err.message);
      trade.closing = false;
    }
  }
}

// ─── Scan ─────────────────────────────────────────────────────────────────────

async function runScan() {
  if (!enabled || adminRef?.emergencyStop || adminRef?.globalPaused) return;
  if (openTrades.size >= cfg.maxTrades) return;
  if (!isInSession()) {
    console.log(`[s2] outside session window (${cfg.sessionFrom}–${cfg.sessionUntil} ${cfg.sessionTz}) — scan skipped`);
    return;
  }

  // Base pairs + top 20 by volume, deduplicated
  const tickers = await bitget.getAllTickers();
  const top20   = tickers
    .filter((t) => t.amount24 > 0)
    .sort((a, b) => b.amount24 - a.amount24)
    .slice(0, 20)
    .map((t) => t.symbol);

  const symbols = [...new Set([...BASE_SYMBOLS, ...top20])];

  console.log(`[s2] scanning ${symbols.length} symbols… (open: ${openTrades.size}/${cfg.maxTrades})`);

  for (const symbol of symbols) {
    if (openTrades.size >= cfg.maxTrades) break;
    if (openTrades.has(symbol)) continue;
    const last = cooldowns.get(symbol);
    if (last && Date.now() - last < COOLDOWN_MS) continue;

    try {
      const signal = await analyzeSymbol(symbol);
      if (signal) {
        // Cross-agent conflict guard: skip if any agent already holds this symbol
        if (await positionCache.isSymbolTaken(symbol)) {
          console.log(`[s2] ${symbol}: skip — open position exists on exchange (cross-agent conflict)`);
        } else {
          cooldowns.set(symbol, Date.now()); // set before execute so failure doesn't cause retry spam
          await executeTrade(signal);
          positionCache.invalidate(); // force fresh fetch for next agent scan
        }
      }
    } catch (err) {
      console.error(`[s2] ${symbol}:`, err.message);
    }
    await new Promise((r) => setTimeout(r, SCAN_DELAY));
  }
}

// ─── Status ───────────────────────────────────────────────────────────────────

function buildStatus() {
  const s      = adminRef?.agentStatus?.SCALPER2 ?? {};
  const status = !enabled ? '⛔ OFF' : adminRef?.emergencyStop ? '🛑 STOPPED' : '🟢 ON';
  const lines  = [
    `📊 <b>SCALPER2</b> — VWAP+EMA — ${status}`,
    '',
    `<b>⚙️ Settings:</b>`,
    `  leverage:     <code>${cfg.leverage}x</code>  ${cfg.marginMode}`,
    `  risk:         <code>${cfg.riskPct}%</code>`,
    `  tp:           <code>${cfg.tp}%</code>`,
    `  sl:           <code>${cfg.sl}%</code>`,
    `  maxTrades:    <code>${cfg.maxTrades}</code>`,
    `  trailingStop: <code>${cfg.trailingStop}</code>`,
    '',
    `<b>📈 Stats:</b>`,
    `  Open:   <code>${openTrades.size}/${cfg.maxTrades}</code>`,
    `  Trades: <code>${s.trades ?? 0}</code>`,
    `  PnL:    <code>${(s.totalPnl ?? 0) >= 0 ? '+' : ''}${(s.totalPnl ?? 0).toFixed(2)} USD</code>`,
  ];
  if (openTrades.size > 0) {
    lines.push('', '<b>Open positions:</b>');
    for (const [sym, t] of openTrades) {
      const dir   = t.direction === 'long' ? '🟢' : '🔴';
      const trail = t.trailActive ? ' 🔒BE' : '';
      lines.push(`  ${dir} <b>${sym}</b> @ <code>${t.entry}</code>  SL <code>${t.sl}</code>${trail}`);
    }
  }
  return lines.join('\n');
}

// ─── Init ─────────────────────────────────────────────────────────────────────

function init(admin) {
  adminRef = admin;

  const status = adminRef?.agentStatus?.SCALPER2;
  if (status) status.running = true; // trades/pnl persist across restarts via admin.js

  registerCommand('s2', async (ctx) => {
    const arg = ctx.message?.text?.trim().split(/\s+/)[1]?.toLowerCase();
    const { sendAdmin } = require('../core/telegram');
    if (arg === 'on') {
      enabled = true;
      if (adminRef?.agentStatus?.SCALPER2) adminRef.agentStatus.SCALPER2.running = true;
      await sendAdmin('✅ <b>SCALPER2</b> enabled');
    } else if (arg === 'off') {
      enabled = false;
      if (adminRef?.agentStatus?.SCALPER2) adminRef.agentStatus.SCALPER2.running = false;
      await sendAdmin('⛔ <b>SCALPER2</b> disabled');
    } else {
      await sendAdmin(buildStatus());
    }
  });

  // /s2_set_tpsl SYMBOL SIDE SL TP
  registerCommand('s2_set_tpsl', async (args) => {
    const { sendAdmin } = require('../core/telegram');
    const parts = (args || '').trim().split(/\s+/);
    if (parts.length < 4) {
      await sendAdmin('Usage: /s2_set_tpsl SYMBOL SIDE SL TP');
      return;
    }
    const [symbol, holdSide, slStr, tpStr] = parts;
    const sl = parseFloat(slStr);
    const tp = parseFloat(tpStr);
    if (isNaN(sl) || isNaN(tp)) { await sendAdmin('❌ Invalid price values'); return; }
    try {
      await bitget.setPositionSingleTPSL(symbol.toUpperCase(), holdSide.toLowerCase(), sl, tp);
      await sendAdmin(`✅ <b>SCALPER2</b> TP/SL set on ${symbol.toUpperCase()} ${holdSide.toLowerCase()}\nSL: <code>${sl}</code>  TP: <code>${tp}</code>`);
    } catch (err) {
      console.error('[s2] s2_set_tpsl error:', err.message);
      await sendAdmin(`❌ Failed: ${err.message}`);
    }
  });

  bitget.loadContractSpecs().catch(err => console.error('[s2] loadContractSpecs:', err.message));

  cron.schedule('4,19,34,49 * * * *', () => {
    runScan().catch((err) => {
      console.error('[s2] scan error:', err.message);
      sendAlert(`S2 scan error: ${err.message}`).catch(() => {});
    });
  });

  setInterval(() => {
    syncPositions().catch((err) => console.error('[s2] syncPositions error:', err.message));
  }, 10_000);

  // Recover positions from disk (preserves SL/TP), then cross-check with Bitget
  const savedTrades = loadOpenTrades();
  let recoverDelay = 0;
  for (const t of savedTrades) {
    if (openTrades.has(t.symbol) || tradeRegistry.isClaimed(t.symbol)) continue;
    const trade = { ...t, closing: false, trailActive: false };
    openTrades.set(t.symbol, trade);
    tradeRegistry.claim(t.symbol);
    setTimeout(() => startMonitor(trade), recoverDelay);
    recoverDelay += 2000; // stagger monitors 2s apart to avoid API rate limits
    console.log(`[s2] recovered from disk: ${t.symbol} ${t.direction} x${t.size} @ ${t.entry} SL=${t.sl} TP=${t.tp}`);
  }

  bitget.getOpenPositions().then(positions => {
    let bitgetDelay = 0;
    for (const pos of positions) {
      const sym = pos.symbol;
      if (openTrades.has(sym) || tradeRegistry.isClaimed(sym)) continue;
      const direction = pos.holdSide;
      const entry     = parseFloat(pos.openPriceAvg);
      const sl        = parseFloat(pos.stopLossPrice)   || 0;
      const tp        = parseFloat(pos.takeProfitPrice) || 0;
      const size      = parseFloat(pos.total);
      if (!size || !entry) continue;
      const trade = { symbol: sym, direction, entry, sl, tp, size, openedAt: Date.now() - 300_000, closing: false, trailActive: false };
      openTrades.set(sym, trade);
      tradeRegistry.claim(sym);
      setTimeout(() => startMonitor(trade), bitgetDelay);
      bitgetDelay += 2000; // stagger monitors 2s apart to avoid API rate limits
      if (!sl) console.warn(`[s2] recovered ${sym} (Bitget): no SL/TP — use /s2_set_tpsl to fix`);
      else console.log(`[s2] recovered position (Bitget): ${sym} ${direction} x${size} @ ${entry} SL=${sl} TP=${tp}`);
    }
    saveOpenTrades();
  }).catch(err => console.error('[s2] position recovery failed:', err.message));

  console.log(`[s2] initialized — VWAP+EMA | BTC/ETH/SOL/BNB+top20 | 15m scan | ${cfg.leverage}x ${cfg.marginMode} | max ${cfg.maxTrades} trades`);
}

// ─── Exports ──────────────────────────────────────────────────────────────────

function setEnabled(val) { enabled = val; }

module.exports = { init, applySetting, setEnabled, get enabled() { return enabled; } };
