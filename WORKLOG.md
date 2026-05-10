# WORKLOG — Trading Office

Хронология изменений по проектам. Новые записи — **вверху** каждого раздела.
Формат описан в `CLAUDE.md → WORKLOG RULES`.

---

## PUMP-FADER

### 2026-05-10 — Фикс ML inference: модель не подхватывалась + неверный output

**Задача:** Отчёт pump-fader писал «ML: не обучена», хотя `model.onnx` присутствовал.

**Изменённые файлы:**
- `ml/pump-fader/inference.js`
- `agents/pump-fader.js`

**Что сделано:**
1. `MODEL_PRESENT` (константа, вычислялась один раз при `require`) заменён на `isModelPresent()` — `fs.existsSync` теперь вызывается на каждом предикте, retrain подхватывается без рестарта.
2. В `predict` исправлен парс ONNX-вывода: skl2onnx экспортирует два output'а (`label` int64 + `probabilities` float32). Старый код брал `outputNames[0]` = `label` и падал на `Math.max(...BigInt64Array)`. Теперь явно ищем тензор с именем, содержащим `prob`.
3. Все 3 потребителя в `agents/pump-fader.js` обновлены на вызов `isModelPresent()`.

**Результат проверки:** `node -e 'predict(zeros)'` возвращает `class=FALL conf=0.72 placeholder=false`. `pm2 restart pump-fader` — процесс онлайн, ошибок в логах нет.

---

### 2026-05-07 — Фикс paper-записи в дашборде + сброс настроек TP/SL

**Задача:** Исправить запись paper-трейдов pump-fader как реальных; починить настройки после 100% стоплосов.

**Изменённые файлы:**
- `agents/pump-fader.js`
- `data/trades.csv` (ретроактивный rename)
- `.claude/memory/pump-fader-settings.json`
- `data/open_trades_pump_fader.json` (добавлен `paper: true`)

**Что сделано:**
1. В `sendTrade` при paper-режиме теперь передаётся `agent: 'PUMP-FADER [PAPER]'` (как DOLF-HUNTER) — `isPaperRow` в дашборде корректно разделит PnL.
2. В `checkTrade` при закрытии также используется `trade.paper ? 'PUMP-FADER [PAPER]' : 'PUMP-FADER'`.
3. Ретроактивно переименованы 151 запись в `trades.csv` (`PUMP-FADER` → `PUMP-FADER [PAPER]`).
4. Два открытых трейда без флага `paper: true` — добавлен флаг вручную.
5. Критические баги настроек: `tpMinDistance: 50→1`, `tpDefaultPct: 90→4`, `slMaxPct: 20→3`, `maxTrades: 25→4`.
6. Скорректированы условия входа: `pumpWindowMin: 30→10`, `pumpPctMin: 10→6`, `volumeMultiplier: 5→7`, `rsiThreshold: 70→76`, `baseLeverage: 17→10`, `maxLev: 25→15`, `cooldownHours: 1→2`.

**Результат проверки:** pm2 restart прошёл, лог показывает `paperMode=true | scan every 30s`, `open: 0/4`. TP по логу проверен — больше не будет 0.2 при цене 2.4.

---

## SMC BACKTEST

### 2026-05-10 — Phase 2 Complete: Multi-TF Context + TradeSimulator Extension

**Задача:** Исполнить `plans/phase2-multitf-simulator.md` inline (executing-plans). Подготовить инфраструктуру для написания SMC-стратегии в Phase 3.

**Изменённые файлы:**
- `tests/smc/helpers.js` — добавлены `aggregateTF`, `makeAlignedSet`
- `core/smc/multiTF.js` (NEW) — `alignTimeframes(c1H, c4H, c1D)` + helpers `lastClosedIndex`, `biasFromStructure`
- `core/smc/levels.js` (NEW) — `getStopLossPrice`, `getTakeProfitPrice`, `getRiskRewardRatio`
- `core/backtest/simulator.js` — `processCandle`/`_openTrade` теперь принимают сигнал-объект `{ direction, tpPrice?, slPrice? }`; строковый интерфейс сохранён
- 5 новых test-файлов: `helpers.test.js`, `multiTF.test.js`, `levels.test.js`, `simulator.test.js`, `simulator-regression.test.js`

