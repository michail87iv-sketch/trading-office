// core/backtest/strategySmcHunter.js
'use strict';
// SMC Hunter strategy (Pattern B) for Phase 3 baseline.
//
// Setup priority (first match wins, strict bias_1D for all):
//   FP variants > FVG variants > RB > SNR
// Rationale: FP and FVG are more selective; if a bar happens to satisfy multiple,
// the more restrictive trigger should win. Tunable post-baseline.

const { precomputeSMC } = require('../smc');
const { alignFromCtx }  = require('../smc/multiTF');
const { detectSNRSetup } = require('../smc/setups/snr');
const { detectRBSetup }  = require('../smc/setups/rb');
const { detectFVGSetup } = require('../smc/setups/fvg');
const { detectFPSetup }  = require('../smc/setups/fp');

const DETECTORS = [detectFPSetup, detectFVGSetup, detectRBSetup, detectSNRSetup];

module.exports = {
  requiredTimeframes: ['1H', '4H', '1D'],

  buildStrategy(_config = {}) {
    return {
      precompute(symbol, candlesByTF) {
        const candles1H = candlesByTF['1H'] || [];
        const candles4H = candlesByTF['4H'] || [];
        const candles1D = candlesByTF['1D'] || [];

        const ctx1H = precomputeSMC(candles1H);
        const ctx4H = precomputeSMC(candles4H);
        const ctx1D = precomputeSMC(candles1D);
        const aligned = alignFromCtx(ctx1H, ctx4H, ctx1D, candles1H, candles4H, candles1D);

        return { symbol, ctx1H, ctx4H, ctx1D, aligned, candles1H, candles4H, candles1D };
      },

      signal(idx, ctx) {
        if (!ctx.candles1H[idx]) return null;
        for (const fn of DETECTORS) {
          const out = fn(idx, ctx);
          if (out) return out;
        }
        return null;
      },
    };
  },
};
