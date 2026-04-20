'use strict';

require('dotenv').config();

const fs   = require('fs');
const path = require('path');
const bitget = require('../core/bitget');
const { registerCommand, sendToTopic, sendAdmin, TOPICS } = require('../core/telegram');

// ─── Persistent settings ──────────────────────────────────────────────────────

const SETTINGS_FILE = path.join(__dirname, '../.claude/memory/screener_settings.json');

// Priority: saved file → .env → hardcoded defaults
const DEFAULTS = {
  pumpPct:     parseFloat(process.env.SCREENER_PUMP_PCT    ?? 7),
  periodMin:   parseInt(process.env.SCREENER_PERIOD_MIN    ?? 15),
  intervalSec: parseInt(process.env.SCREENER_INTERVAL_SEC  ?? 60),
  cooldownMin: parseInt(process.env.SCREENER_COOLDOWN_MIN  ?? 30),
};

let settings = { ...DEFAULTS };

function loadSettings() {
  try {
    const saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    settings = { ...DEFAULTS, ...saved };
  } catch {
    settings = { ...DEFAULTS };
  }
}

function saveSettings() {
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

// /set key → field mapping
const SET_MAP = {
  pump:     { field: 'pumpPct',     parse: parseFloat, label: 'Порог памп/дамп', unit: '%'  },
  period:   { field: 'periodMin',   parse: parseInt,   label: 'Период',           unit: 'м'  },
  interval: { field: 'intervalSec', parse: parseInt,   label: 'Интервал скана',   unit: 'с'  },
  cooldown: { field: 'cooldownMin', parse: parseInt,   label: 'Кулдаун',          unit: 'м'  },
};

/**
 * Update one setting, persist to disk, clear snapshot history, restart interval.
 * Returns { ok, label, unit, value } or { ok: false, error }
 */
function applySetting(key, rawValue) {
  const entry = SET_MAP[key.toLowerCase()];
  if (!entry) {
    return { ok: false, error: `Неизвестный параметр <code>${key}</code>. Доступны: pump, period, interval, cooldown` };
  }
  const value = entry.parse(rawValue);
  if (isNaN(value) || value <= 0) {
    return { ok: false, error: `Некорректное значение: <code>${rawValue}</code>` };
  }
  settings[entry.field] = value;
  saveSettings();
  snapshots.length = 0; // clear history — old snapshots use wrong period
  restartInterval();
  return { ok: true, label: entry.label, unit: entry.unit, value };
}

// ─── State ────────────────────────────────────────────────────────────────────

// Ring buffer of price snapshots: [{ ts, prices: Map<symbol, {price, amount24}> }]
const snapshots    = [];
const cooldowns    = new Map(); // symbol → ms timestamp of last signal
let   adminRef     = null;
let   enabled      = true;     // toggled by /screener_on / /screener_off
let   scanInterval = null;     // held so we can clear/restart on settings change
let   lastScanTs   = null;
let   totalScans   = 0;
let   totalSignals = 0;

function maxSnaps() {
  return Math.ceil((settings.periodMin * 60) / settings.intervalSec) + 5;
}

// ─── RSI (Wilder, period 14) ──────────────────────────────────────────────────

function calcRSI(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const closes = candles.map((c) => c.close);

  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) avgGain += d; else avgLoss -= d;
  }
  avgGain /= period;
  avgLoss /= period;

  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
  }

  if (avgLoss === 0) return 100;
  return +(100 - 100 / (1 + avgGain / avgLoss)).toFixed(1);
}

// ─── Snapshot helpers ─────────────────────────────────────────────────────────

function pushSnapshot(prices) {
  snapshots.push({ ts: Date.now(), prices });
  const max = maxSnaps();
  while (snapshots.length > max) snapshots.shift();
}

function getAgoSnapshot() {
  if (snapshots.length < 2) return null;
  const target  = Date.now() - settings.periodMin * 60 * 1000;
  let best = null, bestDiff = Infinity;
  for (const snap of snapshots) {
    const diff = Math.abs(snap.ts - target);
    if (diff < bestDiff) { best = snap; bestDiff = diff; }
  }
  const minAge = settings.periodMin * 60 * 1000 * 0.8;
  if (!best || (Date.now() - best.ts) < minAge) return null;
  return best;
}

// ─── Formatting helpers ───────────────────────────────────────────────────────

function fmtPrice(n) {
  if (n >= 1000) return n.toFixed(2);
  if (n >= 1)    return n.toFixed(4);
  return n.toFixed(8);
}

function fmtVol(usd) {
  if (usd >= 1e9) return (usd / 1e9).toFixed(2) + 'B';
  if (usd >= 1e6) return (usd / 1e6).toFixed(2) + 'M';
  if (usd >= 1e3) return (usd / 1e3).toFixed(0) + 'K';
  return usd.toFixed(0);
}

function fmtSymbol(s) { return s.replace('_', ''); }

function utcTime() { return new Date().toISOString().slice(11, 16) + ' UTC'; }

// ─── Signal message ───────────────────────────────────────────────────────────

function buildMessage(symbol, pct, price, periodVol, rsi) {
  const isPump = pct > 0;
  const lines  = [
    `${isPump ? '🚀' : '💥'} <b>${isPump ? 'ПАМП' : 'ДАМП'}: ${fmtSymbol(symbol)}</b> ${isPump ? '+' : ''}${pct.toFixed(1)}% за ${settings.periodMin}м`,
    `💰 Цена: <code>${fmtPrice(price)}</code> | Объём: <b>$${fmtVol(periodVol)}</b>`,
  ];
  if (rsi !== null) lines.push(`📊 RSI(1h): <code>${rsi}</code>`);
  lines.push(`⏰ ${utcTime()}`);
  return lines.join('\n');
}

