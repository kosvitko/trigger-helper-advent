# AI Advent Challenge #9 — Week 02, Day 06

**Задание:** простой агент — запрос пользователя → LLM API → ответ в UI. Агент = **отдельная сущность** (не голый вызов API).

Trigger Helper (day06): модуль `Agent` + policies, dual **инстансы × агенты**, чат с hydrate после F5 (server in-memory, без БД), полоса счётчиков (сессия / VPS / дорогие), meta на ответе (model · ms · tok · ₽).

**Stack:** TypeScript · Fastify · Zod · DeepSeek (env) · demo `server/public` (Agent UI; day05 lab demo не сохраняем)

**Статус README:** черновик под outbox · код/tag ещё не в этом срезе  
**Tag (когда будет):** `week02-day06` · Live: http://91.188.212.10/

## Quick start (после реализации)

```bash
cp .env.example .env   # DEEPSEEK_API_KEY=...
npm install
npm run dev            # http://localhost:3000 — Agent UI
```

Smoke: `GET /api/health` · `POST /api/agent/run` · (опц.) `POST /api/ask` без регрессии API.

## Demo на видео (план)

| | |
|:--|:--|
| UI | Agent: вкладки инстансов + агентов |
| Действия | run → `+ агент` → `+ инстанс` → spawn count → F5 hydrate |
| Debug | счётчики + ₽/tok/ms на ответе |

## Layout кода

| Путь | Что |
|:-----|:----|
| `server/` `shared/` `data/` | runtime |
| `advent/week02/` | мета сдачи (этот README в outbox) |

Ключ API только в env на server, не в клиенте и не в git.
