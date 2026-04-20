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

const AGENT       = 'SCALPER3';
const CAPITAL     = 2;           // $2 dedicated capital
const COOLDOWN_MS = 60 * 60 * 1000;  // 1h cooldown per symbol — higher leverage needs patience
const SCAN_DELAY  = 350;
const MONITOR_SEC = 20_000;      // faster monitor — 50x leverage

const SETTINGS_FILE    = path.join(__dirname, '../.claude/memory/scalper_settings.json');
const OPEN_TRADES_FILE = path.join(__dirname, '../data/open_trades_s3.json');

function saveOpenTrades() {
  try {
    const arr = [];
    for (const [, t] of openTrades) {
      if (t.closing) continue;
      arr.push({ symbol: t.symbol, direction: t.direction, entry: t.entry, sl: t.sl, tp: t.tp, size: t.size, openedAt: t.openedAt });
    }
    fs.writeFileSync(OPEN_TRADES_FILE, JSON.stringify(arr, null, 2));
  } catch (err) { console.error('[s3] saveOpenTrades:', err.message); }
}

function loadOpenTrades() {
  try {
    if (!fs.existsSync(OPEN_TRADES_FILE)) return [];
    return JSON.parse(fs.readFileSync(OPEN_TRADES_FILE, 'utf8'));
  } catch { return []; }
}

// ─── Settings ─────────────────────────────────────────────────────────────────

const DEFAULTS = {
  leverage: 50, riskPct: 0.5, minRR: 2.5, slPct: 0.5, maxTrades: 2,
  marginMode: 'crossed',
  // Wall detection
  minWallSize: 50000, maxSpread: 0.1, fibLevel: 0.618,
  // Short protection
  shortOnly: true, negTpGuard: true,
  // Blacklist
  excludedSymbols: 'XAUTUSDT,XAUUSDT',
};

function readAll() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch { return {}; }
}

function loadSettings() {
  const all = readAll();
  return { ...DEFAULTS, ...all.s3 };
}

function saveSettings() {
  const all = readAll();
  all.s3 = {
    leverage: cfg.leverage, riskPct: cfg.riskPct, minRR: cfg.minRR, slPct: cfg.slPct, maxTrades: cfg.maxTrades,
    marginMode: cfg.marginMode,
    minWallSize: cfg.minWallSize, maxSpread: cfg.maxSpread, fibLevel: cfg.fibLevel,
    shortOnly: cfg.shortOnly, negTpGuard: cfg.negTpGuard,
    excludedSymbols: cfg.excludedSymbols,
  };
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(all, null, 2));
}

let cfg = loadSettings();

const SET_KEYS = {
  // Core
  leverage:         { parse: parseFloat, min: 1,   max: 125,  label: 'Leverage'          },
  risk:             { field: 'riskPct',         parse: parseFloat, min: 0.1,  max: 5,    label: 'Risk %'            },
  minrr:            { field: 'minRR',           parse: parseFloat, min: 1,    max: 20,   label: 'Min RR'            },
  sl:               { field: 'slPct',           parse: parseFloat, min: 0.1,  max: 500,  label: 'SL %'              },
  maxtrades:        { field: 'maxTrades',        parse: parseInt,   min: 1,    max: 50,   label: 'Max Trades'        },
  // Wall detection
  minwallsize:      { field: 'minWallSize',      parse: parseFloat, min: 0,    max: 1e8,  label: 'Min Wall Size'     },
  maxspread:        { field: 'maxSpread',        parse: parseFloat, min: 0.01, max: 1.0,  label: 'Max Spread %'      },
  fiblvl:           { field: 'fibLevel',         parse: parseFloat, enum: [0.5, 0.618, 0.786], label: 'Fib Level'   },
  // Short protection
  shortonly:        { field: 'shortOnly',        parse: (v) => v === '1' || v === 'true' || v === true, label: 'Short Only'  },
  negtpguard:       { field: 'negTpGuard',       parse: (v) => v === '1' || v === 'true' || v === true, label: 'Neg TP Guard' },
  // Blacklist
  excludedsymbols:  { field: 'excludedSymbols',  parse: String,     label: 'Excluded Symbols'  },
  // Margin
  margin:           { field: 'marginMode',        parse: String, enum: ['isolated', 'crossed'], label: 'Margin Mode' },
};

