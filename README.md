# AI Advent Challenge #9 — Week 02, Day 10

**Задание:** минимум три стратегии контекста **без summary** + переключатель: Sliding Window / Sticky Facts / Branching. Один сценарий × все три; сравнить качество, стабильность, токены, удобство. Сдача: видео + код.

Trigger Helper (day10): три режима сборки контекста поверх агента day06–09. **Sliding** — в LLM уходят только последние N сообщений (`HISTORY_TAIL=10`, user+assistant суммарно); полная лента остаётся в UI/store. **Facts** — LLM-extract sticky KV (allowlist: цель, ограничения, предпочтения, решения, договорённости) + хвост окна. **Branching** — checkpoint → fork двух веток (`agentId#a` / `#b`) → switch без смешения хвостов. Переключатель в Lab; в кадре — payload (`historySent`) и панель facts.

**Live demo:** http://91.188.212.10/ · **Tag:** [`week02-day10`](https://github.com/kosvitko/trigger-helper-advent/tree/week02-day10)

Модель в демо — дефолтная дешёвая (DeepSeek chat), одна, без ×3. Автосжатие в сценарии выключено (`compressEvery=0`).

## Demo на видео (~4 мин)

Один продуктовый сценарий (зона/точка/техника/ограничения) в трёх чатах:

| | |
|:--|:--|
| **Sliding** | 6 ходов → ≥12 сообщений в ленте → probes к якорям **msg1** (уже вне окна N=10) и **msg5** (ещё в окне); `historySent` ≤ 10 |
| **Facts** | тот же build + те же probes; KV в кадре; facts уходят в запрос вместе с хвостом |
| **Branching** | префикс → checkpoint → fork → ветка изометрия / ветка растяжка → switch; хвосты не смешиваются |

## Выводы

- **Sliding window** приводит к «забыванию» фактов — что ожидаемо: ранние реплики просто не попадают в очередной запрос к модели (окно N=10 суммарно user+assistant).
- **Facts** несколько увеличивает латентность и бюджет (отдельный extract). При сопоставимом объёме диалога модель отвечает суше и структурнее — на вход в основном структурированные факты, а не длинный «сырой» хвост.
- **Ветвление** по сути добавляет часть диалога как условный «системный» префикс ветки. Близко к работе с файлами проекта (общий префикс) и к моделям с разными ролями (аналитик, архитектор и т.п.): общий ствол → разные продолжения без смешения.

## Что где реализовано

| Требование | Где |
|:-----------|:----|
| Переключатель стратегии | `overrides.contextStrategy`: `sliding` \| `facts` \| `branching` · Lab UI (`#context-strategy` + lock) · persist в `var/agent-state.json` |
| Sliding = LLM-окно | `server/src/services/agent/llm-agent.ts` — `historyToChat(…, "tail")`, `HISTORY_TAIL=10`; store/UI не режутся |
| Sticky facts (F1) | extract → allowlist merge → system «Sticky facts» в запросе; fail-open при сбое extract |
| Payload в кадре | `context.historyMessages` + `tokens.historySent`; панель `#payload-panel` |
| Facts KV в кадре | `context.facts` + `#facts-panel` |
| Branching | `agentId#a` / `#b` · `POST …/branch/checkpoint\|fork\|switch` · UI Checkpoint/Fork/tabs |
| Схемы | `shared/src/schemas/agent.ts` — strategy, facts, branch meta, context в ответе run |

## Быстрый старт

```bash
git clone https://github.com/kosvitko/trigger-helper-advent.git
cd trigger-helper-advent
git checkout week02-day10
cp .env.example .env   # DEEPSEEK_API_KEY=...
npm install
npm run dev            # http://127.0.0.1:3000 — Agent UI · title «Агент · day10»
```

## Demo через API

```bash
# инстанс + агент
curl -X POST http://127.0.0.1:3000/api/instances -H "Content-Type: application/json" -d '{"seedPresetIds":["care"]}'

# Sliding: хвост ≤ N в context.historyMessages
curl -X POST http://127.0.0.1:3000/api/agent/run -H "Content-Type: application/json" \
  -d '{"instanceId":"<iid>","agentId":"<aid>","input":"Зона: шея. Ограничение: при остром — к врачу.","overrides":{"contextStrategy":"sliding","compressEvery":0}}'

# Facts: extract + KV в ответе
curl -X POST http://127.0.0.1:3000/api/agent/run -H "Content-Type: application/json" \
  -d '{"instanceId":"<iid>","agentId":"<aid>","input":"Цель: снять напряжение. Предпочтения: короткая изометрия.","overrides":{"contextStrategy":"facts","compressEvery":0}}'

# Branching: checkpoint → fork → run на #a / #b
curl -X POST http://127.0.0.1:3000/api/instances/<iid>/agents/<aid>/branch/checkpoint
curl -X POST http://127.0.0.1:3000/api/instances/<iid>/agents/<aid>/branch/fork
curl -X POST http://127.0.0.1:3000/api/agent/run -H "Content-Type: application/json" \
  -d '{"instanceId":"<iid>","agentId":"<aid>#a","input":"Ветка: изометрия.","overrides":{"contextStrategy":"branching"}}'
```

## Структура репозитория

```
server/   API (agents / run / branch / messages / tokens) + Agent UI
shared/   Zod: contextStrategy, facts, branch, context payload
data/     точки для grounded-режима
var/      снапшот (agent-state.json) — вне git
```

Ключ API только в env на сервере, не в клиенте и не в git.
