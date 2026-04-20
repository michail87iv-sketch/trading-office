'use strict';

require('dotenv').config();

const fs        = require('fs');
const path      = require('path');
const axios     = require('axios');
const crypto    = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');

const { backtest, STRATEGY_DEFAULTS, STRATEGY_PARAM_RANGES, STRATEGY_TYPES } = require('../core/backtest');
const { generate: genPineScript } = require('../utils/pinescript');
const { sendReport, sendAlert }   = require('../core/telegram');

// ─── Paths ────────────────────────────────────────────────────────────────────

const SETTINGS_FILE  = path.join(__dirname, '../.claude/memory/researcher_settings.json');
const RESULTS_DIR    = path.join(__dirname, '../data/strategies');
const CACHE_DIR      = path.join(__dirname, '../data/ohlcv_cache');
const SESSION_FILE   = path.join(__dirname, '../data/strategies/sessions.json');
const TOKENS_FILE    = path.join(__dirname, '../data/token_usage.json');

// ─── Token tracking ───────────────────────────────────────────────────────────

function loadTokenStats() {
  try {
    if (fs.existsSync(TOKENS_FILE)) return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
  } catch {}
  return { totalIn: 0, totalOut: 0, totalCost: 0, sessions: 0, lastReset: Date.now() };
}

function saveTokenStats() {
  fs.mkdirSync(path.dirname(TOKENS_FILE), { recursive: true });
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(_tokenStats, null, 2));
}

let _tokenStats = loadTokenStats();
// Per-session counters (reset on each start())
let _sessionTokensIn  = 0;
let _sessionTokensOut = 0;
let _sessionCost      = 0;

// ─── Default settings ─────────────────────────────────────────────────────────

const DEFAULT_SETTINGS = {
  symbols:        ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'AVAXUSDT'],
  timeframes:     ['5m', '15m'],
  maxIterations:  30,
  targetWinRate:  0.52,
  minTrades:      25,
  maxDrawdown:    0.25,
  minProfitFactor: 1.2,
  dataMonths:     3,
  walkForward:    true,
  modelId:        'claude-haiku-4-5-20251001',
};

// ─── State ────────────────────────────────────────────────────────────────────

let _settings      = loadSettings();
let _running       = false;
let _stopFlag      = false;
let _currentSession = null;
let _progressCb    = null;
let _anthropic     = null;

const GRANULARITY_MAP = { '1m':'1m', '3m':'3m', '5m':'5m', '15m':'15m', '30m':'30m', '1h':'1H', '4h':'4H', '1d':'1D' };

// ─── Settings ─────────────────────────────────────────────────────────────────

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
    }
  } catch {}
  return { ...DEFAULT_SETTINGS };
}

function saveSettings() {
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(_settings, null, 2));
}

function applySettings(updates) {
  _settings = { ..._settings, ...updates };
  saveSettings();
}

// ─── Sessions ─────────────────────────────────────────────────────────────────

function loadSessions() {
  try {
    if (fs.existsSync(SESSION_FILE)) return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
  } catch {}
  return [];
}

function saveSessions(sessions) {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  fs.writeFileSync(SESSION_FILE, JSON.stringify(sessions.slice(-50), null, 2)); // keep last 50
}

// ─── OHLCV cache ──────────────────────────────────────────────────────────────

function cacheKey(symbol, tf) {
  return path.join(CACHE_DIR, `${symbol}_${tf}.json`);
}

function readCache(symbol, tf) {
  try {
    const file = cacheKey(symbol, tf);
    if (!fs.existsSync(file)) return null;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const ageH = (Date.now() - data.savedAt) / 3_600_000;
    if (ageH > 2) return null; // refresh if older than 2h
    return data.candles;
  } catch { return null; }
}

function writeCache(symbol, tf, candles) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(cacheKey(symbol, tf), JSON.stringify({ symbol, tf, savedAt: Date.now(), candles }));
}

// ─── Bitget historical data (paginated) ──────────────────────────────────────

