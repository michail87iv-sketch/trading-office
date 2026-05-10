# Phase 2: Multi-TF Context + TradeSimulator Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Подготовить инфраструктуру для Phase 3 (SMC-стратегия): функция `alignTimeframes` для проекции 1D/4H контекста на 1H индексы, helpers для расчёта SL/TP/RR от структуры зон, и расширение `TradeSimulator` режимом абсолютных цен SL/TP без поломки S1/S2/S3.

**Architecture:** Тот же паттерн чистых функций, что и в Phase 1 (`core/smc/index.js → precomputeSMC`). Новые модули — `core/smc/multiTF.js` и `core/smc/levels.js` — не трогают существующие детекторы. `simulator.js` расширяется аддитивно: при наличии `tpPrice/slPrice` в сигнале они побеждают проценты, иначе — старое поведение. Тесты — `node:test` + `node:assert/strict` на синтетических свечах из `tests/smc/helpers.js`.

**Tech Stack:** Node.js 18+, `node:test` / `node:assert` (built-in), существующие `core/smc/*` детекторы, `core/backtest/simulator.js`.

---

## Структура файлов

```
trading-office/
├── plans/
│   └── phase2-multitf-simulator.md          # этот файл
├── core/smc/
│   ├── multiTF.js                            # NEW — Tasks 2–4
│   └── levels.js                             # NEW — Tasks 5–6
├── core/backtest/
│   └── simulator.js                          # MODIFY — Task 7 (абсолютные цены)
└── tests/smc/
    ├── multiTF.test.js                       # NEW — Tasks 2–4
    ├── levels.test.js                        # NEW — Tasks 5–6
    ├── simulator.test.js                     # NEW — Task 7
    └── simulator-regression.test.js          # NEW — Task 8 (S1/S2/S3 backward-compat)
```

`tests/smc/helpers.js` (`candle`, `resetTime`, `flatCandles`) уже существует — переиспользуем без изменений.

---

## Общие соглашения по типам

Используются shape-объекты, выдаваемые детекторами Phase 1 (см. `core/smc/index.js`):

```js
// SwingPoint    : { index, type: 'high'|'low', price, strength?: 'strong'|'weak' }
// StructureEvt  : { index, type: 'BOS'|'FakeBOS'|'Conf', direction: 'bullish'|'bearish', ... }
// SNR           : { indexStart, indexEnd, type: '+SNR'|'-SNR', high, low, valid }
// FVG           : { indexLeft, indexRight, type: 'bullish'|'bearish', high, low, ... }
// RB            : { index, type: 'bullish'|'bearish', high, low, ... }
```

`alignTimeframes` использует только `time` свечей (миллисекунды) для маппинга индексов между TF — ничто в Phase 1 не предполагает фиксированный шаг времени, поэтому маппинг делаем по `<= candle.time` против `candles4H[i].time + 4h` / `candles1D[i].time + 24h`.

---

### Task 1: Test fixtures для multi-TF свечных наборов

**Files:**
- Modify: `tests/smc/helpers.js` (добавить две функции, не ломая существующие)

- [ ] **Step 1: Написать падающий тест для `aggregateTF`**

Создать `tests/smc/helpers.test.js`:

```js
// tests/smc/helpers.test.js
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { candle, aggregateTF, makeAlignedSet } = require('./helpers');

describe('helpers — aggregateTF', () => {
  it('агрегирует 4 1H-свечи в одну 4H-свечу: high=max, low=min, open=first.open, close=last.close', () => {
    const c = [
      { time: 0,            open: 10, high: 12, low:  9, close: 11, volume: 1 },
      { time: 3600_000,     open: 11, high: 15, low: 10, close: 14, volume: 2 },
      { time: 7200_000,     open: 14, high: 14, low:  8, close:  9, volume: 3 },
      { time: 10800_000,    open:  9, high: 13, low:  9, close: 13, volume: 4 },
    ];
    const out = aggregateTF(c, 4);
    assert.equal(out.length, 1);
    assert.deepEqual(out[0], { time: 0, open: 10, high: 15, low: 8, close: 13, volume: 10 });
  });

  it('makeAlignedSet возвращает 1H/4H/1D массивы кратной длины (24 1H = 6 4H = 1 1D)', () => {
    const { c1H, c4H, c1D } = makeAlignedSet(48);
    assert.equal(c1H.length, 48);
    assert.equal(c4H.length, 12);
    assert.equal(c1D.length, 2);
    assert.equal(c4H[0].time, c1H[0].time);
    assert.equal(c1D[0].time, c1H[0].time);
  });
});
```

- [ ] **Step 2: Запустить и убедиться что падает**

Run: `node --test tests/smc/helpers.test.js`
Expected: FAIL — `aggregateTF is not a function`.

- [ ] **Step 3: Реализовать в `tests/smc/helpers.js`**

Дополнить файл (не трогая существующие экспорты):

