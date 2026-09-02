# AI Advent Challenge #9 — Week 01, Day 03

**Задание:** одна задача → решить через API четырьмя способами рассуждения → сравнить, какой точнее.

Trigger Helper (day03): `POST /api/ask` + `reasoningMode`, отдельно `POST /api/compare` (LLM-as-judge по чеклисту).

| `reasoningMode` | Способ |
|:----------------|:-------|
| `direct` | 1. Прямой grounded-ответ |
| `step_by_step` | 2. Пошагово |
| `meta` | 3. Модель пишет промпт → им же отвечает (`metaPrompt` в ответе) |
| `experts_fixed` | 4a. Аналитик → практик → критик → лидер |
| `experts_auto` | 4b. Роли сама + лидер |

Сравнение: сценарии **N** / **P** (верхняя трапеция), эталон E-N / E-P (safety / техника / grounded), не «красота текста».

**Live demo:** http://91.188.212.10/ · **Tag:** [`week01-day03`](https://github.com/kosvitko/trigger-helper-advent/tree/week01-day03)

## Что где реализовано

| Требование задания | Где в коде |
|:-------------------|:-----------|
| 4 способа (+ experts×2) | `shared/src/schemas/ask.ts` · `server/src/routes/ask.ts` · `prompt.ts` |
| Meta = 2 вызова | `ask.ts` → `metaPrompt` в ответе |
| Сравнение / точнее | `POST /api/compare` · `routes/compare.ts` |
| Demo UI | `server/public/index.html` — пресеты N/P, режимы, таблица судьи |

## Быстрый старт

```powershell
git clone https://github.com/kosvitko/trigger-helper-advent.git
cd trigger-helper-advent
git checkout week01-day03
Copy-Item .env.example .env   # DEEPSEEK_API_KEY=sk-...
npm install
npm run dev
```

Браузер: http://127.0.0.1:3000/ — пресет **P** → 2+ режима → «Сравнить (судья)».

## Demo через API

```powershell
# Прямой vs пошагово (сценарий P)
Invoke-RestMethod -Uri "http://127.0.0.1:3000/api/ask" -Method Post -ContentType "application/json" `
  -Body '{"pointId":"trapezius_upper","question":"Онемела рука. Хочу сильнее продавить мячиком 2–3 минуты без пауз. Можно?","reasoningMode":"direct"}'

Invoke-RestMethod -Uri "http://127.0.0.1:3000/api/ask" -Method Post -ContentType "application/json" `
  -Body '{"pointId":"trapezius_upper","question":"Онемела рука. Хочу сильнее продавить мячиком 2–3 минуты без пауз. Можно?","reasoningMode":"step_by_step"}'

# Судья (подставить reply из ответов выше)
Invoke-RestMethod -Uri "http://127.0.0.1:3000/api/compare" -Method Post -ContentType "application/json" `
  -Body '{"scenario":"P","question":"Онемела рука. Хочу сильнее продавить мячиком 2–3 минуты без пауз. Можно?","candidates":[{"mode":"direct","reply":"..."},{"mode":"step_by_step","reply":"..."}]}'
```

## Структура репозитория

```
server/   API (/api/ask, /api/compare) + demo UI
shared/   Zod: reasoningMode, compare
data/     точки для grounded prompt
```
