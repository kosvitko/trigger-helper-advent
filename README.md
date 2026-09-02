# AI Advent Challenge #9 — Week 01, Day 01

**Задание:** минимальный код → запрос в LLM через API → ответ → demo (curl или UI).

Trigger Helper (day01): Fastify-сервер шлёт вопрос в DeepSeek и возвращает ответ. Контекст — одна триггерная точка из JSON (grounded prompt).

**Live demo:** http://91.188.212.10/ · **Tag:** `week01-day01`

## Что где реализовано

| Требование задания | Где в коде |
|:-------------------|:-----------|
| HTTP API для запроса | `server/src/routes/ask.ts` — `POST /api/ask` |
| Вызов LLM через API | `server/src/services/deepseek.ts` — `fetch` к DeepSeek Chat Completions |
| Ключ модели только в env | `server/src/config/env.ts`, `.env.example` — `DEEPSEEK_API_KEY` не в коде |
| Контракт запроса/ответа | `shared/src/schemas/ask.ts` — `pointId`, `question` → `reply`, `usage` |
| Контекст для промпта (данные) | `data/points.json` — 3 точки; `server/src/services/points.ts` — загрузка |
| System prompt из карточки точки | `server/src/services/prompt.ts` — `buildGroundedSystemPrompt()` |
| Точка входа сервера | `server/src/index.ts` — Fastify, static UI, регистрация routes |
| Demo UI (альтернатива curl) | `server/public/index.html` — чат: зона → вопрос → `POST /api/ask` |
| Health-check | `server/src/routes/health.ts` — `GET /api/health` |

## Быстрый старт

```powershell
git clone https://github.com/kosvitko/trigger-helper-advent.git
cd trigger-helper-advent
Copy-Item .env.example .env   # DEEPSEEK_API_KEY=sk-...
npm install
npm run dev
```

Браузер: http://127.0.0.1:3000/

## Demo через API

```powershell
Invoke-RestMethod -Uri "http://127.0.0.1:3000/api/health"

Invoke-RestMethod -Uri "http://127.0.0.1:3000/api/ask" `
  -Method Post -ContentType "application/json" `
  -Body '{"pointId":"trapezius_upper","question":"Как понять, что давлю не слишком сильно?"}'
```

## Структура репозитория

```
server/   API + demo UI
shared/   Zod-схемы
data/     минимальный набор точек для day01
```
