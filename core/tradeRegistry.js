'use strict';

/**
 * Shared registry to prevent multiple agents from claiming the same open position.
 * Used during startup recovery from Bitget's position list.
 */
const claimed = new Set(); // Set<symbol>

function claim(symbol)        { claimed.add(symbol); }
function isClaimed(symbol)    { return claimed.has(symbol); }
function release(symbol)      { claimed.delete(symbol); }

module.exports = { claim, isClaimed, release };
