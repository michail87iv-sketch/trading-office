'use strict';

/**
 * Generates Pine Script v5 strategies from research results.
 * Output can be pasted directly into TradingView Pine Editor.
 */

function header(name, symbol, tf, metrics) {
  const wr  = (metrics.winRate  * 100).toFixed(1);
  const pf  = metrics.profitFactor.toFixed(2);
  const dd  = (metrics.maxDD    * 100).toFixed(1);
  const ret = (metrics.totalReturn * 100).toFixed(1);
  return `//@version=5
// ═══════════════════════════════════════════════════════════════
// Trading Office — Research Strategy
// Symbol    : ${symbol}
// Timeframe : ${tf}
// Win Rate  : ${wr}%  |  Profit Factor: ${pf}
// Max DD    : ${dd}%  |  Total Return : ${ret}%
// Trades    : ${metrics.trades}
// Generated : ${new Date().toISOString().slice(0, 10)}
// ═══════════════════════════════════════════════════════════════
strategy("TO: ${name}", overlay=true, default_qty_type=strategy.percent_of_equity, default_qty_value=10, commission_type=strategy.commission.percent, commission_value=0.05)
`;
}

function tpslBlock(tp, sl) {
  return `
// ── Risk management ──────────────────────────────────────────
tp_pct = input.float(${tp}, "Take Profit %", minval=0.1, step=0.1, group="Risk")
sl_pct = input.float(${sl}, "Stop Loss %",   minval=0.1, step=0.1, group="Risk")

strategy_tp_long  = strategy.position_avg_price * (1 + tp_pct / 100)
strategy_sl_long  = strategy.position_avg_price * (1 - sl_pct / 100)
strategy_tp_short = strategy.position_avg_price * (1 - tp_pct / 100)
strategy_sl_short = strategy.position_avg_price * (1 + sl_pct / 100)

if strategy.position_size > 0
    strategy.exit("TP/SL L", limit=strategy_tp_long,  stop=strategy_sl_long)
if strategy.position_size < 0
    strategy.exit("TP/SL S", limit=strategy_tp_short, stop=strategy_sl_short)
`;
}

// ─── Strategy templates ───────────────────────────────────────────────────────