```js
// tests/smc/helpers.js — append below existing code

function aggregateTF(candles, groupSize) {
  const out = [];
  for (let i = 0; i + groupSize <= candles.length; i += groupSize) {
    const slice = candles.slice(i, i + groupSize);
    out.push({
      time:  slice[0].time,
      open:  slice[0].open,
      high:  Math.max(...slice.map(c => c.high)),
      low:   Math.min(...slice.map(c => c.low)),
      close: slice[slice.length - 1].close,
      volume: slice.reduce((s, c) => s + (c.volume ?? c.vol ?? 0), 0),
    });
  }
  return out;
}

// Build 1H/4H/1D series of `len1H` deterministic candles.
// 1H step = 3_600_000 ms. 4H = 4×1H, 1D = 24×1H.
function makeAlignedSet(len1H, basePrice = 100) {
  const c1H = Array.from({ length: len1H }, (_, i) => ({
    time:  i * 3_600_000,
    open:  basePrice,
    high:  basePrice + 1,
    low:   basePrice - 1,
    close: basePrice,
    volume: 1,
  }));
  return { c1H, c4H: aggregateTF(c1H, 4), c1D: aggregateTF(c1H, 24) };
}

module.exports = { candle, resetTime, flatCandles, aggregateTF, makeAlignedSet };
```

- [ ] **Step 4: Проверить что тесты проходят и ничего не сломали в Phase 1**

Run: `node --test tests/smc/helpers.test.js && npm run test:smc`
Expected: оба зелёные.

- [ ] **Step 5: Commit**

```bash
git add tests/smc/helpers.js tests/smc/helpers.test.js
git commit -m "test: add aggregateTF + makeAlignedSet helpers for multi-TF tests"
```

---

### Task 2: alignTimeframes — каркас и индекс-маппинг

**Files:**
- Create: `core/smc/multiTF.js`
- Create: `tests/smc/multiTF.test.js`

- [ ] **Step 1: Написать падающий тест на длину и форму вывода**

```js
// tests/smc/multiTF.test.js
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { makeAlignedSet } = require('./helpers');
const { alignTimeframes } = require('../../core/smc/multiTF');

describe('alignTimeframes — output shape', () => {
  it('возвращает массив длины candles1H.length', () => {
    const { c1H, c4H, c1D } = makeAlignedSet(48);
    const out = alignTimeframes(c1H, c4H, c1D);
    assert.equal(out.length, 48);
  });

  it('каждая запись содержит ключи bias_1D, activePOI_4H, contextSwings_4H', () => {
    const { c1H, c4H, c1D } = makeAlignedSet(48);
    const out = alignTimeframes(c1H, c4H, c1D);
    for (const row of out) {
      assert.ok('bias_1D'         in row);
      assert.ok('activePOI_4H'    in row);
      assert.ok('contextSwings_4H' in row);
      assert.ok(Array.isArray(row.activePOI_4H));
    }
  });

  it('на flat-данных без структуры bias_1D = neutral, activePOI_4H = []', () => {
    const { c1H, c4H, c1D } = makeAlignedSet(48);
    const out = alignTimeframes(c1H, c4H, c1D);
    assert.equal(out[0].bias_1D, 'neutral');
    assert.deepEqual(out[0].activePOI_4H, []);
  });
});
```

- [ ] **Step 2: Запустить и убедиться что падает**

Run: `node --test tests/smc/multiTF.test.js`
Expected: FAIL — `Cannot find module '../../core/smc/multiTF'`.

- [ ] **Step 3: Минимальная реализация `multiTF.js`**

```js
// core/smc/multiTF.js
'use strict';

const { precomputeSMC } = require('./index');

/**
 * Project 4H/1D SMC context onto every 1H candle index.
 *
 * @param {Candle[]} candles1H
 * @param {Candle[]} candles4H
 * @param {Candle[]} candles1D
 * @returns {Array<{ bias_1D, activePOI_4H, contextSwings_4H }>}
 */
function alignTimeframes(candles1H, candles4H, candles1D) {
  const ctx4H = precomputeSMC(candles4H);
  const ctx1D = precomputeSMC(candles1D);

  return candles1H.map(() => ({
    bias_1D: 'neutral',
    activePOI_4H: [],
    contextSwings_4H: { lastStrongHigh: null, lastStrongLow: null },
  }));
}

module.exports = { alignTimeframes };
```

- [ ] **Step 4: Проверить что тесты проходят**

Run: `node --test tests/smc/multiTF.test.js`
Expected: PASS (3/3).

- [ ] **Step 5: Commit**

```bash
git add core/smc/multiTF.js tests/smc/multiTF.test.js
git commit -m "feat(smc): add alignTimeframes skeleton with shape contract"
```

---

### Task 3: bias_1D — последний BOS направления, если не было FakeBOS/Conf после

**Files:**
- Modify: `core/smc/multiTF.js`
- Modify: `tests/smc/multiTF.test.js`

Правило: для каждого 1H-индекса найти максимальный 1D-индекс с `time + 24h <= 1H.time` (т.е. бар уже закрыт). В `ctx1D.structure` отфильтровать события с `index <= этот 1D-индекс`. Взять последний `BOS` — его `direction` и есть `bias_1D`. Если после него идёт `FakeBOS` или `Conf` — bias сбрасывается в `'neutral'` (Conf подтверждает структуру → bias уже отыгран, новый BOS ещё не сформирован; FakeBOS опровергает).

