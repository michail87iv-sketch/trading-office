'use strict';

const http    = require('http');
const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');
const express = require('express');
const cors    = require('cors');
const { execSync } = require('child_process');
const { WebSocketServer } = require('ws');
const { router: favoritesRouter, setRefs: favoritesSetRefs } = require('./routes/favorites');
const { router: backtestRouter } = require('./routes/backtest');
const { router: symbolsRouter,  setRef:  symbolsSetRef  } = require('./routes/symbols');

const DASHBOARD_PORT = parseInt(process.env.DASHBOARD_PORT || '8080', 10);
const DASHBOARD_USER = 'admin';
const getPass        = () => process.env.DASHBOARD_PASSWORD || 'trading123';

const CSV_FILE      = path.join(__dirname, '../data/trades.csv');
const SETTINGS_FILE = path.join(__dirname, '../.claude/memory/scalper_settings.json');
const SCREENER_FILE      = path.join(__dirname, '../.claude/memory/screener_settings.json');
const SCREENER_OI_FILE   = path.join(__dirname, '../.claude/memory/screener_oi_settings.json');
const SCREENER_FUND_FILE = path.join(__dirname, '../.claude/memory/screener_funding_settings.json');
const SCREENER_LIQ_FILE  = path.join(__dirname, '../.claude/memory/screener_liquidation_settings.json');

const SCREENER_OI_DEFAULTS = {
  interval_minutes: 5, oi_change_pct: 3.0, volume_multiplier: 5.0,
  volume_lookback_candles: 20, timeframes: [5, 20, 60],
};
const SCREENER_FUND_DEFAULTS = { interval_minutes: 30, funding_threshold: -0.1 };
const SCREENER_LIQ_DEFAULTS  = { min_liquidation_usd: 10000, volume_multiplier: 5.0, volume_lookback_candles: 20 };
const CAPITAL_FILE  = path.join(__dirname, '../.claude/memory/capital_settings.json');
const SETTINGS_HISTORY_FILE = path.join(__dirname, '../data/settings_history.csv');
const CONFIG_FILE   = path.join(__dirname, '../data/config.json');

const GLOBAL_DEFAULTS = {
  maxTotalRisk:        3,
  dailyLossLimit:      20,
  dailyLossEnabled:    true,
  marketMode:          'BULL',
  agentPriority:       ['S3', 'HUNTER', 'S2', 'S1'],
  paused:              false,
  dailyLossTriggered:  false,
};

function readGlobalConfig() {
  const config = readJson(CONFIG_FILE);
  return { ...GLOBAL_DEFAULTS, ...(config.global ?? {}) };
}

function writeGlobalConfig(global) {
  const config  = readJson(CONFIG_FILE);
  config.global = global;
  writeJson(CONFIG_FILE, config);
}

// ─── Injected agent refs ───────────────────────────────────────────────────────

let _rescentWinner = null;
let _admin      = null;
let _hunter     = null;
let _scalper1   = null;
let _scalper2   = null;
let _scalper3   = null;
let _screener   = null;
let _bitget     = null;
let _webhook    = null;
let _researcher = null;

// ─── Signal buffer (screener alerts pushed here) ───────────────────────────────

const signalBuffer = [];