**Что сделано (8 atomic tasks, 8 коммитов):**
1. Helpers: aggregateTF + makeAlignedSet (2 тест-кейса)
2. multiTF skeleton + контракт формы (3 теста)
3. bias_1D из последнего BOS на 1D, сброс на FakeBOS/Conf (2 теста — bullish 1D / flat → neutral)
4. activePOI_4H (SNR `valid && indexEnd<=i`, FVG `index<=i`, RB `index<=i`) + contextSwings_4H (last strong high/low) (3 теста)
5. getStopLossPrice — long/short, buffer 0.5%, явная zone override (4 теста)
6. getTakeProfitPrice + getRiskRewardRatio (5 тестов)
7. TradeSimulator: per-trade `tpPrice/slPrice` + backwards-compat для строковых сигналов (4 теста)
8. Regression snapshot: 200-bar детерминированный прогон → totalTrades=11, totalPnl=10.0097, winRate=0.6364

**Уточнения от исходного спека:**
- ~~`Conf` сбрасывает bias_1D в neutral~~ — **исправлено пост-фактум**: Conf **подтверждает** BOS (стандартная SMC-конвенция), bias сохраняется. Сбрасывают только FakeBOS и встречный BOS. См. коммит после ревью + 5 unit-тестов на `biasFromStructure`.
- SL/TP абсолютные цены передаются **per-trade** через сигнал-объект, не через конструктор. Это естественно для SMC: уровни считаются от структуры зоны.
- FVG-shape: используется `index` (одиночный), не `indexLeft/indexRight` — спек указывал теоретическую форму, реальная из Phase 1 была одиночным `index`. `grep -rn 'indexLeft\|indexRight' core/ tests/` → пусто, других мест с устаревшим контрактом нет.

**Результат проверки:** `npm run test:smc` → **68/68 PASS** (45 Phase 1 + 23 Phase 2). История: 8 commits `3a1a875..c6fa6ca` на master, после каждой таски один коммит.

---

### 2026-05-07 — Phase 1 Complete: все 10 задач, 43 теста зелёных

**Задача:** Исполнить plans/phase1-smc-detectors.md через subagent-driven-development.

**Изменённые файлы:**
- `scripts/cache-smc-data.js`, `package.json`
- `tests/smc/helpers.js` + 8 test файлов
- `core/smc/` — 8 файлов (7 детекторов + index.js)

**Что сделано:**
1. Task 1: кэш данных 18/20 символов (MATIC делистинг), 4H: 2179 свечей/символ
2. Task 2: TDD инфраструктура node:test + helpers.js
3. Tasks 3-9: 7 детекторов TDD-first (тесты → red → impl → green → commit)
4. Task 10: precomputeSMC — entry point с правильным порядком зависимостей

**Результат проверки:** `npm run test:smc` → `tests 43  pass 43  fail 0`. 10 коммитов.

---

### 2026-05-07 — Task 2: TDD-инфраструктура (node:test + candle helpers)

**Задача:** Добавить тестовые скрипты в package.json и создать фабрику свечей для SMC-тестов.

**Изменённые файлы:**
- `package.json` (добавлены скрипты `test` и `test:smc`)
- `tests/smc/helpers.js` (создан)

**Что сделано:**
1. Добавлены скрипты `"test"` и `"test:smc"` в package.json с использованием встроенного `node:test`
2. Создан `tests/smc/helpers.js` с функциями `candle`, `resetTime`, `flatCandles`
3. Smoke-тест запущен, прошёл (pass 1), удалён

**Результат проверки:** `npm run test:smc` → `# pass 1 # fail 0`

---