function applySetting(key, rawValue) {
  const ALIASES = { riskpct: 'risk', maxtrades: 'maxtrades', minrr: 'minrr', slpct: 'sl', marginmode: 'margin' };
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
 * Find the most recent major swing: returns { swingHigh, swingLow } over the last `lookback` candles.
 * Uses a simple highest-high / lowest-low in two halves to find the significant move.
 */
function findSwing(candles, lookback = 60) {
  const c         = candles.slice(-lookback);
  const swingHigh = Math.max(...c.map((x) => x.high));
  const swingLow  = Math.min(...c.map((x) => x.low));
  return { swingHigh, swingLow };
}

/**
 * Calculate Fibonacci retracement levels for a SHORT setup.
 * In a downtrend, price bounces; the 61.8% and 78.6% retracements from the
 * most recent swing high back toward the swing low act as resistance.
 *
 * Returns { fib618, fib786, swingHigh, swingLow }
 */
function calcFibLevels(candles) {
  const { swingHigh, swingLow } = findSwing(candles, 80);
  const range = swingHigh - swingLow;
  if (range === 0) return null;
  return {
    fibSelected: swingHigh - range * cfg.fibLevel,  // configurable retracement level
    fibLabel:    `Fib ${(cfg.fibLevel * 100 % 1 === 0 ? cfg.fibLevel * 100 : (cfg.fibLevel * 100).toFixed(1))}%`,
    swingHigh,
    swingLow,
    range,
  };
}

/**
 * Check if current price is within `tolerance` of a Fibonacci level.
 */
function nearFibLevel(price, fib, tolerance = 0.004) {
  return Math.abs(price - fib) / price <= tolerance;
}

function hasVolumeSpike(candles) {
  const c   = candles.slice(-21);
  const cur = c[c.length - 1].vol;
  const avg = c.slice(0, -1).reduce((s, x) => s + x.vol, 0) / 20;
  return avg > 0 && cur > avg * 1.4;
}

// ─── Analysis (SHORT ONLY) ───────────────────────────────────────────────────

async function analyzeSymbol(symbol) {
  // 15m candles — enough data for fib + EMA50 + volume
  const candles = await bitget.getKlines(symbol, 'Min15', 100);
  if (candles.length < 60) {
    console.log(`[s3] ${symbol}: skip — only ${candles.length} candles`);
    return null;
  }

  const closes = candles.map((c) => c.close);
  const ema50  = calcEMA(closes, 50);
  if (!ema50) {
    console.log(`[s3] ${symbol}: skip — EMA50 calc failed`);
    return null;
  }

  const price = candles[candles.length - 1].close;

  // EMA50 must be above price → bearish context
  if (ema50 <= price) {
    console.log(`[s3] ${symbol}: skip — bullish context (EMA50=${ema50.toPrecision(5)} <= price=${price.toPrecision(5)})`);
    return null;
  }

  const fibs = calcFibLevels(candles);
  if (!fibs) {
    console.log(`[s3] ${symbol}: skip — flat range, cannot calc Fib`);
    return null;
  }

  // Is price near the configured Fib resistance level?
  if (!nearFibLevel(price, fibs.fibSelected)) {
    const dist = ((Math.abs(price - fibs.fibSelected) / price) * 100).toFixed(2);
    console.log(`[s3] ${symbol}: skip — not near ${fibs.fibLabel} (${dist}% away)`);
    return null;
  }
  const hitLevel = { value: fibs.fibSelected, label: fibs.fibLabel };

  // Spread + wall size check via order book
  if (cfg.minWallSize > 0 || cfg.maxSpread < 1.0) {
    try {
      const book = await bitget.getOrderBook(symbol, 20);
      // Spread guard
      const bestBid = book.bids[0]?.[0];
      const bestAsk = book.asks[0]?.[0];
      if (bestBid && bestAsk) {
        const spreadPct = (bestAsk - bestBid) / bestAsk * 100;
        if (spreadPct > cfg.maxSpread) {
          console.log(`[s3] ${symbol}: skip — spread ${spreadPct.toFixed(3)}% > max ${cfg.maxSpread}%`);
          return null;
        }
      }
      // Sell wall guard: aggregate ask size (in USDT) within 1% of fib level
      if (cfg.minWallSize > 0) {
        const wallUsd = book.asks
          .filter(([p]) => Math.abs(p - hitLevel.value) / hitLevel.value <= 0.01)
          .reduce((sum, [p, s]) => sum + p * s, 0);
        if (wallUsd < cfg.minWallSize) {
          console.log(`[s3] ${symbol}: skip — no wall at ${hitLevel.label} (wall $${wallUsd.toFixed(0)} < min $${cfg.minWallSize})`);
          return null;
        }
        console.log(`[s3] ${symbol}: wall confirmed at ${hitLevel.label} ($${wallUsd.toFixed(0)})`);
      }
    } catch (err) {
      console.error(`[s3] ${symbol}: order book fetch error: ${err.message} — continuing without wall check`);
    }
  }

  // Volume confirmation
  if (!hasVolumeSpike(candles)) {
    const c21 = candles.slice(-21);
    const cur = c21[c21.length - 1].vol, avg = c21.slice(0, -1).reduce((s, x) => s + x.vol, 0) / 20;
    console.log(`[s3] ${symbol}: skip — ${hitLevel.label} hit but no volume spike (vol=${cur.toFixed(0)} avg=${avg.toFixed(0)} ratio=${(cur/avg).toFixed(2)}x < 1.4x)`);
    return null;
  }

  // Build trade parameters — SHORT only
  const direction = 'short';
  const entry     = price;
  const slPct     = cfg.slPct / 100;
  const sl        = bitget.roundPrice(entry * (1 + slPct), symbol);   // SL above entry
  const risk      = sl - entry;

  // TP at minimum RR
  const tp  = bitget.roundPrice(entry - risk * cfg.minRR, symbol);
  const rr  = cfg.minRR;

  if (tp <= 0) {
    if (cfg.negTpGuard) {
      console.error(`[s3] ${symbol}: skip — TP=${tp} <= 0 (negTpGuard ON | entry=${entry} risk=${risk} minRR=${cfg.minRR} slPct=${cfg.slPct}%)`);
      return null;
    }
    console.warn(`[s3] ${symbol}: WARNING — TP=${tp} <= 0 but negTpGuard is OFF`);
  }

  // Additional EMA50 confluence check: EMA50 should be near the fib level (within 1%)
  const ema50NearLevel = Math.abs(ema50 - hitLevel.value) / ema50 <= 0.01;

  const size = bitget.roundSize(calcSize(entry, sl), symbol);
  console.log(`[s3] ${symbol}: SIGNAL SHORT | ${hitLevel.label} | EMA50=${ema50.toPrecision(5)} conf=${ema50NearLevel} | entry=${entry.toPrecision(5)} sl=${sl} tp=${tp} size=${size} notional=$${(size*entry).toFixed(2)}`);

  return {
    symbol, direction, entry, sl, tp, rr,
    level:       hitLevel,
    ema50:       +ema50.toPrecision(6),
    ema50Conf:   ema50NearLevel,
    swingHigh:   fibs.swingHigh,
    swingLow:    fibs.swingLow,
  };
}

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
    console.warn('[s3] executeTrade ignored — agent disabled or stopped');
    return;
  }
  const { symbol, direction, entry, sl, tp, level, ema50, ema50Conf } = signal;
  const size = bitget.roundSize(calcSize(entry, sl), symbol);

  const { orderId } = await bitget.placeLimitOrder(
    symbol, direction, size, entry, cfg.leverage, cfg.marginMode, sl, tp
  );

  const trade = { symbol, direction, entry, sl, tp, size, orderId, openedAt: Date.now(), tpslSet: false };
  openTrades.set(symbol, trade);
  saveOpenTrades();
  cooldowns.set(symbol, Date.now());

  const status = adminRef?.agentStatus?.SCALPER3;
  if (status) status.trades = (status.trades || 0) + 1;

  const conf = ema50Conf ? 0.80 : 0.70;
  const setupLabel = `S3/SHORT@${level.label}${ema50Conf ? '+EMA50✓' : ''} | ${cfg.leverage}x ${cfg.marginMode}`;

  await sendSignal({
    symbol, direction, entry, sl, tp, rr: signal.rr, tf: '15m', confidence: conf,
    setup: setupLabel, from: AGENT,
  });
  await sendTrade({ agent: AGENT, action: 'open', symbol, direction, size, entry, sl, tp, pnl: null });

  console.log(`[s3] limit SHORT: ${symbol} x${size} @ ${entry} | SL ${sl} | TP ${tp} | ${level.label} | EMA50 ${ema50}`);

  startMonitor(trade);
}