// ─── Core scan ────────────────────────────────────────────────────────────────

async function runScan() {
  if (!enabled || adminRef?.emergencyStop) return;

  const tickers = await bitget.getAllTickers();
  lastScanTs = Date.now();
  totalScans++;

  const current = new Map();
  for (const t of tickers) {
    if (!t.symbol || !t.lastPrice) continue;
    current.set(t.symbol, {
      price:    parseFloat(t.lastPrice),
      amount24: parseFloat(t.amount24 ?? 0),
    });
  }

  pushSnapshot(current);

  const ago = getAgoSnapshot();
  if (!ago) return; // still warming up

  const candidates = [];
  for (const [symbol, cur] of current) {
    const prev = ago.prices.get(symbol);
    if (!prev || prev.price === 0) continue;
    const pct = (cur.price - prev.price) / prev.price * 100;
    if (Math.abs(pct) >= settings.pumpPct) {
      candidates.push({ symbol, pct, price: cur.price, amount24: cur.amount24 });
    }
  }

  if (candidates.length === 0) return;

  for (const c of candidates) {
    const last = cooldowns.get(c.symbol);
    if (last && Date.now() - last < settings.cooldownMin * 60 * 1000) continue;

    let rsi = null;
    try {
      rsi = calcRSI(await bitget.getKlines(c.symbol, 'Min60', 20));
    } catch { /* send signal without RSI */ }

    const periodVol = c.amount24 * (settings.periodMin / 1440);
    const text      = buildMessage(c.symbol, c.pct, c.price, periodVol, rsi);

    try {
      await sendToTopic(TOPICS.pumpDump, text);
      cooldowns.set(c.symbol, Date.now());
      totalSignals++;
      console.log(`[screener] ${c.pct > 0 ? 'PUMP' : 'DUMP'} ${c.symbol} ${c.pct.toFixed(1)}% | RSI ${rsi ?? '?'}`);
    } catch (err) {
      console.error(`[screener] send failed for ${c.symbol}:`, err.message);
    }

    await new Promise((r) => setTimeout(r, 300));
  }
}

// ─── Interval management ──────────────────────────────────────────────────────

function restartInterval() {
  if (scanInterval) clearInterval(scanInterval);
  scanInterval = setInterval(() => {
    runScan().catch((err) => console.error('[screener] scan error:', err.message));
  }, settings.intervalSec * 1000);
  console.log(`[screener] interval → every ${settings.intervalSec}s`);
}

// ─── Admin commands ───────────────────────────────────────────────────────────

async function handleScreenerCmd() {
  const onCooldown = [...cooldowns.values()]
    .filter((ts) => Date.now() - ts < settings.cooldownMin * 60 * 1000).length;

  const age    = lastScanTs ? `${Math.round((Date.now() - lastScanTs) / 1000)}с назад` : 'никогда';
  const status = !enabled ? '⛔ ВЫКЛЮЧЕН' : adminRef?.emergencyStop ? '🛑 ОСТАНОВЛЕН' : '🟢 РАБОТАЕТ';

  const lines = [
    `📡 <b>SCREENER</b> — ${status}`,
    '',
    `<b>⚙️ Настройки:</b>`,
    `  pump:     <code>${settings.pumpPct}%</code>       <i>/set pump ${settings.pumpPct}</i>`,
    `  period:   <code>${settings.periodMin}м</code>      <i>/set period ${settings.periodMin}</i>`,
    `  cooldown: <code>${settings.cooldownMin}м</code>      <i>/set cooldown ${settings.cooldownMin}</i>`,
    `  interval: <code>${settings.intervalSec}с</code>      <i>/set interval ${settings.intervalSec}</i>`,
    '',
    `<b>📊 Статистика:</b>`,
    `  Сканов: <code>${totalScans}</code> | Сигналов: <code>${totalSignals}</code>`,
    `  На кулдауне: <code>${onCooldown}</code> символов`,
    `  Последний скан: <code>${age}</code>`,
    `  История снапшотов: <code>${snapshots.length}/${maxSnaps()}</code>`,
  ];

  await sendAdmin(lines.join('\n'));
}

// ─── Start ────────────────────────────────────────────────────────────────────

function start(admin) {
  adminRef = admin;
  loadSettings();

  registerCommand('screener',     handleScreenerCmd);

  registerCommand('screener_on',  async () => {
    enabled = true;
    await sendAdmin(`✅ <b>SCREENER</b> включён — скан каждые ${settings.intervalSec}с`);
    console.log('[screener] enabled via /screener_on');
  });

  registerCommand('screener_off', async () => {
    enabled = false;
    await sendAdmin('⛔ <b>SCREENER</b> выключен');
    console.log('[screener] disabled via /screener_off');
  });

  runScan().catch((err) => console.error('[screener] initial scan error:', err.message));
  restartInterval();

  console.log(
    `[screener] started — pump≥${settings.pumpPct}% in ${settings.periodMin}м,` +
    ` scan every ${settings.intervalSec}с, cooldown ${settings.cooldownMin}м`
  );
}

// ─── Exports ──────────────────────────────────────────────────────────────────

function setEnabled(val) { enabled = !!val; }

module.exports = { start, applySetting, setEnabled, get enabled() { return enabled; } };
