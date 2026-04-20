'use strict';

const fs   = require('fs');
const path = require('path');
const cron = require('node-cron');
const bitget = require('../core/bitget');
const tradeRegistry = require('../core/tradeRegistry');
const { sendSignal, sendTrade, sendAlert, sendAdmin, registerCommand } = require('../core/telegram');
const { logSettingChange } = require('../core/archive');

const SETTINGS_FILE = path.join(__dirname, '../.claude/memory/scalper_settings.json');
const CONFIG_FILE   = path.join(__dirname, '../data/config.json');

function loadHunterSettings() {
  try {
    const all = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    return all.hunter ?? {};
  } catch { return {}; }
}

function loadHunterConfig() {
  try {
    const all = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return all.hunter ?? {};
  } catch { return {}; }
}

// Runtime ICT config — updated live via applySetting() / PATCH endpoint
let hunterConfig = {
  htfTimeframe:   '4H',
  obMitigation:   0.3,
  fvgFilter:      true,
  killZoneOnly:   false,
  killZoneLondon: false,
  killZoneNY:     false,
  killZoneAsian:  false,
  ...loadHunterConfig(),
};

let hunterMarginMode = loadHunterSettings().marginMode ?? 'crossed';

function saveHunterSettings(maxTrades, marginMode) {
  try {
    let all = {};
    try { all = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch {}
    all.hunter = { ...(all.hunter ?? {}), maxTrades, marginMode: marginMode ?? hunterMarginMode };
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(all, null, 2));
  } catch (err) {
    console.error('[hunter] saveSettings:', err.message);
  }
}

// ─── Config ───────────────────────────────────────────────────────────────────

const CAPITAL          = 5;       // $5 allocated to HUNTER
const LEVERAGE         = 20;      // 20x cross margin
const RISK_PCT         = 0.015;   // 1.5% risk per trade = $0.075
const MIN_RR           = 3;       // minimum 1:3 reward/risk
const SL_BUFFER        = 0.001;   // 0.1% beyond zone boundary
const SIGNAL_COOLDOWN  = 4 * 60 * 60 * 1000; // 4h per symbol
const SCAN_DELAY_MS    = 500;     // between symbols to respect Bitget rate limits

// Top-40 Bitget futures universe (USDT-margined perpetuals)
const SYMBOLS = [
  'BTCUSDT',  'ETHUSDT',   'BNBUSDT',   'XRPUSDT',   'SOLUSDT',
  'ADAUSDT',  'DOGEUSDT',  'AVAXUSDT',  'DOTUSDT',   'LINKUSDT',
  'POLUSDT',  'UNIUSDT',   'ATOMUSDT',  'LTCUSDT',   'ETCUSDT',
  'FILUSDT',  'NEARUSDT',  'APTUSDT',   'ARBUSDT',   'OPUSDT',
  'INJUSDT',  'SUIUSDT',   'SEIUSDT',   'TIAUSDT',   'WLDUSDT',
  'PEPEUSDT', 'SHIBUSDT',  'FLOKIUSDT', '1000BONKUSDT', 'JTOUSDT',
  'JUPUSDT',  'PYTHUSDT',  'STRKUSDT',  'DYMUSDT',   'ORDIUSDT',
  'RENDERUSDT','FETUSDT',  'GRTUSDT',   'SANDUSDT',  'MANAUSDT',
];

// ─── ICT / SMC Analysis ───────────────────────────────────────────────────────

/**
 * Determine Daily trend from swing structure (Higher Highs/Lows vs Lower Highs/Lows).
 * Compares first half vs second half of the last 30 candles.
 * Returns 'bullish' | 'bearish' | 'ranging'
 */
function detectTrend(candles) {
  if (candles.length < 30) return 'ranging';
  const c   = candles.slice(-30);
  const mid = 15;

  const fHigh = Math.max(...c.slice(0, mid).map((x) => x.high));
  const fLow  = Math.min(...c.slice(0, mid).map((x) => x.low));
  const lHigh = Math.max(...c.slice(mid).map((x) => x.high));
  const lLow  = Math.min(...c.slice(mid).map((x) => x.low));

  if (lHigh > fHigh && lLow > fLow) return 'bullish';
  if (lHigh < fHigh && lLow < fLow) return 'bearish';
  return 'ranging';
}

/**
 * Find the most recent unmitigated Fair Value Gap.
 *
 * Bullish FVG: candle[i-1].high < candle[i+1].low  (gap above)
 * Bearish FVG: candle[i-1].low  > candle[i+1].high (gap below)
 *
 * "Unmitigated" = current price has not fully entered the gap from the entry side.
 */
function findFVG(candles, direction) {
  const price = candles[candles.length - 1].close;

  // Search newest → oldest, return first fresh FVG
  for (let i = candles.length - 2; i >= 1; i--) {
    const prev = candles[i - 1];
    const next = candles[i + 1];

    if (direction === 'bullish') {
      if (next.low > prev.high) {
        const lo = prev.high;
        const hi = next.low;
        // Unmitigated: price still at or above the bottom of the gap
        if (price >= lo * 0.997) {
          return { high: hi, low: lo, mid: (hi + lo) / 2 };
        }
      }
    } else {
      if (next.high < prev.low) {
        const hi = prev.low;
        const lo = next.high;
        // Unmitigated: price still at or below the top of the gap
        if (price <= hi * 1.003) {
          return { high: hi, low: lo, mid: (hi + lo) / 2 };
        }
      }
    }
  }
  return null;
}

/**
 * Find the most recent valid Order Block.
 *
 * Bullish OB: last bearish candle before a structural bullish break
 *             (the impulse candles after it exceed the prior 5-candle high).
 * Bearish OB: last bullish candle before a structural bearish break.
 */