// ─── Trade monitor ────────────────────────────────────────────────────────────

function startMonitor(trade) {
  const id = setInterval(async () => {
    try {
      await checkTrade(trade, id);
    } catch (err) {
      console.error(`[s3] monitor ${trade.symbol}:`, err.message);
    }
  }, MONITOR_SEC);
}

async function checkTrade(trade, intervalId) {
  const price  = await bitget.getPrice(trade.symbol);

  // Set TP/SL on exchange once the limit order fills (position becomes visible)
  if (!trade.tpslSet) {
    if (trade.sl > 0 && trade.tp > 0) {
      try {
        const positions = await bitget.getOpenPositions(trade.symbol);
        if (positions.some((p) => p.holdSide === trade.direction)) {
          await bitget.setPositionSingleTPSL(trade.symbol, trade.direction, trade.sl, trade.tp);
          trade.tpslSet = true;
          console.log(`[s3] TP/SL set on position: ${trade.symbol} SL=${trade.sl} TP=${trade.tp}`);
        }
      } catch (err) {
        console.error(`[s3] failed to set TP/SL ${trade.symbol}:`, err.message);
      }
    } else {
      trade.tpslSet = true; // no valid SL/TP values — skip, rely on syncPositions for closure
    }
  }

  // If no valid SL/TP (e.g. recovered position with no TP/SL on exchange), skip price-based exit
  // and rely on syncPositions to detect closure. Without this guard, tp=0 causes tpHit=true always.
  if (!trade.sl || !trade.tp) return;

  const slHit  = price >= trade.sl;   // SHORT — SL above entry
  const tpHit  = price <= trade.tp;   // SHORT — TP below entry

  if (!slHit && !tpHit) return;

  if (trade.closing) { clearInterval(intervalId); return; }
  trade.closing = true;
  clearInterval(intervalId);
  try {
    await bitget.closePosition(trade.symbol);
  } catch (err) {
    // 22002 = position already closed by exchange TP/SL — continue to log the trade
    console.log(`[s3] closePosition ${trade.symbol} skipped (${err.message}) — logging anyway`);
  }

  // BUG 2 fix: fetch actual realized PnL from Bitget history instead of estimating
  let pnl = await bitget.getClosedPositionPnl(trade.symbol, trade.openedAt);
  if (pnl === null) {
    pnl = +(trade.size * (trade.entry - price)).toFixed(4);  // short PnL fallback
  } else {
    pnl = +pnl.toFixed(4);
  }

  const exitPrice = slHit ? trade.sl : trade.tp;
  await sendTrade({ agent: AGENT, action: 'close', symbol: trade.symbol, direction: trade.direction,
    size: trade.size, entry: trade.entry, sl: trade.sl, tp: trade.tp, exitPrice, pnl });

  const status = adminRef?.agentStatus?.SCALPER3;
  if (status) status.pnl = +((status.pnl || 0) + pnl).toFixed(4);

  openTrades.delete(trade.symbol);
  saveOpenTrades();
  tradeRegistry.release(trade.symbol);

  if (slHit) await sendAlert(`S3 SL hit: ${trade.symbol} SHORT | exit: ${exitPrice} | pnl: ${pnl}`);

  adminRef?.checkRisk?.().catch(() => {});
  console.log(`[s3] ${slHit ? 'SL' : 'TP'} hit ${trade.symbol} pnl ${pnl >= 0 ? '+' : ''}${pnl}`);
}

