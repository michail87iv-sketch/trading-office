'use strict';

const { Telegraf } = require('telegraf');
require('dotenv').config();

const { logTrade } = require('./archive');

// ─── Config ───────────────────────────────────────────────────────────────────

const BOT_TOKEN = process.env.TG_BOT_TOKEN || process.env.TELEGRAM_TOKEN;
const CHAT_ID   = process.env.TG_CHAT_ID;   // supergroup id, negative number

const TOPICS = {
  signals:  Number(process.env.TG_TOPIC_SIGNALS),
  trades:   Number(process.env.TG_TOPIC_TRADES),
  reports:  Number(process.env.TG_TOPIC_REPORTS),
  alerts:   Number(process.env.TG_TOPIC_ALERTS),
  admin:    Number(process.env.TG_TOPIC_ADMIN),
  pumpDump: Number(process.env.TG_TOPIC_PUMPDUMP_ID),
};

if (!BOT_TOKEN) throw new Error('TG_BOT_TOKEN is not set');
if (!CHAT_ID)   throw new Error('TG_CHAT_ID is not set');

// ─── Bot instance ─────────────────────────────────────────────────────────────

const bot = new Telegraf(BOT_TOKEN);

// ─── Command handlers registry ────────────────────────────────────────────────
// Populated by admin.js via registerCommand()

const commandHandlers = {};

/**
 * Register a handler for an admin command.
 * @param {string} cmd - e.g. 'status'
 * @param {(ctx) => Promise<void>} handler
 */
function registerCommand(cmd, handler) {
  commandHandlers[cmd] = handler;
}

// ─── Middleware: restrict commands to #admin topic ────────────────────────────

bot.use(async (ctx, next) => {
  if (!ctx.message) return next();

  const isCommand = ctx.message.text?.startsWith('/');
  if (!isCommand) return next();

  const inAdminTopic =
    String(ctx.message.chat.id) === String(CHAT_ID) &&
    ctx.message.message_thread_id === TOPICS.admin;

  if (!inAdminTopic) return; // silently ignore commands outside #admin
  return next();
});

// ─── Route commands to registered handlers ────────────────────────────────────

bot.on('message', async (ctx, next) => {
  const text = ctx.message?.text;
  if (!text?.startsWith('/')) return next(); // pass non-commands to admin.js handler

  const cmd = text.slice(1).split(/[\s@]/)[0].toLowerCase();
  const handler = commandHandlers[cmd];

  if (handler) {
    try {
      await handler(ctx);
    } catch (err) {
      await sendAlert(`Command /${cmd} failed: ${err.message}`);
    }
  } else {
    await sendAdmin(`Unknown command: /${cmd}`);
  }
});

// ─── Send helpers ─────────────────────────────────────────────────────────────

/**
 * Low-level send to a specific topic.
 * @param {number} threadId
 * @param {string} text
 */
async function sendToTopic(threadId, text) {
  await bot.telegram.sendMessage(CHAT_ID, text, {
    message_thread_id: threadId,
    parse_mode: 'HTML',
  });
}

async function sendSignal(payload) {
  const msg = formatSignal(payload);
  await sendToTopic(TOPICS.signals, msg);
}

async function sendTrade(payload) {
  logTrade(payload);
  const msg = formatTrade(payload);
  await sendToTopic(TOPICS.trades, msg);
}

async function sendReport(payload) {
  const msg = formatReport(payload);
  await sendToTopic(TOPICS.reports, msg);
}

async function sendAlert(text) {
  await sendToTopic(TOPICS.alerts, `⚠️ ${text}`);
}

async function sendAdmin(text) {
  await sendToTopic(TOPICS.admin, text);
}

// ─── Formatters ───────────────────────────────────────────────────────────────

function formatSignal(s) {
  const dir    = s.direction === 'long' ? '🟢 LONG' : '🔴 SHORT';
  const agent  = s.to ? ` → <b>${s.to}</b>` : '';
  const header = s.limitQueued
    ? `🎯 <b>LIMIT QUEUED</b>${agent}`
    : `📡 <b>SIGNAL</b>${agent}`;
  const entryLabel = s.limitQueued ? 'Limit @' : 'Entry:';
  return (
    `${header}\n` +
    `${dir} <b>${s.symbol}</b> [${s.tf}]\n` +
    `${entryLabel} <code>${s.entry}</code>\n` +
    `SL: <code>${s.sl}</code>  TP: <code>${s.tp}</code>\n` +
    `RR: <code>1:${s.rr}</code>  Conf: <code>${s.confidence}</code>\n` +
    `Setup: ${s.setup}`
  );
}

function formatTrade(t) {
  const dir    = t.direction === 'long' ? '🟢' : '🔴';
  const pnlStr = t.pnl != null
    ? `${t.pnl >= 0 ? '+' : ''}$${Math.abs(t.pnl).toFixed(2)}`
    : null;

  // Closed position format (SL/TP fired on exchange or detected by monitor)
  if (t.action === 'close' && t.exitPrice != null && t.reason) {
    const dirLabel     = t.direction === 'long' ? 'Long' : 'Short';
    const reasonEmoji  = t.reason === 'TP hit' ? '🎯' : '💥';
    return (
      `✅ ЗАКРЫТО: <b>${t.symbol}</b> ${dirLabel} [${t.agent}]\n` +
      `Вход: <code>${t.entry}</code> | Выход: <code>${t.exitPrice}</code>\n` +
      `PnL: <code>${pnlStr ?? 'n/a'}</code> | ${t.reason} ${reasonEmoji}`
    );
  }

  const action = t.action === 'filled' ? '✅ FILLED'
               : t.action === 'open'   ? '📂 OPEN'
               :                         '📁 CLOSE';
  const pnl    = pnlStr ? `\nPnL: <code>${pnlStr}</code>` : '';
  return (
    `${action} ${dir} <b>${t.symbol}</b> [${t.agent}]\n` +
    `Entry: <code>${t.entry}</code>  Size: <code>${t.size}</code>\n` +
    `SL: <code>${t.sl}</code>  TP: <code>${t.tp}</code>${pnl}`
  );
}

function formatReport(r) {
  const rows = r.agents
    .map((a) => {
      const sign = a.pnl >= 0 ? '+' : '';
      return `  <b>${a.name}</b>: ${sign}${a.pnl.toFixed(2)} USD (${a.trades} trades)`;
    })
    .join('\n');
  const totalSign = r.total >= 0 ? '+' : '';
  return (
    `📊 <b>Daily Report</b> — ${r.date}\n\n` +
    `${rows}\n\n` +
    `Total: <b>${totalSign}${r.total.toFixed(2)} USD</b>\n` +
    `Drawdown: <code>${r.drawdown.toFixed(2)}%</code>`
  );
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

async function launch() {
  function startPolling() {
    bot.launch().catch((err) => {
      console.error('[telegram] bot crashed:', err.message, '— restarting in 5s');
      setTimeout(startPolling, 5_000);
    });
  }
  startPolling();
  // Give Telegraf time to establish the polling connection
  await new Promise((resolve) => setTimeout(resolve, 1500));
  console.log('[telegram] bot launched');
}

function stop(signal) {
  bot.stop(signal);
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  bot,
  launch,
  stop,
  registerCommand,
  sendToTopic,
  sendSignal,
  sendTrade,
  sendReport,
  sendAlert,
  sendAdmin,
  TOPICS,
};