### 2026-05-07 — Task 1: Скрипт кэширования данных (cache-smc-data.js)

**Задача:** Создать и запустить скрипт загрузки 1-годовых свечей 4H+1D для top-10 символов в data/backtest-cache/.

**Изменённые файлы:**
- `scripts/cache-smc-data.js` (создан)

**Что сделано:**
1. Создан скрипт с пагинацией через `fetchCandles` из dataLoader; 10 символов × 2 таймфрейма = 20 пар
2. Запущен: 18/20 файлов загружены; MATICUSDT недоступен на Bitget (HTTP 400 — вероятно делистинг)
3. 4H-файлы: 2179 свечей каждый (>1500 — критерий выполнен)
4. 1D-файлы: 90 свечей каждый (ограничение Bitget API для данного эндпоинта)

**Результат проверки:** `ls data/backtest-cache/ | grep -E "(4H|1D)" | wc -l` → 18 (ожидалось ≥20; 18 из-за MATICUSDT). 4H критерий ≥1500 выполнен.

---

### 2026-05-07 — Phase 1 SMC Plan: 5 методологических правок по PDF

**Задача:** Исправить plan по 5 критичным расхождениям с пользовательскими PDF.

**Изменённые файлы:**
- `plans/phase1-smc-detectors.md` (перезаписан)

**Что сделано:**
1. SNR переделан: зона ≥3 свечей консолидации + пробой (не "одна свеча"); сигнатура `detectSNR(candles, liquidity, fvgs)`; valid только через liquidity sweep или FVG в зоне
2. detectStructure: инвертирован Strong/Weak — strong = prior swing (точка отправления импульса), не broken swing; Conf = новый swing в направлении BOS выше bosPrice (не просто "свеча не откатывается")
3. detectFVG: добавлен rank-based `setStatus()` для монотонного обновления статуса; тест на невозможность отката из 0.5 в IOFED
4. detectRB: переделан с обязательной привязкой к KL; сигнатура `detectRB(candles, keyLevels)`; три условия (направление + wick на KL + оба close за KL)
5. Порядок в precomputeSMC исправлен: swings → structure → fvg → liquidity → snr → rb → rejection; добавлен `buildKeyLevels(swings, fvgs)` для RB

**Результат проверки:** 29 тестов → 42 теста; контракты обновлены; порядок зависимостей зафиксирован в заголовке плана.

---

### 2026-05-07 — Phase 1 Implementation Plan: SMC Detectors

**Задача:** Создать детальный план Phase 1 SMC Backtest модуля (детекторы + кэш данных).

**Изменённые файлы:**
- `plans/phase1-smc-detectors.md` (создан)

**Что сделано:**
1. Проведён discovery: изучена структура `core/backtest/` (dataLoader, strategyPumpFader, runner, simulator)
2. Зафиксированы контракты интерфейсов для всех 7 детекторов (SwingPoint, Structure, FVG, SNR, RB, LiqLevel, Rejection, SMCContext)
3. Написан план из 10 задач с TDD-шагами, реальными тест-кейсами на синтетических свечах и готовой реализацией для каждого детектора
4. Покрыты: скрипт кэша данных (Task 1), инфраструктура node:test (Task 2), detectSwings/Structure/FVG/SNR/RB/Liquidity/Rejection/precomputeSMC (Tasks 3-10)

**Результат проверки:** Файл `plans/phase1-smc-detectors.md` создан, содержит 29 тест-кейсов и полный код реализации без плейсхолдеров.

---

## PUMP-FADER

### 2026-05-07 — Сканирование всех монет Bitget + настраиваемый pre-filter; fix mlLine TDZ

**Задача:** Убрать ограничение top-100, сделать pre-filter настраиваемым в дашборде; починить ошибку `mlLine before initialization`.

**Изменённые файлы:**
- `agents/pump-fader.js`
- `dashboard/server.js`
- `dashboard/public/index.html`

