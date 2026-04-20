'use strict';

require('dotenv').config();

const { spawn } = require('child_process');
const cron      = require('node-cron');
const fs        = require('fs');
const path      = require('path');

const {
  bot,
  registerCommand,
  sendAdmin,
  sendAlert,
  sendReport,
  TOPICS,
} = require('../core/telegram');

const { buildSummaryCSV, ARCHIVE_FILE } = require('../core/archive');

const programmer = require('./programmer');
const webhook    = require('../core/webhook');

// ─── Constants ────────────────────────────────────────────────────────────────

const OWNER_ID       = 2104689411;
const ADMIN_TOPIC_ID = Number(process.env.TG_TOPIC_ADMIN) || 6;
const MEMORY_FILE    = path.join(__dirname, '../.claude/memory/admin_memory.json');
const CAPITAL_FILE   = path.join(__dirname, '../.claude/memory/capital_settings.json');
const CLAUDE_MD_FILE = path.join(__dirname, '../CLAUDE.md');
const STRATEGY_FILE  = path.join(__dirname, '../strategies/hunter_ict.md');
const MAX_HISTORY    = 20; // turns kept in prompt (each = user+assistant pair)

const WELCOME_TEXT = [
  '📋 <b>Trading Office — команды</b>',
  '',
  '<b>📊 Статус</b>',
  '  /status — статус всех агентов',
  '  /balance — баланс по агентам',
  '  /report — дневной отчёт PnL',
  '  /archive — скачать CSV-архив сделок по агентам',
  '  /hunter — статус HUNTER',
  '  /screener — статус SCREENER',
  '  /s1 — SCALPER1 (Level/RSI)',
  '  /s2 — SCALPER2 (VWAP+EMA)',
  '  /s3 — SCALPER3 (Short from Wall)',
  '',
  '<b>🔧 Управление агентами</b>',
  '  /hunter_on / /hunter_off',
  '  /screener_on / /screener_off',
  '  /s1 on / /s1 off',
  '  /s2 on / /s2 off',
  '  /s3 on / /s3 off',
  '  /stop — аварийная остановка всех',
  '  /restart — перезапустить бота',
  '  /resume — возобновить после /stop',
  '',
  '<b>⚙️ Настройки</b>',
  '  /deposit &lt;агент&gt; &lt;сумма&gt; — изменить депозит агента',
  '  /set pump|period|cooldown|interval &lt;val&gt; — screener',
  '  /set s1 leverage|risk|tp|sl|maxTrades|margin &lt;val&gt;',
  '  /set s2 leverage|risk|tp|sl|trailingStop|margin &lt;val&gt;',
  '  /set s3 leverage|risk|minRR|sl|maxTrades|margin &lt;val&gt;',
  '  /set hunter margin isolated|crossed',
  '  /set mt &lt;hunter|s1|s2|s3&gt; &lt;val&gt; — изменить maxTrades агента',
  '',
  '  /webhook — последние 10 TV сигналов',
  '  /code &lt;задача&gt; — делегировать PROGRAMMER',
  '',
  '<b>🖥 Dashboard</b>',
  `  http://YOUR_SERVER_IP:${process.env.DASHBOARD_PORT || 8080}  (login: admin)`,
  'Или просто напишите сообщение — ADMIN ответит.',
].join('\n');

const AGENT_CAPITAL_DEFAULTS = {
  HUNTER:   5,
  SCALPER1: 5,
  SCALPER2: 5,
  SCALPER3: 5,
};

function loadCapital() {
  try {
    if (fs.existsSync(CAPITAL_FILE)) {
      const saved = JSON.parse(fs.readFileSync(CAPITAL_FILE, 'utf8'));
      return Object.assign({}, AGENT_CAPITAL_DEFAULTS, saved);
    }
  } catch {
    // corrupt file — use defaults
  }
  return { ...AGENT_CAPITAL_DEFAULTS };
}

function saveCapital() {
  fs.mkdirSync(path.dirname(CAPITAL_FILE), { recursive: true });
  fs.writeFileSync(CAPITAL_FILE, JSON.stringify(AGENT_CAPITAL, null, 2));
}

let AGENT_CAPITAL = loadCapital();

function totalCapital() {
  return Object.values(AGENT_CAPITAL).reduce((s, v) => s + v, 0);
}

