# AI Advent Challenge #9 — Week 02, Day 09

**Задание:** управление контекстом — сжатие истории: последние N сообщений «как есть», остальное заменять summary (например, каждые 10 сообщений); хранить summary отдельно и подставлять в запрос вместо полной истории. Сравнить качество ответов без/со сжатием и расход токенов.

Trigger Helper (day09): **автосжатие истории прямо в обработчике диалога** — каждые M диалоговых сообщений (сверх последних 4, которые всегда остаются дословно) старая история сворачивается в одну system-сводку дешёвой моделью **синхронно, до вызова LLM**: ответ на текущий вопрос агент даёт уже на сжатом контексте. Сводка — обычное сообщение треда (`role: system`): переживает рестарт, а `saved_tokens` учитывает экономию окна. Порог настраивается: env `AGENT_COMPRESS_EVERY` (по умолчанию 10, `0` = выключено) или per-request override в Lab-панели UI. Сбой суммаризатора не ломает диалог — вопрос уходит без сжатия, попытка повторится на следующем.

**Live demo:** http://91.188.212.10/ · **Tag:** [`week02-day09`](https://github.com/kosvitko/trigger-helper-advent/tree/week02-day09)

Модель в демо — дефолтная дешёвая (DeepSeek chat), одна, без ×3.

## Demo на видео (~12 мин)

Один и тот же диалог (13 вопросов о шее/плече) в двух чатах одного инстанса — факты закладываются в первых вопросах, 25-е сообщение в каждом чате просит их вспомнить:

| | |
|:--|:--|
| **Чат A — автосжатие (M=10)** | два автосжатия в кадре: фаза «Сжимаю историю…» с секундомером → бейдж «сжатие ~X → ~Y (₽Z)», окно освобождается; ответ на 25-й вопрос — по сводке, ранние факты на месте |
| **Чат B — без сжатия (Lab: 0 + full)** | тот же диалог: 26 сообщений, окно ~11.9k ток, ₽1.92 — против ~1.5k ток · ₽0.31 в чате A |
| **Ручное «Сжать» (чат B)** | 11.9k → 1.7k ток в окне — демонстрация кнопки из day09 на длинной истории |

Качество: оба чата корректно отвечают на 25-й вопрос (A — из сводки, B — из полной истории), расход токенов отличается в разы.

## Что где реализовано

| Требование | Где |
|:-----------|:----|
| Триггер «каждые M сообщений» | `server/src/services/agent/llm-agent.ts` — `shouldAutoCompress()`: счётчик диалоговых user+assistant после последней system-сводки **сверх keepLast-хвоста** (хвост не ускоряет ритм); `>= M`; счётчик выводится из треда — рестарт не сдвигает |
| Сжатие до ответа | `server/src/routes/agents.ts` — в `POST /api/agent/run` после троттлингов: `compressAndPersist()` (общий путь с ручным «Сжать»: сводка + persist + ledger) → история перечитывается → LLM отвечает уже на сжатом |
| Настройка/выключение | env `AGENT_COMPRESS_EVERY` (default 10, 0=off) + `overrides.compressEvery` в Lab UI (пусто = default, 0 = выкл); default в `GET /api/agents → autoCompress.defaultEvery` |
| Сбой | opportunistic: ошибка суммаризатора → `log.warn`, вопрос отвечается без сжатия; сжатие не откатывается; естественный ретрай на следующем вопросе |
| UI | `server/public/index.html` — фаза «Сжимаю историю…» с секундомером → «Печатает…» (клиент предсказывает сжатие, poll `GET .../messages` на появление сводки), бейдж «сжатие ~X → ~Y (₽Z)» на сводке, Lab-инпут «Автосжатие» |
| Учёт экономии | `saved_tokens` на сводке + `savedTokensSum` в `GET .../tokens` — экономия окна переживает рестарт (persist дня 07) |
| Ручное «Сжать» | `POST .../compress` — как в day08, без изменений (extract общего пути persist+ledger) |

## Быстрый старт

```bash
git clone https://github.com/kosvitko/trigger-helper-advent.git
cd trigger-helper-advent
git checkout week02-day09
cp .env.example .env   # DEEPSEEK_API_KEY=...
npm install
npm run dev            # http://127.0.0.1:3000 — Agent UI

# порог автосжатия (default 10); 0 = выключить
AGENT_COMPRESS_EVERY=10 npm run dev
```

## Demo через API

```bash
# инстанс + агент
curl -X POST http://127.0.0.1:3000/api/instances -H "Content-Type: application/json" -d '{"seedPresetIds":["care"]}'

# 5 вопросов подряд (при M=10 пятый ответ приходит уже после автосжатия:
# в ответе — autoCompression {summaryId, before, after, compression})
curl -X POST http://127.0.0.1:3000/api/agent/run -H "Content-Type: application/json" \
  -d '{"instanceId":"<iid>","agentId":"<aid>","input":"Шея каменная — какую точку проверить?","overrides":{"compressEvery":4}}'

# тред: одна system-сводка вместо старой истории + saved_tokens
curl http://127.0.0.1:3000/api/instances/<iid>/agents/<aid>/messages

# экономия окна суммарно по треду
curl http://127.0.0.1:3000/api/instances/<iid>/agents/<aid>/tokens
```

## Структура репозитория

```
server/   API (agents / instances / run / messages / tokens / compress) + Agent UI
shared/   Zod-схемы: инстансы, агенты, сообщения, compress, autoCompression
data/     точки для grounded-режима
var/      снапшот контекста (agent-state.json) — вне git
```

Ключ API только в env на сервере, не в клиенте и не в git.
