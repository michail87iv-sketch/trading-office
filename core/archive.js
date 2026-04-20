'use strict';

const fs   = require('fs');
const path = require('path');

const ARCHIVE_DIR  = path.join(__dirname, '../data');
const ARCHIVE_FILE = path.join(ARCHIVE_DIR, 'trades.csv');
const SETTINGS_HISTORY_FILE = path.join(ARCHIVE_DIR, 'settings_history.csv');

const CSV_HEADER = 'timestamp,date,time,agent,action,symbol,direction,size,entry,sl,tp,pnl,exit_price\n';
const SETTINGS_HISTORY_HEADER = 'timestamp,date,time,agent,key,old_value,new_value\n';

// ─── Init ─────────────────────────────────────────────────────────────────────

function ensureFile() {
  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  if (!fs.existsSync(ARCHIVE_FILE)) {
    fs.writeFileSync(ARCHIVE_FILE, CSV_HEADER);
  }
}

// ─── Write one trade row ──────────────────────────────────────────────────────

function logTrade(payload) {
  try {
    ensureFile();

    const now = new Date();
    const ts  = now.toISOString();
    const date = ts.slice(0, 10);
    const time = ts.slice(11, 19);

    const row = [
      ts,
      date,
      time,
      payload.agent      ?? '',
      payload.action     ?? '',
      payload.symbol     ?? '',
      payload.direction  ?? '',
      payload.size       != null ? payload.size  : '',
      payload.entry      != null ? payload.entry : '',
      payload.sl         != null ? payload.sl        : '',
      payload.tp         != null ? payload.tp        : '',
      payload.pnl        != null ? payload.pnl        : '',
      payload.exitPrice  != null ? payload.exitPrice  : '',
    ].map(escapeCSV).join(',');

    fs.appendFileSync(ARCHIVE_FILE, row + '\n');
  } catch (err) {
    console.error('[archive] failed to log trade:', err.message);
  }
}

// ─── Log a settings change ────────────────────────────────────────────────────

function logSettingChange(agent, key, oldValue, newValue) {
  try {
    if (!fs.existsSync(SETTINGS_HISTORY_FILE)) {
      fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
      fs.writeFileSync(SETTINGS_HISTORY_FILE, SETTINGS_HISTORY_HEADER);
    }
    const now  = new Date();
    const ts   = now.toISOString();
    const row  = [ts, ts.slice(0, 10), ts.slice(11, 19), agent, key, oldValue ?? '', newValue ?? ''].map(escapeCSV).join(',');
    fs.appendFileSync(SETTINGS_HISTORY_FILE, row + '\n');
  } catch (err) {
    console.error('[archive] failed to log setting change:', err.message);
  }
}

function escapeCSV(val) {
  const str = String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

// ─── Build per-agent summary CSV (for download) ───────────────────────────────

function buildSummaryCSV() {
  ensureFile();

  const raw = fs.readFileSync(ARCHIVE_FILE, 'utf8').trim().split('\n');
  if (raw.length <= 1) return null; // header only, no trades

  const header = raw[0].split(',');
  const idxAgent  = header.indexOf('agent');
  const idxAction = header.indexOf('action');
  const idxPnl    = header.indexOf('pnl');

  // Group rows by agent, keep only closed trades (action = close)
  const byAgent = {};
  for (let i = 1; i < raw.length; i++) {
    const cols = parseCSVLine(raw[i]);
    if (!cols || cols.length < header.length) continue;
    const agent  = cols[idxAgent];
    const action = cols[idxAction];
    if (!agent) continue;
    if (!byAgent[agent]) byAgent[agent] = [];
    byAgent[agent].push({ cols, action });
  }

  // Build output: one section per agent
  const sections = [];
  for (const [agent, rows] of Object.entries(byAgent).sort()) {
    sections.push(`# ${agent}`);
    sections.push(raw[0]); // header row

    for (const { cols } of rows) {
      sections.push(cols.join(','));
    }

    // Summary line
    const closed = rows.filter((r) => r.action === 'close');
    const pnls   = closed.map((r) => parseFloat(r.cols[idxPnl])).filter((v) => !isNaN(v));
    const total  = pnls.reduce((s, v) => s + v, 0);
    const wins   = pnls.filter((v) => v > 0).length;
    sections.push(
      `# ${agent} summary — ${closed.length} closed trades | ` +
      `wins: ${wins} | losses: ${closed.length - wins} | ` +
      `total PnL: ${total >= 0 ? '+' : ''}${total.toFixed(2)} USD`
    );
    sections.push('');
  }

  return sections.join('\n');
}

// Minimal CSV line parser (handles quoted fields)
function parseCSVLine(line) {
  const result = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQ = false;
      else cur += ch;
    } else {
      if (ch === '"') inQ = true;
      else if (ch === ',') { result.push(cur); cur = ''; }
      else cur += ch;
    }
  }
  result.push(cur);
  return result;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = { logTrade, logSettingChange, buildSummaryCSV, ARCHIVE_FILE, SETTINGS_HISTORY_FILE };
