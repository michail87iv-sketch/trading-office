'use strict';

const cron   = require('node-cron');
const fs     = require('fs');
const path   = require('path');
const bitget        = require('../core/bitget');
const { ema: calcEMA } = require('../core/indicators');
const positionCache   = require('../core/positionCache');
const tradeRegistry   = require('../core/tradeRegistry');
const { sendSignal, sendTrade, sendAlert, registerCommand } = require('../core/telegram');
const { logSettingChange } = require('../core/archive');

// ─── Config ───────────────────────────────────────────────────────────────────

const AGENT       = 'SCALPER1';
const CAPITAL     = 3;
const SCAN_DELAY  = 300;          // ms between symbols
const MONITOR_SEC = 30_000;       // price check interval

const SETTINGS_FILE    = path.join(__dirname, '../.claude/memory/scalper_settings.json');
const OPEN_TRADES_FILE = path.join(__dirname, '../data/open_trades_s1.json');

function saveOpenTrades() {
  try {
    const arr = [];
    for (const [, t] of openTrades) {
      if (t.closing) continue;
      arr.push({ symbol: t.symbol, direction: t.direction, entry: t.entry, sl: t.sl, tp: t.tp, size: t.size, openedAt: t.openedAt });
    }
    fs.writeFileSync(OPEN_TRADES_FILE, JSON.stringify(arr, null, 2));
  } catch (err) { console.error('[s1] saveOpenTrades:', err.message); }
}

function loadOpenTrades() {
  try {
    if (!fs.existsSync(OPEN_TRADES_FILE)) return [];
    return JSON.parse(fs.readFileSync(OPEN_TRADES_FILE, 'utf8'));
  } catch { return []; }
}

// ─── Settings ─────────────────────────────────────────────────────────────────

const DEFAULTS = {
  leverage: 15, riskPct: 1.5, tp: 0.7, sl: 0.4, maxTrades: 3,
  marginMode: 'isolated',
  timeframe: 'Min5',
  // RSI
  rsiPeriod: 14, rsiOversold: 30, rsiOverbought: 70,
  // Trend filter
  emaEnabled: true, emaPeriod: 50, emaTf: 'Min60',
  // Safety
  cooldownMin: 30, minVol24h: 1_000_000,
};

function readAll() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch { return {}; }
}

function loadSettings() {
  const all = readAll();
  return { ...DEFAULTS, ...all.s1 };
}

function saveSettings() {
  const all = readAll();
  // Prefer in-memory symbols; fall back to whatever is already on disk so a
  // concurrent symbols-route write is never silently erased.
  const symbols = (cfg.symbols && Object.keys(cfg.symbols).length)
    ? cfg.symbols
    : (all.s1?.symbols ?? {});
  all.s1 = {
    leverage: cfg.leverage, riskPct: cfg.riskPct, tp: cfg.tp, sl: cfg.sl, maxTrades: cfg.maxTrades,
    marginMode: cfg.marginMode, timeframe: cfg.timeframe,
    rsiPeriod: cfg.rsiPeriod, rsiOversold: cfg.rsiOversold, rsiOverbought: cfg.rsiOverbought,
    emaEnabled: cfg.emaEnabled, emaPeriod: cfg.emaPeriod, emaTf: cfg.emaTf,
    cooldownMin: cfg.cooldownMin, minVol24h: cfg.minVol24h,
  };
  if (Object.keys(symbols).length) all.s1.symbols = symbols;
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(all, null, 2));
}

function reloadSymbols() {
  const all = readAll();
  cfg.symbols = all.s1?.symbols ?? {};
}

let cfg = loadSettings();

function getSymbolCfg(symbol) {
  return { ...cfg, ...(cfg.symbols?.[symbol] ?? {}) };
}