function findOrderBlock(candles, direction) {
  const c = candles.slice(-60);

  if (direction === 'bullish') {
    for (let i = c.length - 6; i >= 5; i--) {
      if (c[i].close >= c[i].open) continue; // need bearish candle
      const priorHigh  = Math.max(...c.slice(i - 5, i).map((x) => x.high));
      const impulseHigh = Math.max(...c.slice(i + 1, i + 5).map((x) => x.high));
      if (impulseHigh > priorHigh) {
        return { high: c[i].high, low: c[i].low, mid: (c[i].high + c[i].low) / 2 };
      }
    }
  } else {
    for (let i = c.length - 6; i >= 5; i--) {
      if (c[i].close <= c[i].open) continue; // need bullish candle
      const priorLow   = Math.min(...c.slice(i - 5, i).map((x) => x.low));
      const impulseLow = Math.min(...c.slice(i + 1, i + 5).map((x) => x.low));
      if (impulseLow < priorLow) {
        return { high: c[i].high, low: c[i].low, mid: (c[i].high + c[i].low) / 2 };
      }
    }
  }
  return null;
}

/**
 * Detect Market Structure Shift on 1H.
 *
 * Bullish MSS: after a retracement, price closes above the most recent swing high.
 * Bearish MSS: after a rally, price closes below the most recent swing low.
 *
 * Swing high/low identified by 2-bar fractal (surrounded by 2 lower highs / higher lows).
 */
function detectMSS(candles, direction) {
  const c    = candles.slice(-25);
  const last = c[c.length - 1];

  if (direction === 'bullish') {
    // Find the most recent swing high in the body of the array
    for (let i = c.length - 6; i >= 3; i--) {
      const isSwingHigh =
        c[i].high > c[i - 1].high &&
        c[i].high > c[i - 2].high &&
        c[i].high > c[i + 1].high &&
        c[i].high > c[i + 2].high;
      if (!isSwingHigh) continue;

      // After the swing high there must have been a pullback below it
      const loAfter = Math.min(...c.slice(i + 1).map((x) => x.low));
      if (loAfter < c[i].high && last.close > c[i].high) return true;
      break; // only the most recent swing matters
    }
  } else {
    for (let i = c.length - 6; i >= 3; i--) {
      const isSwingLow =
        c[i].low < c[i - 1].low &&
        c[i].low < c[i - 2].low &&
        c[i].low < c[i + 1].low &&
        c[i].low < c[i + 2].low;
      if (!isSwingLow) continue;

      const hiAfter = Math.max(...c.slice(i + 1).map((x) => x.high));
      if (hiAfter > c[i].low && last.close < c[i].low) return true;
      break;
    }
  }
  return false;
}

/**
 * Calculate Fibonacci position of current price within the last 20-candle range.
 * fibLevel 0 = swing low, 1 = swing high.
 * Discount zone: < 0.45  (buy zone for bullish setups)
 * Premium zone:  > 0.55  (sell zone for bearish setups)
 */
function getFibPosition(candles) {
  const c         = candles.slice(-20);
  const swingHigh = Math.max(...c.map((x) => x.high));
  const swingLow  = Math.min(...c.map((x) => x.low));
  const price     = c[c.length - 1].close;
  const range     = swingHigh - swingLow;

  if (range === 0) {
    return { fibLevel: 0.5, isDiscount: false, isPremium: false, isEquilibrium: true, swingHigh, swingLow };
  }

  const fibLevel = (price - swingLow) / range;
  return {
    fibLevel,
    isDiscount:    fibLevel < 0.45,
    isPremium:     fibLevel > 0.55,
    isEquilibrium: fibLevel >= 0.45 && fibLevel <= 0.55,
    swingHigh,
    swingLow,
  };
}

/**
 * Round a price to an appropriate number of decimal places.
 */
function fmt(n) {
  if (n >= 1000) return +n.toFixed(2);
  if (n >= 1)    return +n.toFixed(4);
  return +n.toFixed(8);
}

// ─── Top-down analysis for one symbol ────────────────────────────────────────

