'use strict';

const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const express = require('express');

// ─── File paths ────────────────────────────────────────────────────────────────

const SETTINGS_FILE  = path.join(__dirname, '../../.claude/memory/scalper_settings.json');
const CONFIG_FILE    = path.join(__dirname, '../../data/config.json');
const FAVORITES_FILE = path.join(__dirname, '../../data/favorites.json');

const VALID_AGENTS = ['s1', 's2', 's3', 'hunter'];
const MAX_PER_AGENT = 20;

// ─── Agent refs (injected from server.js) ─────────────────────────────────────

let _scalper1, _scalper2, _scalper3, _hunter;

function setRefs(refs) {
  _scalper1 = refs.scalper1 ?? null;
  _scalper2 = refs.scalper2 ?? null;
  _scalper3 = refs.scalper3 ?? null;
  _hunter   = refs.hunter   ?? null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function readFavorites() {
  try {
    const data = JSON.parse(fs.readFileSync(FAVORITES_FILE, 'utf8'));
    // ensure all keys exist
    for (const agent of VALID_AGENTS) {
      if (!Array.isArray(data[agent])) data[agent] = [];
    }
    return data;
  } catch {
    return { s1: [], s2: [], s3: [], hunter: [] };
  }
}

function writeFavorites(data) {
  fs.mkdirSync(path.dirname(FAVORITES_FILE), { recursive: true });
  fs.writeFileSync(FAVORITES_FILE, JSON.stringify(data, null, 2));
}

function uuid() {
  return crypto.randomUUID();
}

/** Read current live settings for a given agent key. */
function getCurrentSettings(agent) {
  if (agent === 'hunter') {
    const base   = readJson(SETTINGS_FILE).hunter ?? {};
    const config = readJson(CONFIG_FILE).hunter ?? {};
    return { ...base, ...config };
  }
  return readJson(SETTINGS_FILE)[agent] ?? {};
}

/** Write settings to disk and apply to running agent in-memory. */
function applySettings(agent, settings) {
  if (agent === 'hunter') {
    const config  = readJson(CONFIG_FILE);
    config.hunter = { ...(config.hunter ?? {}), ...settings };
    writeJson(CONFIG_FILE, config);
    if (_hunter?.applySetting) {
      for (const [k, v] of Object.entries(settings))
        _hunter.applySetting(k, String(v));
    }
  } else {
    const all = readJson(SETTINGS_FILE);
    all[agent] = { ...(all[agent] ?? {}), ...settings };
    writeJson(SETTINGS_FILE, all);
    const ref = { s1: _scalper1, s2: _scalper2, s3: _scalper3 }[agent];
    if (ref?.applySetting) {
      for (const [k, v] of Object.entries(settings))
        ref.applySetting(k, String(v));
    }
  }
}

function validateName(name) {
  const s = (name ?? '').trim();
  if (!s)         return 'Name is required';
  if (s.length > 40) return 'Name must be ≤ 40 characters';
  return null;
}

// ─── Router ───────────────────────────────────────────────────────────────────

const router = express.Router();

// GET /api/favorites — all agents
router.get('/favorites', (req, res) => {
  res.json({ ok: true, favorites: readFavorites() });
});

// GET /api/favorites/:agent
router.get('/favorites/:agent', (req, res) => {
  const agent = req.params.agent.toLowerCase();
  if (!VALID_AGENTS.includes(agent))
    return res.status(400).json({ ok: false, error: 'Invalid agent' });
  const favs = readFavorites();
  res.json({ ok: true, favorites: favs[agent] });
});

// POST /api/favorites/:agent — save current settings as new favorite
router.post('/favorites/:agent', (req, res) => {
  const agent = req.params.agent.toLowerCase();
  if (!VALID_AGENTS.includes(agent))
    return res.status(400).json({ ok: false, error: 'Invalid agent' });

  const nameErr = validateName(req.body?.name);
  if (nameErr) return res.status(400).json({ ok: false, error: nameErr });

  const favs = readFavorites();
  if (favs[agent].length >= MAX_PER_AGENT)
    return res.status(400).json({ ok: false, error: `Max ${MAX_PER_AGENT} favorites per agent` });

  const entry = {
    id:        uuid(),
    name:      req.body.name.trim(),
    createdAt: new Date().toISOString(),
    settings:  getCurrentSettings(agent),
  };
  favs[agent].push(entry);
  writeFavorites(favs);
  res.json({ ok: true, favorite: entry });
});

// PUT /api/favorites/:agent/:id — rename
router.put('/favorites/:agent/:id', (req, res) => {
  const agent = req.params.agent.toLowerCase();
  if (!VALID_AGENTS.includes(agent))
    return res.status(400).json({ ok: false, error: 'Invalid agent' });

  const nameErr = validateName(req.body?.name);
  if (nameErr) return res.status(400).json({ ok: false, error: nameErr });

  const favs = readFavorites();
  const item = favs[agent].find(f => f.id === req.params.id);
  if (!item) return res.status(404).json({ ok: false, error: 'Not found' });

  item.name = req.body.name.trim();
  writeFavorites(favs);
  res.json({ ok: true });
});

// DELETE /api/favorites/:agent/:id
router.delete('/favorites/:agent/:id', (req, res) => {
  const agent = req.params.agent.toLowerCase();
  if (!VALID_AGENTS.includes(agent))
    return res.status(400).json({ ok: false, error: 'Invalid agent' });

  const favs = readFavorites();
  const before = favs[agent].length;
  favs[agent] = favs[agent].filter(f => f.id !== req.params.id);
  if (favs[agent].length === before)
    return res.status(404).json({ ok: false, error: 'Not found' });

  writeFavorites(favs);
  res.json({ ok: true });
});

// POST /api/favorites/:agent/:id/load — apply saved settings to agent
router.post('/favorites/:agent/:id/load', (req, res) => {
  const agent = req.params.agent.toLowerCase();
  if (!VALID_AGENTS.includes(agent))
    return res.status(400).json({ ok: false, error: 'Invalid agent' });

  const favs = readFavorites();
  const item = favs[agent].find(f => f.id === req.params.id);
  if (!item) return res.status(404).json({ ok: false, error: 'Not found' });

  try {
    applySettings(agent, item.settings);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = { router, setRefs };