async function fetchHistoricalCandles(symbol, tf, months = 3) {
  const cached = readCache(symbol, tf);
  if (cached) {
    emit('log', `  📦 ${symbol} ${tf}: using cache (${cached.length} candles)`);
    return cached;
  }

  const gran      = GRANULARITY_MAP[tf] || tf;
  const endMs     = Date.now();
  const startMs   = endMs - months * 30 * 24 * 60 * 60 * 1000;
  const BASE_URL  = 'https://api.bitget.com';
  const API_KEY   = process.env.BITGET_API_KEY;
  const SECRET    = process.env.BITGET_SECRET_KEY;
  const PASS      = process.env.BITGET_PASSPHRASE;

  function sign(ts, method, path, body = '') {
    return crypto.createHmac('sha256', SECRET)
      .update(ts + method.toUpperCase() + path + body)
      .digest('base64');
  }

  let allCandles  = [];
  let currentEnd  = endMs;
  let pages       = 0;
  const maxPages  = 50;

  emit('log', `  🌐 Fetching ${symbol} ${tf} data…`);

  while (currentEnd > startMs && pages < maxPages) {
    if (_stopFlag) break;

    const qs   = `symbol=${symbol}&productType=USDT-FUTURES&granularity=${gran}&endTime=${currentEnd}&limit=200`;
    const reqPath = `/api/v2/mix/market/candles?${qs}`;
    const ts   = Date.now().toString();
    const sig  = sign(ts, 'GET', reqPath);

    try {
      const { data } = await axios.get(`${BASE_URL}${reqPath}`, {
        headers: {
          'ACCESS-KEY': API_KEY, 'ACCESS-SIGN': sig,
          'ACCESS-TIMESTAMP': ts, 'ACCESS-PASSPHRASE': PASS,
          'Content-Type': 'application/json', 'locale': 'en-US',
        },
        timeout: 10000,
      });

      if (data.code !== '00000' || !Array.isArray(data.data) || !data.data.length) break;

      const batch = data.data.map(c => ({
        time:  parseInt(c[0]),
        open:  parseFloat(c[1]),
        high:  parseFloat(c[2]),
        low:   parseFloat(c[3]),
        close: parseFloat(c[4]),
        vol:   parseFloat(c[5]),
      }));

      allCandles = [...allCandles, ...batch];
      currentEnd = batch[batch.length - 1].time - 1;
      pages++;
      await sleep(150);
    } catch (err) {
      emit('log', `  ⚠ Fetch error: ${err.message}`);
      break;
    }
  }

  // Sort oldest → newest, deduplicate
  allCandles.sort((a, b) => a.time - b.time);
  allCandles = allCandles.filter((c, i, arr) => i === 0 || c.time !== arr[i - 1].time);

  emit('log', `  ✅ ${symbol} ${tf}: ${allCandles.length} candles fetched`);
  if (allCandles.length > 100) writeCache(symbol, tf, allCandles);
  return allCandles;
}

// ─── Claude strategy generation ───────────────────────────────────────────────

// Token-rate throttle: track usage per minute
let _tokensThisMinute = 0;
let _minuteStart      = Date.now();
const TOKEN_LIMIT     = 45_000; // stay 10% below the 50k/min hard cap
const MIN_CALL_GAP_MS = 2_000;  // never fire faster than 1 call / 2s
let   _lastCallAt     = 0;