async function analyzeSymbol(symbol) {
  console.log(`[hunter] >> ${symbol}: fetching candles`);
  // Fetch all three timeframes in parallel
  const [daily, h4, h1] = await Promise.all([
    bitget.getKlines(symbol, 'Day1',  50),
    bitget.getKlines(symbol, 'Hour4', 100),
    bitget.getKlines(symbol, 'Min60', 50),
  ]);

  if (daily.length < 30 || h4.length < 30 || h1.length < 20) {
    console.log(`[hunter] SKIP ${symbol}: insufficient candles (D:${daily.length} 4H:${h4.length} 1H:${h1.length})`);
    return null;
  }

  // ── 1. HTF trend (Daily or 4H depending on hunterConfig.htfTimeframe) ────────
  const htfCandles = hunterConfig.htfTimeframe === '4H' ? h4 : daily;
  const trend = detectTrend(htfCandles);
  console.log(`[hunter] ${symbol}: trend=${trend}`);
  if (trend === 'ranging') {
    console.log(`[hunter] SKIP ${symbol}: ranging trend`);
    return null;
  }
  const direction = trend; // 'bullish' | 'bearish'

  // ── 2. Fibonacci / Premium-Discount filter ──────────────────────────────────
  const fib = getFibPosition(daily);
  console.log(`[hunter] ${symbol}: fib=${fib.fibLevel.toFixed(3)} discount=${fib.isDiscount} premium=${fib.isPremium} equil=${fib.isEquilibrium}`);
  if (fib.isEquilibrium) {
    console.log(`[hunter] SKIP ${symbol}: price at equilibrium (fib ${fib.fibLevel.toFixed(3)})`);
    return null;
  }
  if (direction === 'bullish' && !fib.isDiscount) {
    console.log(`[hunter] SKIP ${symbol}: bullish but price in premium zone (fib ${fib.fibLevel.toFixed(3)})`);
    return null;
  }
  if (direction === 'bearish' && !fib.isPremium) {
    console.log(`[hunter] SKIP ${symbol}: bearish but price in discount zone (fib ${fib.fibLevel.toFixed(3)})`);
    return null;
  }

  // ── 3. Daily zone: FVG preferred, OB as fallback ───────────────────────────
  const dailyFVG  = findFVG(daily, direction);
  const dailyOB   = dailyFVG ? null : findOrderBlock(daily, direction);
  const dailyZone = dailyFVG ?? dailyOB;
  console.log(`[hunter] ${symbol}: dailyFVG=${!!dailyFVG} dailyOB=${!!dailyOB}`);
  if (!dailyZone) {
    console.log(`[hunter] SKIP ${symbol}: no daily FVG or OB (${direction})`);
    return null;
  }

  // ── 4. 4H zone for precise entry ────────────────────────────────────────────
  const h4FVG  = findFVG(h4, direction);
  const h4OB   = h4FVG ? null : findOrderBlock(h4, direction);
  const h4Zone = h4FVG ?? h4OB;
  console.log(`[hunter] ${symbol}: h4FVG=${!!h4FVG} h4OB=${!!h4OB}`);
  if (!h4Zone) {
    console.log(`[hunter] SKIP ${symbol}: no 4H FVG or OB (${direction})`);
    return null;
  }

  // ── 4.5 FVG filter — skip setup if no 4H FVG found when filter is active ────
  if (hunterConfig.fvgFilter && !h4FVG) {
    console.log(`[hunter] SKIP ${symbol}: FVG filter ON, no 4H FVG found`);
    return null;
  }

  // ── 5. 1H Market Structure Shift ───────────────────────────────────────────
  const mss = detectMSS(h1, direction);
  console.log(`[hunter] ${symbol}: 1H MSS=${mss} (${direction})`);
  if (!mss) {
    console.log(`[hunter] SKIP ${symbol}: no 1H MSS confirmed (${direction})`);
    return null;
  }

  // ── 6. Entry, SL, TP calculation ───────────────────────────────────────────
  // FVG: enter at midpoint. OB: enter at obMitigation depth from boundary.
  let entry;
  if (h4FVG) {
    entry = h4Zone.mid;
  } else {
    const ob = h4Zone;
    entry = direction === 'bullish'
      ? ob.high - (ob.high - ob.low) * hunterConfig.obMitigation
      : ob.low  + (ob.high - ob.low) * hunterConfig.obMitigation;
  }
  let sl, tp1, tp2;

  if (direction === 'bullish') {
    sl  = h4Zone.low  * (1 - SL_BUFFER);          // below zone + buffer
    tp2 = fib.swingHigh;                            // Daily swing high (final target)

    const risk   = entry - sl;
    const minTP1 = entry + risk * MIN_RR;           // floor at 1:3

    // Find nearest 4H swing high above the 1:3 floor
    const h4HighsAbove = h4.slice(-30)
      .map((c) => c.high)
      .filter((h) => h >= minTP1)
      .sort((a, b) => a - b);
    tp1 = h4HighsAbove[0] ?? minTP1;
  } else {
    sl  = h4Zone.high * (1 + SL_BUFFER);
    tp2 = fib.swingLow;

    const risk   = sl - entry;
    const minTP1 = entry - risk * MIN_RR;

    const h4LowsBelow = h4.slice(-30)
      .map((c) => c.low)
      .filter((l) => l <= minTP1)
      .sort((a, b) => b - a);
    tp1 = h4LowsBelow[0] ?? minTP1;
  }

  // ── 7. Validate RR1 ≥ 3 ────────────────────────────────────────────────────
  const risk    = Math.abs(entry - sl);
  const reward1 = Math.abs(tp1 - entry);
  const rr1     = reward1 / risk;
  console.log(`[hunter] ${symbol}: entry=${fmt(entry)} sl=${fmt(sl)} tp1=${fmt(tp1)} rr1=${rr1.toFixed(2)}`);
  if (rr1 < MIN_RR) {
    console.log(`[hunter] SKIP ${symbol}: RR too low (${rr1.toFixed(2)} < ${MIN_RR})`);
    return null;
  }

  // ── 8. Ensure TP2 gives at least 1:5 ──────────────────────────────────────
  const rr2 = Math.abs(tp2 - entry) / risk;
  if (rr2 < 5) {
    tp2 = direction === 'bullish'
      ? entry + risk * 5
      : entry - risk * 5;
  }

  // ── Setup label & confidence ────────────────────────────────────────────────
  const dLabel  = dailyFVG ? 'D-FVG' : 'D-OB';
  const h4Label = h4FVG    ? '4H-FVG' : '4H-OB';
  // Confluence bonus: both timeframes agree on FVG or both on OB
  const confluence = (dailyFVG && h4FVG) || (dailyOB && h4OB);
  const confidence = confluence ? 0.85 : 0.70;

  console.log(`[hunter] SETUP ${symbol}: ${direction} entry=${fmt(entry)} sl=${fmt(sl)} tp1=${fmt(tp1)} tp2=${fmt(tp2)} rr=${rr1.toFixed(2)} conf=${confidence} setup=${dLabel}+${h4Label}`);

  return {
    symbol,
    direction:  direction === 'bullish' ? 'long' : 'short',
    entry:      bitget.roundPrice(entry, symbol),
    sl:         bitget.roundPrice(sl,    symbol),
    tp:         bitget.roundPrice(tp1,   symbol),   // sendSignal() uses `tp` for TP1
    tp2:        bitget.roundPrice(tp2,   symbol),
    rr:         +rr1.toFixed(2),
    tf:         '1h',
    leverage:   LEVERAGE,
    setup:      `ICT/${dLabel}+${h4Label}+MSS | TP2: ${fmt(tp2)} | ${LEVERAGE}x`,
    confidence,
    from:       'HUNTER',
  };
}

