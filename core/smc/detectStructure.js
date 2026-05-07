// core/smc/detectStructure.js
'use strict';

/**
 * Detect BOS, FakeBOS, and Conf by scanning candles against precomputed swings.
 *
 * Strong/Weak rule:
 *   - 'strong' → the prior swing (departure point before the impulse) is tagged
 *                ONLY after Conf is confirmed (new swing forms in BOS direction).
 *   - 'weak'   → all other swings (including the broken one) remain weak.
 *
 * Conf rule: a NEW swing point forms in the BOS direction AND its price is
 *            beyond the BOS price (new HH for bullish, new LL for bearish).
 *
 * Mutates swings[].strength in place.
 *
 * @param {Array}        candles  OHLCV candles
 * @param {SwingPoint[]} swings   Output of detectSwings()
 * @returns {Structure[]}
 */
function detectStructure(candles, swings) {
  if (!swings.length) return [];

  const structures = [];

  const swingsByIndex = new Map();
  for (const s of swings) {
    if (!swingsByIndex.has(s.index)) swingsByIndex.set(s.index, []);
    swingsByIndex.get(s.index).push(s);
  }

  let lastHigh    = null;  // most recent swing high not yet broken
  let lastLow     = null;  // most recent swing low not yet broken
  let pendingBOS  = null;  // { direction, bosPrice, brokenSwingIndex, brokenSwingPrice, priorSwing }

  for (let i = 0; i < candles.length; i++) {
    const here = swingsByIndex.get(i) || [];
    // Register new swings first — they may be the Conf trigger
    for (const s of here) {
      if (s.type === 'high') lastHigh = s;
      if (s.type === 'low')  lastLow  = s;
    }

    const c = candles[i];

    // --- Check for Conf on pending BOS ---
    // Conf = a new swing in the BOS direction whose price extends beyond bosPrice
    if (pendingBOS) {
      for (const ns of here) {
        const isConf =
          pendingBOS.direction === 'bullish'
            ? ns.type === 'high' && ns.price > pendingBOS.bosPrice
            : ns.type === 'low'  && ns.price < pendingBOS.bosPrice;

        if (isConf) {
          structures.push({
            index: i, type: 'Conf', direction: pendingBOS.direction,
            brokenSwingIndex: pendingBOS.brokenSwingIndex,
            brokenSwingPrice: pendingBOS.brokenSwingPrice,
            price: ns.price,
          });
          // Tag the PRIOR swing (departure point) as strong — not the broken one
          if (pendingBOS.priorSwing) pendingBOS.priorSwing.strength = 'strong';
          pendingBOS = null;
          break;
        }
      }
    }

    // --- Bullish BOS: close above last swing high ---
    if (lastHigh && c.close > lastHigh.price) {
      const event = {
        index: i, type: 'BOS', direction: 'bullish',
        brokenSwingIndex: lastHigh.index,
        brokenSwingPrice: lastHigh.price,
        price: c.close,
      };
      structures.push(event);
      pendingBOS = {
        direction: 'bullish', bosPrice: c.close,
        brokenSwingIndex: lastHigh.index, brokenSwingPrice: lastHigh.price,
        priorSwing: lastLow,   // the swing LOW from which the impulse departed
      };
      lastHigh = null;
    }
    // --- Bearish BOS: close below last swing low ---
    else if (lastLow && c.close < lastLow.price) {
      const event = {
        index: i, type: 'BOS', direction: 'bearish',
        brokenSwingIndex: lastLow.index,
        brokenSwingPrice: lastLow.price,
        price: c.close,
      };
      structures.push(event);
      pendingBOS = {
        direction: 'bearish', bosPrice: c.close,
        brokenSwingIndex: lastLow.index, brokenSwingPrice: lastLow.price,
        priorSwing: lastHigh,  // the swing HIGH from which the impulse departed
      };
      lastLow = null;
    }
    // --- FakeBOS: wick breaks but close stays inside ---
    else {
      if (lastHigh && c.high > lastHigh.price && c.close < lastHigh.price) {
        structures.push({
          index: i, type: 'FakeBOS', direction: 'bullish',
          brokenSwingIndex: lastHigh.index, brokenSwingPrice: lastHigh.price,
          price: c.close,
        });
      }
      if (lastLow && c.low < lastLow.price && c.close > lastLow.price) {
        structures.push({
          index: i, type: 'FakeBOS', direction: 'bearish',
          brokenSwingIndex: lastLow.index, brokenSwingPrice: lastLow.price,
          price: c.close,
        });
      }
    }
  }

  return structures;
}

module.exports = { detectStructure };