async function askClaude(stratType, currentParams, tp, sl, results, history, symbol, tf) {
  if (!_anthropic) return null;

  // Enforce minimum gap between calls
  const sinceLast = Date.now() - _lastCallAt;
  if (sinceLast < MIN_CALL_GAP_MS) await sleep(MIN_CALL_GAP_MS - sinceLast);

  // Reset per-minute counter every 60 s
  if (Date.now() - _minuteStart > 60_000) {
    _tokensThisMinute = 0;
    _minuteStart      = Date.now();
  }

  // If approaching limit, wait for the minute to reset
  if (_tokensThisMinute >= TOKEN_LIMIT) {
    const wait = 61_000 - (Date.now() - _minuteStart);
    emit('log', `  ⏳ Rate-limit pause: ${Math.ceil(wait / 1000)}s (${_tokensThisMinute} tokens used this minute)`);
    await sleep(wait > 0 ? wait : 5_000);
    _tokensThisMinute = 0;
    _minuteStart      = Date.now();
  }

  const ranges = STRATEGY_PARAM_RANGES[stratType] || {};
  // Keep history summary short: last 3 iterations only
  const histSummary = history.slice(-3).map(h =>
    `${JSON.stringify(h.params)} WR:${(h.result?.winRate * 100 || 0).toFixed(0)}% PF:${(h.result?.profitFactor || 0).toFixed(2)}`
  ).join('\n');

  // Compact prompt to minimise input tokens
  const prompt = `Optimize crypto scalping strategy. Reply ONLY with a JSON object, no markdown.
Type:${stratType} ${symbol} ${tf}
Target: WR>${((_settings.targetWinRate)*100).toFixed(0)}% PF>${_settings.minProfitFactor} DD<${((_settings.maxDrawdown)*100).toFixed(0)}%
Params:${JSON.stringify(currentParams)}
Results: WR=${(results?.winRate*100||0).toFixed(0)}% PF=${(results?.profitFactor||0).toFixed(2)} DD=${((results?.maxDD||0)*100).toFixed(0)}% T=${results?.trades||0}
Ranges:${JSON.stringify(ranges)}
History:\n${histSummary||'first'}
Return improved JSON with same keys, values within ranges.`;

  const doCall = () => _anthropic.messages.create({
    model:      _settings.modelId,
    max_tokens: 256,
    messages:   [{ role: 'user', content: prompt }],
  });

  let msg;
  try {
    _lastCallAt = Date.now();
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('Claude timeout (30s)')), 30_000));
    msg = await Promise.race([doCall(), timeout]);
  } catch (err) {
    // On 429 wait 60 s and retry once
    if (err.message?.includes('429') || err.status === 429) {
      emit('log', `  ⏳ Rate limit hit — waiting 60s then retrying…`);
      await sleep(61_000);
      _tokensThisMinute = 0;
      _minuteStart      = Date.now();
      try {
        _lastCallAt = Date.now();
        msg = await doCall();
      } catch (err2) {
        emit('log', `  ⚠ Claude error (retry): ${err2.message}`);
        return null;
      }
    } else {
      emit('log', `  ⚠ Claude error: ${err.message}`);
      return null;
    }
  }

  const { input_tokens, output_tokens } = msg.usage;
  _tokensThisMinute  += input_tokens + output_tokens;
  const callCost      = (input_tokens / 1_000_000 * 0.80) + (output_tokens / 1_000_000 * 4.00);

  // Update session counters
  _sessionTokensIn  += input_tokens;
  _sessionTokensOut += output_tokens;
  _sessionCost      += callCost;

  // Update lifetime counters and persist
  _tokenStats.totalIn   += input_tokens;
  _tokenStats.totalOut  += output_tokens;
  _tokenStats.totalCost += callCost;
  saveTokenStats();

  emit('log', `  🤖 Haiku: ${input_tokens}in/${output_tokens}out ~$${callCost.toFixed(5)} | session ~$${_sessionCost.toFixed(4)} | lifetime ~$${_tokenStats.totalCost.toFixed(3)}`);

  try {
    const text = msg.content[0]?.text?.trim() || '';
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]+?)```/) || [null, text];
    const parsed    = JSON.parse(jsonMatch[1].trim());
    delete parsed._cache;
    return parsed;
  } catch (err) {
    emit('log', `  ⚠ Claude parse error: ${err.message}`);
    return null;
  }
}

// ─── Random mutation (fallback when Claude fails) ────────────────────────────

function mutateParams(type, params) {
  const ranges = STRATEGY_PARAM_RANGES[type] || {};
  const result = { ...params };
  delete result._cache;

  // Mutate 1-3 random parameters
  const keys      = Object.keys(ranges);
  const numMutate = Math.min(keys.length, 1 + Math.floor(Math.random() * 2));
  for (let i = 0; i < numMutate; i++) {
    const key   = keys[Math.floor(Math.random() * keys.length)];
    const [lo, hi] = ranges[key];
    const isInt = Number.isInteger(lo) && Number.isInteger(hi);
    result[key] = isInt
      ? Math.round(lo + Math.random() * (hi - lo))
      : parseFloat((lo + Math.random() * (hi - lo)).toFixed(2));
  }
  return result;
}

// ─── Core research loop ───────────────────────────────────────────────────────

async function researchPair(symbol, tf, session) {
  emit('log', `\n🔬 ${symbol} / ${tf}`);

  // Fetch data
  let candles;
  try {
    candles = await fetchHistoricalCandles(symbol, tf, _settings.dataMonths);
  } catch (err) {
    emit('log', `  ❌ Data fetch failed: ${err.message}`);
    return;
  }

  if (candles.length < 200) {
    emit('log', `  ⚠ Insufficient data (${candles.length} candles), skipping`);
    return;
  }

  // Try each strategy type
  const typesToTry = [...STRATEGY_TYPES].sort(() => Math.random() - 0.5);

  for (const stratType of typesToTry) {
    if (_stopFlag) return;

    emit('log', `\n  📐 Strategy: ${stratType}`);
    let params  = { ...STRATEGY_DEFAULTS[stratType] };
    let tp      = 1.5;
    let sl      = 0.8;
    const history = [];

    for (let iter = 0; iter < _settings.maxIterations; iter++) {
      if (_stopFlag) return;

      // Yield to event loop so WS/HTTP can process (dashboard stays live)
      // Minimum 400ms between iterations so the 2s WS broadcast timer always fires
      await sleep(400);
      if (_stopFlag) return;

      let result;
      try {
        const bt = backtest(candles, { type: stratType, params, tp, sl }, {
          walkForward: _settings.walkForward,
        });
        result = bt.metrics || bt.fullMetrics;
      } catch (err) {
        emit('log', `    Iter ${iter + 1}: backtest error — ${err.message}`);
        params = mutateParams(stratType, params);
        continue;
      }

      if (!result) {
        emit('log', `    Iter ${iter + 1}: no trades generated`);
        params = mutateParams(stratType, params);
        continue;
      }

      const wr  = (result.winRate * 100).toFixed(1);
      const pf  = result.profitFactor.toFixed(2);
      const dd  = (result.maxDD * 100).toFixed(1);
      const tr  = result.trades;
      emit('log', `    Iter ${iter + 1}: WR=${wr}%  PF=${pf}  DD=${dd}%  Trades=${tr}  TP=${tp}% SL=${sl}%`);

      session.iterations = (session.iterations || 0) + 1;
      history.push({ params: { ...params }, tp, sl, result });
      emit('progress', session);

      // ── Winner found ──
      if (
        result.winRate  >= _settings.targetWinRate &&
        result.profitFactor >= _settings.minProfitFactor &&
        result.maxDD    <= _settings.maxDrawdown &&
        result.trades   >= _settings.minTrades
      ) {
        const strategy  = { type: stratType, params: { ...params }, tp, sl };
        const pineScript = genPineScript(strategy, symbol, tf, result);
        const id         = `${symbol}_${tf}_${stratType}_${Date.now()}`;
        const winner     = {
          id, symbol, tf, strategy, metrics: result, pineScript,
          ts: (Date.now() / 1000) | 0,
        };

        // Save to disk
        fs.mkdirSync(RESULTS_DIR, { recursive: true });
        fs.writeFileSync(path.join(RESULTS_DIR, `${id}.json`), JSON.stringify(winner, null, 2));

        session.winners = session.winners || [];
        session.winners.push(winner);
        emit('winner', winner);

        // Notify Telegram
        await notifyWinner(winner).catch(() => {});

        emit('log', `    🏆 WINNER! WR=${wr}% PF=${pf} DD=${dd}%`);
        break; // move to next strategy type
      }

      // ── Ask Claude to improve (smart gating — don't call on every iteration) ──
      // Call Claude only when: enough trades to learn from, every 3rd iter, WR shows signal
      const enoughData   = result.trades >= 10;
      const isClaudeIter = (iter % 3 === 2); // every 3rd iteration (iter 2, 5, 8…)
      const hasSignal    = result.winRate > 0.05; // at least 5% WR, not total noise

      const cleanParams = { ...params };
      delete cleanParams._cache;

      let newParams = null;
      if (_anthropic && enoughData && isClaudeIter && hasSignal) {
        newParams = await askClaude(stratType, cleanParams, tp, sl, result, history, symbol, tf);
      }
      if (!newParams) newParams = mutateParams(stratType, params);

      // Also occasionally mutate TP/SL
      if (Math.random() < 0.3) {
        tp = parseFloat((0.5 + Math.random() * 4.5).toFixed(1));
        sl = parseFloat((0.3 + Math.random() * 2.7).toFixed(1));
      }

      params = { ...newParams };
    }
  }
}

// ─── Notification ─────────────────────────────────────────────────────────────

async function notifyWinner(w) {
  const m = w.metrics;
  const lines = [
    `🏆 <b>Research Winner Found!</b>`,
    ``,
    `<b>Symbol:</b>    ${w.symbol}`,
    `<b>Timeframe:</b> ${w.tf}`,
    `<b>Strategy:</b>  ${w.strategy.type.replace(/_/g, ' ')}`,
    `<b>TP/SL:</b>     ${w.strategy.tp}% / ${w.strategy.sl}%`,
    ``,
    `<b>Win Rate:</b>      ${(m.winRate * 100).toFixed(1)}%`,
    `<b>Profit Factor:</b> ${m.profitFactor}`,
    `<b>Max Drawdown:</b>  ${(m.maxDD * 100).toFixed(1)}%`,
    `<b>Total Return:</b>  ${(m.totalReturn * 100).toFixed(1)}%`,
    `<b>Trades:</b>        ${m.trades}`,
    `<b>Sharpe:</b>        ${m.sharpe}`,
    ``,
    `Pine Script saved — check dashboard Research tab.`,
  ];
  await sendReport({ raw: lines.join('\n') }).catch(() =>
    sendAlert(lines.join('\n')).catch(() => {})
  );
}

// ─── Session management ───────────────────────────────────────────────────────

async function start(options = {}) {
  if (_running) return { ok: false, error: 'Already running' };

  const settings = { ..._settings, ...options };
  _settings = settings;

  if (process.env.ANTHROPIC_API_KEY) {
    _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    emit('log', `🤖 Claude AI enabled (${settings.modelId})`);
  } else {
    _anthropic = null;
    emit('log', `⚠ No ANTHROPIC_API_KEY — using random search`);
  }

  const sessionId = `sess_${Date.now()}`;
  _currentSession = {
    id:         sessionId,
    started:    (Date.now() / 1000) | 0,
    status:     'running',
    symbols:    settings.symbols,
    timeframes: settings.timeframes,
    iterations: 0,
    winners:    [],
    log:        [],
  };
  _running   = true;
  _stopFlag  = false;

  // Reset per-session token counters
  _sessionTokensIn  = 0;
  _sessionTokensOut = 0;
  _sessionCost      = 0;
  _tokenStats.sessions = (_tokenStats.sessions || 0) + 1;
  saveTokenStats();

  emit('log', `🚀 Research session started: ${sessionId}`);
  emit('log', `   Symbols: ${settings.symbols.join(', ')}`);
  emit('log', `   Timeframes: ${settings.timeframes.join(', ')}`);
  emit('log', `   Target: WR>${(settings.targetWinRate * 100).toFixed(0)}%  PF>${settings.minProfitFactor}  MaxDD<${(settings.maxDrawdown * 100).toFixed(0)}%`);

  // Run async (non-blocking)
  runLoop(settings).catch((err) => {
    emit('log', `❌ Session error: ${err.message}`);
  });

  return { ok: true, sessionId };
}

async function runLoop(settings) {
  try {
    for (const symbol of settings.symbols) {
      for (const tf of settings.timeframes) {
        if (_stopFlag) break;
        await researchPair(symbol, tf, _currentSession);
      }
      if (_stopFlag) break;
    }
  } finally {
    _running = false;
    _currentSession.status = _stopFlag ? 'stopped' : 'completed';
    _currentSession.ended  = (Date.now() / 1000) | 0;

    const sessions = loadSessions();
    sessions.push(_currentSession);
    saveSessions(sessions);

    const msg = _stopFlag
      ? `⏹ Research stopped. Iterations: ${_currentSession.iterations}, Winners: ${_currentSession.winners.length}`
      : `✅ Research complete. Iterations: ${_currentSession.iterations}, Winners: ${_currentSession.winners.length}`;

    emit('log', msg);
    emit('done', _currentSession);
    await sendAlert(msg).catch(() => {});
  }
}

function stop() {
  if (!_running) return { ok: false, error: 'Not running' };
  _stopFlag = true;
  return { ok: true };
}

// ─── Results ──────────────────────────────────────────────────────────────────

function getResults() {
  try {
    const files = fs.readdirSync(RESULTS_DIR).filter(f => f.endsWith('.json') && f !== 'sessions.json');
    return files.map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, f), 'utf8')); }
      catch { return null; }
    }).filter(Boolean).sort((a, b) => b.ts - a.ts);
  } catch { return []; }
}

function getState() {
  return {
    running:        _running,
    session:        _currentSession,
    settings:       _settings,
    winners:        _currentSession?.winners?.length || 0,
    log:            _currentSession?.log?.slice(-200) || [],
    tokens: {
      sessionIn:    _sessionTokensIn,
      sessionOut:   _sessionTokensOut,
      sessionCost:  _sessionCost,
      lifetimeIn:   _tokenStats.totalIn,
      lifetimeOut:  _tokenStats.totalOut,
      lifetimeCost: _tokenStats.totalCost,
      sessions:     _tokenStats.sessions || 0,
    },
  };
}

function getTokenStats() {
  return {
    session:  { in: _sessionTokensIn, out: _sessionTokensOut, cost: _sessionCost },
    lifetime: { in: _tokenStats.totalIn, out: _tokenStats.totalOut, cost: _tokenStats.totalCost, sessions: _tokenStats.sessions || 0 },
  };
}

// ─── Progress emitter ─────────────────────────────────────────────────────────

const _listeners = {};

function on(event, cb) {
  if (!_listeners[event]) _listeners[event] = [];
  _listeners[event].push(cb);
}

function emit(event, data) {
  // Also append log lines to session
  if (event === 'log' && _currentSession) {
    _currentSession.log = _currentSession.log || [];
    _currentSession.log.push({ ts: Date.now(), msg: data });
    if (_currentSession.log.length > 500) _currentSession.log.shift();
  }
  (_listeners[event] || []).forEach(cb => { try { cb(data); } catch {} });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Telegram command handler ─────────────────────────────────────────────────

async function handleCommand(ctx, admin) {
  const text  = ctx.message?.text?.trim() || '';
  const parts = text.split(/\s+/);
  const sub   = parts[1]?.toLowerCase();

  const { registerCommand, sendAdmin } = require('../core/telegram');

  if (!sub || sub === 'status') {
    const state   = getState();
    const results = getResults();
    const status  = state.running ? '🟢 RUNNING' : '⚪ IDLE';
    const lines   = [
      `<b>🔬 RESEARCHER — ${status}</b>`,
      state.running ? `Iterations: ${state.session?.iterations || 0}  Winners this session: ${state.winners}` : '',
      `Total strategies saved: ${results.length}`,
      ``,
      `<b>Settings:</b>`,
      `  Symbols: ${state.settings.symbols.join(', ')}`,
      `  Timeframes: ${state.settings.timeframes.join(', ')}`,
      `  Target WR: ${(state.settings.targetWinRate * 100).toFixed(0)}%`,
      ``,
      state.running ? `Use /research stop to stop.` : `Use /research start to begin.`,
    ].filter(Boolean);
    await sendAdmin(lines.join('\n'));
    return;
  }

  if (sub === 'start') {
    const overrides = {};
    // Parse optional args: /research start symbols=BTCUSDT,ETHUSDT tf=5m,15m
    for (const part of parts.slice(2)) {
      const [k, v] = part.split('=');
      if (k === 'symbols') overrides.symbols = v.split(',');
      if (k === 'tf') overrides.timeframes = v.split(',');
      if (k === 'wr') overrides.targetWinRate = parseFloat(v);
      if (k === 'iter') overrides.maxIterations = parseInt(v);
    }
    const res = await start(overrides);
    if (res.ok) {
      await sendAdmin(`🚀 Research started (session: ${res.sessionId})\nMonitor progress in the dashboard Research tab.`);
    } else {
      await sendAdmin(`⚠ ${res.error}`);
    }
    return;
  }

  if (sub === 'stop') {
    const res = stop();
    await sendAdmin(res.ok ? '⏹ Research stopping…' : `⚠ ${res.error}`);
    return;
  }

  if (sub === 'results') {
    const results = getResults().slice(0, 5);
    if (!results.length) {
      await sendAdmin('📭 No winning strategies found yet.');
      return;
    }
    const lines = [`<b>🏆 Top strategies (${results.length} total)</b>\n`];
    for (const r of results) {
      lines.push(
        `<b>${r.symbol} ${r.tf}</b> — ${r.strategy.type.replace(/_/g, ' ')}\n` +
        `  WR: ${(r.metrics.winRate * 100).toFixed(1)}%  PF: ${r.metrics.profitFactor}  DD: ${(r.metrics.maxDD * 100).toFixed(1)}%  Trades: ${r.metrics.trades}`
      );
    }
    await sendAdmin(lines.join('\n'));
    return;
  }

  await sendAdmin(
    '<b>/research commands:</b>\n' +
    '  /research status — current state\n' +
    '  /research start [symbols=X,Y] [tf=5m,15m] [wr=0.52] [iter=30]\n' +
    '  /research stop — stop current session\n' +
    '  /research results — show top strategies'
  );
}

// ─── Init (register Telegram commands) ───────────────────────────────────────

function init(admin) {
  const { registerCommand } = require('../core/telegram');
  registerCommand('research', (ctx) => handleCommand(ctx, admin));
  console.log('[researcher] initialized');
}

module.exports = { init, start, stop, getState, getResults, getTokenStats, applySettings, on };