// ─── Trade state ──────────────────────────────────────────────────────────────

const recentSignals  = new Map(); // symbol → ms timestamp of last signal
const openTrades     = new Set(); // symbols with active or pending position (scan gate)
const activeTrades   = new Map(); // symbol → full trade object (monitor state)
const pendingOrders  = new Map(); // symbol → { orderId, trade, placedAt }
let MAX_TRADES     = loadHunterSettings().maxTrades ?? 5;

// Limit orders expire after SIGNAL_COOLDOWN (4h) if never filled
const LIMIT_ORDER_TTL = SIGNAL_COOLDOWN;

let adminRef = null; // set by init()
let enabled  = true; // toggled by /hunter_on / /hunter_off

// ─── Position sizing ──────────────────────────────────────────────────────────

/**
 * Calculate contract quantity to risk CAPITAL * RISK_PCT on this trade.
 * Assumes 1 contract = 1 unit of base currency (refined per-symbol later).
 * Caps at 10 000 to guard against micro-priced tokens inflating the number.
 */
const MIN_NOTIONAL = 5; // Bitget minimum order value in USDT

function calcSize(entry, sl) {
  const riskUsdt     = CAPITAL * RISK_PCT;
  const slGap        = Math.abs(entry - sl);
  const contracts    = slGap > 0 ? riskUsdt / slGap : 0;
  const minContracts = MIN_NOTIONAL * 1.10 / entry; // 10% buffer — always clears $5 after rounding
  const raw          = Math.max(minContracts, contracts);
  // Round UP to 4 significant figures so we never fall below the minimum
  const exp = Math.pow(10, 3 - Math.floor(Math.log10(raw)));
  return Math.ceil(raw * exp) / exp;
}

// ─── Execution ────────────────────────────────────────────────────────────────

async function executeTrade(signal) {
  const { symbol, direction, entry, sl, tp: tp1, tp2 } = signal;
  const size = bitget.roundSize(calcSize(entry, sl), symbol);

  // Skip if notional is still below Bitget minimum after rounding
  if (size * entry < MIN_NOTIONAL) {
    console.log(`[hunter] SKIP ${symbol}: notional $${(size * entry).toFixed(3)} < $${MIN_NOTIONAL} after rounding`);
    return;
  }

  // Place a limit order at the 4H zone midpoint with preset SL/TP on exchange
  const { orderId } = await bitget.placeLimitOrder(symbol, direction, size, entry, LEVERAGE, hunterMarginMode, sl, tp1);

  // Build trade record (will be activated once the limit order fills)
  const trade = {
    symbol,
    direction,
    entry,
    sl,             // mutable — moves to breakeven after TP1
    tp1,
    tp2,
    size,
    remainingSize:  size,
    tp1Hit:         false,
    orderId,
  };

  pendingOrders.set(symbol, { orderId, trade, placedAt: Date.now() });

  // Notify #signals that a limit order is queued
  await sendSignal({ ...signal, limitQueued: true });

  console.log(`[hunter] limit order queued: ${symbol} ${direction.toUpperCase()} x${size} @ ${entry} | SL ${sl} | TP1 ${tp1} | TP2 ${tp2} | orderId ${orderId}`);
}

// Called once the exchange confirms a pending limit order has been filled
async function onLimitFilled(symbol, trade) {
  pendingOrders.delete(symbol);
  trade.openedAt = Date.now();

  activeTrades.set(symbol, trade);

  const { direction, entry, sl, tp1, tp2, size, orderId } = trade;

  // Reflect in agentStatus
  const status = adminRef?.agentStatus?.HUNTER;
  if (status) {
    status.trades = (status.trades || 0) + 1;
    status.openTrades = status.openTrades || [];
    status.openTrades.push({ symbol, direction, entry, sl, tp1, tp2, size, orderId });
  }

  await sendTrade({ agent: 'HUNTER', action: 'filled', symbol, direction, size, entry, sl, tp: tp1, pnl: null });

  console.log(`[hunter] limit filled: ${symbol} ${direction.toUpperCase()} x${size} @ ${entry}`);

  // Set TP/SL on the live position so they execute on-exchange automatically
  trade.tpslSet = false;
  try {
    await bitget.setPositionTPSL(symbol, direction, sl, tp1, tp2);
    trade.tpslSet = true;
    console.log(`[hunter] TP/SL set on position: ${symbol} SL=${sl} TP1=${tp1} TP2=${tp2}`);
  } catch (err) {
    console.error(`[hunter] failed to set TP/SL on ${symbol}:`, err.message);
    await sendAlert(`HUNTER: failed to set TP/SL on ${symbol}: ${err.message}`);
  }

  startMonitor(trade);
}

// ─── Pending order monitor ────────────────────────────────────────────────────

// If price moves this far toward TP1 without the limit order filling, auto-cancel
const AUTO_CANCEL_TP_THRESHOLD = 0.70; // 70% of entry → TP1 distance