**Что сделано:**
1. Добавлен параметр `preFilterPct: 0` в DEFAULTS (0 = отключён — сканировать все монеты)
2. Убран `.slice(0, 100)` — теперь сканируются все USDT-пары на Bitget (~543 символа)
3. `preFilterPct` добавлен в `applySetting` numKeys, PF_DEFAULTS в server.js, поле "Фильтры" в дашборде
4. Исправлен баг `Cannot access 'mlLine' before initialization` — блок `condLines` перенесён после вычисления `mlLine`

**Результат проверки:** `[pf] scanning 543 symbols…` в логах, ошибка mlLine исчезла.

---

### 2026-05-06 — TG-отчёт: условия ✅/❌, fix ML 0%, убрать CoinGlass; бэктест: пагинированный выбор пар

**Задача:** Улучшить читаемость TG-сигнала, добавить пикер пар в бэктест.

**Изменённые файлы:**
- `agents/pump-fader.js`
- `dashboard/public/index.html`

**Что сделано:**

1. **TG-сообщение — условия ✅/❌**
   - В `analyzeSymbol()` добавлены именованные bool: `condRsiMet`, `condPumpMet`, `condVolumeMet`, `condZoneMet`, `condMlMet` (вместо анонимного `metCount++`)
   - `buildTelegramMsg()` рендерит блок условий после заголовка: каждое активное условие — отдельная строка ✅/❌ с фактическим значением vs порогом
   - ML: если `condMl` отключён → "🔘 ML: отключён"; если включён → показывает реальный класс (`mlClass`) и confidence%; ✅ только если условие выполнено
   - Убраны строки "КАЧЕСТВО СЕТАПА: -13.2/5.5+" и "ML ПРОГНОЗ: СИЛЬНОЕ ПАДЕНИЕ (0%)" — заменены conditions block
   - Убрана строка "CoinGlass: CoinGlass ..."

2. **Бэктест — пагинированный пикер пар**
   - Заменён текстовый input `bt-pf-symbol` на paginated chip selector (20 пар/страница)
   - Пресеты: Top 20 / Top 50 / Top 100 (из SYM_LIST, отсортирован по market cap)
   - Навигация ←/→ по страницам; поддержка кастомных пар
   - По умолчанию выбран SOLUSDT (BTC/ETH редко дают 5%+ pumps)
   - Подсказка: "на BTC/ETH снизьте Pump% до 1-2%, Volume× до 2-4"
   - `pfRenderPicker()` вызывается из `btInitDates()` при открытии вкладки бэктест

**Результат проверки:**
- `node --check agents/pump-fader.js` → OK
- PM2: pump-fader online (pid 300297)

### 2026-05-06 — Условия-галочки, интеграция скринера, бэктест

**Задача:** Настраиваемые условия верификации сделки, интеграция pump-скринера, реализация бэктеста.

**Изменённые файлы:**
- `agents/pump-fader.js`
- `agents/screener.js`
- `index.js`
- `core/backtest/strategyPumpFader.js`
- `core/backtest/runner.js`
- `dashboard/server.js`
- `dashboard/public/index.html`

**Что сделано:**

1. **Условия-галочки (5 AND → пороговая логика)**
   - Добавлены в DEFAULTS: `condRsi`, `condPump`, `condVolume`, `condZone`, `condMl` (bool), `signalThreshold` (default 3), `tradeThreshold` (default 4)
   - `analyzeSymbol()` считает `metCount` по активным условиям; ранний выход только если `metCount + remaining < signalThreshold`
   - `signalThreshold` выполнен → TG-сигнал без позиции (`SIGNAL-ONLY ... N/M cond`)
   - `tradeThreshold` выполнен → открыть сделку
   - Funding и RR остались жёсткими фильтрами (не входят в счёт условий)