// ─── Memory ───────────────────────────────────────────────────────────────────

function loadMemory() {
  try {
    if (fs.existsSync(MEMORY_FILE)) {
      return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
    }
  } catch {
    // corrupt file — start fresh
  }
  return { history: [], notes: [] };
}

function saveMemory() {
  fs.mkdirSync(path.dirname(MEMORY_FILE), { recursive: true });
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(memory, null, 2));
}

let memory = loadMemory();

function pushHistory(role, content) {
  memory.history.push({ role, content: String(content) });
  if (memory.history.length > MAX_HISTORY) {
    memory.history = memory.history.slice(-MAX_HISTORY);
  }
  saveMemory();
}

// ─── Shared agent state (mutated by other agents via exports) ─────────────────

const agentStatus = {
  SCREENER: { running: false, lastScan: null },
  HUNTER:   { running: false, trades: 0, pnl: 0.00 },
  SCALPER1: { running: false, trades: 0, pnl: 0.00 },
  SCALPER2: { running: false, trades: 0, pnl: 0.00 },
  SCALPER3: { running: false, trades: 0, pnl: 0.00 },
};

// ─── Agent status persistence (survives restarts) ─────────────────────────────

const STATUS_FILE = path.join(__dirname, '../.claude/memory/agent_status.json');

// Временное хранилище enabled-флагов, загруженных из файла до инициализации агентов
let savedEnabled = {};

function loadAgentStatus() {
  try {
    if (fs.existsSync(STATUS_FILE)) {
      const saved = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
      for (const [k, v] of Object.entries(saved)) {
        if (agentStatus[k]) {
          if (v.trades  != null) agentStatus[k].trades = v.trades;
          if (v.pnl     != null) agentStatus[k].pnl    = v.pnl;
        }
        // Сохраняем enabled для последующего применения через applyAgentEnabled()
        if (v.enabled != null) savedEnabled[k] = v.enabled;
      }
    }
  } catch (err) {
    console.warn('[admin] failed to load agent status:', err.message);
  }
}

function saveAgentStatus() {
  try {
    const toSave = {};
    for (const [k, v] of Object.entries(agentStatus)) {
      toSave[k] = {};
      if (v.trades != null) toSave[k].trades = v.trades;
      if (v.pnl    != null) toSave[k].pnl    = v.pnl;
    }
    // Сохраняем enabled-состояние каждого агента
    const refMap = {
      HUNTER:   hunterRef,
      SCREENER: screenerRef,
      SCALPER1: scalper1Ref,
      SCALPER2: scalper2Ref,
      SCALPER3: scalper3Ref,
    };
    for (const [name, ref] of Object.entries(refMap)) {
      if (ref) {
        if (!toSave[name]) toSave[name] = {};
        toSave[name].enabled = ref.enabled;
      }
    }
    fs.mkdirSync(path.dirname(STATUS_FILE), { recursive: true });
    fs.writeFileSync(STATUS_FILE, JSON.stringify(toSave, null, 2));
  } catch (err) {
    console.warn('[admin] failed to save agent status:', err.message);
  }
}

// Вызывается из index.js после того как все агенты инициализированы
function applyAgentEnabled() {
  const refMap = {
    HUNTER:   hunterRef,
    SCREENER: screenerRef,
    SCALPER1: scalper1Ref,
    SCALPER2: scalper2Ref,
    SCALPER3: scalper3Ref,
  };
  for (const [name, ref] of Object.entries(refMap)) {
    if (ref && savedEnabled[name] != null) {
      ref.setEnabled(savedEnabled[name]);
      console.log(`[admin] restored ${name} enabled=${savedEnabled[name]}`);
    }
  }
}

let emergencyStop = false;
let globalPaused  = false;
let screenerRef   = null;
let hunterRef     = null;
let scalper1Ref   = null;
let scalper2Ref   = null;
let scalper3Ref   = null;
let greeted       = false; // show welcome on first message after restart

// ─── Static context loaded once at startup ────────────────────────────────────

let CLAUDE_MD = '';
try {
  CLAUDE_MD = fs.readFileSync(CLAUDE_MD_FILE, 'utf8');
} catch {
  console.warn('[admin] CLAUDE.md not found');
}