// Polls every 60 s for pending limit orders; confirms fill, detects external
// cancellation, expires on TTL, and auto-cancels when price has already run
// 70%+ toward TP without filling.
function startPendingMonitor() {
  setInterval(async () => {
    for (const [symbol, pending] of pendingOrders) {
      try {
        // ── 1. TTL expiry ──────────────────────────────────────────────────────
        if (Date.now() - pending.placedAt > LIMIT_ORDER_TTL) {
          await bitget.cancelOrder(symbol, pending.orderId);
          pendingOrders.delete(symbol);
          openTrades.delete(symbol);
          tradeRegistry.release(symbol);
          console.log(`[hunter] limit order expired & cancelled: ${symbol}`);
          await sendAlert(`HUNTER: limit order expired (unfilled) — ${symbol}`);
          continue;
        }

        // ── 2. Check order state on exchange ──────────────────────────────────
        const { state } = await bitget.getOrderStatus(symbol, pending.orderId);

        if (state === 2) {
          // Fully filled — activate the trade
          await onLimitFilled(symbol, pending.trade);
          continue;
        }

        if (state === 4) {
          // Cancelled externally (manual cancel on Bitget UI or API)
          pendingOrders.delete(symbol);
          openTrades.delete(symbol);
          tradeRegistry.release(symbol);
          console.log(`[hunter] limit order cancelled externally: ${symbol}`);
          await sendAlert(`HUNTER: limit order for ${symbol} was cancelled manually on exchange`);
          continue;
        }

        // ── 3. Auto-cancel when price has run toward TP without filling ────────
        // This happens when the market moves in our direction but the entry
        // zone was never revisited — the setup played out without us.
        const { trade } = pending;
        const price     = await bitget.getPrice(symbol);
        const isLong    = trade.direction === 'long';
        const tpDist    = Math.abs(trade.tp1 - trade.entry);

        if (tpDist > 0) {
          const movedTowardTP = isLong
            ? (price - trade.entry) / tpDist   // positive = moved above entry toward TP
            : (trade.entry - price) / tpDist;  // positive = moved below entry toward TP

          if (movedTowardTP >= AUTO_CANCEL_TP_THRESHOLD) {
            await bitget.cancelOrder(symbol, pending.orderId);
            pendingOrders.delete(symbol);
            openTrades.delete(symbol);
            tradeRegistry.release(symbol);
            const pct = (movedTowardTP * 100).toFixed(0);
            console.log(`[hunter] auto-cancelled ${symbol}: price moved ${pct}% toward TP without filling`);
            await sendAlert(`HUNTER: auto-cancelled ${symbol} — price moved ${pct}% toward TP without filling the limit`);
          }
        }
      } catch (err) {
        console.error(`[hunter] pending monitor ${symbol}:`, err.message);
      }
    }
  }, 60_000);
}

// ─── Price monitor ────────────────────────────────────────────────────────────

function startMonitor(trade) {
  const id = setInterval(async () => {
    try {
      await checkTrade(trade, id);
    } catch (err) {
      console.error(`[hunter] monitor ${trade.symbol}:`, err.message);
    }
  }, 60_000); // every 60 s
}

async function checkTrade(trade, intervalId) {
  const price  = await bitget.getPrice(trade.symbol);
  const isLong = trade.direction === 'long';

  // Retry TPSL if the initial set failed in onLimitFilled
  if (!trade.tpslSet && trade.sl && trade.tp1) {
    try {
      await bitget.setPositionTPSL(trade.symbol, trade.direction, trade.sl, trade.tp1, trade.tp2);
      trade.tpslSet = true;
      console.log(`[hunter] TP/SL set on position (retry): ${trade.symbol} SL=${trade.sl} TP1=${trade.tp1}`);
    } catch (err) {
      console.error(`[hunter] retry set TP/SL ${trade.symbol}:`, err.message);
    }
  }

  // If no valid SL/TP (e.g. recovered position with no TP/SL on exchange), skip price-based exit
  // and rely on syncPositions to detect closure. Without this guard, sl=0 or tp1=0 falsely triggers.
  if (!trade.sl || !trade.tp1) return;

  // SL check — always highest priority
  const slHit = isLong ? price <= trade.sl : price >= trade.sl;
  if (slHit) {
    if (trade.closing) { clearInterval(intervalId); return; }
    trade.closing = true;
    clearInterval(intervalId);
    await handleSLHit(trade, price);
    return;
  }

  if (trade.tp1Hit) {
    // Waiting for TP2 (remaining 50%)
    const tp2Hit = isLong ? price >= trade.tp2 : price <= trade.tp2;
    if (tp2Hit) {
      if (trade.closing) { clearInterval(intervalId); return; }
      trade.closing = true;
      clearInterval(intervalId);
      await handleTP2Hit(trade, price);
    }
    return;
  }

  // Waiting for TP1 (first 50%)
  const tp1Hit = isLong ? price >= trade.tp1 : price <= trade.tp1;
  if (tp1Hit) {
    await handleTP1Hit(trade, price);
  }
}

async function handleTP1Hit(trade, price) {
  const { symbol, direction, size, entry } = trade;
  const halfSize = Math.max(1, Math.floor(size / 2));

  await bitget.closePositionPartial(symbol, 0.5);

  const pnl = +(halfSize * (direction === 'long' ? price - entry : entry - price)).toFixed(4);

  // Move SL to breakeven, flag TP1 done
  trade.sl           = entry;
  trade.tp1Hit       = true;
  trade.remainingSize = size - halfSize;

  // Accumulate PnL
  const status = adminRef?.agentStatus?.HUNTER;
  if (status) status.pnl = +((status.pnl || 0) + pnl).toFixed(4);

  await sendTrade({ agent: 'HUNTER', action: 'close', symbol, direction, size: halfSize, entry, sl: trade.sl, tp: price, exitPrice: price, reason: 'TP1 hit', pnl });

  console.log(`[hunter] TP1 hit ${symbol} — closed ${halfSize} contracts, pnl ${pnl >= 0 ? '+' : ''}${pnl}, SL → breakeven @ ${entry}`);
}