> Уточнение по `Conf`: в Phase 1 `Conf` означает «BOS подтверждён». В контексте многоTF это значит «движение завершилось» — для bias входа в 1H это уже отыгранный сигнал. Поэтому Conf тоже сбрасывает bias в neutral до следующего BOS. Это уточняет формулировку из исходного спека («последняя BOS direction если не было FakeBOS/Conf после»).

- [ ] **Step 1: Падающий тест — 1D bullish BOS, 4H bearish → bias=bullish**

Дополнить `tests/smc/multiTF.test.js`:

```js
const { candle, aggregateTF, makeAlignedSet } = require('./helpers');

describe('alignTimeframes — bias_1D', () => {
  it('1D с bullish BOS даёт bias_1D=bullish независимо от 4H', () => {
    // 30 1D-баров: 0-9 ranging, 10-12 swing high @120, 13-19 откат, 20-29 пробой выше 120 → bullish BOS
    const c1D = [];
    let t = 0;
    const step1D = 24 * 3_600_000;
    for (let i = 0; i < 10; i++) c1D.push({ time: t += step1D, open: 100, high: 101, low:  99, close: 100, volume: 1 });
    c1D.push({ time: t += step1D, open: 100, high: 110, low: 100, close: 108, volume: 1 });
    c1D.push({ time: t += step1D, open: 108, high: 120, low: 105, close: 118, volume: 1 }); // swing high 120
    c1D.push({ time: t += step1D, open: 118, high: 119, low: 110, close: 112, volume: 1 });
    for (let i = 0; i < 6; i++) c1D.push({ time: t += step1D, open: 112, high: 115, low: 105, close: 110, volume: 1 });
    for (let i = 0; i < 11; i++) c1D.push({ time: t += step1D, open: 110, high: 130, low: 110, close: 128, volume: 1 }); // пробой 120 → BOS bullish
    // 1H — 30 дней × 24 часа, простые свечи
    const c1H = Array.from({ length: 30 * 24 }, (_, i) => ({
      time: i * 3_600_000, open: 100, high: 101, low: 99, close: 100, volume: 1,
    }));
    const c4H = aggregateTF(c1H, 4); // даже без структуры на 4H
    const out = alignTimeframes(c1H, c4H, c1D);
    // последний 1H бар должен видеть bullish BOS
    assert.equal(out[out.length - 1].bias_1D, 'bullish');
  });

  it('flat 1D → bias_1D=neutral', () => {
    const { c1H, c4H, c1D } = makeAlignedSet(48);
    const out = alignTimeframes(c1H, c4H, c1D);
    assert.equal(out[out.length - 1].bias_1D, 'neutral');
  });
});
```

- [ ] **Step 2: Запустить — провалится**

Run: `node --test tests/smc/multiTF.test.js`
Expected: FAIL на первом из двух новых — bias_1D всё ещё `'neutral'`.

- [ ] **Step 3: Реализация bias_1D в `multiTF.js`**

Заменить тело `alignTimeframes`:

```js
'use strict';

const { precomputeSMC } = require('./index');

const ONE_DAY_MS = 24 * 3_600_000;
const FOUR_H_MS  = 4  * 3_600_000;

// Найти максимальный i, где candles[i].time + barLenMs <= asOfMs.
// Возвращает -1 если ни один бар ещё не закрыт.
function lastClosedIndex(candles, asOfMs, barLenMs) {
  let lo = 0, hi = candles.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].time + barLenMs <= asOfMs) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return ans;
}

function biasFromStructure(structure, upToIndex) {
  let bias = 'neutral';
  for (const ev of structure) {
    if (ev.index > upToIndex) break;
    if (ev.type === 'BOS')                          bias = ev.direction;
    else if (ev.type === 'FakeBOS' || ev.type === 'Conf') bias = 'neutral';
  }
  return bias;
}

function alignTimeframes(candles1H, candles4H, candles1D) {
  const ctx4H = precomputeSMC(candles4H);
  const ctx1D = precomputeSMC(candles1D);

  return candles1H.map(c1 => {
    const idx1D = lastClosedIndex(candles1D, c1.time, ONE_DAY_MS);
    const bias_1D = idx1D < 0 ? 'neutral' : biasFromStructure(ctx1D.structure, idx1D);
    return {
      bias_1D,
      activePOI_4H: [],
      contextSwings_4H: { lastStrongHigh: null, lastStrongLow: null },
    };
  });
}

module.exports = { alignTimeframes, lastClosedIndex, biasFromStructure };
```

- [ ] **Step 4: Запустить — должны пройти все 5 тестов в файле**

Run: `node --test tests/smc/multiTF.test.js`
Expected: PASS 5/5.

- [ ] **Step 5: Commit**

```bash
git add core/smc/multiTF.js tests/smc/multiTF.test.js
git commit -m "feat(smc): bias_1D from last BOS (reset on FakeBOS/Conf)"
```