const SET_KEYS = {
  // Core
  leverage:      { parse: parseFloat, min: 1,   max: 125,       label: 'Leverage'          },
  risk:          { field: 'riskPct',     parse: parseFloat, min: 0.1, max: 5,     label: 'Risk %'          },
  tp:            { parse: parseFloat, min: 0.1, max: 500,       label: 'TP %'              },
  sl:            { parse: parseFloat, min: 0.1, max: 500,       label: 'SL %'              },
  maxtrades:     { field: 'maxTrades',   parse: parseInt,   min: 1,   max: 50,    label: 'Max Trades'      },
  // RSI
  rsiperiod:     { field: 'rsiPeriod',   parse: parseInt,   min: 2,   max: 50,    label: 'RSI Period'      },
  rsioversold:   { field: 'rsiOversold', parse: parseFloat, min: 10,  max: 45,    label: 'RSI Oversold'    },
  rsioverbought: { field: 'rsiOverbought', parse: parseFloat, min: 55, max: 90,   label: 'RSI Overbought'  },
  // Trend filter
  emaenabled:    { field: 'emaEnabled',  parse: (v) => v === 'true' || v === true, label: 'EMA Filter' },
  emaperiod:     { field: 'emaPeriod',   parse: parseInt,   min: 10,  max: 200,   label: 'EMA Period'      },
  ematf:         { field: 'emaTf',       parse: String,     enum: ['Min15','Min60','Hour4'], label: 'EMA Timeframe' },
  // Safety
  cooldownmin:   { field: 'cooldownMin', parse: parseInt,   min: 0,   max: 1440,  label: 'Cooldown (min)'  },
  minvol24h:     { field: 'minVol24h',   parse: parseFloat, min: 0,   max: 1e11,  label: 'Min Vol 24h'     },
  // Margin
  margin:        { field: 'marginMode',  parse: String,     enum: ['isolated', 'crossed'], label: 'Margin Mode' },
  // Timeframe
  timeframe:     { field: 'timeframe',   parse: String,     enum: ['Min1','Min5','Min15','Min30','H1','H4','D1'], label: 'Timeframe' },
};

function applySetting(key, rawValue) {
  const ALIASES = { riskpct: 'risk', maxtrades: 'maxtrades', marginmode: 'margin' };
  const lookup  = ALIASES[key.toLowerCase()] ?? key.toLowerCase();
  const def = SET_KEYS[lookup];
  if (!def) return { ok: false, error: `Unknown key. Use: ${Object.keys(SET_KEYS).join(', ')}` };
  const val = def.parse(rawValue);
  if (typeof val === 'number') {
    if (isNaN(val) || (def.min != null && val < def.min) || (def.max != null && val > def.max))
      return { ok: false, error: `Value must be ${def.min}–${def.max}` };
  }
  if (def.enum && !def.enum.includes(val))
    return { ok: false, error: `Value must be one of: ${def.enum.join(', ')}` };
  const field    = def.field ?? key.toLowerCase();
  const oldValue = cfg[field];
  cfg[field] = val;
  logSettingChange(AGENT, field, oldValue, val);
  saveSettings();
  return { ok: true, label: def.label, value: val };
}

// ─── State ────────────────────────────────────────────────────────────────────

const openTrades = new Map();  // symbol → trade
const cooldowns  = new Map();  // symbol → timestamp
let   adminRef   = null;
let   enabled    = true;

// ─── Indicators ───────────────────────────────────────────────────────────────

function calcRSI(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const closes = candles.map((c) => c.close);
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) avgGain += d; else avgLoss -= d;
  }
  avgGain /= period; avgLoss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return +(100 - 100 / (1 + avgGain / avgLoss)).toFixed(1);
}

/**
 * Find nearest support (for long) or resistance (for short) using 3-bar fractals.
 * Returns the level price or null.
 */
