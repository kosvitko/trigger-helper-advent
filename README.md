# AI Advent Challenge #9 — Week 02, Day 07

**Задание:** сохранение контекста — хранить историю диалога (messages) в JSON или SQLite, при перезапуске загружать обратно, продолжать диалог как будто агент не выключался.

Trigger Helper (day07): треды агента + реестр инстансов сериализуются в **JSON-снапшот** (`var/agent-state.json`): atomic `tmp → rename`, запись с дебаунсом после каждой мутации, flush при остановке; на старте снапшот читается и валидируется (Zod, битые записи отбрасываются по одной). Диалог → рестарт процесса → F5 → тред на месте → агент отвечает с фактами из дотрестартного диалога (в LLM уходит хвост истории треда).

**Live demo:** http://91.188.212.10/ · **Tag:** [`week02-day07`](https://github.com/kosvitko/trigger-helper-advent/tree/week02-day07)

Модель в демо — дефолтная дешёвая (DeepSeek chat), одна, без ×3.

## Demo на видео

| | |
|:--|:--|
| Чаты | **2 инстанса × 2 чата** — треды независимы |
| Диалоги | шея → точка (Inst1/Care) · протокол самопомощи (Inst1/Strict) · голова (Inst2) |
| Рестарт | перезапуск процесса сервера на камере (`systemctl restart`) |
| F5 | **3 треда восстановлены раздельно** (1/1/1) с диска, не из кэша браузера |
| Проверка | «Мы до перезапуска разбирали шею — какую точку?» → агент отвечает из своего треда |

Перед записью треды почищены (state-файл удалён + рестарт сервиса).

## Что где реализовано

| Требование | Где |
|:-----------|:----|
| JSON-хранилище | `server/src/services/agent/persistence.ts` — `AgentStateStore` (atomic write, debounce, health-restore пустого состояния) |
| Снапшот контекста | instances + seq-счётчики + threads `instanceId|agentId → messages[]` — тред без реестра бессмыслен (`run`/`messages` проверяют существование агента) |
| Загрузка при старте | `server/src/index.ts` — снапшот до `app.listen`; seed-инстанс только на пустом состоянии |
| Персист-хуки | `ThreadStore` / `InstanceRegistry` — `onChange` → дебаунс-запись; flush на SIGINT/SIGTERM |
| Продолжение диалога | `POST /api/agent/run` без изменений: history из того же `ThreadStore` → хвост 10 сообщений в контекст LLM |
| Гигиена | ≤100 последних сообщений на тред в файле; `var/` вне git; путь настраивается `AGENT_STATE_FILE` |

Почему JSON, а не SQLite: read-only-каталог данных мал, миграции не нужны, нативный модуль на VPS не привлекаем — SQLite запланирован позже, с аккаунтами.

## Быстрый старт

```bash
git clone https://github.com/kosvitko/trigger-helper-advent.git
cd trigger-helper-advent
git checkout week02-day07
cp .env.example .env   # DEEPSEEK_API_KEY=...
npm install
npm run dev            # http://127.0.0.1:3000 — Agent UI
```

Сценарий проверки: два вопроса агенту → остановить сервер → запустить снова → F5 → тред на месте → «какую точку мы разбирали?» → ответ с фактами.

## Demo через API

```bash
# инстанс + агент
curl -X POST http://127.0.0.1:3000/api/instances -H "Content-Type: application/json" -d '{"seedPresetIds":["care"]}'

# диалог (history сохраняется в var/agent-state.json)
curl -X POST http://127.0.0.1:3000/api/agent/run -H "Content-Type: application/json" \
  -d '{"instanceId":"<iid>","agentId":"<aid>","input":"Шея каменная — какую точку проверить?"}'

# после рестарта процесса: та же история доступна
curl http://127.0.0.1:3000/api/instances/<iid>/agents/<aid>/messages
```

## Структура репозитория

```
server/   API (agents / instances / run / messages, /api/ask) + Agent UI
shared/   Zod-схемы: инстансы, агенты, сообщения
data/     точки для grounded-режима
var/      снапшот контекста (agent-state.json) — вне git
```

Ключ API только в env на сервере, не в клиенте и не в git.
