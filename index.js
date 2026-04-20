'use strict';

require('dotenv').config();

const { launch, stop, sendAdmin } = require('./core/telegram');
const admin     = require('./agents/admin');
const hunter    = require('./agents/hunter');
const screener  = require('./agents/screener');
const scalper1  = require('./agents/scalper1');
const scalper2  = require('./agents/scalper2');
const scalper3  = require('./agents/scalper3');
const webhook   = require('./core/webhook');
const bitget      = require('./core/bitget');
const dashboard   = require('./dashboard/server');
const researcher  = require('./agents/researcher');

// ─── Startup ──────────────────────────────────────────────────────────────────

async function start() {
  // 1. Register all command handlers before launching the bot
  admin.init();

  // 2. Start HUNTER
  hunter.init(admin);
  admin.setHunterRef(hunter);

  // 3. Start SCREENER
  screener.start(admin);
  admin.setScreenerRef(screener);

  // 4. Start SCALPERS
  scalper1.init(admin);
  admin.setScalper1Ref(scalper1);

  scalper2.init(admin);
  admin.setScalper2Ref(scalper2);

  scalper3.init(admin);
  admin.setScalper3Ref(scalper3);

  // 5. Restore enabled/disabled state for all agents from last session
  admin.applyAgentEnabled();

  // 6. Start webhook server (TradingView signal receiver — scalpers only)
  webhook.start(admin, {
    scalper1,
    scalper2,
    scalper3,
  });

  // 7. Init researcher
  researcher.init(admin);

  // 8. Start dashboard
  dashboard.start({ admin, hunter, scalper1, scalper2, scalper3, screener, bitget, webhook, researcher });

  // 9. Start Telegram bot (begins polling)
  await launch();

  // 8. Announce startup
  const webhookPort = process.env.WEBHOOK_PORT || 3001;
  await sendAdmin(
    `🚀 Trading Office запущен!\n` +
    `Hunter + Screener + Scalper1/2/3 онлайн.\n` +
    `📡 Webhook: порт ${webhookPort} (POST /webhook)`
  );

  console.log('[index] Trading Office is running. Press Ctrl+C to stop.');
}

// ─── Graceful shutdown ────────────────────────────────────────────────────────

function shutdown(signal) {
  console.log(`\n[index] Received ${signal}, shutting down…`);
  webhook.stop();
  stop(signal);
  process.exit(0);
}

process.once('SIGINT',  () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

// ─── Run ──────────────────────────────────────────────────────────────────────

start().catch((err) => {
  console.error('[index] Fatal startup error:', err.message);
  process.exit(1);
});