function detectLevel(candles, direction) {
  const c = candles.slice(-60);
  if (direction === 'long') {
    for (let i = c.length - 4; i >= 2; i--) {
      if (c[i].low < c[i - 1].low && c[i].low < c[i - 2].low &&
          c[i + 1] && c[i].low < c[i + 1].low &&
          c[i + 2] && c[i].low < c[i + 2].low) {
        return c[i].low;
      }
    }
  } else {
    for (let i = c.length - 4; i >= 2; i--) {
      if (c[i].high > c[i - 1].high && c[i].high > c[i - 2].high &&
          c[i + 1] && c[i].high > c[i + 1].high &&
          c[i + 2] && c[i].high > c[i + 2].high) {
        return c[i].high;
      }
    }
  }
  return null;
}

function hasVolumeSpike(candles) {
  const c   = candles.slice(-21);
  const cur = c[c.length - 1].vol;
  const avg = c.slice(0, -1).reduce((s, x) => s + x.vol, 0) / 20;
  return avg > 0 && cur > avg * 1.5;
}

// ─── Analysis ─────────────────────────────────────────────────────────────────

async function analyzeSymbol(symbol) {
  const c       = getSymbolCfg(symbol);
  const candles = await bitget.getKlines(symbol, c.timeframe, 80);
  if (candles.length < 30) {
    console.log(`[s1] ${symbol}: skip — insufficient candles (${candles.length})`);
    return null;
  }

  const rsi = calcRSI(candles, c.rsiPeriod);
  if (rsi === null) {
    console.log(`[s1] ${symbol}: skip — RSI calc failed`);
    return null;
  }

  let direction;
  if (rsi < c.rsiOversold)       direction = 'long';
  else if (rsi > c.rsiOverbought) direction = 'short';
  else {
    console.log(`[s1] ${symbol}: skip — RSI=${rsi} (need <${c.rsiOversold} long or >${c.rsiOverbought} short)`);
    return null;
  }

  const price = candles[candles.length - 1].close;

  // ── EMA trend filter — LONG only ────────────────────────────────────────────
  // RSI oversold in a downtrend is continuation, not reversal. Skip if price is
  // below the EMA on the configured timeframe.
  if (direction === 'long' && c.emaEnabled) {
    const tfCandles = await bitget.getKlines(symbol, c.emaTf, c.emaPeriod + 10);
    if (tfCandles.length >= c.emaPeriod) {
      const emaArr = calcEMA(tfCandles.map((x) => x.close), c.emaPeriod);
      const emaVal = emaArr[emaArr.length - 1];
      if (emaVal !== null && price < emaVal) {
        console.log(`[s1] ${symbol}: skip — EMA${c.emaPeriod}(${c.emaTf}) filter: bearish trend (price=${price.toPrecision(5)} < EMA=${emaVal.toPrecision(5)})`);
        return null;
      }
    }
  }
  // ────────────────────────────────────────────────────────────────────────────

  if (!hasVolumeSpike(candles)) {
    console.log(`[s1] ${symbol}: skip — RSI=${rsi} OK (${direction}) but no volume spike`);
    return null;
  }

  const level = detectLevel(candles, direction);
  if (!level) {
    console.log(`[s1] ${symbol}: skip — RSI=${rsi} OK (${direction}), vol OK, no level fractal`);
    return null;
  }

  const dist  = Math.abs(price - level) / price;
  if (dist > 0.005) {
    console.log(`[s1] ${symbol}: skip — RSI=${rsi} OK (${direction}), level=${level.toPrecision(6)}, price too far from level (${(dist*100).toFixed(2)}% > 0.5%)`);
    return null;
  }

  const tpPct = c.tp / 100;
  const slPct = c.sl / 100;

  const entry = bitget.roundPrice(direction === 'long'
    ? level * (1 + 0.0005)
    : level * (1 - 0.0005), symbol);
  const sl    = bitget.roundPrice(direction === 'long'
    ? level * (1 - slPct)
    : level * (1 + slPct), symbol);
  const tp    = bitget.roundPrice(direction === 'long'
    ? entry * (1 + tpPct)
    : entry * (1 - tpPct), symbol);
  const rr    = +(tpPct / slPct).toFixed(2);

  const size = bitget.roundSize(calcSize(c, entry, sl), symbol);
  console.log(`[s1] ${symbol}: SIGNAL ${direction.toUpperCase()} | RSI=${rsi} level=${level.toPrecision(6)} entry=${entry} sl=${sl} tp=${tp} size=${size} notional=$${(size*entry).toFixed(2)}`);

  return { symbol, direction, entry, sl, tp, rr, rsi, level };
}