async function handleTP2Hit(trade, price) {
  const { symbol, direction, remainingSize, entry } = trade;

  try {
    await bitget.closePosition(symbol);
  } catch (err) {
    console.log(`[hunter] closePosition ${symbol} skipped (${err.message}) — logging anyway`);
  }

  // BUG 2 fix: fetch actual realized PnL from Bitget history
  let pnl = await bitget.getClosedPositionPnl(symbol, trade.openedAt);
  if (pnl === null) {
    pnl = +(remainingSize * (direction === 'long' ? price - entry : entry - price)).toFixed(4);
  } else {
    pnl = +pnl.toFixed(4);
  }

  await sendTrade({ agent: 'HUNTER', action: 'close', symbol, direction, size: remainingSize, entry, sl: trade.sl, tp: price, exitPrice: price, reason: 'TP2 hit', pnl });

  console.log(`[hunter] TP2 hit ${symbol} — closed ${remainingSize} contracts, pnl ${pnl >= 0 ? '+' : ''}${pnl}`);

  finalizeTrade(trade, pnl);
}

async function handleSLHit(trade, price) {
  const { symbol, direction, remainingSize, entry } = trade;

  try {
    await bitget.closePosition(symbol);
  } catch (err) {
    console.log(`[hunter] closePosition ${symbol} skipped (${err.message}) — logging anyway`);
  }

  // BUG 2 fix: fetch actual realized PnL from Bitget history
  let pnl = await bitget.getClosedPositionPnl(symbol, trade.openedAt);
  if (pnl === null) {
    pnl = +(remainingSize * (direction === 'long' ? price - entry : entry - price)).toFixed(4);
  } else {
    pnl = +pnl.toFixed(4);
  }

  await sendTrade({ agent: 'HUNTER', action: 'close', symbol, direction, size: remainingSize, entry, sl: price, tp: null, exitPrice: price, reason: 'SL hit', pnl });

  if (!trade.tp1Hit) {
    // Full loss — alert
    await sendAlert(`HUNTER SL hit: ${symbol} ${direction.toUpperCase()} | exit: ${price} | pnl: ${pnl}`);
  }

  console.log(`[hunter] SL hit ${symbol} (tp1Hit=${trade.tp1Hit}) — pnl ${pnl}`);

  finalizeTrade(trade, pnl);
}

function finalizeTrade(trade, additionalPnl) {
  const { symbol } = trade;

  activeTrades.delete(symbol);
  openTrades.delete(symbol); // free the scan slot
  tradeRegistry.release(symbol);

  const status = adminRef?.agentStatus?.HUNTER;
  if (status) {
    status.pnl       = +((status.pnl || 0) + additionalPnl).toFixed(4);
    status.openTrades = (status.openTrades || []).filter((t) => t.symbol !== symbol);
  }

  // Let admin risk-check run after every closed trade
  adminRef?.checkRisk?.().catch(() => {});
}

// ─── Position sync (detect Bitget SL/TP closures) ────────────────────────────

async function syncPositions() {
  if (activeTrades.size === 0) return;

  for (const [symbol, trade] of activeTrades) {
    if (trade.closing) continue;

    // BUG 1 fix: query per-symbol so an empty result reliably means the position is gone
    let symbolPositions;
    try {
      symbolPositions = await bitget.getOpenPositions(symbol);
    } catch (err) {
      console.error(`[hunter] syncPositions fetch error for ${symbol}:`, err.message);
      continue;
    }

    const positionExists = symbolPositions.some((p) => p.holdSide === trade.direction);
    if (positionExists) continue; // still open on Bitget

    trade.closing = true;
    console.log(`[hunter] sync: ${symbol} no longer on Bitget → closed externally`);

    try {
      // BUG 2 fix: fetch actual realized PnL from Bitget history
      let realPnl = await bitget.getClosedPositionPnl(symbol, trade.openedAt);

      const price  = await bitget.getPrice(symbol);
      const isLong = trade.direction === 'long';

      let exitPrice, reason, sizeToClose;

      if (trade.tp1Hit) {
        // Remaining 50% was open — TP2 or trailing SL (breakeven)
        sizeToClose = trade.remainingSize;
        const tp2Hit = isLong ? price >= trade.tp2 : price <= trade.tp2;
        exitPrice = tp2Hit ? trade.tp2 : trade.sl;
        reason    = tp2Hit ? 'TP2 hit' : 'SL hit (breakeven)';
      } else {
        // Full position — SL or TP1
        sizeToClose = trade.size;
        const slHit = isLong ? price < trade.entry : price > trade.entry;
        exitPrice = slHit ? trade.sl : trade.tp1;
        reason    = slHit ? 'SL hit' : 'TP1 hit';
      }

      let pnl;
      if (realPnl !== null) {
        pnl = +realPnl.toFixed(4);
      } else {
        pnl = +(sizeToClose * (isLong ? exitPrice - trade.entry : trade.entry - exitPrice)).toFixed(4);
      }

      await sendTrade({ agent: 'HUNTER', action: 'close', symbol, direction: trade.direction,
        size: sizeToClose, entry: trade.entry, sl: trade.sl, tp: trade.tp1, exitPrice, reason, pnl });

      if (reason === 'SL hit') {
        await sendAlert(`HUNTER SL hit (exchange): ${symbol} ${trade.direction.toUpperCase()} | exit: ${exitPrice} | pnl: ${pnl}`);
      }

      finalizeTrade(trade, pnl);
      console.log(`[hunter] sync: ${symbol} closed by exchange (${reason}) exit=${exitPrice} pnl=${pnl >= 0 ? '+' : ''}${pnl}`);
    } catch (err) {
      console.error(`[hunter] syncPositions ${symbol}:`, err.message);
      trade.closing = false;
    }
  }
}