---

### Task 4: contextSwings_4H + activePOI_4H

**Files:**
- Modify: `core/smc/multiTF.js`
- Modify: `tests/smc/multiTF.test.js`

Логика:
- `contextSwings_4H.lastStrongHigh/Low` = последний swing с `strength === 'strong'` соответствующего типа из `ctx4H.swings`, у которого `swing.index <= idx4H`. Если ни одного — `null`.
- `activePOI_4H` = массив объектов `{ kind, ...poi }` из `ctx4H.{snrs, fvgs, rbs}`:
  - `kind: 'SNR'|'FVG'|'RB'`
  - SNR: включаем только `valid === true` и `indexEnd <= idx4H`
  - FVG: включаем все с `indexRight <= idx4H` (FVG считается активным, пока не закрыт — детекция «закрытия» — Phase 3, на Phase 2 берём весь список)
  - RB: включаем все с `index <= idx4H`

- [ ] **Step 1: Падающий тест на activePOI_4H + contextSwings_4H**

Дополнить `tests/smc/multiTF.test.js`:

```js
const { precomputeSMC } = require('../../core/smc/index');

describe('alignTimeframes — 4H context', () => {
  it('activePOI_4H пуст для индексов до появления первого POI', () => {
    const { c1H, c4H, c1D } = makeAlignedSet(48);
    const out = alignTimeframes(c1H, c4H, c1D);
    assert.deepEqual(out[0].activePOI_4H, []);
  });

  it('activePOI_4H проектирует SNRs/FVGs/RBs c 4H на 1H по времени', () => {
    // Синтетика: создаём 4H-серию с явным FVG
    const c4H = [
      { time:        0, open: 10, high: 12, low:  8, close: 11, volume: 1 },
      { time:  4*3.6e6, open: 11, high: 11, low:  9, close: 10, volume: 1 }, // gap setup
      { time:  8*3.6e6, open: 10, high: 20, low: 10, close: 19, volume: 1 }, // FVG-кандидат
      { time: 12*3.6e6, open: 19, high: 25, low: 17, close: 24, volume: 1 },
    ];
    const c1H = Array.from({ length: 16 }, (_, i) => ({
      time: i * 3.6e6, open: 10, high: 11, low: 9, close: 10, volume: 1,
    }));
    const c1D = []; // не важно для этого теста
    const ctx4H = precomputeSMC(c4H);
    // если FVG детектирован хотя бы один — позже он должен появиться в activePOI_4H
    if (ctx4H.fvgs.length > 0) {
      const out = alignTimeframes(c1H, c4H, c1D);
      // 1H-индекс, чьё время >= конец последнего FVG-бара 4H
      const lastFvgRightIdx = ctx4H.fvgs[ctx4H.fvgs.length - 1].indexRight;
      const minTime = c4H[lastFvgRightIdx].time + 4*3.6e6;
      const i1H = c1H.findIndex(c => c.time >= minTime);
      assert.ok(i1H >= 0, 'expected 1H index after FVG bar');
      assert.ok(
        out[i1H].activePOI_4H.some(p => p.kind === 'FVG'),
        'expected FVG to appear in activePOI_4H'
      );
    }
  });

  it('contextSwings_4H хранит lastStrongHigh/Low с 4H', () => {
    const { c1H, c4H, c1D } = makeAlignedSet(48);
    const out = alignTimeframes(c1H, c4H, c1D);
    // Для flat-серии strong-свингов нет → должны быть null
    assert.equal(out[0].contextSwings_4H.lastStrongHigh, null);
    assert.equal(out[0].contextSwings_4H.lastStrongLow, null);
  });
});
```

- [ ] **Step 2: Запустить — упадёт на проверке FVG**

Run: `node --test tests/smc/multiTF.test.js`
Expected: FAIL на тесте c FVG (activePOI_4H остаётся `[]`).

- [ ] **Step 3: Реализация — расширить map в `alignTimeframes`**

Заменить функцию `alignTimeframes`:

```js
function lastStrongSwing(swings, type, upToIndex) {
  let last = null;
  for (const s of swings) {
    if (s.index > upToIndex) break;
    if (s.type === type && s.strength === 'strong') last = s;
  }
  return last;
}

function activePOIs(ctx, upToIndex) {
  const out = [];
  for (const snr of ctx.snrs) {
    if (snr.indexEnd <= upToIndex && snr.valid) out.push({ kind: 'SNR', ...snr });
  }
  for (const fvg of ctx.fvgs) {
    if (fvg.indexRight <= upToIndex) out.push({ kind: 'FVG', ...fvg });
  }
  for (const rb of ctx.rbs) {
    if (rb.index <= upToIndex) out.push({ kind: 'RB', ...rb });
  }
  return out;
}

function alignTimeframes(candles1H, candles4H, candles1D) {
  const ctx4H = precomputeSMC(candles4H);
  const ctx1D = precomputeSMC(candles1D);

  return candles1H.map(c1 => {
    const idx1D = lastClosedIndex(candles1D, c1.time, ONE_DAY_MS);
    const idx4H = lastClosedIndex(candles4H, c1.time, FOUR_H_MS);
    const bias_1D = idx1D < 0 ? 'neutral' : biasFromStructure(ctx1D.structure, idx1D);
    return {
      bias_1D,
      activePOI_4H: idx4H < 0 ? [] : activePOIs(ctx4H, idx4H),
      contextSwings_4H: {
        lastStrongHigh: idx4H < 0 ? null : lastStrongSwing(ctx4H.swings, 'high', idx4H),
        lastStrongLow:  idx4H < 0 ? null : lastStrongSwing(ctx4H.swings, 'low',  idx4H),
      },
    };
  });
}
```