// ─── Sizing ───────────────────────────────────────────────────────────────────

const MIN_NOTIONAL = 5; // Bitget minimum order value in USDT

function calcSize(c, entry, sl) {
  const riskUsdt     = CAPITAL * (c.riskPct / 100);
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
    console.warn('[s1] executeTrade ignored — agent disabled or stopped');
    return;
  }
  const { symbol, direction, entry, sl, tp, rsi } = signal;
  const c    = getSymbolCfg(symbol);
  const size = bitget.roundSize(calcSize(c, entry, sl), symbol);

  const { orderId } = await bitget.placeLimitOrder(
    symbol, direction, size, entry, c.leverage, c.marginMode, sl, tp
  );

  const trade = { symbol, direction, entry, sl, tp, size, orderId, openedAt: Date.now(), tpslSet: false };
  openTrades.set(symbol, trade);
  saveOpenTrades();
  cooldowns.set(symbol, Date.now());

  const status = adminRef?.agentStatus?.SCALPER1;
  if (status) status.trades = (status.trades || 0) + 1;

  await sendSignal({
    symbol, direction, entry, sl, tp, rr: signal.rr, tf: '5m', confidence: 0.65,
    setup:  `S1/RSI${rsi}+Level | ${c.leverage}x ${c.marginMode}`,
    from:   AGENT,
  });
  await sendTrade({ agent: AGENT, action: 'open', symbol, direction, size, entry, sl, tp, pnl: null });

  console.log(`[s1] order: ${symbol} ${direction} x${size} @ ${entry} | SL ${sl} | TP ${tp} | orderId ${orderId}`);

  startMonitor(trade);
}

// ─── Trade monitor ────────────────────────────────────────────────────────────

function startMonitor(trade) {
  const id = setInterval(async () => {
    try {
      await checkTrade(trade, id);
    } catch (err) {
      console.error(`[s1] monitor ${trade.symbol}:`, err.message);
    }
  }, MONITOR_SEC);
}