// ─── TP/SL on existing open positions ────────────────────────────────────────

/**
 * Set TP/SL on an already-open position (e.g. positions opened manually or
 * before the bot was running).
 *
 * @param {string} symbol
 * @param {string} holdSide - 'long' | 'short'
 * @param {number} sl
 * @param {number} tp1
 * @param {number} tp2
 */
async function setTPSLOnExistingPosition(symbol, holdSide, sl, tp1, tp2) {
  await bitget.setPositionTPSL(symbol, holdSide, sl, tp1, tp2);
  console.log(`[hunter] setTPSLOnExistingPosition: ${symbol} ${holdSide} SL=${sl} TP1=${tp1} TP2=${tp2}`);
  await sendAdmin(
    `✅ <b>HUNTER</b> TP/SL set on ${symbol} ${holdSide.toUpperCase()}\n` +
    `SL: <code>${sl}</code>\nTP1: <code>${tp1}</code> (50%)\nTP2: <code>${tp2}</code> (50%)`
  );
}

// ─── Scan loop ────────────────────────────────────────────────────────────────

function isBlocked() {
  if (!adminRef) return false;
  if (adminRef.emergencyStop) return true;
  if (adminRef.globalPaused) return true;
  const s = adminRef.agentStatus?.HUNTER;
  if (!s || s.pnl >= 0) return false;
  return Math.abs(s.pnl / CAPITAL) * 100 >= 5; // agent drawdown ≥ 5%
}

function atMaxTrades() {
  return openTrades.size >= MAX_TRADES;
}

function isInKillZone() {
  const now = new Date();
  const hm  = now.getUTCHours() * 60 + now.getUTCMinutes();
  const zones = [];
  if (hunterConfig.killZoneLondon) zones.push([7 * 60, 9 * 60]);
  if (hunterConfig.killZoneNY)     zones.push([13 * 60, 15 * 60]);
  if (hunterConfig.killZoneAsian)  zones.push([0, 2 * 60]);
  if (zones.length === 0) return false; // no zones selected → never in zone
  return zones.some(([s, e]) => hm >= s && hm < e);
}

async function runScan() {
  if (!enabled) {
    console.log('[hunter] scan skipped — disabled');
    return;
  }
  if (isBlocked()) {
    console.log('[hunter] scan skipped — emergency stop or drawdown limit reached');
    return;
  }

  if (hunterConfig.killZoneOnly && !isInKillZone()) {
    console.log('[hunter] scan skipped — kill zone filter active, not in kill zone');
    return;
  }

  console.log(`[hunter] scanning ${SYMBOLS.length} symbols… (open trades: ${openTrades.size}/${MAX_TRADES})`);
  let found = 0;

  for (const symbol of SYMBOLS) {
    if (atMaxTrades()) {
      console.log(`[hunter] max trades (${MAX_TRADES}) reached — stopping scan`);
      break;
    }

    const lastSent = recentSignals.get(symbol);
    if (lastSent && Date.now() - lastSent < SIGNAL_COOLDOWN) continue;
    if (openTrades.has(symbol) || pendingOrders.has(symbol)) continue;

    try {
      const signal = await analyzeSymbol(symbol);
      if (signal) {
        // Set cooldown immediately so a failed execution doesn't cause retry spam
        recentSignals.set(symbol, Date.now());
        openTrades.add(symbol);             // add BEFORE executeTrade so state is set even if Telegram throws
        await executeTrade(signal);         // place order + notify #signals
        found++;
      }
    } catch (err) {
      console.error(`[hunter] ${symbol}:`, err.message);
    }

    await new Promise((r) => setTimeout(r, SCAN_DELAY_MS));
  }

  const status = adminRef?.agentStatus?.HUNTER;
  if (status) status.running = true;

  console.log(`[hunter] scan complete — ${found} new trade(s), ${openTrades.size} open`);
}

// ─── Init ─────────────────────────────────────────────────────────────────────