let HUNTER_ICT_STRATEGY = '';
try {
  HUNTER_ICT_STRATEGY = fs.readFileSync(STRATEGY_FILE, 'utf8');
} catch {
  console.warn('[admin] strategies/hunter_ict.md not found — HUNTER context will be limited');
}

// ─── HTML sanitizer (keeps only Telegram-safe tags) ──────────────────────────

const ALLOWED_TAGS = new Set(['b', '/b', 'i', '/i', 'code', '/code', 'pre', '/pre', 'u', '/u', 's', '/s']);

function sanitizeHtml(text) {
  return text.replace(/<([^>]{0,60})>/g, (match, inner) => {
    const name = inner.trim().split(/[\s=]/)[0].toLowerCase();
    return ALLOWED_TAGS.has(name) ? match : '';
  });
}

// ─── Claude Code CLI subprocess ───────────────────────────────────────────────

function buildPrompt(userMessage) {
  // Recent history: last MAX_HISTORY entries (user+assistant turns interleaved)
  const historyText = memory.history.slice(-MAX_HISTORY)
    .map((m) => `${m.role === 'user' ? 'Владелец' : 'ADMIN'}: ${m.content}`)
    .join('\n');

  return [
    '# Системный контекст: Trading Office',
    CLAUDE_MD,

    HUNTER_ICT_STRATEGY
      ? `# Стратегия HUNTER (ICT/SMC)\n\n${HUNTER_ICT_STRATEGY}`
      : '',

    '# Инструкции для ADMIN',
    [
      'Ты ADMIN — умный оркестратор. Отвечай на русском языке.',
      'Будь кратким и конкретным — не более 250 слов.',
      'Используй только обычный текст; HTML-теги <b>, <i>, <code>, <pre> допустимы.',
      'Не повторяй вопрос. Не пиши "Как ADMIN, я..." — просто отвечай.',
    ].join('\n'),

    historyText
      ? `# История диалога\n${historyText}`
      : '',

    `# Новое сообщение от владельца\n${userMessage}`,
  ].filter(Boolean).join('\n\n');
}