async function checkTrade(trade, intervalId) {
  const price  = await bitget.getPrice(trade.symbol);
  const isLong = trade.direction === 'long';

  // Set TP/SL on exchange once the limit order fills (position becomes visible)
  if (!trade.tpslSet) {
    if (trade.sl > 0 && trade.tp > 0) {
      try {
        const positions = await bitget.getOpenPositions(trade.symbol);
        if (positions.some((p) => p.holdSide === trade.direction)) {
          await bitget.setPositionSingleTPSL(trade.symbol, trade.direction, trade.sl, trade.tp);
          trade.tpslSet = true;
          console.log(`[s1] TP/SL set on position: ${trade.symbol} SL=${trade.sl} TP=${trade.tp}`);
        }
      } catch (err) {
        console.error(`[s1] failed to set TP/SL ${trade.symbol}:`, err.message);
      }
    } else {
      trade.tpslSet = true; // no valid SL/TP values — skip, rely on syncPositions for closure
    }
  }

  // If no valid SL/TP (e.g. recovered position with no TP/SL on exchange), skip price-based exit
  // and rely on syncPositions to detect closure. Without this guard, tp=0 causes tpHit=true always.
  if (!trade.sl || !trade.tp) return;

  const slHit  = isLong ? price <= trade.sl : price >= trade.sl;
  const tpHit  = isLong ? price >= trade.tp : price <= trade.tp;

  if (!slHit && !tpHit) return;

  if (trade.closing) { clearInterval(intervalId); return; }
  trade.closing = true;
  clearInterval(intervalId);
  try {
    await bitget.closePosition(trade.symbol);
  } catch (err) {
    // 22002 = position already closed by exchange TP/SL — continue to log the trade
    console.log(`[s1] closePosition ${trade.symbol} skipped (${err.message}) — logging anyway`);
  }

  const reason    = tpHit ? 'TP hit' : 'SL hit';
  const exitPrice = tpHit ? trade.tp : trade.sl;

  // BUG 2 fix: fetch actual realized PnL from Bitget history instead of estimating
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

  const status = adminRef?.agentStatus?.SCALPER1;
  if (status) status.pnl = +((status.pnl || 0) + pnl).toFixed(4);

  openTrades.delete(trade.symbol);
  saveOpenTrades();
  tradeRegistry.release(trade.symbol);

  if (slHit) await sendAlert(`S1 SL hit: ${trade.symbol} ${trade.direction.toUpperCase()} | exit: ${exitPrice} | pnl: ${pnl}`);

  adminRef?.checkRisk?.().catch(() => {});
  console.log(`[s1] ${slHit ? 'SL' : 'TP'} hit ${trade.symbol} pnl ${pnl >= 0 ? '+' : ''}${pnl}`);
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
      console.error(`[s1] syncPositions fetch error for ${symbol}:`, err.message);
      continue;
    }

    const positionExists = symbolPositions.some((p) => p.holdSide === trade.direction);
    if (positionExists) continue; // still open on Bitget

    trade.closing = true;
    console.log(`[s1] sync: ${symbol} no longer on Bitget → closed externally`);

    try {
      // BUG 2 fix: fetch actual realized PnL from Bitget history
      let pnl = await bitget.getClosedPositionPnl(symbol, trade.openedAt);

      const price   = await bitget.getPrice(symbol);
      const isLong  = trade.direction === 'long';
      const slHit   = isLong ? price < trade.entry : price > trade.entry;
      const exitPrice = slHit ? trade.sl : trade.tp;
      const reason    = slHit ? 'SL hit' : 'TP hit';

      if (pnl === null) {
        // exitPrice can be 0 when trade was recovered from Bitget without SL/TP data;
        // fall back to current market price to avoid computing notional as PnL
        const effectiveExit = exitPrice || price;
        pnl = +(trade.size * (isLong ? effectiveExit - trade.entry : trade.entry - effectiveExit)).toFixed(4);
      } else {
        pnl = +pnl.toFixed(4);
      }

      openTrades.delete(symbol);
      saveOpenTrades();
      tradeRegistry.release(symbol);

      const status = adminRef?.agentStatus?.SCALPER1;
      if (status) status.pnl = +((status.pnl || 0) + pnl).toFixed(4);

      await sendTrade({ agent: AGENT, action: 'close', symbol, direction: trade.direction,
        size: trade.size, entry: trade.entry, sl: trade.sl, tp: trade.tp, exitPrice, reason, pnl });

      if (slHit) await sendAlert(`S1 SL hit (exchange): ${symbol} ${trade.direction.toUpperCase()} | exit: ${exitPrice} | pnl: ${pnl}`);

      adminRef?.checkRisk?.().catch(() => {});
      console.log(`[s1] sync: ${symbol} closed by exchange (${reason}) exit=${exitPrice} pnl=${pnl >= 0 ? '+' : ''}${pnl}`);
    } catch (err) {
      console.error(`[s1] syncPositions ${symbol}:`, err.message);
      trade.closing = false; // allow retry next tick
    }
  }
}

// ─── Scan ─────────────────────────────────────────────────────────────────────