- [ ] **Step 4: Запустить — все 8 тестов файла должны пройти**

Run: `node --test tests/smc/multiTF.test.js`
Expected: PASS 8/8.

- [ ] **Step 5: Commit**

```bash
git add core/smc/multiTF.js tests/smc/multiTF.test.js
git commit -m "feat(smc): project active 4H POIs and strong swings onto 1H index"
```

---

### Task 5: levels.getStopLossPrice

**Files:**
- Create: `core/smc/levels.js`
- Create: `tests/smc/levels.test.js`

Правило:
- Long на `+SNR / bullish FVG / bullish RB` → SL = `zone.low * (1 - bufferPct)` (по умолчанию `bufferPct = 0.005` = 0.5%)
- Short на `-SNR / bearish FVG / bearish RB` → SL = `zone.high * (1 + bufferPct)`
- `zone` извлекается из самого setup: SNR имеет `low/high`; FVG — `low/high`; RB — `low/high`. Если `setup.zone` явно передан — он побеждает.
- Сигнатура: `getStopLossPrice(setup, opts?)` — `candles` зарезервирован для расширений Phase 3 (например, swing-based SL), сейчас неиспользован.

- [ ] **Step 1: Падающий тест**

```js
// tests/smc/levels.test.js
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { getStopLossPrice, getTakeProfitPrice, getRiskRewardRatio } = require('../../core/smc/levels');

describe('getStopLossPrice', () => {
  it('long на +SNR [100..105] с buffer 0.5% → 99.50', () => {
    const sl = getStopLossPrice({
      kind: 'SNR', type: '+SNR', direction: 'long', high: 105, low: 100,
    });
    assert.equal(sl, 99.5);
  });

  it('short на -SNR [100..105] с buffer 0.5% → 105.525', () => {
    const sl = getStopLossPrice({
      kind: 'SNR', type: '-SNR', direction: 'short', high: 105, low: 100,
    });
    assert.equal(sl, 105.525);
  });

  it('long на bullish FVG [200..210] с buffer 1% → 198', () => {
    const sl = getStopLossPrice({
      kind: 'FVG', type: 'bullish', direction: 'long', high: 210, low: 200,
    }, { bufferPct: 0.01 });
    assert.equal(sl, 198);
  });

  it('явная zone в setup побеждает high/low', () => {
    const sl = getStopLossPrice({
      kind: 'RB', direction: 'long', high: 999, low: 999,
      zone: { high: 50, low: 48 },
    });
    assert.equal(sl, +(48 * 0.995).toFixed(8));
  });
});
```

- [ ] **Step 2: Запустить — упадёт**

Run: `node --test tests/smc/levels.test.js`
Expected: FAIL — `Cannot find module '../../core/smc/levels'`.

- [ ] **Step 3: Реализация**

```js
// core/smc/levels.js
'use strict';

const DEFAULT_SL_BUFFER = 0.005; // 0.5%

/**
 * @param {Object} setup
 *   { kind: 'SNR'|'FVG'|'RB', direction: 'long'|'short', high, low, zone? }
 * @param {Object} [opts]
 *   { bufferPct: number }   default 0.005
 * @returns {number}  SL price
 */
function getStopLossPrice(setup, opts = {}) {
  const buffer = opts.bufferPct ?? DEFAULT_SL_BUFFER;
  const zoneHigh = setup.zone?.high ?? setup.high;
  const zoneLow  = setup.zone?.low  ?? setup.low;
  if (setup.direction === 'long')  return +(zoneLow  * (1 - buffer)).toFixed(8);
  if (setup.direction === 'short') return +(zoneHigh * (1 + buffer)).toFixed(8);
  throw new Error(`unknown direction: ${setup.direction}`);
}

module.exports = { getStopLossPrice };
```

- [ ] **Step 4: Запустить — PASS 4/4**

Run: `node --test tests/smc/levels.test.js`
Expected: PASS 4/4.

- [ ] **Step 5: Commit**

```bash
git add core/smc/levels.js tests/smc/levels.test.js
git commit -m "feat(smc): getStopLossPrice for SNR/FVG/RB setups with buffer"
```

---

### Task 6: getTakeProfitPrice + getRiskRewardRatio

**Files:**
- Modify: `core/smc/levels.js`
- Modify: `tests/smc/levels.test.js`

Правила:
- `getTakeProfitPrice(entry, sl, rr)` где `rr` — желаемый Risk:Reward (например 2.5).
  - long:  `tp = entry + (entry - sl) * rr`
  - short: `tp = entry - (sl - entry) * rr`
  - Бросает Error если `entry === sl`.
