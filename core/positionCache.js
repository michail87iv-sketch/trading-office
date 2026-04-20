'use strict';

/**
 * core/positionCache.js — singleton in-process cache of open Bitget positions.
 *
 * WHY in-memory (not Redis / shared file):
 *   All agents (S1, S2, S3, Hunter) run in the same Node.js process (index.js).
 *   A module-level singleton is shared across all require() calls — zero overhead,
 *   no IPC, no extra dependency. Redis would only be needed if agents were separate
 *   OS processes; they are not.
 *
 * Solves two problems:
 *   A) 429 rate-limit: replaces per-scan /all-position calls with one shared fetch
 *      refreshed at most every TTL_MS milliseconds.
 *   B) Cross-agent conflicts: any agent can check isSymbolTaken() before opening,
 *      catching cases where another agent already holds the same symbol.
 */

const bitget = require('./bitget');

const TTL_MS = 30_000; // 30 s — matches Bitget's recommended poll interval

let _cache     = null;   // Array of Bitget position objects
let _fetchedAt = 0;      // timestamp of last successful fetch
let _pending   = null;   // in-flight Promise (dedup concurrent callers)

/**
 * Return all open positions across the account.
 * At most one HTTP request per TTL_MS window, regardless of how many agents call.
 * @returns {Promise<Array>}
 */
async function getPositions() {
  const now = Date.now();
  if (_cache !== null && now - _fetchedAt < TTL_MS) return _cache;
  if (_pending) return _pending; // dedup: callers wait on the same request

  _pending = bitget.getOpenPositions()
    .then((data) => {
      _cache     = data;
      _fetchedAt = Date.now();
      _pending   = null;
      return _cache;
    })
    .catch((err) => {
      _pending = null;
      throw err;
    });

  return _pending;
}

/**
 * Check whether any agent already holds an open position for the given symbol.
 * Normalises symbol to Bitget format (removes underscores, uppercases).
 * @param {string} symbol
 * @returns {Promise<boolean>}
 */
async function isSymbolTaken(symbol) {
  const sym       = symbol.replace('_', '').toUpperCase();
  const positions = await getPositions();
  return positions.some((p) => (p.symbol ?? '').toUpperCase() === sym);
}

/**
 * Force-invalidate the cache.
 * Call this immediately after opening or closing a position so the next
 * consumer sees fresh data instead of stale state.
 */
function invalidate() {
  _cache     = null;
  _fetchedAt = 0;
}

module.exports = { getPositions, isSymbolTaken, invalidate };
