'use strict';

/**
 * TradeSimulator — candle-by-candle backtesting engine for S1-style strategies.
 *
 * Usage:
 *   const sim = new TradeSimulator({ leverage:15, riskPct:1.5, tp:0.7, sl:0.4,
 *                                    maxTrades:3, initialCapital:5 });
 *   for (let i = 0; i < candles.length; i++) {
 *     const signal = getSignal(candles, i, params);
 *     sim.processCandle(candles[i], signal);
 *   }
 *   const results = sim.getResults();
 */
class TradeSimulator {
  /**
   * @param {Object} params
   * @param {number}  params.leverage        e.g. 15
   * @param {number}  params.riskPct         % of capital risked per trade, e.g. 1.5
   * @param {number}  params.tp              take-profit %, e.g. 0.7
   * @param {number}  params.sl              stop-loss %,   e.g. 0.4
   * @param {number}  params.maxTrades       max concurrent open positions, e.g. 3
   * @param {number}  params.initialCapital  starting capital in USD, e.g. 5
   * @param {number}  [params.feeRate=0.0006] taker fee per side (0.06%)
   * @param {number}  [params.cooldownMin=30] minutes to skip new entries after a SL hit
   * @param {number}  [params.tradeLimit=0]  max total closed trades before stopping new entries (0 = unlimited)
   */
  constructor(params = {}) {
    const {
      leverage       = 15,
      riskPct        = 1.5,
      tp             = 0.7,
      sl             = 0.4,
      maxTrades      = 3,
      initialCapital = 5,
      feeRate        = 0.0006,
      cooldownMin    = 30,
      tradeLimit     = 0,
    } = params;

    if (tp >= 100) {
      throw new Error(
        `TP=${tp}% is a price-distance %, not a PnL %. ` +
        `A value ≥ 100% makes SHORT take-profits physically impossible (negative price). ` +
        `For ${tp}% PnL at ${leverage}x leverage use TP = ${+(tp / leverage).toFixed(2)}%.`
      );
    }

    this.leverage       = leverage;
    this.riskPct        = riskPct;
    this.tpPct          = tp / 100;
    this.slPct          = sl / 100;
    this.maxTrades      = maxTrades;
    this.feeRate        = feeRate;
    this.cooldownMs     = cooldownMin * 60_000;
    this.tradeLimit     = tradeLimit;

    this.capital        = initialCapital;
    this.initialCapital = initialCapital;

    // State
    this.openTrades     = [];          // active positions
    this.trades         = [];          // all closed trades
    this.equityCurve    = [];          // { time, capital } per candle
    this.lastSlTime     = null;        // ms timestamp of last SL hit
    this.peakCapital    = initialCapital;
    this.maxDrawdown    = 0;
  }

  // ─── Core ──────────────────────────────────────────────────────────────────