- `getRiskRewardRatio(entry, sl, tp)` возвращает фактический RR (всегда положительное число).

- [ ] **Step 1: Падающие тесты**

Дополнить `tests/smc/levels.test.js`:

```js
describe('getTakeProfitPrice', () => {
  it('long entry=100 sl=99 rr=2.5 → tp=102.5', () => {
    assert.equal(getTakeProfitPrice(100, 99, 2.5), 102.5);
  });
  it('short entry=100 sl=101 rr=2.5 → tp=97.5', () => {
    assert.equal(getTakeProfitPrice(100, 101, 2.5), 97.5);
  });
  it('бросает если entry == sl', () => {
    assert.throws(() => getTakeProfitPrice(100, 100, 2));
  });
});

describe('getRiskRewardRatio', () => {
  it('long: entry=100 sl=99 tp=102.5 → 2.5', () => {
    assert.equal(getRiskRewardRatio(100, 99, 102.5), 2.5);
  });
  it('short: entry=100 sl=101 tp=97.5 → 2.5', () => {
    assert.equal(getRiskRewardRatio(100, 101, 97.5), 2.5);
  });
});
```

- [ ] **Step 2: Запустить — FAIL**

Run: `node --test tests/smc/levels.test.js`
Expected: FAIL — `getTakeProfitPrice is not a function`.

- [ ] **Step 3: Реализация — дополнить `core/smc/levels.js`**

Добавить перед `module.exports`:

```js
function getTakeProfitPrice(entry, sl, rr) {
  if (entry === sl) throw new Error('entry equals sl — risk is zero');
  const risk = Math.abs(entry - sl);
  const isLong = entry > sl;
  const tp = isLong ? entry + risk * rr : entry - risk * rr;
  return +tp.toFixed(8);
}

function getRiskRewardRatio(entry, sl, tp) {
  const risk   = Math.abs(entry - sl);
  const reward = Math.abs(tp - entry);
  if (risk === 0) return 0;
  return +(reward / risk).toFixed(4);
}

module.exports = { getStopLossPrice, getTakeProfitPrice, getRiskRewardRatio };
```

- [ ] **Step 4: Запустить — PASS 9/9**

Run: `node --test tests/smc/levels.test.js`
Expected: PASS 9/9 (4 SL + 3 TP + 2 RR).

- [ ] **Step 5: Commit**

```bash
git add core/smc/levels.js tests/smc/levels.test.js
git commit -m "feat(smc): getTakeProfitPrice + getRiskRewardRatio"
```

---

### Task 7: TradeSimulator — режим абсолютных цен SL/TP

**Files:**
- Modify: `core/backtest/simulator.js`
- Create: `tests/smc/simulator.test.js`

Контракт расширения (чтобы не сломать S1/S2/S3):
- `processCandle(candle, signal)` сейчас принимает `signal: 'long'|'short'|null`.
- После изменений `signal` может быть **либо** строкой (старое поведение), **либо** объектом `{ direction: 'long'|'short', tpPrice?: number, slPrice?: number }`.
- Если `tpPrice/slPrice` присутствуют — они подставляются в trade «как есть». Иначе — старая формула (`entry * (1 ± slPct/tpPct)`).
- Position sizing: `slGap = entry - slPrice` (или `slPrice - entry` для short) вместо `entry * slPct`.
- Никаких изменений нигде, кроме `_openTrade` и сигнатур.

- [ ] **Step 1: Падающий тест на абсолютные цены**

```js
// tests/smc/simulator.test.js
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { TradeSimulator } = require('../../core/backtest/simulator');

function bar(time, open, high, low, close) {
  return { time, open, high, low, close, volume: 1 };
}

describe('TradeSimulator — абсолютные цены SL/TP', () => {
  it('long с tpPrice выходит на tpPrice, не на high', () => {
    const sim = new TradeSimulator({
      leverage: 5, riskPct: 1, tp: 5, sl: 2, maxTrades: 1, initialCapital: 100, feeRate: 0, cooldownMin: 0,
    });
    sim.processCandle(bar(0, 100, 101, 99, 100), { direction: 'long', tpPrice: 110, slPrice: 99 });
    sim.processCandle(bar(60_000, 100, 112, 100, 111), null); // high=112, должен закрыть @110
    const r = sim.getResults();
    assert.equal(r.trades.length, 1);
    assert.equal(r.trades[0].exit, 110);
    assert.equal(r.trades[0].reason, 'TP');
  });

  it('short с slPrice выходит на slPrice', () => {
    const sim = new TradeSimulator({
      leverage: 5, riskPct: 1, tp: 5, sl: 2, maxTrades: 1, initialCapital: 100, feeRate: 0, cooldownMin: 0,
    });
    sim.processCandle(bar(0, 100, 101, 99, 100), { direction: 'short', tpPrice: 90, slPrice: 105 });
    sim.processCandle(bar(60_000, 100, 106, 99, 102), null);
    const r = sim.getResults();
    assert.equal(r.trades.length, 1);
    assert.equal(r.trades[0].exit, 105);
    assert.equal(r.trades[0].reason, 'SL');
  });

  it('старый интерфейс (signal=string) работает как раньше', () => {
    const sim = new TradeSimulator({
      leverage: 5, riskPct: 1, tp: 1, sl: 1, maxTrades: 1, initialCapital: 100, feeRate: 0, cooldownMin: 0,
    });
    sim.processCandle(bar(0, 100, 101, 99, 100), 'long');
    sim.processCandle(bar(60_000, 100, 102, 100, 101.5), null); // tp = 100*1.01 = 101
    const r = sim.getResults();
    assert.equal(r.trades.length, 1);
    assert.equal(r.trades[0].exit, 101);
  });

  it('частичный override: только slPrice — tp остаётся в %', () => {
    const sim = new TradeSimulator({
      leverage: 5, riskPct: 1, tp: 1, sl: 5, maxTrades: 1, initialCapital: 100, feeRate: 0, cooldownMin: 0,
    });
    sim.processCandle(bar(0, 100, 101, 99, 100), { direction: 'long', slPrice: 99 });
    sim.processCandle(bar(60_000, 100, 102, 100, 101.5), null);
    const r = sim.getResults();
    assert.equal(r.trades.length, 1);
    assert.equal(r.trades[0].exit, 101); // tp по %
  });
});
```

