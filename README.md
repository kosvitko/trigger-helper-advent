# AI Advent Challenge #9 — Week 06, Day 30

**Trigger Helper** — продуктовый SPA самопомощи по триггерным точкам (Svelte 5 + Fastify). День 30 — **локальная LLM как приватный сервис**: продукт сам является HTTP API (Caddy → Fastify → Ollama на loopback), с семафором на одновременные локальные ходы (`LOCAL_MAX_CONCURRENT=1`) и живой очередью в UI. Живое демо: https://trigger.ksvitkov.ru

## Demo на видео

1. **Четыре клиента одновременно (2×2)**: четыре окна продукта с локальной моделью Qwen2.5 0.5B · RAG; первый занимает слот генерации, остальные встают в очередь.
2. **Очередь в диалоге**: у ждущих клиентов бабл «Ваш запрос N в очереди.» — позиция обновляется при сдвиге очереди; в трейсе шаг `local-queue`.
3. **Все четверо получают ответ** по базе (жевательная мышца / точки / самомассаж / отражённая боль), сессия ₽0.
4. **Терминал: `npm run local-llm:check -- --concurrent`**: два non-RAG клиента через тот же семафор — таблица «очередь / ждал / gen / wall», PASS при wall≈сумма gen (NUM_PARALLEL=1).

## Выводы

При наличии достаточно мощного оборудования, используя простые техники массового обслуживания, можно достаточно экономично (эксплуатация сервера + расходы на эл-во) решать задачи, связанные с обработкой данных LLM.

## Что где реализовано

| Пункт задания | Где |
|:---|:---|
| Локальная LLM как HTTP-сервис | продукт за Caddy/LAN: `POST /api/chat` → Ollama `127.0.0.1`; снаружи Ollama не торчит |
| Чат + доступ по сети | SPA + HTTPS прод `trigger.ksvitkov.ru`; `GET /api/health` → `localQueue` |
| ≥2 одновременных коннекта / очередь | `server/src/services/local-llm-gate.ts` — семафор max=`LOCAL_MAX_CONCURRENT` (default 1); SSE `local-queue` + flush; UI-бабл «Ваш запрос N в очереди.» (`dialog.svelte.ts` / `DialogColumn.svelte`) |
| Rate limit / max context | существующий IP rate limit + `num_ctx` профиля модели; evidence в шапке `local-llm:check --concurrent` |
| Проверка concurrent | `npm run local-llm:check -- --concurrent` — 2 клиента, PASS = очередь + wall≈сумма gen |
| Прод | тот же код на h3llo (деплой 11.10): health `localQueue.max=1`, dual-client SSE на VPS — второй видит очередь |

## Быстрый старт

```bash
npm install                # воркспейсы: shared + server + client
npm run build              # shared → server → client (SPA собирается последней)

# локальная ветка: Ollama + модель каталога (loopback)
ollama pull qwen2.5:0.5b
# OLLAMA_NUM_PARALLEL=1  и  LOCAL_MAX_CONCURRENT=1  (согласованы)

cd server
npm run dev                # API на :3000
npm run local-llm:check -- --concurrent   # очередь + wall≈сумма gen

# SPA — второй терминал из корня репо
npm run dev:spa            # vite :5173, /api проксируется
```

## Demo через API

```bash
# два параллельных non-RAG хода на локальной модели — второй ждёт семафор
curl -N -X POST http://127.0.0.1:3000/api/chat -H "Content-Type: application/json" \
  -d '{"input":"Скажи одно слово: синий","preset":"care","contextTail":{},"overrides":{"model":"qwen2.5:0.5b"}}'
# → SSE: step local-queue (если слот занят) → local-gen → done; usage.estimated_cost_rub = 0
```