// ─── Position sync (detect Bitget SL/TP closures) ────────────────────────────

async function syncPositions() {
  if (openTrades.size === 0) return;

  for (const [symbol, trade] of openTrades) {
    if (trade.closing) continue;
    if (!trade.tpslSet) continue; // limit order not yet confirmed filled

    // BUG 1 fix: query per-symbol so an empty result reliably means the position is gone
    let symbolPositions;
    try {
      symbolPositions = await bitget.getOpenPositions(symbol);
    } catch (err) {
      console.error(`[s3] syncPositions fetch error for ${symbol}:`, err.message);
      continue;
    }

    const positionExists = symbolPositions.some((p) => p.holdSide === trade.direction);
    if (positionExists) continue; // still open on Bitget

    trade.closing = true;
    console.log(`[s3] sync: ${symbol} no longer on Bitget → closed externally`);

    try {
      // BUG 2 fix: fetch actual realized PnL from Bitget history
      let pnl = await bitget.getClosedPositionPnl(symbol, trade.openedAt);

      const price = await bitget.getPrice(symbol);
      // SHORT only — SL is above entry, TP is below entry
      const slHit    = price > trade.entry;
      const exitPrice = slHit ? trade.sl : trade.tp;
      const reason    = slHit ? 'SL hit' : 'TP hit';

      if (pnl === null) {
        pnl = +(trade.size * (trade.entry - exitPrice)).toFixed(4);
      } else {
        pnl = +pnl.toFixed(4);
      }

      openTrades.delete(symbol);
      saveOpenTrades();
      tradeRegistry.release(symbol);

      const status = adminRef?.agentStatus?.SCALPER3;
      if (status) status.pnl = +((status.pnl || 0) + pnl).toFixed(4);

      await sendTrade({ agent: AGENT, action: 'close', symbol, direction: trade.direction,
        size: trade.size, entry: trade.entry, sl: trade.sl, tp: trade.tp, exitPrice, reason, pnl });

      if (slHit) await sendAlert(`S3 SL hit (exchange): ${symbol} SHORT | exit: ${exitPrice} | pnl: ${pnl}`);

      adminRef?.checkRisk?.().catch(() => {});
      console.log(`[s3] sync: ${symbol} closed by exchange (${reason}) exit=${exitPrice} pnl=${pnl >= 0 ? '+' : ''}${pnl}`);
    } catch (err) {
      console.error(`[s3] syncPositions ${symbol}:`, err.message);
      trade.closing = false;
    }
  }
}