2. **Интеграция скринера → pump-fader (межпроцессная)**
   - `screener.js`: добавлен `addPumpCallback(fn)` — вызывается при обнаружении памп-кандидатов
   - `index.js`: регистрирует callback → пишет символы в `data/pf-trigger-queue.json`
   - `pump-fader.js`: polling файла каждые 5 сек → немедленный `analyzeSymbol()` для каждого символа
   - Архитектура: файловая очередь (pump-fader — отдельный PM2 процесс, in-memory недоступен)

3. **Бэктест pump-fader**
   - `strategyPumpFader.js`: поддержаны `condRsi/condPump/condVolume/condZone`, `signalThreshold`, `tradeThreshold`; ML не поддерживается исторически
   - `runner.js`: добавлен `agentType: 'pump-fader'` через `buildPfStrategy()` + `precompute()` + `signal()` per candle
   - Баг исправлен: симулятор ожидает строку `'short'`/`'long'`, передаём `sig.direction`
   - Dashboard: `btPfRun()` / `btPfGridRun()` — реальный запуск через `/api/backtest/run` и `/api/backtest/grid`; поля символ/период/условия/пороги добавлены в форму

4. **Дашборд — Fader-таб (Статистика)**
   - Новая секция "Условия верификации": 5 чекбоксов + поля signalThreshold/tradeThreshold + кнопка "Сохранить"
   - `fetchFaderStats()` синхронизирует чекбоксы с сервером; params-грид показывает `✅/❌` для каждого условия

5. **Исправление роутинга server.js**
   - `POST /api/settings/pump-fader` перехватывался generic роутом `POST /api/settings/:agent` (Express — первый совпавший маршрут)
   - Специфичные pump-fader GET/POST роуты перемещены ДО generic `:agent` роутов

**Результат проверки:**
- `[pf] SIGNAL-ONLY XAGUSDT SHORT @ 76.44 | SL 76.8 | TP 75.45 | RR 2.75 | 2/4 cond` — логика работает
- Бэктест SOLUSDT 1H (relaxed params): 23 сделки, WR 39%
- API POST настроек сохраняет новые поля в `pump-fader-settings.json`

---

## DOLF-HUNTER

### 2026-05-10 — Фикс «пустышек»: paper-сделки на символах не из Bitget

**Задача:** Третий рецидив — DOLF открывает paper-сделки, которых не видно в дашборде (current/unrealized=null). Накопилось 100 активных, из них 45 на не-Bitget символах.

**Корень:** Скринер пишет сигналы по Bybit-вселенной; DOLF получает котировку через `bitget.getPrice()`. На символах вне Bitget (HPOS10I, PORTAL, 1000LUNC, VELO, …) `getPrice` бросает, `checkPaperPositions` молча `continue` — сделка зависает навсегда.

**Изменённые файлы:**
- `core/bitget.js` — добавлен экспорт `hasSymbol(sym)`: `true/false/null` (null пока specs не загружены).
- `agents/dolf_hunter.js` — гард `bitget.hasSymbol(symbol) === false → skipped: symbol_not_on_bitget` в `processSignal`. Стартовая чистка `cleanupUnsupportedTrades()` после `loadContractSpecs()` закрывает зависшие paper-трейды на неподдерживаемых символах с `pnl=0, exit_reason=symbol_not_supported`.

**Результат проверки:** После рестарта `trading-office`: `[dolf-hunter] cleaned up 45 stuck paper trades on unsupported symbols`. `/api/dolf/positions`: было 100 (45 «пустышек»), стало 55 (0 пустышек).

---

### 2026-05-07 — Persistence activeTrades + очистка 1368 orphaned paper trades

**Задача:** Открытые paper-сделки пропадали при рестарте pm2; статистика раздута orphaned executed сигналами без exit_reason.

**Изменённые файлы:**
- `agents/dolf_hunter.js`