const TEMPLATES = {

  ema_crossover: (p, tp, sl) => `${`
// ── EMA Crossover ────────────────────────────────────────────
fast_len = input.int(${p.fast || 9},  "Fast EMA", minval=1, group="EMA")
slow_len = input.int(${p.slow || 21}, "Slow EMA", minval=1, group="EMA")
use_rsi  = input.bool(${p.rsiPeriod ? 'true' : 'false'}, "RSI Filter", group="Filters")
rsi_len  = input.int(${p.rsiPeriod || 14}, "RSI Period", group="Filters")
rsi_min  = input.float(${p.rsiMin || 40}, "RSI Min (long)", group="Filters")
rsi_max  = input.float(${p.rsiMax || 60}, "RSI Max (short)", group="Filters")

fast_ema = ta.ema(close, fast_len)
slow_ema = ta.ema(close, slow_len)
rsi_val  = ta.rsi(close, rsi_len)

rsi_ok_long  = not use_rsi or (rsi_val >= rsi_min)
rsi_ok_short = not use_rsi or (rsi_val <= (100 - rsi_min))

long_entry  = ta.crossover(fast_ema, slow_ema) and rsi_ok_long
short_entry = ta.crossunder(fast_ema, slow_ema) and rsi_ok_short

plot(fast_ema, "Fast EMA", color=color.new(#00ff88, 0), linewidth=1)
plot(slow_ema, "Slow EMA", color=color.new(#ff4444, 0), linewidth=1)
`}
if long_entry  and strategy.position_size <= 0
    strategy.entry("Long",  strategy.long)
if short_entry and strategy.position_size >= 0
    strategy.entry("Short", strategy.short)
${tpslBlock(tp, sl)}`,

  rsi_reversion: (p, tp, sl) => `
// ── RSI Mean Reversion ───────────────────────────────────────
rsi_len    = input.int(${p.period || 14},   "RSI Period",  group="RSI")
oversold   = input.float(${p.oversold || 30},   "Oversold",    group="RSI")
overbought = input.float(${p.overbought || 70}, "Overbought",  group="RSI")
trend_len  = input.int(${p.trendPeriod || 50},  "Trend EMA",   group="Filters")
use_trend  = input.bool(true, "Use Trend Filter", group="Filters")

rsi_val    = ta.rsi(close, rsi_len)
trend_ema  = ta.ema(close, trend_len)

trend_long  = not use_trend or close >= trend_ema
trend_short = not use_trend or close <= trend_ema

long_entry  = ta.crossover(rsi_val, oversold)   and trend_long
short_entry = ta.crossunder(rsi_val, overbought) and trend_short

hline(oversold,   "Oversold",   color=color.new(color.green, 50))
hline(overbought, "Overbought", color=color.new(color.red,   50))
plot(rsi_val, "RSI", color=color.blue, display=display.pane)

if long_entry  and strategy.position_size <= 0
    strategy.entry("Long",  strategy.long)
if short_entry and strategy.position_size >= 0
    strategy.entry("Short", strategy.short)
${tpslBlock(tp, sl)}`,

  macd_momentum: (p, tp, sl) => `
// ── MACD Momentum ────────────────────────────────────────────
fast_len   = input.int(${p.fast || 12},   "MACD Fast",   group="MACD")
slow_len   = input.int(${p.slow || 26},   "MACD Slow",   group="MACD")
signal_len = input.int(${p.signal || 9},  "Signal",      group="MACD")
trend_len  = input.int(${p.trendPeriod || 50}, "Trend EMA", group="Filters")
use_trend  = input.bool(true, "Use Trend Filter", group="Filters")

[macd_l, signal_l, hist_l] = ta.macd(close, fast_len, slow_len, signal_len)
trend_ema = ta.ema(close, trend_len)

trend_long  = not use_trend or close >= trend_ema
trend_short = not use_trend or close <= trend_ema

long_entry  = ta.crossover(hist_l,  0) and trend_long
short_entry = ta.crossunder(hist_l, 0) and trend_short

plot(hist_l,   "MACD Hist",   color=hist_l >= 0 ? color.new(#00ff88,30) : color.new(#ff4444,30), style=plot.style_histogram, display=display.pane)
plot(macd_l,   "MACD",        color=color.blue,  display=display.pane)
plot(signal_l, "Signal",      color=color.orange, display=display.pane)

if long_entry  and strategy.position_size <= 0
    strategy.entry("Long",  strategy.long)
if short_entry and strategy.position_size >= 0
    strategy.entry("Short", strategy.short)
${tpslBlock(tp, sl)}`,

  bollinger_reversion: (p, tp, sl) => `
// ── Bollinger Band Mean Reversion ────────────────────────────
bb_len     = input.int(${p.period || 20},  "BB Period", group="Bollinger")
bb_mult    = input.float(${p.mult || 2.0}, "BB Mult",   group="Bollinger", step=0.1)
rsi_len    = input.int(${p.rsiPeriod || 14}, "RSI Period", group="Filters")
rsi_os     = input.float(${p.rsiOversold || 35},  "RSI Oversold",  group="Filters")
rsi_ob     = input.float(${p.rsiOverbought || 65}, "RSI Overbought", group="Filters")

[bb_mid, bb_up, bb_lo] = ta.bb(close, bb_len, bb_mult)
rsi_val = ta.rsi(close, rsi_len)

long_entry  = ta.crossover(close, bb_lo) and rsi_val < rsi_os
short_entry = ta.crossunder(close, bb_up) and rsi_val > rsi_ob

plot(bb_up,  "BB Upper", color=color.new(color.red,   50))
plot(bb_mid, "BB Mid",   color=color.new(color.gray,  50))
plot(bb_lo,  "BB Lower", color=color.new(color.green, 50))

if long_entry  and strategy.position_size <= 0
    strategy.entry("Long",  strategy.long)
if short_entry and strategy.position_size >= 0
    strategy.entry("Short", strategy.short)
${tpslBlock(tp, sl)}`,

  bollinger_breakout: (p, tp, sl) => `
// ── Bollinger Band Breakout ───────────────────────────────────
bb_len    = input.int(${p.period || 20},  "BB Period", group="Bollinger")
bb_mult   = input.float(${p.mult || 2.0}, "BB Mult",   group="Bollinger", step=0.1)
vol_len   = input.int(${p.volPeriod || 20}, "Vol MA Period", group="Filters")
vol_mult  = input.float(${p.volMult || 1.5}, "Vol Multiplier", group="Filters", step=0.1)

[bb_mid, bb_up, bb_lo] = ta.bb(close, bb_len, bb_mult)
vol_ma    = ta.sma(volume, vol_len)
vol_spike = volume > vol_ma * vol_mult

long_entry  = ta.crossover(close, bb_up)  and vol_spike
short_entry = ta.crossunder(close, bb_lo) and vol_spike

plot(bb_up,  "BB Upper", color=color.new(color.blue, 30))
plot(bb_mid, "BB Mid",   color=color.new(color.gray, 50))
plot(bb_lo,  "BB Lower", color=color.new(color.blue, 30))

if long_entry  and strategy.position_size <= 0
    strategy.entry("Long",  strategy.long)
if short_entry and strategy.position_size >= 0
    strategy.entry("Short", strategy.short)
${tpslBlock(tp, sl)}`,

  ema_rsi_combo: (p, tp, sl) => `
// ── EMA + RSI Combo ──────────────────────────────────────────
ema_len   = input.int(${p.emaPeriod || 50},    "Trend EMA",  group="Indicators")
rsi_len   = input.int(${p.rsiPeriod || 14},    "RSI Period", group="Indicators")
rsi_thr   = input.float(${p.rsiThreshold || 50}, "RSI Threshold", group="Indicators")

trend_ema = ta.ema(close, ema_len)
rsi_val   = ta.rsi(close, rsi_len)

long_entry  = close > trend_ema and ta.crossover(rsi_val,         rsi_thr)
short_entry = close < trend_ema and ta.crossunder(rsi_val, 100 - rsi_thr)

plot(trend_ema, "Trend EMA", color=color.new(#00ff88, 0), linewidth=2)

if long_entry  and strategy.position_size <= 0
    strategy.entry("Long",  strategy.long)
if short_entry and strategy.position_size >= 0
    strategy.entry("Short", strategy.short)
${tpslBlock(tp, sl)}`,

  atr_breakout: (p, tp, sl) => `
// ── ATR Breakout ─────────────────────────────────────────────
atr_len    = input.int(${p.period || 14},   "ATR Period",   group="Indicators")
lb_bars    = input.int(${p.lookback || 10}, "Lookback Bars", group="Indicators")
atr_mult   = input.float(${p.atrMult || 0.5}, "ATR Multiplier", group="Indicators", step=0.1)
trend_len  = input.int(${p.trendPeriod || 50}, "Trend EMA", group="Filters")
use_trend  = input.bool(true, "Use Trend Filter", group="Filters")

atr_val    = ta.atr(atr_len)
trend_ema  = ta.ema(close, trend_len)
recent_hi  = ta.highest(high, lb_bars)[1]
recent_lo  = ta.lowest(low,  lb_bars)[1]

trend_long  = not use_trend or close >= trend_ema
trend_short = not use_trend or close <= trend_ema

long_entry  = close > recent_hi + atr_val * atr_mult and trend_long
short_entry = close < recent_lo - atr_val * atr_mult and trend_short

plot(trend_ema, "Trend EMA", color=color.new(color.yellow, 30))

if long_entry  and strategy.position_size <= 0
    strategy.entry("Long",  strategy.long)
if short_entry and strategy.position_size >= 0
    strategy.entry("Short", strategy.short)
${tpslBlock(tp, sl)}`,

  stoch_rsi: (p, tp, sl) => `
// ── Stochastic RSI ───────────────────────────────────────────
rsi_len    = input.int(${p.rsiPeriod || 14},   "RSI Length",    group="Stoch RSI")
stoch_len  = input.int(${p.stochPeriod || 14}, "Stoch Length",  group="Stoch RSI")
k_smooth   = input.int(${p.kSmooth || 3},      "K Smooth",      group="Stoch RSI")
d_smooth   = input.int(${p.dSmooth || 3},      "D Smooth",      group="Stoch RSI")
os         = input.float(${p.oversold || 20},  "Oversold",      group="Stoch RSI")
ob         = input.float(${p.overbought || 80}, "Overbought",   group="Stoch RSI")
trend_len  = input.int(${p.trendPeriod || 50}, "Trend EMA",     group="Filters")
use_trend  = input.bool(true, "Use Trend Filter", group="Filters")

rsi_1      = ta.rsi(close, rsi_len)
stoch_rsi  = ta.stoch(rsi_1, rsi_1, rsi_1, stoch_len)
k          = ta.sma(stoch_rsi, k_smooth)
d          = ta.sma(k, d_smooth)
trend_ema  = ta.ema(close, trend_len)

trend_long  = not use_trend or close >= trend_ema
trend_short = not use_trend or close <= trend_ema

long_entry  = ta.crossover(k, d)  and k < os and trend_long
short_entry = ta.crossunder(k, d) and k > ob and trend_short

plot(k, "%K", color=color.blue,   display=display.pane)
plot(d, "%D", color=color.orange, display=display.pane)
hline(os, "Oversold",   color=color.new(color.green, 50), display=display.pane)
hline(ob, "Overbought", color=color.new(color.red,   50), display=display.pane)

if long_entry  and strategy.position_size <= 0
    strategy.entry("Long",  strategy.long)
if short_entry and strategy.position_size >= 0
    strategy.entry("Short", strategy.short)
${tpslBlock(tp, sl)}`,
};

// ─── Public API ───────────────────────────────────────────────────────────────

function generate(strategy, symbol, timeframe, metrics) {
  const { type, params, tp = 1.5, sl = 0.8 } = strategy;
  const fn = TEMPLATES[type];
  if (!fn) return `// No Pine Script template for strategy type: ${type}`;

  const cleanParams = { ...params };
  delete cleanParams._cache;

  const name = type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  return header(name, symbol, timeframe, metrics) + fn(cleanParams, tp, sl);
}

module.exports = { generate };