async function runScan() {
  if (!enabled || adminRef?.emergencyStop || adminRef?.globalPaused) return;
  if (openTrades.size >= cfg.maxTrades) return;

  // Only trade symbols explicitly configured in per-symbol overrides with enabled !== false
  const scanList = Object.entries(cfg.symbols ?? {})
    .filter(([, ov]) => ov.enabled !== false)
    .map(([sym]) => sym);

  if (!scanList.length) {
    console.log('[s1] no enabled symbols configured — add symbols in Strategies → Scalper 1');
    return;
  }

  console.log(`[s1] scanning ${scanList.length} symbols: ${scanList.join(', ')} (open: ${openTrades.size}/${cfg.maxTrades})`);

  for (const symbol of scanList) {
    if (openTrades.size >= cfg.maxTrades) break;
    if (openTrades.has(symbol)) continue;
    const last = cooldowns.get(symbol);
    if (last && Date.now() - last < cfg.cooldownMin * 60_000) continue;

    try {
      const signal = await analyzeSymbol(symbol);
      if (signal) {
        // Cross-agent conflict guard: skip if any agent already holds this symbol
        if (await positionCache.isSymbolTaken(symbol)) {
          console.log(`[s1] ${symbol}: skip — open position exists on exchange (cross-agent conflict)`);
        } else {
          cooldowns.set(symbol, Date.now()); // set before execute so failure doesn't cause retry spam
          await executeTrade(signal);
          positionCache.invalidate(); // force fresh fetch for next agent scan
        }
      }
    } catch (err) {
      console.error(`[s1] ${symbol}:`, err.message);
    }
    await new Promise((r) => setTimeout(r, SCAN_DELAY));
  }
}

// ─── Status ───────────────────────────────────────────────────────────────────

function buildStatus() {
  const s      = adminRef?.agentStatus?.SCALPER1 ?? {};
  const status = !enabled ? '⛔ OFF' : adminRef?.emergencyStop ? '🛑 STOPPED' : '🟢 ON';
  const lines  = [
    `📊 <b>SCALPER1</b> — Level Scalper — ${status}`,
    '',
    `<b>⚙️ Settings:</b>`,
    `  leverage:  <code>${cfg.leverage}x</code>  ${cfg.marginMode}`,
    `  risk:      <code>${cfg.riskPct}%</code>  (~$${(CAPITAL * cfg.riskPct / 100).toFixed(3)})`,
    `  tp:        <code>${cfg.tp}%</code>`,
    `  sl:        <code>${cfg.sl}%</code>`,
    `  maxTrades: <code>${cfg.maxTrades}</code>`,
    '',
    `<b>📈 Stats:</b>`,
    `  Open:   <code>${openTrades.size}/${cfg.maxTrades}</code>`,
    `  Trades: <code>${s.trades ?? 0}</code>`,
    `  PnL:    <code>${(s.pnl ?? 0) >= 0 ? '+' : ''}${(s.pnl ?? 0).toFixed(2)} USD</code>`,
  ];
  if (openTrades.size > 0) {
    lines.push('', '<b>Open positions:</b>');
    for (const [sym, t] of openTrades) {
      const dir = t.direction === 'long' ? '🟢' : '🔴';
      lines.push(`  ${dir} <b>${sym}</b> @ <code>${t.entry}</code>  SL <code>${t.sl}</code>  TP <code>${t.tp}</code>`);
    }
  }
  return lines.join('\n');
}

// ─── Init ─────────────────────────────────────────────────────────────────────