**Что сделано:**
1. Добавлен `ACTIVE_TRADES_FILE = data/dolf_active_trades.json`
2. Функции `saveActiveTrades()` / `loadActiveTrades()` — сохраняют Map как JSON-массив `[symbol, trade]`
3. `saveActiveTrades()` вызывается после каждой мутации activeTrades (set/delete в 4 местах)
4. В `init()`: сначала `loadActiveTrades()` — восстановление paper-позиций; затем маркировка orphaned — все `executed` paper-сигналы без `exit_reason`, которых нет в восстановленных trades, помечаются `exit_reason=orphaned_restart, pnl=0`
5. При первом запуске очищены 1368 накопленных orphaned trades

**Результат проверки:** `dolf_active_trades.json` создан с текущей позицией PRLUSDT; orphaned 1368 → 0 (теперь все executed имеют exit_reason).

---

## HUNTER

*(нет записей)*

---

## SCALPERS (S1 / S2 / S3)

*(нет записей)*

---

## SCREENER (OI / Funding / Liquidation)

*(нет записей)*

---

## DASHBOARD

*(общие изменения дашборда логируются в разделе конкретного проекта)*

---

## ИНФРАСТРУКТУРА

*(нет записей)*

---

## pump-fader ML

### 2026-05-06 — Обучение модели pump-fader на 300 монетах

**Задача:** Собрать датасет, обучить XGBoost, экспортировать model.onnx.

**Изменённые файлы:**
- ml/pump-fader/config.yaml (symbols_limit: 300 — изменено пользователем)
- ml/pump-fader/export-onnx.py (заменён skl2onnx → onnxmltools, opset 17→15)

**Что сделано:**
1. Установлены все Python-зависимости (xgboost, sklearn, pandas, aiohttp, onnxmltools и др.)
2. `build-dataset.py` — собрано 204 997 строк по 300 монетам с Bitget/Bybit
3. `train.py` — обучена XGBoost multi-class модель (accuracy 44%, log_loss 1.36)
4. `export-onnx.py` — исправлен конвертер (skl2onnx не поддерживает XGBClassifier), экспортирован model.onnx (1 MB)

**Результат проверки:** model.onnx (1 MB), model_xgb.json (3.1 MB), scaler.json, metrics.json — все файлы на месте.

**Замечание:** Модель сильно перекошена к STRONG_FALL/STRONG_RISE (recall 74% и 54%), RISE не предсказывается (recall 0%). Это следствие дисбаланса классов. Стоит рассмотреть балансировку через oversample minority / undersample majority.

### 2026-05-06 — Исправление дисбаланса классов pump-fader

**Задача:** Исправить перекос модели — RISE/FLAT/FALL предсказывались с recall ~0%.

**Изменённые файлы:**
- ml/pump-fader/train.py
- ml/pump-fader/config.yaml

**Что сделано:**
1. В `train.py` заменили ручные веса на `compute_class_weight("balanced")` из sklearn — веса вычисляются автоматически как обратно пропорциональные частоте класса.
2. Фактические веса: STRONG_FALL=0.54, FALL=1.67, FLAT=2.16, RISE=1.74, STRONG_RISE=0.66 (ранее было наоборот — 3.0 на мажоритарные классы).
3. Переобучена модель, пересохранены model_xgb.json, scaler.json, metrics.json.
4. Экспортирован model.onnx (7.6 MB).

**Результат проверки:** Все 5 классов теперь предсказываются: recall RISE 34%, FLAT 29%, FALL 25%, STRONG_FALL 54%, STRONG_RISE 42%. Accuracy 42% (macro-avg f1 0.36 vs 0.21 ранее).

### 2026-05-06 — ML как фильтр сделок в pump-fader

**Задача:** Подключить ML-модель как реальный фильтр (вето) вместо информационной строки.

**Изменённые файлы:**
- agents/pump-fader.js

**Что сделано:**
1. Добавлен флаг `condMl: true` в DEFAULTS (можно отключить через dashboard).
2. После ML-предикции вычисляются `mlBlocks` и `mlBoosts`:
   - `mlBlocks = condMl && MODEL_PRESENT && class in [RISE, STRONG_RISE] && conf >= mlConfThreshold (0.65)` → блокирует открытие сделки
   - `mlBoosts = condMl && MODEL_PRESENT && class in [STRONG_FALL, FALL] && conf >= threshold` → подтверждает
