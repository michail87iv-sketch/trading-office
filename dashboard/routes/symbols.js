'use strict';

const fs      = require('fs');
const path    = require('path');
const express = require('express');

const SETTINGS_FILE = path.join(__dirname, '../../.claude/memory/scalper_settings.json');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

let _scalper1 = null;
function setRef(s1) { _scalper1 = s1; }

const router = express.Router();

// GET /api/scalper1/symbols → { ok, global, symbols }
router.get('/scalper1/symbols', (req, res) => {
  const s1 = readJson(SETTINGS_FILE).s1 ?? {};
  const { symbols, ...global } = s1;
  res.json({ ok: true, global, symbols: symbols ?? {} });
});

// POST /api/scalper1/symbols/:symbol → upsert override
router.post('/scalper1/symbols/:symbol', (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const body   = req.body ?? {};
  try {
    // Strip NaN / null / undefined coming from client form parsing
    const clean = Object.fromEntries(
      Object.entries(body).filter(([, v]) => v !== null && v !== undefined && !(typeof v === 'number' && !isFinite(v)))
    );
    const all = readJson(SETTINGS_FILE);
    if (!all.s1) all.s1 = {};
    if (!all.s1.symbols) all.s1.symbols = {};
    all.s1.symbols[symbol] = { ...(all.s1.symbols[symbol] ?? {}), ...clean };
    writeJson(SETTINGS_FILE, all);
    _scalper1?.reloadSymbols?.();
    res.json({ ok: true, symbol, override: all.s1.symbols[symbol] });
  } catch (err) {
    console.error('[symbols route] POST', symbol, err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// DELETE /api/scalper1/symbols/:symbol → remove override
router.delete('/scalper1/symbols/:symbol', (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  try {
    const all = readJson(SETTINGS_FILE);
    if (all.s1?.symbols?.[symbol]) {
      delete all.s1.symbols[symbol];
      writeJson(SETTINGS_FILE, all);
      _scalper1?.reloadSymbols?.();
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = { router, setRef };