  /**
   * Process one candle and an optional signal for that bar.
   * Order of operations per candle:
   *   1. Check TP/SL for all open positions (uses candle high/low)
   *   2. If signal && slots available && not in cooldown → open new position at candle close
   *   3. Record equity
   *
   * @param {{time,open,high,low,close,volume}} candle
   * @param {'long'|'short'|null} signal
   */
  processCandle(candle, signal) {
    // 1. Check existing positions
    this._checkPositions(candle);

    // Normalise signal: legacy 'long'|'short' string OR { direction, tpPrice?, slPrice? }
    let sigObj = null;
    if (signal === 'long' || signal === 'short') {
      sigObj = { direction: signal };
    } else if (signal && typeof signal === 'object' && (signal.direction === 'long' || signal.direction === 'short')) {
      sigObj = signal;
    }

    // 2. Open new position
    if (
      sigObj &&
      this.openTrades.length < this.maxTrades &&
      !this._inCooldown(candle.time) &&
      (this.tradeLimit === 0 || this.trades.length < this.tradeLimit)
    ) {
      this._openTrade(candle, sigObj);
    }

    // 3. Record equity (unrealised PnL not counted — conservative)
    this.equityCurve.push({ time: candle.time, capital: +this.capital.toFixed(6) });
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  _inCooldown(time) {
    if (this.lastSlTime === null) return false;
    return time - this.lastSlTime < this.cooldownMs;
  }

  _openTrade(candle, sig) {
    const direction = sig.direction;
    const entry     = candle.close;
    const isLong    = direction === 'long';

    const slPrice = (sig.slPrice != null)
      ? sig.slPrice
      : (isLong ? entry * (1 - this.slPct) : entry * (1 + this.slPct));

    const tpPrice = (sig.tpPrice != null)
      ? sig.tpPrice
      : (isLong ? entry * (1 + this.tpPct) : entry * (1 - this.tpPct));

    // Position sizing: risk a fixed % of current capital on the SL distance
    const riskUSDT  = this.capital * (this.riskPct / 100);
    const slGap     = Math.abs(entry - slPrice);
    const contracts = slGap > 0 ? riskUSDT / slGap : 0;
    if (contracts <= 0) return;

    const notional  = contracts * entry;
    const openFee   = notional * this.feeRate;
    this.capital   -= openFee;                      // fee paid on entry

    this.openTrades.push({
      direction,
      entry,
      tp: tpPrice,
      sl: slPrice,
      contracts,
      notional,
      openedAt: candle.time,
      setupType: sig.setupType ?? null,
      meta:      sig.meta ?? null,
    });
  }

  _checkPositions(candle) {
    const remaining = [];

    for (const trade of this.openTrades) {
      const { direction, entry, tp, sl, contracts } = trade;
      const isLong = direction === 'long';

      // Conservative: check SL first (if both levels are inside the candle, SL wins)
      const slHit = isLong ? candle.low  <= sl : candle.high >= sl;
      const tpHit = isLong ? candle.high >= tp : candle.low  <= tp;

      if (!slHit && !tpHit) {
        remaining.push(trade);
        continue;
      }

      const exitPrice = slHit ? sl : tp;
      const reason    = slHit ? 'SL' : 'TP';

      // Gross PnL
      const rawPnl    = contracts * (isLong ? exitPrice - entry : entry - exitPrice);
      const closeFee  = contracts * exitPrice * this.feeRate;
      const netPnl    = +(rawPnl - closeFee).toFixed(6);

      this.capital   += netPnl;
      if (this.capital > this.peakCapital) this.peakCapital = this.capital;

      const dd = (this.peakCapital - this.capital) / this.peakCapital;
      if (dd > this.maxDrawdown) this.maxDrawdown = dd;

      if (slHit) this.lastSlTime = candle.time;

      this.trades.push({
        direction,
        entry:     +entry.toFixed(6),
        exit:      +exitPrice.toFixed(6),
        reason,
        pnl:       netPnl,
        openedAt:  trade.openedAt,
        closedAt:  candle.time,
        contracts: +contracts.toFixed(8),
        setupType: trade.setupType ?? null,
        meta:      trade.meta ?? null,
      });
    }

    this.openTrades = remaining;
  }

  // ─── Results ───────────────────────────────────────────────────────────────

  /**
   * Returns the full backtest results after all candles have been processed.
   * @returns {{ trades, equityCurve, stats }}
   */
  getResults() {
    const wins   = this.trades.filter((t) => t.pnl > 0).length;
    const losses = this.trades.filter((t) => t.pnl <= 0).length;
    const total  = this.trades.length;
    const totalPnl = +this.trades.reduce((s, t) => s + t.pnl, 0).toFixed(4);

    const sharpe = this._calcSharpe();

    return {
      trades:      this.trades,
      equityCurve: this.equityCurve,
      stats: {
        initialCapital: +this.initialCapital.toFixed(4),
        finalCapital:   +this.capital.toFixed(4),
        totalPnl,
        totalTrades:    total,
        wins,
        losses,
        winRate:        total > 0 ? +(wins / total).toFixed(4) : 0,
        maxDrawdown:    +(this.maxDrawdown * 100).toFixed(2),   // in %
        sharpeRatio:    sharpe,
      },
    };
  }

  _calcSharpe() {
    if (this.equityCurve.length < 2) return null;

    // Group equity by calendar day → compute daily returns
    const byDay = new Map();
    for (const { time, capital } of this.equityCurve) {
      const day = new Date(time).toISOString().slice(0, 10);
      byDay.set(day, capital);
    }

    const days    = [...byDay.values()];
    if (days.length < 2) return null;

    const returns = [];
    for (let i = 1; i < days.length; i++) {
      if (days[i - 1] > 0) returns.push((days[i] - days[i - 1]) / days[i - 1]);
    }
    if (returns.length < 2) return null;

    const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
    const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1);
    const std = Math.sqrt(variance);

    if (std === 0) return null;
    return +(mean / std * Math.sqrt(252)).toFixed(3);
  }

  /** Force-close all open positions at the given price (e.g. for end-of-test cleanup). */
  closeAll(price, time) {
    for (const trade of this.openTrades) {
      const isLong  = trade.direction === 'long';
      const rawPnl  = trade.contracts * (isLong ? price - trade.entry : trade.entry - price);
      const fee     = trade.contracts * price * this.feeRate;
      const netPnl  = +(rawPnl - fee).toFixed(6);
      this.capital += netPnl;
      this.trades.push({
        direction:  trade.direction,
        entry:      +trade.entry.toFixed(6),
        exit:       +price.toFixed(6),
        reason:     'END',
        pnl:        netPnl,
        openedAt:   trade.openedAt,
        closedAt:   time,
        contracts:  +trade.contracts.toFixed(8),
        setupType:  trade.setupType ?? null,
        meta:       trade.meta ?? null,
      });
    }
    this.openTrades = [];
  }
}

module.exports = { TradeSimulator };