function init(admin) {
  adminRef = admin;

  const status = adminRef?.agentStatus?.SCALPER1;
  if (status) status.running = true; // trades/pnl persist across restarts via admin.js

  registerCommand('s1', async (ctx) => {
    const arg = ctx.message?.text?.trim().split(/\s+/)[1]?.toLowerCase();
    if (arg === 'on') {
      enabled = true;
      if (adminRef?.agentStatus?.SCALPER1) adminRef.agentStatus.SCALPER1.running = true;
      const { sendAdmin } = require('../core/telegram');
      await sendAdmin('✅ <b>SCALPER1</b> enabled');
    } else if (arg === 'off') {
      enabled = false;
      if (adminRef?.agentStatus?.SCALPER1) adminRef.agentStatus.SCALPER1.running = false;
      const { sendAdmin } = require('../core/telegram');
      await sendAdmin('⛔ <b>SCALPER1</b> disabled');
    } else {
      const { sendAdmin } = require('../core/telegram');
      await sendAdmin(buildStatus());
    }
  });

  // /s1_set_tpsl SYMBOL SIDE SL TP
  // Example: /s1_set_tpsl BTCUSDT long 60000 65000
  registerCommand('s1_set_tpsl', async (args) => {
    const { sendAdmin } = require('../core/telegram');
    const parts = (args || '').trim().split(/\s+/);
    if (parts.length < 4) {
      await sendAdmin('Usage: /s1_set_tpsl SYMBOL SIDE SL TP');
      return;
    }
    const [symbol, holdSide, slStr, tpStr] = parts;
    const sl = parseFloat(slStr);
    const tp = parseFloat(tpStr);
    if (isNaN(sl) || isNaN(tp)) { await sendAdmin('❌ Invalid price values'); return; }
    try {
      await bitget.setPositionSingleTPSL(symbol.toUpperCase(), holdSide.toLowerCase(), sl, tp);
      await sendAdmin(`✅ <b>SCALPER1</b> TP/SL set on ${symbol.toUpperCase()} ${holdSide.toLowerCase()}\nSL: <code>${sl}</code>  TP: <code>${tp}</code>`);
    } catch (err) {
      console.error('[s1] s1_set_tpsl error:', err.message);
      await sendAdmin(`❌ Failed: ${err.message}`);
    }
  });

  bitget.loadContractSpecs().catch(err => console.error('[s1] loadContractSpecs:', err.message));

  cron.schedule('2-59/5 * * * *', () => {
    runScan().catch((err) => {
      console.error('[s1] scan error:', err.message);
      sendAlert(`S1 scan error: ${err.message}`).catch(() => {});
    });
  });

  setInterval(() => {
    syncPositions().catch((err) => console.error('[s1] syncPositions error:', err.message));
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
    console.log(`[s1] recovered from disk: ${t.symbol} ${t.direction} x${t.size} @ ${t.entry} SL=${t.sl} TP=${t.tp}`);
  }

  // Bitget fallback: only picks up positions not already claimed by this agent's disk file
  // (other agents with their own disk files claim first; unclaimed positions go to the first agent that sees them)
  bitget.getOpenPositions().then(positions => {
    for (const pos of positions) {
      const sym = pos.symbol;
      if (openTrades.has(sym) || tradeRegistry.isClaimed(sym)) continue;
      const direction = pos.holdSide;
      const entry     = parseFloat(pos.openPriceAvg);
      const sl        = parseFloat(pos.stopLossPrice)   || 0;
      const tp        = parseFloat(pos.takeProfitPrice) || 0;
      const size      = parseFloat(pos.total);
      if (!size || !entry) continue;
      const trade = { symbol: sym, direction, entry, sl, tp, size, openedAt: Date.now() - 300_000, tpslSet: true, closing: false };
      openTrades.set(sym, trade);
      tradeRegistry.claim(sym);
      startMonitor(trade);
      if (!sl) console.warn(`[s1] recovered ${sym} (Bitget): no SL/TP — use /s1_set_tpsl to fix`);
      else console.log(`[s1] recovered position (Bitget): ${sym} ${direction} x${size} @ ${entry} SL=${sl} TP=${tp}`);
    }
    saveOpenTrades();
  }).catch(err => console.error('[s1] position recovery failed:', err.message));

  console.log(`[s1] initialized — Level Scalper | top50 | 5m scan | ${cfg.leverage}x ${cfg.marginMode} | max ${cfg.maxTrades} trades`);
}

// ─── Exports ──────────────────────────────────────────────────────────────────

function setEnabled(val) { enabled = val; }

module.exports = { init, applySetting, setEnabled, reloadSymbols, get enabled() { return enabled; } };