// ─── Scan ─────────────────────────────────────────────────────────────────────

async function runScan() {
  if (!enabled || adminRef?.emergencyStop || adminRef?.globalPaused) return;
  if (openTrades.size >= cfg.maxTrades) return;

  const tickers = await bitget.getAllTickers();
  const top50   = tickers
    .filter((t) => t.amount24 > 0)
    .sort((a, b) => b.amount24 - a.amount24)
    .slice(0, 50)
    .map((t) => t.symbol);

  // Build blacklist set from cfg (parsed fresh each scan so live edits take effect)
  const blacklist = new Set(
    (cfg.excludedSymbols || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
  );

  console.log(`[s3] scanning ${top50.length} symbols… (open: ${openTrades.size}/${cfg.maxTrades} | blacklist: ${blacklist.size} | shortOnly: ${cfg.shortOnly})`);

  for (const symbol of top50) {
    if (openTrades.size >= cfg.maxTrades) break;
    if (openTrades.has(symbol)) continue;
    // Blacklist check
    if (blacklist.has(symbol)) {
      console.log(`[s3] ${symbol}: skip — blacklisted`);
      continue;
    }
    const last = cooldowns.get(symbol);
    if (last && Date.now() - last < COOLDOWN_MS) continue;

    try {
      const signal = await analyzeSymbol(symbol);
      if (signal) {
        // Short Only guard: belt-and-suspenders check
        if (cfg.shortOnly && signal.direction !== 'short') {
          console.log(`[s3] ${symbol}: skip — shortOnly=true, signal direction=${signal.direction}`);
          continue;
        }
        // Cross-agent conflict guard: skip if any agent already holds this symbol
        if (await positionCache.isSymbolTaken(symbol)) {
          console.log(`[s3] ${symbol}: skip — open position exists on exchange (cross-agent conflict)`);
        } else {
          cooldowns.set(symbol, Date.now()); // set before execute so failure doesn't cause retry spam
          await executeTrade(signal);
          positionCache.invalidate(); // force fresh fetch for next agent scan
        }
      }
    } catch (err) {
      console.error(`[s3] ${symbol}:`, err.message);
    }
    await new Promise((r) => setTimeout(r, SCAN_DELAY));
  }
}

// ─── Status ───────────────────────────────────────────────────────────────────

function buildStatus() {
  const s      = adminRef?.agentStatus?.SCALPER3 ?? {};
  const status = !enabled ? '⛔ OFF' : adminRef?.emergencyStop ? '🛑 STOPPED' : '🟢 ON';
  const lines  = [
    `📊 <b>SCALPER3</b> — Short from Wall — ${status}`,
    `<i>SHORT ONLY | Fib 61.8%/78.6% + EMA50 + Volume</i>`,
    '',
    `<b>⚙️ Settings:</b>`,
    `  leverage:  <code>${cfg.leverage}x</code>  ${cfg.marginMode}`,
    `  risk:      <code>${cfg.riskPct}%</code>  (~$${(CAPITAL * cfg.riskPct / 100).toFixed(3)})`,
    `  sl:        <code>${cfg.slPct}%</code>`,
    `  minRR:     <code>1:${cfg.minRR}</code>`,
    `  maxTrades: <code>${cfg.maxTrades}</code>`,
    '',
    `<b>📈 Stats:</b>`,
    `  Open:   <code>${openTrades.size}/${cfg.maxTrades}</code>`,
    `  Trades: <code>${s.trades ?? 0}</code>`,
    `  PnL:    <code>${(s.pnl ?? 0) >= 0 ? '+' : ''}${(s.pnl ?? 0).toFixed(2)} USD</code>`,
  ];
  if (openTrades.size > 0) {
    lines.push('', '<b>Open shorts:</b>');
    for (const [sym, t] of openTrades) {
      lines.push(`  🔴 <b>${sym}</b> @ <code>${t.entry}</code>  SL <code>${t.sl}</code>  TP <code>${t.tp}</code>`);
    }
  }
  return lines.join('\n');
}

// ─── Init ─────────────────────────────────────────────────────────────────────

function init(admin) {
  adminRef = admin;

  const status = adminRef?.agentStatus?.SCALPER3;
  if (status) status.running = true; // trades/pnl persist across restarts via admin.js

  registerCommand('s3', async (ctx) => {
    const arg = ctx.message?.text?.trim().split(/\s+/)[1]?.toLowerCase();
    const { sendAdmin } = require('../core/telegram');
    if (arg === 'on') {
      enabled = true;
      if (adminRef?.agentStatus?.SCALPER3) adminRef.agentStatus.SCALPER3.running = true;
      await sendAdmin('✅ <b>SCALPER3</b> enabled');
    } else if (arg === 'off') {
      enabled = false;
      if (adminRef?.agentStatus?.SCALPER3) adminRef.agentStatus.SCALPER3.running = false;
      await sendAdmin('⛔ <b>SCALPER3</b> disabled');
    } else {
      await sendAdmin(buildStatus());
    }
  });

  // /s3_set_tpsl SYMBOL SIDE SL TP
  registerCommand('s3_set_tpsl', async (args) => {
    const { sendAdmin } = require('../core/telegram');
    const parts = (args || '').trim().split(/\s+/);
    if (parts.length < 4) {
      await sendAdmin('Usage: /s3_set_tpsl SYMBOL SIDE SL TP');
      return;
    }
    const [symbol, holdSide, slStr, tpStr] = parts;
    const sl = parseFloat(slStr);
    const tp = parseFloat(tpStr);
    if (isNaN(sl) || isNaN(tp)) { await sendAdmin('❌ Invalid price values'); return; }
    try {
      await bitget.setPositionSingleTPSL(symbol.toUpperCase(), holdSide.toLowerCase(), sl, tp);
      await sendAdmin(`✅ <b>SCALPER3</b> TP/SL set on ${symbol.toUpperCase()} ${holdSide.toLowerCase()}\nSL: <code>${sl}</code>  TP: <code>${tp}</code>`);
    } catch (err) {
      console.error('[s3] s3_set_tpsl error:', err.message);
      await sendAdmin(`❌ Failed: ${err.message}`);
    }
  });

  bitget.loadContractSpecs().catch(err => console.error('[s3] loadContractSpecs:', err.message));

  cron.schedule('1-59/2 * * * *', () => {
    runScan().catch((err) => {
      console.error('[s3] scan error:', err.message);
      sendAlert(`S3 scan error: ${err.message}`).catch(() => {});
    });
  });

  setInterval(() => {
    syncPositions().catch((err) => console.error('[s3] syncPositions error:', err.message));
  }, 30_000);

  // Recover positions from disk (preserves SL/TP), then cross-check with Bitget
  const savedTrades = loadOpenTrades();
  let recoverDelay = 0;
  for (const t of savedTrades) {
    if (openTrades.has(t.symbol) || tradeRegistry.isClaimed(t.symbol)) continue;
    const trade = { ...t, tpslSet: false, closing: false };
    openTrades.set(t.symbol, trade);
    tradeRegistry.claim(t.symbol);
    setTimeout(() => startMonitor(trade), recoverDelay);
    recoverDelay += 2000; // stagger monitors 2s apart to avoid API rate limits
    console.log(`[s3] recovered from disk: ${t.symbol} ${t.direction} x${t.size} @ ${t.entry} SL=${t.sl} TP=${t.tp}`);
  }

  // Fallback: catch any open shorts on Bitget not in the saved file (s3 = short-only)
  bitget.getOpenPositions().then(positions => {
    let bitgetDelay = 0;
    for (const pos of positions) {
      const sym = pos.symbol;
      if (openTrades.has(sym) || tradeRegistry.isClaimed(sym)) continue;
      const direction = pos.holdSide;
      if (direction !== 'short') continue; // S3 is short-only
      const entry = parseFloat(pos.openPriceAvg);
      const sl    = parseFloat(pos.stopLossPrice)   || 0;
      const tp    = parseFloat(pos.takeProfitPrice) || 0;
      const size  = parseFloat(pos.total);
      if (!size || !entry) continue;
      const trade = { symbol: sym, direction, entry, sl, tp, size, openedAt: Date.now() - 300_000, tpslSet: true, closing: false };
      openTrades.set(sym, trade);
      tradeRegistry.claim(sym);
      setTimeout(() => startMonitor(trade), bitgetDelay);
      bitgetDelay += 2000; // stagger monitors 2s apart to avoid API rate limits
      if (!sl) {
        console.warn(`[s3] recovered ${sym}: no SL/TP on exchange — use /s3_set_tpsl to fix`);
        sendAlert(`⚠️ S3 recovered <b>${sym}</b> short @ ${entry} with NO SL/TP on exchange!\nUse: <code>/s3_set_tpsl ${sym} short SL TP</code>`).catch(() => {});
      } else {
        console.log(`[s3] recovered position (Bitget): ${sym} ${direction} x${size} @ ${entry} SL=${sl} TP=${tp}`);
      }
    }
    saveOpenTrades();
  }).catch(err => console.error('[s3] position recovery (Bitget) failed:', err.message));

  console.log(`[s3] initialized — Short from Wall | top50 | 2m scan | ${cfg.leverage}x ${cfg.marginMode} | SHORT ONLY | max ${cfg.maxTrades} trades`);
}

// ─── Exports ──────────────────────────────────────────────────────────────────

function setEnabled(val) { enabled = val; }

module.exports = { init, applySetting, setEnabled, get enabled() { return enabled; } };
