'use strict';

const fs      = require('fs');
const path    = require('path');
const express = require('express');

const { runBacktest, runGridSearch } = require('../../core/backtest/runner');

const RESULTS_DIR = path.resolve(__dirname, '../../data/backtest-results');
const SAVES_FILE  = path.resolve(__dirname, '../../data/backtest-saves.json');

function readSaves() {
  try { return JSON.parse(fs.readFileSync(SAVES_FILE, 'utf8')); } catch { return []; }
}
function writeSaves(arr) {
  fs.mkdirSync(path.dirname(SAVES_FILE), { recursive: true });
  fs.writeFileSync(SAVES_FILE, JSON.stringify(arr, null, 2));
}

const router = express.Router();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resultPath(filename) {
  return path.join(RESULTS_DIR, filename);
}

function readResult(filename) {
  try {
    return JSON.parse(fs.readFileSync(resultPath(filename), 'utf8'));
  } catch {
    return null;
  }
}

function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/** Validate required string fields; returns an error message or null. */
function validateBase(body) {
  const { symbol, timeframe, startDate, endDate } = body;
  if (!symbol)    return 'symbol is required';
  if (!timeframe) return 'timeframe is required';
  if (!startDate) return 'startDate is required';
  if (!endDate)   return 'endDate is required';
  if (new Date(startDate) >= new Date(endDate))
    return 'endDate must be after startDate';
  return null;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// POST /api/backtest/run
// Body: { symbol, timeframe, startDate, endDate, params?, initialCapital? }
// Returns immediately with { ok, id, status:'running' }; result saved to disk async.
router.post('/backtest/run', (req, res) => {
  const err = validateBase(req.body);
  if (err) return res.status(400).json({ ok: false, error: err });

  const { symbol, timeframe, startDate, endDate,
          params = {}, initialCapital = 5 } = req.body;

  // Pre-generate the id so the caller has it before the async work finishes.
  const id       = makeId();
  const filename = `${id}.json`;

  // Write a placeholder immediately so GET /api/backtest/:id returns 'running'
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  fs.writeFileSync(
    resultPath(filename),
    JSON.stringify({ id, status: 'running' })
  );

  // Run in background — do not await
  runBacktest({ symbol, timeframe, startDate, endDate, params, initialCapital })
    .then((result) => {
      // runner already saves to its own id; overwrite our placeholder with the real result
      fs.writeFileSync(resultPath(filename), JSON.stringify({ ...result, id }));
    })
    .catch((err) => {
      fs.writeFileSync(
        resultPath(filename),
        JSON.stringify({ id, status: 'error', error: err.message })
      );
      console.error('[backtest route] run error:', err.message);
    });

  res.json({ ok: true, id, status: 'running' });
});

// GET /api/backtest/saves  ← must be before /backtest/:id
router.get('/backtest/saves', (req, res) => {
  res.json({ ok: true, saves: readSaves() });
});

// DELETE /api/backtest/saves/:id
router.delete('/backtest/saves/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ ok: false, error: 'Invalid id' });
  const saves = readSaves();
  const next  = saves.filter(s => s.id !== id);
  if (next.length === saves.length) return res.status(404).json({ ok: false, error: 'Not found' });
  writeSaves(next);
  res.json({ ok: true });
});

// GET /api/backtest/:id
// Returns the saved result or { status:'running' } if still in progress.
router.get('/backtest/:id', (req, res) => {
  // Sanitise: only allow alphanumeric ids to prevent path traversal
  const id = req.params.id.replace(/[^a-z0-9]/gi, '');
  const data = readResult(`${id}.json`);
  if (!data) return res.status(404).json({ ok: false, error: 'Not found' });
  res.json({ ok: true, ...data });
});

// POST /api/backtest/grid
// Body: { symbol, timeframe, startDate, endDate, paramRanges, initialCapital? }
// Returns immediately with { ok, id, status:'running' }
router.post('/backtest/grid', (req, res) => {
  const err = validateBase(req.body);
  if (err) return res.status(400).json({ ok: false, error: err });

  if (!req.body.paramRanges || typeof req.body.paramRanges !== 'object')
    return res.status(400).json({ ok: false, error: 'paramRanges is required' });

  const { symbol, timeframe, startDate, endDate,
          paramRanges, initialCapital = 5 } = req.body;

  const id       = makeId();
  const filename = `grid_${id}.json`;

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  fs.writeFileSync(
    resultPath(filename),
    JSON.stringify({ id, status: 'running' })
  );

  runGridSearch({ symbol, timeframe, startDate, endDate, paramRanges, initialCapital })
    .then((result) => {
      fs.writeFileSync(resultPath(filename), JSON.stringify({ ...result, id }));
    })
    .catch((err) => {
      fs.writeFileSync(
        resultPath(filename),
        JSON.stringify({ id, status: 'error', error: err.message })
      );
      console.error('[backtest route] grid error:', err.message);
    });

  res.json({ ok: true, id, status: 'running' });
});

// GET /api/backtest/grid/:id
// Returns the saved grid result or { status:'running' }.
router.get('/backtest/grid/:id', (req, res) => {
  const id = req.params.id.replace(/[^a-z0-9]/gi, '');
  const data = readResult(`grid_${id}.json`);
  if (!data) return res.status(404).json({ ok: false, error: 'Not found' });
  res.json({ ok: true, ...data });
});

// POST /api/backtest/saves
// Body: { name, mode, params, results, symbol, timeframe, period }
router.post('/backtest/saves', (req, res) => {
  const { name, mode, params, results, symbol, timeframe, period } = req.body || {};
  const n = (name || '').trim();
  if (!n)          return res.status(400).json({ ok: false, error: 'Name is required' });
  if (n.length > 60) return res.status(400).json({ ok: false, error: 'Name must be ≤ 60 characters' });

  const entry = {
    id:         Date.now(),
    name:       n,
    mode:       mode    || 'manual',
    params:     params  || {},
    results:    {
      totalPnl:    results?.totalPnl    ?? null,
      winRate:     results?.winRate     ?? null,
      totalTrades: results?.totalTrades ?? null,
      maxDrawdown: results?.maxDrawdown ?? null,
      sharpeRatio: results?.sharpeRatio ?? null,
    },
    symbol:     symbol    || '',
    timeframe:  timeframe || '',
    period:     period    || {},
    savedAt:    new Date().toISOString(),
  };

  const saves = readSaves();
  saves.push(entry);
  writeSaves(saves);
  res.json({ ok: true, entry });
});

module.exports = { router };