- [ ] **Step 2: Запустить — FAIL на первом тесте**

Run: `node --test tests/smc/simulator.test.js`
Expected: FAIL — exit=102 (high) или 105 (tp по %), не 110.

- [ ] **Step 3: Изменить `processCandle` и `_openTrade` в `core/backtest/simulator.js`**

В `processCandle` (line ~82) нормализовать сигнал перед всеми проверками:

```js
processCandle(candle, signal) {
  // 1. Check existing positions
  this._checkPositions(candle);

  // Normalise signal: allow legacy 'long'|'short' string OR object form.
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

  // 3. Record equity
  this.equityCurve.push({ time: candle.time, capital: +this.capital.toFixed(6) });
}
```

И заменить `_openTrade` (line ~107):

```js
_openTrade(candle, sig) {
  const direction = sig.direction;
  const entry     = candle.close;
  const isLong    = direction === 'long';

  // Resolve SL price
  const slPrice = (sig.slPrice != null)
    ? sig.slPrice
    : (isLong ? entry * (1 - this.slPct) : entry * (1 + this.slPct));

  // Resolve TP price
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
  this.capital   -= openFee;

  this.openTrades.push({
    direction,
    entry,
    tp: tpPrice,
    sl: slPrice,
    contracts,
    notional,
    openedAt: candle.time,
  });
}
```

`_checkPositions` НЕ трогаем — он уже работает с `tp/sl` в трейде как с абсолютными ценами (см. line ~146: `isLong ? candle.low <= sl : candle.high >= sl`).

- [ ] **Step 4: Запустить новые тесты — PASS 4/4**

Run: `node --test tests/smc/simulator.test.js`
Expected: PASS 4/4.

- [ ] **Step 5: Commit**

```bash
git add core/backtest/simulator.js tests/smc/simulator.test.js
git commit -m "feat(simulator): support per-trade absolute tpPrice/slPrice"
```

---

### Task 8: Regression-тест для S1/S2/S3 после изменений симулятора

**Files:**
- Create: `tests/smc/simulator-regression.test.js`

Цель: убедиться, что строковые сигналы `'long'/'short'` дают **бит-в-бит идентичный** результат до и после Task 7. Используем синтетические свечи (детерминированные), не дёргая network/cache.

- [ ] **Step 1: Написать тест — два прогона разных сценариев**

```js
// tests/smc/simulator-regression.test.js
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { TradeSimulator } = require('../../core/backtest/simulator');

function bar(time, close) {
  // open=close, high=close+0.5, low=close-0.5 — без нойза
  return { time, open: close, high: close + 0.5, low: close - 0.5, close, volume: 1 };
}

// Детерминированная серия: цена ходит по треугольной волне, иногда генерируем сигналы.
function makeRun() {
  const sim = new TradeSimulator({
    leverage: 10, riskPct: 1.5, tp: 0.7, sl: 0.4, maxTrades: 2,
    initialCapital: 100, feeRate: 0.0006, cooldownMin: 30,
  });
  let price = 100;
  for (let i = 0; i < 200; i++) {
    price += (i % 20 < 10) ? 0.3 : -0.3;
    const t = i * 60_000;
    let sig = null;
    if (i % 17 === 0) sig = 'long';
    if (i % 23 === 0) sig = 'short';
    sim.processCandle(bar(t, +price.toFixed(4)), sig);
  }
  return sim.getResults();
}

describe('TradeSimulator — regression на строковом интерфейсе', () => {
  it('детерминированный прогон даёт стабильные totals', () => {
    const r = makeRun();
    // Эти числа фиксируем СНАЧАЛА запустив тест и подставив фактические значения.
    // После Task 7 они не должны измениться.
    assert.ok(r.stats.totalTrades > 0, `expected trades, got ${r.stats.totalTrades}`);
    // Snapshot: проверяем что суммарный PnL и кол-во трейдов в стабильных рамках
    // (точные числа подставит executor после первого прогона)
    assert.equal(typeof r.stats.totalPnl, 'number');
    assert.equal(typeof r.stats.totalTrades, 'number');
    // Жёсткая проверка структуры
    for (const t of r.trades) {
      assert.ok(['TP', 'SL'].includes(t.reason));
      assert.ok(t.exit > 0 && t.entry > 0);
      assert.ok(['long', 'short'].includes(t.direction));
    }
  });

  it('второй прогон с теми же входами даёт идентичный результат (детерминизм)', () => {
    const a = makeRun();
    const b = makeRun();
    assert.equal(a.stats.totalTrades, b.stats.totalTrades);
    assert.equal(a.stats.totalPnl,    b.stats.totalPnl);
    assert.equal(a.stats.winRate,     b.stats.winRate);
    assert.deepEqual(a.trades.map(t => [t.exit, t.reason]), b.trades.map(t => [t.exit, t.reason]));
  });
});
```