function pushSignal(signal) {
  signalBuffer.unshift({ ...signal, ts: (Date.now() / 1000) | 0 });
  if (signalBuffer.length > 20) signalBuffer.pop();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseCsv() {
  try {
    const content = fs.readFileSync(CSV_FILE, 'utf8').trim();
    if (!content) return [];
    const lines   = content.split('\n');
    if (lines.length < 2) return [];
    const headers = lines[0].split(',').map((h) => h.trim());
    return lines.slice(1).reverse().map((line) => {
      const vals = line.split(',');
      const obj  = {};
      headers.forEach((h, i) => { obj[h] = (vals[i] ?? '').trim(); });
      return obj;
    });
  } catch {
    return [];
  }
}

function pnlChartData() {
  const rows   = parseCsv().filter((r) => r.action === 'close' && r.pnl !== '');
  const byDate = {};
  for (const row of rows) {
    if (!row.date) continue;
    byDate[row.date] = (byDate[row.date] || 0) + parseFloat(row.pnl || 0);
  }
  const dates = Object.keys(byDate).sort().slice(-30);
  let equity  = 0;
  return dates.map((date) => {
    equity += byDate[date];
    return { date, pnl: +byDate[date].toFixed(2), equity: +equity.toFixed(2) };
  });
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function todayPnl() {
  const today = new Date().toISOString().split('T')[0];
  return parseCsv()
    .filter((r) => r.action === 'close' && r.date === today && r.pnl !== '')
    .reduce((sum, r) => sum + parseFloat(r.pnl || 0), 0);
}

// Per-agent cumulative PnL + trade counts from CSV (all-time closed trades)
function csvAgentStats() {
  const stats = {};
  for (const r of parseCsv()) {
    if (r.action !== 'close' || !r.agent) continue;
    if (!stats[r.agent]) stats[r.agent] = { pnl: 0, trades: 0 };
    stats[r.agent].trades++;
    const p = parseFloat(r.pnl);
    if (!isNaN(p)) stats[r.agent].pnl = +((stats[r.agent].pnl + p).toFixed(4));
  }
  return stats;
}

// ─── Session-based auth ───────────────────────────────────────────────────────

const sessions = new Map(); // token → expiry

function makeToken() {
  return crypto.randomBytes(24).toString('hex');
}

const LOGIN_PAGE = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Trading Office — Login</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0d1117;color:#e6edf3;font-family:'Segoe UI',system-ui,sans-serif;
  display:flex;align-items:center;justify-content:center;min-height:100vh}
.box{background:#161b22;border:1px solid #30363d;border-radius:10px;padding:36px 32px;width:100%;max-width:360px}
h1{font-size:18px;margin-bottom:4px}
p{color:#8b949e;font-size:13px;margin-bottom:24px}
label{font-size:12px;color:#8b949e;display:block;margin-bottom:5px}
input{width:100%;background:#0d1117;border:1px solid #30363d;border-radius:6px;
  color:#e6edf3;padding:9px 12px;font-size:14px;outline:none;margin-bottom:14px;font-family:inherit}
input:focus{border-color:#00ff88}
button{width:100%;background:rgba(0,255,136,.12);border:1px solid #00ff88;
  color:#00ff88;padding:10px;border-radius:6px;font-size:14px;font-weight:600;cursor:pointer}
button:hover{background:rgba(0,255,136,.22)}
.err{color:#f85149;font-size:13px;margin-bottom:12px;display:none}
</style></head>
<body><div class="box">
<h1>Trading Office</h1><p>Enter your credentials to continue</p>
<div class="err" id="err">Invalid username or password</div>
<form method="POST" action="/login">
<label>Username</label><input name="user" type="text" autocomplete="username" autofocus>
<label>Password</label><input name="pass" type="password" autocomplete="current-password">
<button type="submit">Sign In</button>
</form></div>
<script>
const p = new URLSearchParams(location.search);
if(p.get('err')) document.getElementById('err').style.display='block';
</script>
</body></html>`;

function authMiddleware(req, res, next) {
  // Always allow login routes
  if (req.path === '/login') return next();
  // Allow WS upgrade without cookie (handled separately in WS connection)
  if (req.headers.upgrade === 'websocket') return next();

  const token = req.headers.cookie?.split(';').map(c => c.trim())
    .find(c => c.startsWith('to_session='))?.split('=')[1];

  if (token && sessions.has(token) && sessions.get(token) > Date.now()) {
    return next();
  }
  // API requests get 401; page requests redirect to login
  if (req.path.startsWith('/api/')) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  res.redirect('/login');
}

// ─── Console dispatcher ───────────────────────────────────────────────────────

function processConsoleCommand(cmd) {
  const parts = cmd.trim().split(/\s+/);
  const verb  = parts[0].replace(/^\//, '').toLowerCase();
  const status  = _admin?.agentStatus ?? {};
  const capital = readJson(CAPITAL_FILE);

  const totalPnl = () =>
    Object.values(status).filter((s) => s.pnl != null).reduce((sum, s) => sum + s.pnl, 0);

  switch (verb) {
    case 'status': {
      const lines = ['AGENT STATUS\n'];
      for (const [name, s] of Object.entries(status)) {
        const st  = s.running ? '● ONLINE ' : '○ OFFLINE';
        const pnl = s.pnl  != null ? `  pnl: ${s.pnl >= 0 ? '+' : ''}${s.pnl.toFixed(2)}$` : '';
        const tr  = s.trades != null ? `  trades: ${s.trades}` : '';
        lines.push(`${st}  ${name.padEnd(10)}${tr}${pnl}`);
      }
      const t = totalPnl();
      lines.push(`\nTotal PnL: ${t >= 0 ? '+' : ''}${t.toFixed(2)}$`);
      if (_admin?.emergencyStop) lines.push('\n⚠ EMERGENCY STOP IS ACTIVE');
      return lines.join('\n');
    }

    case 'balance': {
      const lines = ['BALANCE PER AGENT\n'];
      let total = 0;
      for (const [name, cap] of Object.entries(capital)) {
        const pnl = status[name]?.pnl ?? 0;
        const bal = cap + pnl;
        total += bal;
        lines.push(`${name.padEnd(10)} $${bal.toFixed(2)}  (cap $${cap}  pnl ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)})`);
      }
      lines.push(`\nTOTAL  $${total.toFixed(2)}`);
      return lines.join('\n');
    }

    case 'report': {
      const agents = Object.entries(status)
        .filter(([n]) => n !== 'SCREENER')
        .map(([name, s]) =>
          `${name.padEnd(10)}  trades: ${s.trades ?? 0}  pnl: ${(s.pnl ?? 0) >= 0 ? '+' : ''}${(s.pnl ?? 0).toFixed(2)}$`
        );
      const t = totalPnl();
      return `DAILY PnL REPORT\n\n${agents.join('\n')}\n\nTotal: ${t >= 0 ? '+' : ''}${t.toFixed(2)}$`;
    }

    case 'stop': {
      if (_admin?.agentStatus) {
        for (const key of Object.keys(_admin.agentStatus)) {
          _admin.agentStatus[key].running = false;
        }
      }
      return '🛑 EMERGENCY STOP — all agents halted.\nUse Telegram /resume to re-enable agents.';
    }

    case 'hunter': {
      const s            = status.HUNTER ?? {};
      const activeTrades = _hunter?.activeTrades ?? new Map();
      const lines        = [
        `HUNTER — ${s.running ? 'ONLINE' : 'OFFLINE'}`,
        `Trades: ${s.trades ?? 0}  |  PnL: ${(s.pnl ?? 0) >= 0 ? '+' : ''}${(s.pnl ?? 0).toFixed(2)}$`,
        `Open positions: ${activeTrades.size}`,
      ];
      if (activeTrades.size > 0) {
        lines.push('\nOpen trades:');
        for (const [sym, t] of activeTrades) {
          lines.push(`  ${sym}  ${t.direction}  entry @ ${t.entry}`);
        }
      }
      return lines.join('\n');
    }

    case 'screener': {
      const s   = status.SCREENER ?? {};
      const cfg = readJson(SCREENER_FILE);
      return [
        `SCREENER — ${s.running ? 'ONLINE' : 'OFFLINE'}`,
        `Last scan: ${s.lastScan ? new Date(s.lastScan * 1000).toISOString() : 'N/A'}`,
        `pump=${cfg.pumpPct}%  period=${cfg.periodMin}m  interval=${cfg.intervalSec}s  cooldown=${cfg.cooldownMin}m`,
      ].join('\n');
    }

    case 's1': case 'scalper1': {
      const s = status.SCALPER1 ?? {}; const cfg = readJson(SETTINGS_FILE).s1 ?? {};
      return `SCALPER1 — ${s.running ? 'ONLINE' : 'OFFLINE'}\nTrades: ${s.trades ?? 0}  PnL: ${(s.pnl ?? 0).toFixed(2)}$\nLeverage: ${cfg.leverage}x  Risk: ${cfg.riskPct}%  TP: ${cfg.tp}%  SL: ${cfg.sl}%  MaxTrades: ${cfg.maxTrades}`;
    }
    case 's2': case 'scalper2': {
      const s = status.SCALPER2 ?? {}; const cfg = readJson(SETTINGS_FILE).s2 ?? {};
      return `SCALPER2 — ${s.running ? 'ONLINE' : 'OFFLINE'}\nTrades: ${s.trades ?? 0}  PnL: ${(s.pnl ?? 0).toFixed(2)}$\nLeverage: ${cfg.leverage}x  Risk: ${cfg.riskPct}%  TP: ${cfg.tp}%  SL: ${cfg.sl}%  MaxTrades: ${cfg.maxTrades}  Trailing: ${cfg.trailingStop}`;
    }
    case 's3': case 'scalper3': {
      const s = status.SCALPER3 ?? {}; const cfg = readJson(SETTINGS_FILE).s3 ?? {};
      return `SCALPER3 — ${s.running ? 'ONLINE' : 'OFFLINE'}\nTrades: ${s.trades ?? 0}  PnL: ${(s.pnl ?? 0).toFixed(2)}$\nLeverage: ${cfg.leverage}x  Risk: ${cfg.riskPct}%  MinRR: ${cfg.minRR}  SL: ${cfg.slPct}%  MaxTrades: ${cfg.maxTrades}`;
    }

    case 'help':
      return [
        'Available commands:',
        '',
        '  /status   — agent status + PnL overview',
        '  /balance  — capital balance per agent',
        '  /report   — daily PnL report',
        '  /stop     — halt all agents (display only)',
        '  /hunter   — hunter agent details + open trades',
        '  /screener — screener status + settings',
        '  /s1       — scalper1 status + settings',
        '  /s2       — scalper2 status + settings',
        '  /s3       — scalper3 status + settings',
        '  /help     — this message',
        '',
        'Note: /stop and /resume with real effect must be run via Telegram.',
      ].join('\n');

    default:
      return `Unknown command: "${cmd}"\nType /help for available commands.`;
  }
}

// ─── Express app ──────────────────────────────────────────────────────────────

function buildApp() {
  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  // ── Login page
  app.get('/login', (req, res) => res.send(LOGIN_PAGE));
  app.post('/login', (req, res) => {
    const { user, pass } = req.body;
    if (user === DASHBOARD_USER && pass === getPass()) {
      const token = makeToken();
      sessions.set(token, Date.now() + 24 * 60 * 60 * 1000); // 24h
      res.setHeader('Set-Cookie', `to_session=${token}; Path=/; HttpOnly; SameSite=Strict`);
      return res.redirect('/');
    }
    res.redirect('/login?err=1');
  });

  app.use(authMiddleware);
  app.use(express.static(path.join(__dirname, 'public')));

  // GET /api/status
  app.get('/api/status', (req, res) => {
    const status   = _admin?.agentStatus ?? {};
    const capital  = readJson(CAPITAL_FILE);
    const csvStats = csvAgentStats();
    const agents   = Object.entries(status).map(([name, s]) => {
      const csv = csvStats[name] || { pnl: 0, trades: 0 };
      // Use in-memory pnl if it has session data, fall back to CSV all-time
      const memPnl    = s.pnl ?? 0;
      const memTrades = s.trades ?? 0;
      return {
        name,
        running:  s.running,
        trades:   memTrades > 0 ? memTrades : csv.trades,
        pnl:      +((memPnl !== 0 ? memPnl : csv.pnl).toFixed(2)),
        capital:  capital[name] ?? 0,
        lastScan: s.lastScan ?? null,
      };
    });
    const tradingAgents = agents.filter((a) => a.name !== 'SCREENER');
    const totalPnl      = tradingAgents.reduce((sum, a) => sum + a.pnl, 0);
    const totalCap      = tradingAgents.reduce((sum, a) => sum + a.capital, 0);
    const drawdown      = totalPnl < 0 ? Math.abs(totalPnl / Math.max(totalCap, 1)) * 100 : 0;
    res.json({
      ok: true,
      emergencyStop: _admin?.emergencyStop ?? false,
      agents,
      totalPnl:  +totalPnl.toFixed(2),
      totalCap:  +totalCap.toFixed(2),
      todayPnl:  +todayPnl().toFixed(2),
      drawdown:  +drawdown.toFixed(2),
      ts: (Date.now() / 1000) | 0,
    });
  });

  // GET /api/positions
  app.get('/api/positions', async (req, res) => {
    if (!_bitget) return res.json({ ok: false, error: 'Bitget not initialized', positions: [] });
    try {
      const raw = await _bitget.getOpenPositions();
      const positions = raw.map((p) => {
        const entry   = parseFloat(p.openPriceAvg ?? 0);
        const current = parseFloat(p.markPrice ?? p.openPriceAvg ?? 0);
        const margin  = parseFloat(p.margin ?? 1);
        const unreal  = parseFloat(p.unrealizedPL ?? 0);
        const pnlPct  = margin > 0 ? (unreal / margin) * 100 : 0;
        return {
          symbol:     p.symbol,
          side:       p.holdSide,
          size:       parseFloat(p.total ?? 0),
          entry:      +entry.toFixed(4),
          current:    +current.toFixed(4),
          unrealized: +unreal.toFixed(2),
          pnlPct:     +pnlPct.toFixed(2),
          sl:         parseFloat(p.stopLossPrice ?? 0) || null,
          tp:         parseFloat(p.takeProfitPrice ?? 0) || null,
          leverage:   parseInt(p.leverage ?? 1),
          margin:     +margin.toFixed(2),
        };
      });
      res.json({ ok: true, positions });
    } catch (err) {
      res.json({ ok: false, error: err.message, positions: [] });
    }
  });

  // GET /api/trades?agent=SCALPER1&limit=100
  app.get('/api/trades', (req, res) => {
    const agent = req.query.agent?.toUpperCase();
    const limit = Math.min(parseInt(req.query.limit) || 200, 500);
    let rows = parseCsv();
    if (agent) rows = rows.filter((r) => r.agent === agent);
    res.json({ ok: true, trades: rows.slice(0, limit) });
  });

  // POST /api/trades/delete — remove a single trade row from CSV by timestamp
  app.post('/api/trades/delete', (req, res) => {
    try {
      const ts = req.body?.timestamp;
      if (!ts) return res.json({ ok: false, error: 'Missing timestamp' });
      const content = fs.readFileSync(CSV_FILE, 'utf8');
      const lines   = content.split('\n');
      const header  = lines[0];
      const kept    = lines.slice(1).filter((l) => l && !l.startsWith(ts));
      fs.writeFileSync(CSV_FILE, [header, ...kept].join('\n') + '\n');
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // POST /api/trades/clear — wipe all trade history and reset agent PnL
  app.post('/api/trades/clear', (req, res) => {
    try {
      const header = 'timestamp,date,time,agent,action,symbol,direction,size,entry,sl,tp,pnl,exit_price';
      fs.writeFileSync(CSV_FILE, header + '\n');
      // Reset in-memory PnL + trade counts
      if (_admin?.agentStatus) {
        for (const s of Object.values(_admin.agentStatus)) {
          s.pnl    = 0;
          s.trades = 0;
        }
      }
      // Persist zeroed status
      if (_admin?.saveAgentStatus) _admin.saveAgentStatus();
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // POST /api/capital/:agent  — update deposit for one agent
  app.post('/api/capital/:agent', (req, res) => {
    const agent  = req.params.agent.toUpperCase();
    const num    = parseFloat(req.body?.amount);
    if (isNaN(num) || num < 0) return res.status(400).json({ ok: false, error: 'Invalid amount' });
    const capital = readJson(CAPITAL_FILE);
    capital[agent] = num;
    writeJson(CAPITAL_FILE, capital);
    res.json({ ok: true, capital });
  });

  // GET /api/balance
  app.get('/api/balance', async (req, res) => {
    if (!_bitget) return res.json({ ok: false, error: 'Bitget not initialized', wallet: null, agents: [] });
    try {
      const bal     = await _bitget.getBalance();
      const capital = readJson(CAPITAL_FILE);
      const status  = _admin?.agentStatus ?? {};
      const agents  = Object.entries(capital).map(([name, cap]) => ({
        name,
        capital: cap,
        pnl:     +((status[name]?.pnl ?? 0).toFixed(2)),
        balance: +(cap + (status[name]?.pnl ?? 0)).toFixed(2),
      }));
      res.json({ ok: true, wallet: bal, agents });
    } catch (err) {
      res.json({ ok: false, error: err.message, wallet: null, agents: [] });
    }
  });

  // GET /api/settings/history — must be before /api/settings/:agent to avoid param capture
  app.get('/api/settings/history', (req, res) => {
    try {
      if (!fs.existsSync(SETTINGS_HISTORY_FILE)) return res.json({ ok: true, history: [] });
      const lines = fs.readFileSync(SETTINGS_HISTORY_FILE, 'utf8').trim().split('\n');
      if (lines.length <= 1) return res.json({ ok: true, history: [] });
      const history = lines.slice(1).map((line) => {
        const [timestamp, , time, agent, key, old_value, new_value] = line.split(',');
        return { timestamp, time, agent, key, old_value, new_value };
      }).reverse(); // newest first
      res.json({ ok: true, history });
    } catch (err) {
      res.json({ ok: false, error: err.message, history: [] });
    }
  });

  // GET /api/settings/:agent
  app.get('/api/settings/:agent', (req, res) => {
    const agent = req.params.agent.toLowerCase();
    if (agent === 'screener') return res.json({ ok: true, settings: readJson(SCREENER_FILE) });
    const key = agent.replace('scalper', 's');
    res.json({ ok: true, settings: (readJson(SETTINGS_FILE)[key]) ?? {} });
  });

  // POST /api/settings/:agent
  app.post('/api/settings/:agent', (req, res) => {
    const agent    = req.params.agent.toLowerCase();
    const incoming = req.body ?? {};
    try {
      if (agent === 'screener') {
        const merged = { ...readJson(SCREENER_FILE), ...incoming };
        writeJson(SCREENER_FILE, merged);
        if (_screener) {
          for (const [k, v] of Object.entries(incoming)) _screener.applySetting(k, String(v));
        }
        return res.json({ ok: true });
      }
      const key = agent.replace('scalper', 's');
      const all = readJson(SETTINGS_FILE);
      all[key]  = { ...(all[key] ?? {}), ...incoming };
      writeJson(SETTINGS_FILE, all);
      const ref = { s1: _scalper1, s2: _scalper2, s3: _scalper3, hunter: _hunter }[key];
      if (ref) {
        for (const [k, v] of Object.entries(incoming)) ref.applySetting(k, String(v));
      }
      return res.json({ ok: true });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  // POST /api/agent/:name/toggle
  app.post('/api/agent/:name/toggle', (req, res) => {
    const name   = req.params.name.toUpperCase();
    const status = _admin?.agentStatus;
    if (!status || !(name in status)) return res.status(404).json({ ok: false, error: 'Agent not found' });
    status[name].running = !status[name].running;
    // Propagate to the agent's internal enabled flag so runScan respects the toggle
    const agentRefMap = { SCALPER1: _scalper1, SCALPER2: _scalper2, SCALPER3: _scalper3, HUNTER: _hunter, SCREENER: _screener };
    agentRefMap[name]?.setEnabled?.(status[name].running);
    res.json({ ok: true, running: status[name].running, name });
  });

  // POST /api/agent/:name/stop
  app.post('/api/agent/:name/stop', (req, res) => {
    const name   = req.params.name.toUpperCase();
    const status = _admin?.agentStatus;
    if (!status || !(name in status)) return res.status(404).json({ ok: false, error: 'Agent not found' });
    status[name].running = false;
    res.json({ ok: true });
  });

  // GET /api/signals
  app.get('/api/signals', (req, res) => {
    const tvSignals = _webhook?.getSignalLog ? _webhook.getSignalLog() : [];
    const combined  = [...signalBuffer, ...tvSignals].slice(0, 20);
    res.json({ ok: true, signals: combined });
  });

  // GET /api/pnl/chart
  app.get('/api/pnl/chart', (req, res) => {
    res.json({ ok: true, data: pnlChartData() });
  });

  // POST /api/console
  app.post('/api/console', (req, res) => {
    const { command } = req.body ?? {};
    if (!command?.trim()) return res.json({ ok: false, error: 'No command provided' });
    try {
      const result = processConsoleCommand(command.trim());
      res.json({ ok: true, result });
    } catch (err) {
      res.json({ ok: false, result: `Error: ${err.message}` });
    }
  });

  // ── Global settings endpoints ──────────────────────────────────────────────

  // GET /api/strategies/global — read global settings
  app.get('/api/strategies/global', (req, res) => {
    res.json({ ok: true, global: readGlobalConfig() });
  });

  // PATCH /api/strategies/global — save global settings
  app.patch('/api/strategies/global', (req, res) => {
    const incoming = req.body ?? {};
    const current  = readGlobalConfig();
    const updated  = { ...current, ...incoming };
    // Manual reset of paused clears the triggered flag
    if (incoming.paused === false) updated.dailyLossTriggered = false;
    writeGlobalConfig(updated);
    if (_admin) _admin.globalPaused = updated.paused;
    res.json({ ok: true });
  });

  // GET /api/strategies/global/status — live summary
  app.get('/api/strategies/global/status', (req, res) => {
    const global  = readGlobalConfig();
    const status  = _admin?.agentStatus ?? {};
    const capital = readJson(CAPITAL_FILE);
    const settings = readJson(SETTINGS_FILE);
    const configOverrides = readJson(CONFIG_FILE);

    const dailyPnl = todayPnl();

    // Total risk = sum of each running agent's riskPct
    let totalRisk = 0;
    const AGENT_KEY_MAP = { SCALPER1: 's1', SCALPER2: 's2', SCALPER3: 's3', HUNTER: 'hunter' };
    for (const [name, key] of Object.entries(AGENT_KEY_MAP)) {
      if (!status[name]?.running) continue;
      const agentCfg = key === 'hunter'
        ? { ...(settings.hunter ?? {}), ...(configOverrides.hunter ?? {}) }
        : (settings[key] ?? {});
      totalRisk += parseFloat(agentCfg.riskPct ?? 1);
    }

    const limitStatus = global.dailyLossTriggered
      ? 'TRIGGERED'
      : (global.dailyLossEnabled && dailyPnl <= -(global.dailyLossLimit * 0.8))
        ? 'WARNING'
        : 'OK';

    res.json({
      ok: true,
      totalRiskPct:  +totalRisk.toFixed(2),
      dailyPnl:      +dailyPnl.toFixed(2),
      limitStatus,
      triggered:     global.dailyLossTriggered,
      paused:        global.paused,
    });
  });

  // ── Screener settings endpoints (Python bots, hot-reload via JSON files) ────

  function screenerFileFor(name) {
    return { oi: SCREENER_OI_FILE, funding: SCREENER_FUND_FILE, liquidation: SCREENER_LIQ_FILE }[name];
  }
  function screenerDefaultsFor(name) {
    return { oi: SCREENER_OI_DEFAULTS, funding: SCREENER_FUND_DEFAULTS, liquidation: SCREENER_LIQ_DEFAULTS }[name];
  }

  app.get('/api/screeners/status', (req, res) => {
    const services = { oi: 'screener-oi', funding: 'screener-funding', liquidation: 'screener-liquidation' };
    const status = {};
    for (const [key, svc] of Object.entries(services)) {
      try {
        const out = execSync(`systemctl is-active ${svc}`, { timeout: 2000 }).toString().trim();
        status[key] = out === 'active';
      } catch { status[key] = false; }
    }
    res.json({ ok: true, status });
  });

  app.get('/api/screeners/:name', (req, res) => {
    const file = screenerFileFor(req.params.name);
    if (!file) return res.status(404).json({ ok: false, error: 'Unknown screener' });
    const defaults = screenerDefaultsFor(req.params.name);
    res.json({ ok: true, settings: { ...defaults, ...readJson(file) } });
  });

  app.post('/api/screeners/:name/restart', (req, res) => {
    const svcMap = { oi: 'screener-oi', funding: 'screener-funding', liquidation: 'screener-liquidation' };
    const svc = svcMap[req.params.name];
    if (!svc) return res.status(404).json({ ok: false, error: 'Unknown screener' });
    try {
      execSync(`systemctl restart ${svc}`, { timeout: 5000 });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/screeners/:name', (req, res) => {
    const file = screenerFileFor(req.params.name);
    if (!file) return res.status(404).json({ ok: false, error: 'Unknown screener' });
    const defaults = screenerDefaultsFor(req.params.name);
    const current  = { ...defaults, ...readJson(file) };
    const updated  = { ...current, ...req.body };
    writeJson(file, updated);
    res.json({ ok: true, settings: updated });
  });

  // ── Hunter strategy endpoints ──────────────────────────────────────────────

  // GET /api/strategies/hunter — merged settings (scalper_settings.json base + config.json overrides)
  app.get('/api/strategies/hunter', (req, res) => {
    const base   = readJson(SETTINGS_FILE).hunter ?? {};
    const config = readJson(CONFIG_FILE).hunter ?? {};
    res.json({ ok: true, settings: { ...base, ...config } });
  });

  // PATCH /api/strategies/hunter — save to data/config.json under "hunter" key
  app.patch('/api/strategies/hunter', (req, res) => {
    const incoming = req.body ?? {};
    if (incoming.obMitigation !== undefined) {
      const v = parseFloat(incoming.obMitigation);
      if (isNaN(v) || v < 0.1 || v > 2.0)
        return res.status(400).json({ ok: false, error: 'obMitigation must be 0.1–2.0' });
      incoming.obMitigation = v;
    }
    try {
      const config  = readJson(CONFIG_FILE);
      config.hunter = { ...(config.hunter ?? {}), ...incoming };
      writeJson(CONFIG_FILE, config);
      if (_hunter) {
        for (const [k, v] of Object.entries(incoming))
          _hunter.applySetting(k, String(v));
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // GET /api/strategies/hunter/status — current position state
  app.get('/api/strategies/hunter/status', (req, res) => {
    if (!_hunter) return res.json({ ok: true, symbol: null, direction: null, status: 'Waiting' });
    const { activeTrades, pendingOrders } = _hunter;
    if (activeTrades?.size > 0) {
      const [sym, trade] = activeTrades.entries().next().value;
      return res.json({ ok: true, symbol: sym, direction: trade.direction.toUpperCase(), status: 'In Trade' });
    }
    if (pendingOrders?.size > 0) {
      const [sym, p] = pendingOrders.entries().next().value;
      return res.json({ ok: true, symbol: sym, direction: p.trade.direction.toUpperCase(), status: 'Cooldown' });
    }
    res.json({ ok: true, symbol: null, direction: null, status: 'Waiting' });
  });

  // ── Research endpoints ─────────────────────────────────────────────────────

  // GET /api/research/status
  app.get('/api/research/status', (req, res) => {
    if (!_researcher) return res.json({ ok: false, error: 'Researcher not initialized' });
    res.json({ ok: true, ...(_researcher.getState()) });
  });

  // GET /api/research/results
  app.get('/api/research/results', (req, res) => {
    if (!_researcher) return res.json({ ok: false, results: [] });
    res.json({ ok: true, results: _researcher.getResults() });
  });

  // POST /api/research/start
  app.post('/api/research/start', async (req, res) => {
    if (!_researcher) return res.json({ ok: false, error: 'Researcher not initialized' });
    const opts = req.body ?? {};
    const result = await _researcher.start(opts);
    res.json(result);
  });

  // POST /api/research/stop
  app.post('/api/research/stop', (req, res) => {
    if (!_researcher) return res.json({ ok: false, error: 'Researcher not initialized' });
    res.json(_researcher.stop());
  });

  // POST /api/research/settings
  app.post('/api/research/settings', (req, res) => {
    if (!_researcher) return res.json({ ok: false, error: 'Researcher not initialized' });
    _researcher.applySettings(req.body ?? {});
    res.json({ ok: true });
  });

  // GET /api/research/tokens
  app.get('/api/research/tokens', (req, res) => {
    if (!_researcher) return res.json({ ok: false });
    res.json({ ok: true, ...(_researcher.getTokenStats()) });
  });

  // GET /api/research/pinescript/:id
  app.get('/api/research/pinescript/:id', (req, res) => {
    if (!_researcher) return res.json({ ok: false });
    const results = _researcher.getResults();
    const r = results.find(x => x.id === req.params.id);
    if (!r) return res.status(404).json({ ok: false, error: 'Not found' });
    res.json({ ok: true, pineScript: r.pineScript, strategy: r.strategy, metrics: r.metrics });
  });

  // ── Favorites ──────────────────────────────────────────────────────────────
  app.use('/api', favoritesRouter);

  // ── Backtest ───────────────────────────────────────────────────────────────
  app.use('/api', backtestRouter);

  // ── Per-symbol overrides ───────────────────────────────────────────────────
  app.use('/api', symbolsRouter);

  return app;
}

// ─── Daily loss limit guard ───────────────────────────────────────────────────

function checkDailyLossLimit() {
  try {
    const global = readGlobalConfig();
    if (!global.dailyLossEnabled || global.dailyLossTriggered) return;

    const pnl = todayPnl();
    if (pnl > -global.dailyLossLimit) return;

    console.log(`[risk] Daily loss limit hit: ${pnl.toFixed(2)} <= -${global.dailyLossLimit} — pausing all agents`);
    writeGlobalConfig({ ...global, paused: true, dailyLossTriggered: true });

    if (_admin) {
      _admin.globalPaused = true;
      const s = _admin.agentStatus ?? {};
      for (const key of Object.keys(s)) s[key].running = false;
    }
  } catch (err) {
    console.error('[risk] checkDailyLossLimit:', err.message);
  }
}

// ─── WebSocket snapshot ───────────────────────────────────────────────────────

function buildSnapshot() {
  const status    = _admin?.agentStatus ?? {};
  const capital   = readJson(CAPITAL_FILE);
  const csvStats  = csvAgentStats();
  const resState  = _researcher?.getState() ?? null;
  const agents  = Object.entries(status).map(([name, s]) => {
    const csv       = csvStats[name] || { pnl: 0, trades: 0 };
    const memPnl    = s.pnl    ?? 0;
    const memTrades = s.trades ?? 0;
    return {
      name,
      running:  s.running,
      trades:   memTrades > 0 ? memTrades : csv.trades,
      pnl:      +((memPnl !== 0 ? memPnl : csv.pnl).toFixed(2)),
      capital:  capital[name] ?? 0,
      lastScan: s.lastScan ?? null,
    };
  });
  const tradingAgents = agents.filter((a) => a.name !== 'SCREENER');
  const totalPnl      = tradingAgents.reduce((sum, a) => sum + a.pnl, 0);
  const totalCap      = tradingAgents.reduce((sum, a) => sum + a.capital, 0);
  const drawdown      = totalPnl < 0 ? Math.abs(totalPnl / Math.max(totalCap, 1)) * 100 : 0;

  const globalCfg = readGlobalConfig();

  return {
    type: 'snapshot',
    ts:            (Date.now() / 1000) | 0,
    emergencyStop: _admin?.emergencyStop ?? false,
    globalPaused:  globalCfg.paused,
    globalTriggered: globalCfg.dailyLossTriggered,
    marketMode:    globalCfg.marketMode,
    agents,
    totalPnl:  +totalPnl.toFixed(2),
    totalCap:  +totalCap.toFixed(2),
    todayPnl:  +todayPnl().toFixed(2),
    drawdown:  +drawdown.toFixed(2),
    signals:   signalBuffer.slice(0, 5),
    research: resState ? {
      running:    resState.running,
      iterations: resState.session?.iterations || 0,
      winners:    resState.winners || 0,
      lastLog:    resState.log?.slice(-5).map(l => l.msg) || [],
    } : null,
  };
}

// ─── Start ────────────────────────────────────────────────────────────────────

function start(refs = {}) {
  _admin    = refs.admin    ?? null;
  _hunter   = refs.hunter   ?? null;
  _scalper1 = refs.scalper1 ?? null;
  _scalper2 = refs.scalper2 ?? null;
  _scalper3 = refs.scalper3 ?? null;
  _screener = refs.screener ?? null;
  _bitget   = refs.bitget   ?? null;
  _webhook     = refs.webhook     ?? null;
  _researcher  = refs.researcher  ?? null;

  // Inject agent refs into favorites router
  favoritesSetRefs({ scalper1: _scalper1, scalper2: _scalper2, scalper3: _scalper3, hunter: _hunter });
  symbolsSetRef(_scalper1);

  // Wire researcher progress events → WebSocket broadcast
  if (_researcher) {
    _researcher.on('log',      () => {});  // captured in state
    _researcher.on('progress', () => {});  // captured in state
    _researcher.on('winner',   (w) => { _rescentWinner = w; });
    _researcher.on('done',     () => {});
  }

  const app    = buildApp();
  const server = http.createServer(app);
  const wss    = new WebSocketServer({ server, path: '/ws' });
  const clients = new Set();

  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.send(JSON.stringify(buildSnapshot()));
    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
  });

  // Check daily loss limit every minute
  setInterval(checkDailyLossLimit, 60_000);

  // Push live snapshots every 2s
  setInterval(() => {
    if (!clients.size) return;
    const msg = JSON.stringify(buildSnapshot());
    for (const ws of clients) {
      if (ws.readyState === 1 /* OPEN */) ws.send(msg);
    }
  }, 2000);

  server.listen(DASHBOARD_PORT, '0.0.0.0', () => {
    console.log(`[dashboard] http://localhost:${DASHBOARD_PORT}  (user: admin)`);
  });

  return { server, pushSignal };
}

module.exports = { start, pushSignal };