async function askClaude(userMessage) {
  pushHistory('user', userMessage);

  const prompt = buildPrompt(userMessage);

  const reply = await new Promise((resolve, reject) => {
    const child = spawn(
      'claude',
      ['-p', prompt, '--output-format', 'json'],
      {
        cwd: path.join(__dirname, '..'),
        env: process.env,
        // Detach so the child is in its own process group — prevents SIGTERM
        // from propagating back to trading-office when we kill the child.
        detached: true,
        stdio: 'pipe',
      }
    );
    child.unref(); // don't keep our event loop alive waiting for the child

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });

    // Hard timeout — claude CLI should respond well within 90s
    const timer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
      reject(new Error('claude CLI timed out after 90s'));
    }, 90_000);

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`claude exited ${code}: ${stderr.slice(0, 300)}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        // Claude Code CLI --output-format json puts the answer in `result`
        resolve(sanitizeHtml(String(parsed.result ?? parsed.content ?? stdout).trim()));
      } catch {
        resolve(sanitizeHtml(stdout.trim())); // fallback: raw text
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });

  pushHistory('assistant', reply);
  return reply;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ts() {
  return (Date.now() / 1000) | 0;
}

function totalPnl() {
  return Object.values(agentStatus)
    .filter((s) => s.pnl != null)
    .reduce((sum, s) => sum + s.pnl, 0);
}

function drawdownPct() {
  const pnl = totalPnl();
  return pnl < 0 ? Math.abs(pnl / totalCapital()) * 100 : 0;
}

// ─── Command handlers ─────────────────────────────────────────────────────────

async function handleStatus() {
  const stopLine = emergencyStop ? '🛑 <b>EMERGENCY STOP ACTIVE</b>\n' : '';
  const dd       = drawdownPct();
  const ddLine   = dd > 0 ? `⚠️ Daily drawdown: <b>${dd.toFixed(2)}%</b>\n` : '';

  const agentIcons = {
    SCREENER: '📡', HUNTER: '🎯', SCALPER1: '⚡', SCALPER2: '📊', SCALPER3: '🔻',
  };

  const lines = [
    `${stopLine}${ddLine}`,
    '<b>Agent Status</b>',
  ];

  for (const [name, s] of Object.entries(agentStatus)) {
    const icon   = agentIcons[name] ?? '🤖';
    const dot    = s.running ? '🟢' : '🔴';
    const trades = s.trades != null ? `  ${s.trades} trades` : '';
    const pnl    = s.pnl    != null ? `  PnL: ${s.pnl >= 0 ? '+' : ''}${s.pnl.toFixed(2)}$` : '';
    lines.push(`${dot} ${icon} <b>${name}</b>${trades}${pnl}`);
  }

  const totalP = totalPnl();
  lines.push(`\n<b>Total PnL:</b> ${totalP >= 0 ? '+' : ''}${totalP.toFixed(2)}$`);

  await sendAdmin(lines.join('\n'));
}

async function handleReport() {
  const agents = Object.entries(agentStatus)
    .filter(([name]) => name !== 'SCREENER')
    .map(([name, s]) => ({
      name,
      pnl:    s.pnl    ?? 0,
      trades: s.trades ?? 0,
    }));

  const total = agents.reduce((sum, a) => sum + a.pnl, 0);

  await sendReport({
    date:      new Date().toISOString().split('T')[0],
    agents,
    total,
    drawdown:  drawdownPct(),
  });
}

async function handleStop() {
  emergencyStop = true;
  for (const key of Object.keys(agentStatus)) {
    agentStatus[key].running = false;
  }
  await sendAlert('🛑 EMERGENCY STOP — все агенты остановлены командой /stop');
  await sendAdmin('Все агенты остановлены. Для возобновления — <code>/resume</code>');
}

async function handleRestart() {
  await sendAdmin('🔄 Перезапуск Trading Office…');
  const { execSync } = require('child_process');
  setTimeout(() => {
    try { execSync('pm2 restart trading-office'); } catch { /* pm2 handles it */ }
  }, 500);
}

async function handleBalance() {
  const lines = ['<b>Balance per Agent</b>\n'];

  let total = 0;
  for (const [name, cap] of Object.entries(AGENT_CAPITAL)) {
    const pnl     = agentStatus[name]?.pnl ?? 0;
    const balance = cap + pnl;
    total += balance;
    const pnlStr = pnl >= 0 ? `+${pnl.toFixed(2)}` : pnl.toFixed(2);
    const dot    = pnl >= 0 ? '🟢' : '🔴';
    lines.push(`${dot} <b>${name}</b>  $${balance.toFixed(2)}  <i>(cap $${cap}  pnl ${pnlStr})</i>`);
  }

  lines.push(`\n<b>Total:</b> $${total.toFixed(2)}`);
  await sendAdmin(lines.join('\n'));
}

async function handleArchive(ctx) {
  const csv = buildSummaryCSV();
  if (!csv) {
    await sendAdmin('📭 Архив пуст — сделок ещё не было.');
    return;
  }

  const chatId = process.env.TG_CHAT_ID;
  const threadId = TOPICS.admin;

  // Write summary to a temp buffer and send as file
  const { Readable } = require('stream');
  const stream = Readable.from([csv]);
  const date   = new Date().toISOString().slice(0, 10);

  await bot.telegram.sendDocument(
    chatId,
    { source: stream, filename: `trades_${date}.csv` },
    { message_thread_id: threadId, caption: `📊 Архив сделок — ${date}` }
  );
}

async function handleResume() {
  if (!emergencyStop) {
    await sendAdmin('ℹ️ Агенты не остановлены.');
    return;
  }
  emergencyStop = false;
  await sendAdmin('✅ Аварийная остановка снята. Агенты возобновят работу.');
  console.log('[admin] emergency stop cleared via /resume');
}

async function handleHelp() {
  await sendAdmin(WELCOME_TEXT);
}

async function handleDeposit(ctx) {
  const parts = ctx.message?.text?.trim().split(/\s+/);
  // /deposit <agent> <amount>
  if (!parts || parts.length < 3) {
    const lines = [
      'Использование: <code>/deposit &lt;агент&gt; &lt;сумма&gt;</code>',
      '',
      'Доступные агенты:',
      ...Object.entries(AGENT_CAPITAL).map(
        ([name, cap]) => `  <b>${name}</b> — текущий депозит: <code>$${cap}</code>`
      ),
      `\n<b>Итого:</b> $${totalCapital()}`,
    ];
    await sendAdmin(lines.join('\n'));
    return;
  }

  const agentName = parts[1].toUpperCase();
  const amount    = parseFloat(parts[2]);

  if (!(agentName in AGENT_CAPITAL)) {
    await sendAdmin(
      `❌ Неизвестный агент: <code>${agentName}</code>\n` +
      `Доступные: ${Object.keys(AGENT_CAPITAL).join(', ')}`
    );
    return;
  }

  if (isNaN(amount) || amount <= 0) {
    await sendAdmin('❌ Сумма должна быть положительным числом.');
    return;
  }

  const prev = AGENT_CAPITAL[agentName];
  AGENT_CAPITAL[agentName] = amount;
  saveCapital();

  await sendAdmin(
    `✅ Депозит <b>${agentName}</b> изменён: <code>$${prev}</code> → <code>$${amount}</code>\n` +
    `Общий капитал: <code>$${totalCapital()}</code>`
  );
}

async function handleSet(ctx) {
  const parts = ctx.message?.text?.trim().split(/\s+/);
  if (!parts || parts.length < 3) {
    await sendAdmin(
      'Использование:\n' +
      '  <code>/set &lt;key&gt; &lt;value&gt;</code> — screener (pump, period, cooldown, interval)\n' +
      '  <code>/set s1 &lt;key&gt; &lt;value&gt;</code> — SCALPER1 (leverage, risk, tp, sl, maxTrades, margin)\n' +
      '  <code>/set s2 &lt;key&gt; &lt;value&gt;</code> — SCALPER2 (+trailingStop, margin)\n' +
      '  <code>/set s3 &lt;key&gt; &lt;value&gt;</code> — SCALPER3 (leverage, risk, minRR, sl, maxTrades, margin)\n' +
      '  <code>/set hunter margin isolated|crossed</code> — HUNTER margin mode'
    );
    return;
  }

  // /set mt <agent> <value>
  if (parts[1]?.toLowerCase() === 'mt') {
    if (parts.length < 4) {
      await sendAdmin('Использование: <code>/set mt &lt;hunter|s1|s2|s3&gt; &lt;значение&gt;</code>');
      return;
    }
    const agentName = parts[2].toLowerCase();
    const rawValue  = parts[3];
    const agentMap  = {
      hunter: hunterRef, s1: scalper1Ref, scalper1: scalper1Ref,
      s2: scalper2Ref, scalper2: scalper2Ref,
      s3: scalper3Ref, scalper3: scalper3Ref,
    };
    if (!(agentName in agentMap)) {
      await sendAdmin(`❌ Неизвестный агент: <code>${agentName}</code>. Доступные: hunter, s1, s2, s3`);
      return;
    }
    const ref = agentMap[agentName];
    if (!ref) {
      await sendAdmin(`⚠️ Агент <code>${agentName.toUpperCase()}</code> ещё не инициализирован.`);
      return;
    }
    const result = ref.applySetting('maxtrades', rawValue);
    if (!result.ok) {
      await sendAdmin(`❌ ${result.error}`);
      return;
    }
    await sendAdmin(`✅ <b>${agentName.toUpperCase()} Max Trades</b> → <code>${result.value}</code>`);
    return;
  }

  // /set s1|s2|s3|hunter key value
  const agentPrefix = parts[1]?.toLowerCase();
  const scalperMap  = { s1: scalper1Ref, s2: scalper2Ref, s3: scalper3Ref, hunter: hunterRef };

  if (scalperMap[agentPrefix] !== undefined) {
    if (parts.length < 4) {
      await sendAdmin(`❌ Использование: <code>/set ${agentPrefix} &lt;key&gt; &lt;value&gt;</code>`);
      return;
    }
    const ref = scalperMap[agentPrefix];
    if (!ref) {
      await sendAdmin(`⚠️ ${agentPrefix.toUpperCase()} ещё не инициализирован.`);
      return;
    }
    const [, , key, rawValue] = parts;
    const result = ref.applySetting(key, rawValue);
    if (!result.ok) {
      await sendAdmin(`❌ ${result.error}`);
      return;
    }
    await sendAdmin(`✅ <b>${agentPrefix.toUpperCase()} ${result.label}</b> → <code>${result.value}</code>`);
    return;
  }

  // Screener: /set pump 5
  if (!screenerRef) {
    await sendAdmin('⚠️ SCREENER ещё не инициализирован.');
    return;
  }
  const [, key, rawValue] = parts;
  const result = screenerRef.applySetting(key, rawValue);
  if (!result.ok) {
    await sendAdmin(`❌ ${result.error}`);
    return;
  }
  await sendAdmin(
    `✅ <b>${result.label}</b> → <code>${result.value}${result.unit}</code>\n` +
    `Снапшоты очищены, интервал перезапущен.`
  );
}

async function handleWebhook() {
  const log = webhook.getSignalLog();
  if (!log.length) {
    await sendAdmin('📭 Сигналов от TradingView ещё не было.');
    return;
  }

  const lines = [`📡 <b>TradingView — последние сигналы (${log.length})</b>\n`];
  for (const s of log) {
    const dir  = s.action === 'long' ? '🟢' : '🔴';
    const time = new Date(s.ts).toISOString().replace('T', ' ').slice(0, 19);
    const tp2  = s.tp2 ? ` TP2: <code>${s.tp2}</code>` : '';
    lines.push(
      `${dir} <b>${s.agent.toUpperCase()}</b> ${s.symbol}  <i>${time}</i>\n` +
      `  Entry: <code>${s.entry}</code> | SL: <code>${s.sl}</code> | TP: <code>${s.tp1}</code>${tp2}`
    );
  }

  await sendAdmin(lines.join('\n'));
}

async function handleHunter() {
  if (!hunterRef) {
    await sendAdmin('⚠️ HUNTER ещё не инициализирован.');
    return;
  }

  const status  = hunterRef.enabled
    ? (emergencyStop ? '🛑 ОСТАНОВЛЕН (emergency)' : '🟢 РАБОТАЕТ')
    : '⛔ ВЫКЛЮЧЕН';
  const openCnt = hunterRef.openTrades?.size ?? 0;
  const s       = agentStatus.HUNTER;

  const pendingCnt = hunterRef.pendingOrders?.size ?? 0;

  const lines = [
    `🎯 <b>HUNTER</b> — ${status}`,
    '',
    `<b>📊 Статистика:</b>`,
    `  Открытых позиций: <code>${openCnt}/${5}</code>`,
    `  Лимитных в ожидании: <code>${pendingCnt}</code>`,
    `  Сделок всего: <code>${s.trades ?? 0}</code>`,
    `  PnL: <code>${(s.pnl ?? 0) >= 0 ? '+' : ''}${(s.pnl ?? 0).toFixed(2)} USD</code>`,
  ];

  if (hunterRef.activeTrades?.size > 0) {
    lines.push('', '<b>Активные позиции:</b>');
    for (const [sym, t] of hunterRef.activeTrades) {
      const dir = t.direction === 'long' ? '🟢' : '🔴';
      lines.push(`  ${dir} <b>${sym}</b> — entry <code>${t.entry}</code>  SL <code>${t.sl}</code>${t.tp1Hit ? '  ✅ TP1' : ''}`);
    }
  }

  if (pendingCnt > 0) {
    lines.push('', '<b>🎯 Лимитные ордера (ожидание):</b>');
    for (const [sym, p] of hunterRef.pendingOrders) {
      const dir = p.trade.direction === 'long' ? '🟢' : '🔴';
      const age = Math.floor((Date.now() - p.placedAt) / 60_000);
      lines.push(`  ${dir} <b>${sym}</b> — лимит <code>${p.trade.entry}</code>  (${age} мин назад)`);
    }
  }

  await sendAdmin(lines.join('\n'));
}

// ─── Programmer delegation ────────────────────────────────────────────────────

// Keywords that signal a coding task that should go to PROGRAMMER
const CODE_SIGNALS = [
  'напиши', 'создай', 'сделай', 'реализуй', 'добавь', 'исправь', 'починь',
  'отрефактори', 'обнови', 'удали', 'переименуй', 'реализуй', 'напиши код',
  'создай файл', 'агент', 'функцию', 'модуль', 'скрипт', 'алгоритм',
  'write', 'create', 'implement', 'fix', 'refactor', 'add', 'build',
];

function looksLikeCodeTask(text) {
  const lower = text.toLowerCase();
  return CODE_SIGNALS.some((kw) => lower.includes(kw));
}

async function delegateToProgrammer(task) {
  await sendAdmin(`🤖 Делегирую задачу PROGRAMMER:\n<i>${task.slice(0, 200)}</i>`);

  const result = await programmer.execute(task, {
    onProgress: async (msg) => {
      // Throttle: only send meaningful status updates
      if (msg.startsWith('📝') || msg.startsWith('🔧')) {
        await sendAdmin(msg).catch(() => {});
      }
    },
  });

  if (result.error) {
    await sendAdmin(`❌ PROGRAMMER завершил с ошибкой:\n<code>${result.error}</code>`);
    return;
  }

  const filesList = result.filesChanged.length
    ? `\n\nФайлы:\n${result.filesChanged.map((f) => `  • <code>${f}</code>`).join('\n')}`
    : '';

  await sendAdmin(`✅ <b>PROGRAMMER</b> выполнил задачу:${filesList}\n\n${result.summary}`);
}

// ─── Natural language handler ─────────────────────────────────────────────────

async function handleMessage(ctx) {
  const msg = ctx.message;
  if (!msg?.text)               return;
  if (msg.text.startsWith('/')) return; // slash commands handled separately

  // Strict guard: owner only, admin topic only
  if (msg.from?.id !== OWNER_ID)                    return;
  if (String(msg.chat.id) !== String(process.env.TG_CHAT_ID)) return;
  if (msg.message_thread_id !== ADMIN_TOPIC_ID)     return;

  const text = msg.text;

  // First message after restart — show welcome
  if (!greeted) {
    greeted = true;
    await sendAdmin(WELCOME_TEXT).catch(() => {});
  }

  try {
    if (looksLikeCodeTask(text)) {
      await delegateToProgrammer(text);
    } else {
      const reply = await askClaude(text);
      await sendAdmin(reply);
    }
  } catch (err) {
    console.error('[admin] handleMessage error:', err.message);
    await sendAlert(`ADMIN ошибка: ${err.message}`);
  }
}

// ─── /code slash command (explicit delegation) ───────────────────────────────

async function handleMt(ctx) {
  const parts = ctx.message?.text?.trim().split(/\s+/);
  if (!parts || parts.length < 3) {
    await sendAdmin(
      'Использование: <code>/dep &lt;агент&gt; &lt;значение&gt;</code>\n' +
      'Агенты: <code>hunter</code>, <code>s1</code>, <code>s2</code>, <code>s3</code>'
    );
    return;
  }

  const agentName = parts[1].toLowerCase();
  const rawValue  = parts[2];

  const agentMap = {
    hunter:   hunterRef,
    s1:       scalper1Ref,
    scalper1: scalper1Ref,
    s2:       scalper2Ref,
    scalper2: scalper2Ref,
    s3:       scalper3Ref,
    scalper3: scalper3Ref,
  };

  if (!(agentName in agentMap)) {
    await sendAdmin(
      `❌ Неизвестный агент: <code>${agentName}</code>\n` +
      `Доступные: hunter, s1, s2, s3`
    );
    return;
  }

  const ref = agentMap[agentName];
  if (!ref) {
    await sendAdmin(`⚠️ Агент <code>${agentName.toUpperCase()}</code> ещё не инициализирован.`);
    return;
  }

  const result = ref.applySetting('maxTrades', rawValue);
  if (!result.ok) {
    await sendAdmin(`❌ ${result.error}`);
    return;
  }
  await sendAdmin(`✅ <b>${agentName.toUpperCase()} Max Trades</b> → <code>${result.value}</code>`);
}

async function handleCode(ctx) {
  const task = ctx.message?.text?.replace(/^\/code\s*/i, '').trim();
  if (!task) {
    await sendAdmin('Использование: <code>/code &lt;описание задачи&gt;</code>');
    return;
  }
  await delegateToProgrammer(task);
}

// ─── Risk check (called after every trade update) ────────────────────────────

async function checkRisk() {
  // Daily portfolio drawdown
  const dd = drawdownPct();
  if (dd > 3 && !emergencyStop) {
    emergencyStop = true;
    for (const key of Object.keys(agentStatus)) agentStatus[key].running = false;
    await sendAlert(
      `🛑 Дневная просадка ${dd.toFixed(2)}% превысила лимит 3%. Все агенты остановлены.`
    );
    saveAgentStatus();
    return;
  }

  // Per-agent drawdown
  for (const [name, s] of Object.entries(agentStatus)) {
    if (name === 'SCREENER') continue;
    const cap    = AGENT_CAPITAL[name];
    const agentDd = s.pnl < 0 ? Math.abs(s.pnl / cap) * 100 : 0;
    if (agentDd > 5 && s.running) {
      s.running = false;
      await sendAlert(
        `⛔ ${name} остановлен — просадка ${agentDd.toFixed(2)}% (лимит 5%)`
      );
    }
  }
  saveAgentStatus();
}

// ─── Interesting setup alert (called by SCREENER) ─────────────────────────────

async function notifySetup(signal) {
  if (emergencyStop) return;
  try {
    const prompt =
      `SCREENER нашёл сигнал: ${JSON.stringify(signal)}.\n` +
      `Оцени коротко (2-3 предложения): стоит ли на это обратить внимание? Почему?`;
    const comment = await askClaude(prompt);
    await sendAdmin(`🔍 <b>Интересный сетап</b>\n\n${comment}`);
  } catch (err) {
    console.error('[admin] notifySetup error:', err.message);
  }
}

// ─── Scheduled tasks ──────────────────────────────────────────────────────────

function scheduleJobs() {
  // Morning briefing — 9:00 every day
  cron.schedule('0 9 * * *', async () => {
    try {
      const text =
        'Сделай утренний брифинг: статус агентов, общий PnL, что интересного на рынке сегодня, план на день. ' +
        'Кратко, по делу, не более 5 пунктов.';
      const briefing = await askClaude(text);
      await sendAdmin(`🌅 <b>Утренний брифинг</b>\n\n${briefing}`);
    } catch (err) {
      await sendAlert(`Утренний брифинг не удался: ${err.message}`);
    }
  });

  // Weekly review — Monday 10:00
  cron.schedule('0 10 * * 1', async () => {
    try {
      const text =
        'Предложи еженедельный обзор: что работало, что нет, какие настройки агентов стоит пересмотреть, ' +
        'интересные паттерны за неделю.';
      const review = await askClaude(text);
      await sendAdmin(`📈 <b>Еженедельный обзор</b>\n\n${review}`);
    } catch (err) {
      await sendAlert(`Еженедельный обзор не удался: ${err.message}`);
    }
  });
}

// ─── Init ─────────────────────────────────────────────────────────────────────

function init() {
  // Restore persisted trades/pnl from last session
  loadAgentStatus();
  // Auto-save every 60s so we don't lose data on unclean exit
  setInterval(saveAgentStatus, 60_000);

  registerCommand('status',  handleStatus);
  registerCommand('report',  handleReport);
  registerCommand('stop',    handleStop);
  registerCommand('balance', handleBalance);
  registerCommand('code',    handleCode);
  registerCommand('resume',  handleResume);
  registerCommand('help',    handleHelp);
  registerCommand('start',   handleHelp);
  registerCommand('set',     handleSet);
  registerCommand('deposit', handleDeposit);
  registerCommand('archive', handleArchive);
  registerCommand('hunter',  handleHunter);
  registerCommand('webhook', handleWebhook);
  registerCommand('restart', handleRestart);

  // Natural language — Telegraf fires all registered `on('message')` handlers
  bot.on('message', handleMessage);

  scheduleJobs();

  console.log('[admin] initialized — OWNER_ID:', OWNER_ID);
}

function setScreenerRef(ref)  { screenerRef  = ref; }
function setHunterRef(ref)   { hunterRef    = ref; }
function setScalper1Ref(ref) { scalper1Ref  = ref; }
function setScalper2Ref(ref) { scalper2Ref  = ref; }
function setScalper3Ref(ref) { scalper3Ref  = ref; }

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  init,
  agentStatus,
  saveAgentStatus,
  notifySetup,
  checkRisk,
  applyAgentEnabled,
  setScreenerRef,
  setHunterRef,
  setScalper1Ref,
  setScalper2Ref,
  setScalper3Ref,
  get emergencyStop() { return emergencyStop; },
  get globalPaused()  { return globalPaused; },
  set globalPaused(v) { globalPaused = !!v; },
};
