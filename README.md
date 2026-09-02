# AI Advent Challenge #9 — Week 01, Day 02

**Задание:** один запрос к LLM с явным форматом ответа, ограничением длины и условием завершения; сравнить без ограничений ↔ с ограничениями.

Trigger Helper (day02): тот же `POST /api/ask`, параметр `format`:

| `format` | Контроль |
|:---------|:---------|
| `free` (по умолчанию) | обычный grounded-промпт, без `max_tokens` / JSON mode |
| `json` | схема в промпте + `response_format: json_object` + `max_tokens: 700` + инструкция завершить на `}` |

**Live demo:** http://91.188.212.10/ · **Tag:** `week01-day02`

## Что где реализовано

| Требование задания | Где в коде |
|:-------------------|:-----------|
| A/B через API | `server/src/routes/ask.ts` — ветка по `format` |
| Формат JSON | `server/src/services/prompt.ts` — `buildJsonSystemPrompt()`; `deepseek.ts` — `response_format` |
| Ограничение длины | `ask.ts` — `JSON_MAX_TOKENS` → `max_tokens` |
| Условие завершения | промпт: ответ заканчивается на последней `}` |
| Контракт | `shared/src/schemas/ask.ts` — `format: free \| json` |
| Demo UI | `server/public/index.html` — комбо «Формат ответа», бейдж ✓ JSON Ok |

## Быстрый старт

```powershell
git clone https://github.com/kosvitko/trigger-helper-advent.git
cd trigger-helper-advent
git checkout week01-day02
Copy-Item .env.example .env   # DEEPSEEK_API_KEY=sk-...
npm install
npm run dev
```

Браузер: http://127.0.0.1:3000/ — A/B (свободный ↔ JSON) на одном вопросе; затем в JSON — просьба «ответь не JSON» и оффтоп (схема должна удержаться).

## Demo через API

```powershell
Invoke-RestMethod -Uri "http://127.0.0.1:3000/api/ask" `
  -Method Post -ContentType "application/json" `
  -Body '{"pointId":"trapezius_upper","question":"Как понять, что давлю не слишком сильно?","format":"free"}'

Invoke-RestMethod -Uri "http://127.0.0.1:3000/api/ask" `
  -Method Post -ContentType "application/json" `
  -Body '{"pointId":"trapezius_upper","question":"Как понять, что давлю не слишком сильно?","format":"json"}'
```

## Структура репозитория

```
server/   API + demo UI
shared/   Zod-схемы (в т.ч. format)
data/     точки для grounded prompt
```
