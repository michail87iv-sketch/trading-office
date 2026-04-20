'use strict';

const http = require('http');
const { sendToTopic, TOPICS } = require('./telegram');

// ─── Config ───────────────────────────────────────────────────────────────────

const PORT   = Number(process.env.WEBHOOK_PORT) || 3001;
const SECRET = process.env.WEBHOOK_SECRET;

// ─── Signal log (last 10) ─────────────────────────────────────────────────────

const signalLog = [];
const MAX_LOG   = 10;

function logSignal(entry) {
  signalLog.unshift(entry);
  if (signalLog.length > MAX_LOG) signalLog.pop();
}

// ─── Agent registry ───────────────────────────────────────────────────────────

const agentRefs = {};

function registerAgent(name, ref) {
  agentRefs[name.toLowerCase()] = ref;
}

// ─── Telegram notification ────────────────────────────────────────────────────

async function notifySignal(signal, agentName) {
  const dir = signal.action === 'long' ? '🟢 LONG' : '🔴 SHORT';
  const tp  = signal.tp1 ?? signal.tp ?? '—';
  const msg =
    `📡 <b>TV СИГНАЛ: ${agentName.toUpperCase()}</b>\n` +
    `${dir} <b>${signal.symbol}</b>\n` +
    `Entry: <code>${signal.entry}</code> | SL: <code>${signal.sl}</code> | TP: <code>${tp}</code>`;
  await sendToTopic(TOPICS.signals, msg);
}

// ─── Body parser ──────────────────────────────────────────────────────────────

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data',  (chunk) => { body += chunk; });
    req.on('end',   ()      => {
      try   { resolve(JSON.parse(body)); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

// ─── Webhook handler ──────────────────────────────────────────────────────────

async function handleRequest(req, res, adminRef) {
  if (req.method !== 'POST') {
    res.writeHead(405).end('Method Not Allowed');
    return;
  }

  // Validate secret token
  if (SECRET) {
    const token =
      req.headers['x-webhook-secret'] ??
      req.headers['authorization']?.replace('Bearer ', '');
    if (token !== SECRET) {
      console.warn('[webhook] rejected — invalid secret');
      res.writeHead(401).end('Unauthorized');
      return;
    }
  }

  let signal;
  try {
    signal = await parseBody(req);
  } catch (err) {
    res.writeHead(400).end('Bad Request: ' + err.message);
    return;
  }

  // Validate required fields
  const { agent, symbol, action, entry, sl, tp1 } = signal;
  if (!agent || !symbol || !action || entry == null || sl == null || tp1 == null) {
    res.writeHead(422).end(
      'Missing required fields: agent, symbol, action, entry, sl, tp1'
    );
    return;
  }

  // Normalize to internal signal format
  // - hunter destructures `tp: tp1` so we alias tp → tp1
  // - scalpers use `tp` directly
  const normalized = {
    ...signal,
    direction: action,   // 'long' | 'short'
    tp:        tp1,      // used by scalpers and hunter
  };

  // Log signal before doing anything else
  logSignal({
    ts:     Date.now(),
    agent,
    symbol,
    action,
    entry,
    sl,
    tp1,
    tp2:    signal.tp2,
    tf:     signal.tf,
    setup:  signal.setup,
  });

  // Respond immediately so TradingView doesn't time out
  res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true }));

  // Notify #signals topic
  await notifySignal(signal, agent).catch((err) =>
    console.error('[webhook] notify failed:', err.message)
  );

  // Honour emergency stop
  if (adminRef?.emergencyStop) {
    console.warn('[webhook] signal ignored — emergency stop active');
    return;
  }

  // Route to registered agent
  const agentRef = agentRefs[agent.toLowerCase()];
  if (!agentRef) {
    console.warn(`[webhook] no agent registered for "${agent}" — logged but not executed`);
    return;
  }

  try {
    await agentRef.executeTrade(normalized);
    console.log(`[webhook] → ${agent.toUpperCase()} ${action.toUpperCase()} ${symbol} @ ${entry}`);
  } catch (err) {
    console.error(`[webhook] executeTrade(${agent}) failed:`, err.message);
  }
}

// ─── HTTP server ──────────────────────────────────────────────────────────────

let server;

/**
 * Start the webhook HTTP server.
 * @param {object} adminRef  - admin module (checked for emergencyStop)
 * @param {object} agents    - map of agentName → agent module { executeTrade() }
 *                             Example: { hunter, scalper1, scalper2, scalper3 }
 */
function start(adminRef, agents = {}) {
  for (const [name, ref] of Object.entries(agents)) {
    registerAgent(name, ref);
  }

  server = http.createServer((req, res) => {
    if (req.url === '/webhook') {
      handleRequest(req, res, adminRef).catch((err) => {
        console.error('[webhook] unhandled error:', err.message);
        if (!res.writableEnded) res.writeHead(500).end('Internal Server Error');
      });
    } else {
      res.writeHead(404).end('Not Found');
    }
  });

  server.listen(PORT, () => {
    console.log(`[webhook] listening on port ${PORT}`);
  });

  server.on('error', (err) => {
    console.error('[webhook] server error:', err.message);
  });
}

function stop() {
  server?.close();
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  start,
  stop,
  registerAgent,
  getSignalLog: () => [...signalLog],
};
