# AI Advent Challenge #9 — Week 01, Day 05

**Задание:** один запрос × слабая / средняя / сильная модель → time / tokens / cost → качество / скорость / ресурсоёмкость → вывод.

Trigger Helper (day05): `scope` `grounded` | `open`, пресет **L**, ×3 модели (ProxyAPI или DeepSeek fallback), `latency_ms`, usage `by_model`, суточный лимит на дорогие модели.

**Live demo:** http://91.188.212.10/ · **Tag:** [`week01-day05`](https://github.com/kosvitko/trigger-helper-advent/tree/week01-day05)

## Demo на видео

| | |
|:--|:--|
| Scope | **Задача** (`open`) |
| Пресет | **L** — первый экран «болит шея» (текст зафиксирован) |
| Рассуждение | `direct` |
| Temperature | `0.3` |
| Прогон | **×3 модели** |

Тройка (ProxyAPI):

| Tier | Model |
|:-----|:------|
| быстрая | `gemini/gemini-2.5-flash-lite` |
| средняя | `gemini/gemini-2.5-flash` |
| сильная | `anthropic/claude-sonnet-4-5` |

Без `PROXYAPI_API_KEY` — DeepSeek `chat` / `reasoner` как fallback.

## Выводы

Всё достаточно прозаично. Простые модели в основном пересказывают вопрос на разные лады и не ищут дополнительной информации, пока это не сказано явно. При усложнении модели появляется дополнительный анализ и аналитика.

Дорогие модели уместны для разбора области, проработки архитектуры и сложных задач. Простые задачи — особенно после постановки их сильной моделью — могут выполнить и более дешёвые / быстрые модели.

Дальше имеет смысл считать **эффективность на стоимость** (качество ответа vs time / tokens / ₽) на реальных сценариях продукта.

| Tier (demo) | Модель |
|:------------|:-------|
| быстрая | `gemini/gemini-2.5-flash-lite` |
| средняя | `gemini/gemini-2.5-flash` |
| сильная | `anthropic/claude-sonnet-4-5` |

## Что где реализовано

| Требование | Где |
|:-----------|:----|
| ×3 модели | `ASK_DEMO_MODEL_TIERS` · `GET /api/models` · UI «×3» |
| time / tokens / cost | `latency_ms` · `usage` · ledger `by_model` |
| open vs grounded | `scope` в `shared` / `ask` |
| Пресет L | `OPEN_PRESET_L_QUESTION` · `OPEN_TASK_MODE=public` |
| Лимит дорогих | `FREE_DAILY_ASKS` · `isExpensiveModel` |

## Быстрый старт

```powershell
git clone https://github.com/kosvitko/trigger-helper-advent.git
cd trigger-helper-advent
git checkout week01-day05
Copy-Item .env.example .env
# DEEPSEEK_API_KEY=...
# опционально PROXYAPI_API_KEY=... для тройки Gemini/Claude
npm install
npm run dev
```

Браузер: http://127.0.0.1:3000/ — **Задача** → **L** → `direct` → T=0.3 → **×3**.

## Demo через API

```powershell
$q = @"
Пользователь впервые открыл приложение самопомощи и написал: «болит шея». Спроектируй один первый экран: что спросить / что показать (1–2 точки или зоны) / нужна ли графика или анимация / 3 шага самопомощи / дисклеймер.
Структура: цель → сценарий 3–5 шагов → содержимое экрана → 2 риска → MVP. Без кода. Коротко и по делу.
"@
$body = @{
  scope = "open"
  question = $q
  format = "free"
  reasoningMode = "direct"
  temperature = 0.3
  model = "gemini/gemini-2.5-flash"
} | ConvertTo-Json
Invoke-RestMethod -Uri "http://127.0.0.1:3000/api/ask" -Method Post -ContentType "application/json" -Body $body
```

## Структура репозитория

```
server/   API (/api/ask, /api/models, /api/usage) + demo UI
shared/   Zod: scope, L preset, demo tiers
data/     точки для grounded
```