3. `tradeAllowed = metCount >= tradeThreshold && !mlBlocks` — ML может заблокировать даже при 4/4 условий.
4. ML-строка в Telegram перемещена в блок условий: ✅/❌/⚪ в зависимости от результата.
5. `condMl` добавлен в `applySetting` boolKeys — управляется через `/set condMl false`.

**Результат проверки:** `node --check` — синтаксис OK.

### 2026-05-06 — Улучшение качества ML модели pump-fader

**Задача:** Добавить фичи (свечные паттерны, funding накопленный), сравнить горизонты, threshold calibration, переобучение по расписанию.

**Изменённые файлы:**
- ml/pump-fader/data/build-dataset.py
- ml/pump-fader/feature-spec.json (30 → 42 фичи)
- ml/pump-fader/train.py (threshold calibration, исправлен баг расчёта precision)
- ml/pump-fader/compare-horizons.py (новый)
- ml/pump-fader/retrain.sh (новый)
- ml/pump-fader/export-onnx.py (opset 17→15, skl2onnx→onnxmltools)
- crontab (добавлен weekly retrain)

**Что сделано:**
1. +12 новых фич: 10 свечных паттернов (body_ratio, shadows, doji, hammer, shooting_star, engulfing), range_pct, funding_8h_sum, funding_trend. Исправлен lookup funding через bisect (был почти всегда 0).
2. Threshold calibration исправлен (баг: считались predicted labels вместо true labels). Реальная precision STRONG_FALL: 79% при thresh=0.50, 90% при thresh=0.70, 95% при thresh=0.80.
3. compare-horizons.py: 2H даёт macro F1=0.657, 4H даёт 0.676 (лучше). 1H результат завышен из-за temporal leakage при random split.
4. retrain.sh + crontab: каждое воскресенье 03:00 полный pipeline.

**Результат проверки:** model.onnx 7.8 MB, node --check pump-fader.js OK. Threshold 0.70 → precision 90% STRONG_FALL при 3% покрытии — рекомендуемый порог для боевого режима (сейчас стоит 0.65).

### 2026-05-06 — Multi-symbol backtest для pump-fader + фикс критичного бага

**Задача:** Bektest pump-fader находил 0 сделок. Сделать multi-symbol тестирование (top-N), переключить на mix futures.

**Изменённые файлы:**
- core/backtest/dataLoader.js (spot → mix futures, granularity, vol+volume алиас)
- core/backtest/runner.js (+ runMultiBacktest с параллельным fetch)
- dashboard/routes/backtest.js (+ POST /api/backtest/multi, GET /api/backtest/multi/:id)
- dashboard/routes/symbols.js (+ GET /api/symbols/top?n=N)
- dashboard/public/index.html (+ режим single/multi, кнопки Top-50/100/200/300, polling прогресса, таблица per-symbol)

**Что сделано:**
1. Найден root cause "0 сделок": `c.vol` в `strategyPumpFader.js` и `screener-loader.js`, но `dataLoader.js` нормализовал в `c.volume`. Volume условие никогда не срабатывало, при `tradeThreshold: 4` сделок не было. Surgical fix: добавил `vol` алиас в normalize, не трогая стратегии.
2. Переключил `dataLoader.js` со spot на mix futures (`/api/v2/mix/market/history-candles`, `productType=USDT-FUTURES`). Mix-endpoint не принимает `startTime` — пагинация только через `endTime + limit`. Изменены granularity-строки (`1h` → `1H`, `1day` → `1D` и т.д.). Старый кеш сброшен.
3. `runMultiBacktest`: параллельный fetch свечей (concurrency=8), последовательная симуляция, агрегация trades + equity-drawdown chronologically. Прогресс пишется в файл каждые 5 символов.
4. Endpoint `/api/symbols/top?n=N`: топ Bitget USDT-фьючерсов по 24h объёму (usdtVolume), кеш 5 минут. Доступно 543 символа, можно до n=1000.
5. UI: переключатель Single/Multi в форме pump-fader backtest. В Multi — кнопки топ-50/100/200/300 + произвольное N. Прогресс-бар "47/300 символов". Таблица топ-20 символов по PnL после завершения.