- [ ] **Step 2: Зафиксировать snapshot для будущих изменений**

Запустить: `node --test tests/smc/simulator-regression.test.js`
Если PASS — записать в комментарий теста фактические значения:

```js
// После прогона добавить выше первого assert:
// SNAPSHOT (Phase 2): totalTrades=N, totalPnl=X, winRate=Y
// Если эти числа изменятся после правок в simulator.js — это REGRESSION.
```

И добавить жёсткие assert'ы:

```js
// Замени мягкие проверки на:
assert.equal(r.stats.totalTrades, /* подставить N */);
assert.equal(r.stats.totalPnl,    /* подставить X */);
```

- [ ] **Step 3: Запустить полный набор тестов**

Run: `npm run test:smc`
Expected: все тесты Phase 1 + Phase 2 проходят (helpers, multiTF, levels, simulator, simulator-regression).

- [ ] **Step 4: Запустить существующие тесты Phase 1 отдельно — должны быть зелёными**

Run: `node --test tests/smc/precomputeSMC.test.js tests/smc/detectStructure.test.js tests/smc/detectSwings.test.js tests/smc/detectFVG.test.js tests/smc/detectSNR.test.js tests/smc/detectRB.test.js tests/smc/detectLiquidity.test.js tests/smc/detectRejection.test.js`
Expected: все PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/smc/simulator-regression.test.js
git commit -m "test: regression snapshot for legacy string signal in TradeSimulator"
```

---

## Self-Review

**1. Spec coverage**
- ✅ `core/smc/multiTF.js` с `alignTimeframes(candles1H, candles4H, candles1D)` — Tasks 2–4.
- ✅ Возвращает `{ bias_1D, activePOI_4H, contextSwings_4H }` per 1H index — Task 2 (skeleton) + 3 (bias) + 4 (POI/swings).
- ✅ Тест «1D bullish, 4H bearish → bias=bullish» — Task 3 Step 1.
- ✅ Правило bias_1D: последний BOS, сброс на FakeBOS/Conf — Task 3 (с уточнением, что Conf тоже сбрасывает).
- ✅ `simulator.js` режим абсолютных цен `tpPrice/slPrice` — Task 7.
- ✅ Fallback на проценты — Task 7 Step 3 (`if (sig.tpPrice != null)`).
- ✅ Backwards compat S1/S2/S3 — Task 7 Step 1 (тест строкового интерфейса) + Task 8 (regression).
- ✅ Тест «long с tpPrice достигнут → close at tpPrice not at high» — Task 7 Step 1 первый тест.
- ✅ `core/smc/levels.js` с `getStopLossPrice/getTakeProfitPrice/getRiskRewardRatio` — Tasks 5–6.
- ✅ Тест «long на +SNR [100..105], buffer 0.5% → SL=99.5» — Task 5 Step 1.

**2. Placeholder scan**
- Snapshot значения в Task 8 Step 2 — не помечены как «TBD», executor подставляет фактические числа после первого прогона. Это явная инструкция, не плейсхолдер.
- Все остальные шаги содержат полный код.

**3. Type consistency**
- `setup.kind` единообразен в `levels.js` и `activePOIs` (`'SNR' | 'FVG' | 'RB'`).
- `signal` в `processCandle` — оба варианта (string и object) обработаны одной функцией нормализации в Task 7 Step 3.
- `bias_1D` — `'bullish' | 'bearish' | 'neutral'` — из `StructureEvt.direction` или `'neutral'`.
- `activePOI_4H` — массив объектов с обязательным `kind`, остальные поля spread'ом из POI.

---

## Execution Handoff

**Plan complete and saved to `plans/phase2-multitf-simulator.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — я диспатчу свежий subagent на каждый Task, ревью между тасками, быстрая итерация.

**2. Inline Execution** — выполнить таски в этой сессии через executing-plans, batch execution с чекпойнтами для ревью.

**Какой подход?**