function init(admin) {
  adminRef = admin;

  const status = adminRef?.agentStatus?.HUNTER;
  if (status) {
    status.running    = true;
    status.openTrades = []; // array of live trade objects
  }

  registerCommand('hunter_on', async () => {
    enabled = true;
    const status = adminRef?.agentStatus?.HUNTER;
    if (status) status.running = true;
    await sendAdmin('✅ <b>HUNTER</b> включён — следующий скан через ≤15 мин');
    console.log('[hunter] enabled via /hunter_on');
  });

  registerCommand('hunter_off', async () => {
    enabled = false;
    const status = adminRef?.agentStatus?.HUNTER;
    if (status) status.running = false;
    await sendAdmin('⛔ <b>HUNTER</b> выключен — открытые сделки продолжают мониториться');
    console.log('[hunter] disabled via /hunter_off');
  });

  // /hunter_set_tpsl SYMBOL SIDE SL TP1 TP2
  // Example: /hunter_set_tpsl LINKUSDT long 9.041 9.236 10.075
  registerCommand('hunter_set_tpsl', async (args) => {
    const parts = (args || '').trim().split(/\s+/);
    if (parts.length < 5) {
      await sendAdmin('Usage: /hunter_set_tpsl SYMBOL SIDE SL TP1 TP2\nExample: /hunter_set_tpsl LINKUSDT long 9.041 9.236 10.075');
      return;
    }
    const [symbol, holdSide, slStr, tp1Str, tp2Str] = parts;
    const sl  = parseFloat(slStr);
    const tp1 = parseFloat(tp1Str);
    const tp2 = parseFloat(tp2Str);
    if (isNaN(sl) || isNaN(tp1) || isNaN(tp2)) {
      await sendAdmin('❌ Invalid price values — must be numbers');
      return;
    }
    try {
      await setTPSLOnExistingPosition(symbol.toUpperCase(), holdSide.toLowerCase(), sl, tp1, tp2);
    } catch (err) {
      console.error('[hunter] hunter_set_tpsl error:', err.message);
      await sendAdmin(`❌ Failed to set TP/SL on ${symbol}: ${err.message}`);
    }
  });

  bitget.loadContractSpecs().catch(err => console.error('[hunter] loadContractSpecs:', err.message));

  // Scan every 15 minutes (24/7 — no session filter)
  cron.schedule('6,21,36,51 * * * *', () => {
    runScan().catch((err) => {
      console.error('[hunter] runScan crashed:', err.message);
      sendAlert(`HUNTER scan error: ${err.message}`).catch(() => {});
    });
  });

  // Monitor pending limit orders for fills / expiry
  startPendingMonitor();

  // Sync active positions every 30 s to detect Bitget-side SL/TP closures
  setInterval(() => {
    syncPositions().catch((err) => console.error('[hunter] syncPositions error:', err.message));
  }, 30_000);

  // Recover positions that existed before this restart
  bitget.getOpenPositions().then(positions => {
    let recoverDelay = 0;
    for (const pos of positions) {
      const sym = pos.symbol;
      if (activeTrades.has(sym) || tradeRegistry.isClaimed(sym)) continue;
      const direction = pos.holdSide;
      const entry     = parseFloat(pos.openPriceAvg);
      const sl        = parseFloat(pos.stopLossPrice)   || 0;
      const tp1       = parseFloat(pos.takeProfitPrice) || 0;
      const size      = parseFloat(pos.total);
      if (!size || !entry) continue;
      const trade = { symbol: sym, direction, entry, sl, tp1, tp2: 0, size, remainingSize: size, openedAt: Date.now() - 300_000, tpslSet: true, tp1Hit: false, closing: false };
      activeTrades.set(sym, trade);
      openTrades.add(sym);
      tradeRegistry.claim(sym);
      setTimeout(() => startMonitor(trade), recoverDelay);
      recoverDelay += 2000; // stagger monitors 2s apart to avoid API rate limits
      if (!sl) console.warn(`[hunter] recovered ${sym}: no SL/TP on exchange — use /hunter_set_tpsl to fix`);
      else console.log(`[hunter] recovered position: ${sym} ${direction} x${size} @ ${entry} SL=${sl} TP=${tp1}`);
    }
  }).catch(err => console.error('[hunter] position recovery failed:', err.message));

  console.log(
    `[hunter] initialized — ${SYMBOLS.length} symbols, 15-min scan, 24/7, max ${MAX_TRADES} trades, limit orders`
  );
}

// ─── Exports ──────────────────────────────────────────────────────────────────

function applySetting(key, rawValue) {
  const k = key.toLowerCase().replace(/_/g, '');
  // silently accept leverage/riskpct — persisted to file by server, displayed in dashboard
  if (k === 'leverage' || k === 'riskpct') return { ok: true, label: key, value: parseFloat(rawValue) };
  if (k === 'margin' || k === 'marginmode') {
    const val = rawValue.toLowerCase();
    if (!['isolated', 'crossed'].includes(val))
      return { ok: false, error: 'margin must be "isolated" or "crossed"' };
    hunterMarginMode = val;
    saveHunterSettings(undefined, val);
    return { ok: true, label: 'Margin Mode', value: val };
  }
  if (k === 'maxtrades') {
    const val = parseInt(rawValue);
    if (isNaN(val) || val < 1 || val > 50)
      return { ok: false, error: 'Value must be 1–50' };
    const oldValue = MAX_TRADES;
    MAX_TRADES = val;
    logSettingChange('HUNTER', 'maxTrades', oldValue, val);
    saveHunterSettings(val);
    return { ok: true, label: 'Max Trades', value: val };
  }
  if (k === 'htftimeframe') {
    if (!['4H', '1D'].includes(rawValue)) return { ok: false, error: 'htfTimeframe must be 4H or 1D' };
    hunterConfig.htfTimeframe = rawValue;
    return { ok: true, label: 'HTF Timeframe', value: rawValue };
  }
  if (k === 'obmitigation') {
    const v = parseFloat(rawValue);
    if (isNaN(v) || v < 0.1 || v > 2.0) return { ok: false, error: 'obMitigation must be 0.1–2.0' };
    hunterConfig.obMitigation = v;
    return { ok: true, label: 'OB Mitigation', value: v };
  }
  const boolKeys = {
    fvgfilter:      'fvgFilter',
    killzoneonly:   'killZoneOnly',
    killzonelondon: 'killZoneLondon',
    killzoneny:     'killZoneNY',
    killzoneasian:  'killZoneAsian',
  };
  if (boolKeys[k]) {
    hunterConfig[boolKeys[k]] = rawValue === 'true' || rawValue === true;
    return { ok: true, label: key, value: hunterConfig[boolKeys[k]] };
  }
  return { ok: false, error: 'Unknown key' };
}

function setEnabled(val) { enabled = val; }

module.exports = { init, applySetting, setEnabled, openTrades, activeTrades, pendingOrders, LEVERAGE, get enabled() { return enabled; } };