**Результат проверки:** одиночный BT BTCUSDT 1H Aug-Nov 2025 с RSI≥70 + pump≥2% + vol×2 → 24 сделки (раньше 0). Multi-BT 5 топ-альтов → 166 сделок суммарно, агрегация работает. Synтаксис всех файлов чистый.

**Не сделано (на следующий заход):**
- Multi-symbol режим для оптимайзера (`runGridSearch` пока single-symbol)
- Подсказки (tooltips) в полях параметров pump-fader (по типам монет: BTC/ETH vs альты vs мемкоины)

### 2026-05-06 — Multi-symbol оптимайзер + tooltips для pump-fader

**Задача:** Multi-symbol grid search с прогрессом по блокам по 50 символов. Подсказки во всех 25 полях pump-fader (backtest + live).

**Изменённые файлы:**
- core/backtest/runner.js (+ runMultiGridSearch, pf-cache переиспользуется)
- dashboard/routes/backtest.js (+ POST/GET /api/backtest/multi-grid)
- dashboard/public/index.html (UI ветвление single/multi, tooltips на 25 полей backtest + live)

**Что сделано:**
1. `runMultiGridSearch`: параллельный fetch свечей, для каждой пары один раз precompute pf-cache (zones/fibs/vp/sr), затем все 750 комбо переиспользуют его. Иначе precompute гонялся бы 750 раз на пару.
2. Промежуточный прогресс: каждые 50 символов → запись топ-30 текущих лидеров в файл. UI показывает «Промежуточный топ-5» во время выполнения.
3. _simulate расширена: если `indicators.pfCache` передан — используется, иначе вычисляется. Surgical, не ломает single-grid и single-bt.
4. UI `btPfGridRun` ветвится по `pfMultiState.mode`: single → /api/backtest/grid (как было), multi → /api/backtest/multi-grid с polling каждые 3с.
5. Tooltips: 24 поля backtest-формы (`<div class="field" title="..."><label>... ⓘ</label><input ... title="..."></div>`) + 17 полей live-формы (расширены `tip` в массиве `PUMP_FADER.groups[].fields[]`). Текст по схеме: BTC/ETH → топ-альты → альты → мемкоины.

**Результат проверки:** runMultiGridSearch на 3 парах × 16 комбо = 1.0с. Линейная экстраполяция: 300 пар × 750 комбо ≈ 60-90 минут (зависит от длины данных). Кнопка «✅ Готово» в UI отрисовывает топ-20 с колонкой «Symbols» (n/total). Синтаксис всех файлов чистый, dashboard перезапущен.

### 2026-05-06 — График Equity/PnL Real vs Paper на главной странице

**Задача:** Добавить на главную переключатель Real/Paper для графика equity.

**Изменённые файлы:**
- dashboard/server.js
- dashboard/public/index.html

**Что сделано:**
1. Server: добавлена `paperPnlChartData()` — собирает paper-сделки из CSV (`[PAPER]` в имени агента) + из `closed_trades_pump_fader.jsonl` (поле `paper: true`). Endpoint `GET /api/pnl/chart` расширен параметром `?mode=real|paper`.
2. UI: кнопки-табы Real/Paper над графиком (используют существующий `.chart-tab-btn` стиль). `setChartMode()` переключает активную кнопку и перезапрашивает chart.
3. Paper-режим: линия жёлтого цвета, gradient жёлтый, заголовок показывает `[PAPER]`. Real-режим — без изменений (зелёный/красный).

**Результат проверки:** server OK, div balance 0, сервис online. CSV: 44 реальных + 654 paper сделок. PF jsonl: 1 paper сделка.
