# HUNTER — ICT/SMC Strategy Rules

## Overview
HUNTER trades intraday using ICT (Inner Circle Trader) and Smart Money Concepts.
Universe: Top-40 Bitget futures. Capital: $5. Min RR: 1:3. Risk per trade: 1–2%.

---

## Top-Down Analysis (mandatory, every trade)

```
Daily → 4H → 1H
```

1. **Daily** — identify trend direction, major OBs, HTF liquidity pools (equal highs/lows, previous day high/low)
2. **4H** — locate active Order Blocks, FVGs, current range (Premium vs Discount)
3. **1H** — wait for Market Structure Shift (MSS) confirming HTF bias, then enter

Never trade against the Daily trend unless there is a clear MSS on 4H.

---

## Key Concepts

### Order Block (OB)
- Last bearish candle before a strong bullish move (Bullish OB) or last bullish candle before a strong bearish move (Bearish OB)
- Valid OB: causes a structural break, leaves an imbalance (FVG) on departure
- Entry zone: 50–100% of the OB candle body (prefer the wick-to-body area)
- Invalidated if price closes a full candle body through the opposite end of the OB

### Fair Value Gap (FVG) / Imbalance
- Three-candle pattern: candle N+1 low > candle N-1 high (bullish FVG) or candle N+1 high < candle N-1 low (bearish FVG)
- Price returns to fill inefficiency before continuing
- Best entries: FVG that overlaps with an OB on the same timeframe (confluence)
- Fresh FVGs (not yet touched) are higher probability

### Market Structure Shift (MSS)
- Bullish MSS: price breaks above a recent swing high on 1H after a downmove (signals bullish intent on intraday)
- Bearish MSS: price breaks below a recent swing low on 1H after an upmove
- Confirms HTF bias is activating at the current price level

### Premium / Discount Zones
- Use Fibonacci on the last major swing (swing low → swing high for bullish, reversed for bearish)
- **Discount** (0–50%): buy zone for bullish setups
- **Premium** (50–100%): sell zone for bearish setups
- Equilibrium (50%): avoid entries here — too uncertain

### Liquidity
- **Buy-side liquidity**: equal highs, previous day/week high, stop clusters above resistance
- **Sell-side liquidity**: equal lows, previous day/week low, stop clusters below support
- Price seeks liquidity before reversing — use as TP targets
- Do NOT enter when price is already at a liquidity pool (likely to sweep and reverse)


---

## Entry Rules (all conditions required)

1. **HTF bias confirmed** — Daily trend + 4H OB/FVG identified
2. **Price in Discount (longs) or Premium (shorts)** — Fibonacci filter
3. **Price reaches 4H OB or FVG zone**
4. **1H MSS** — structure shift in direction of HTF bias within the zone



Entry type: **limit order** placed at the OB/FVG midpoint or 50% of OB.
Never market order unless there is a confirmed 1H close through structure.

---

## Stop Loss

- Place **behind the Order Block** (below the OB low for longs, above the OB high for shorts)
- Add 0.1–0.2% buffer beyond the wick to avoid premature stops
- Maximum SL size: 2% of $5 = $0.10

---

## Take Profit

- **TP1**: nearest liquidity pool (equal highs/lows, previous session high/low) — minimum 1:3 RR
- **TP2**: major HTF liquidity (Daily swing high/low, weekly level) — 1:5+ RR
- Preferred approach: move SL to breakeven at TP1, let remainder run to TP2

---

## Invalidation / Trade Management

- If price returns inside the OB body (full candle close) before MSS → cancel limit order
- If MSS fails (price re-breaks the structure level in opposite direction) → exit immediately
- Daily drawdown >3% → no new HUNTER trades regardless of setup quality
- HUNTER agent drawdown >5% → halt until manual `/resume`

---

## Setup Quality Checklist

| # | Check                                              | Required |
|---|----------------------------------------------------|----------|
| 1 | Daily bias clear (not ranging)                     | Yes      |
| 2 | 4H OB or FVG identified, fresh (untouched)         | Yes      |
| 3 | Price in correct Premium/Discount zone             | Yes      |
| 4 | 1H MSS in direction of bias                        | Yes      |
| 5 | Kill zone active at time of entry                  | Yes      |
| 6 | RR ≥ 1:3 with SL behind the OB                    | Yes      |
| 7 | OB + FVG overlap (confluence)                      | Bonus    |
| 8 | Liquidity sweep before reversal (stop hunt)        | Bonus    |

Minimum 6/6 required checkboxes to take the trade.
