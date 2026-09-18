# AI Advent Challenge #9 — Week 03, Day 14

**Задание:** добавить в ассистента инварианты, которые он не имеет права нарушать: выбранная архитектура, принятые технические решения, ограничения по стеку, бизнес-правила. Инварианты хранятся отдельно от диалога; ассистент явно учитывает их в рассуждениях и отказывается предлагать решения, которые их нарушают. Проверить конфликт запроса и инварианта и то, как ассистент объясняет отказ. Сдача: видео + код.

Trigger Helper (day14): инварианты — **отдельная сущность уровня агента**, не слой памяти (в памяти факты удаляемы, а классификатор легализует запреты из диалога — прямой prompt-injection вектор). У каждого правила `scope` (`agent` — всегда, `task` — при активной задаче) и `enforcement`: `soft` — только промпт, `hard` — плюс опциональный `pattern` (regex по **входу пользователя**): конфликт детерминированно ловится кодом, и от валидатора требуется подтверждение отказа в ответе — есть отказ с цитатой `[INV-n]` → `ok`, конфликт без отказа → `critical`. Инъекция-блок стоит вторым сообщением сразу после системного промпта (статичен — тёплый префикс-кэш) и объявляет иерархию: правила владельца главнее профиля, памяти, задачи и истории, но не отменяют тему самопомощи и дисклеймер. Место «стейт-машина» из уточнения орга закрыто consent-гвардом: `goto → done` без `consent: true` даёт `409 {consentRequired}`, стейт не меняется. Модель гарантий честная, как в чате потока: детерминированное проверяет код, семантику — промпт, 100% гарантий нет.

**Live demo:** http://91.188.212.10/ · **Tag:** [`week03-day14`](https://github.com/kosvitko/trigger-helper-advent/tree/week03-day14)

## Demo на видео (~43s)

Lab: `История = tail·10`, автосжатие выключено. Панель «Инварианты (day14)» — первая в правом доке: список правил с чипами `hard/soft` и `agent/task`, чекбоксы активности, форма добавления (текст + scope + enforcement + опциональный regex):

| | |
|:--|:--|
| **Seed 6 правил** | первый GET сеет владельческий набор: без медикаментов/диагнозов, красные флаги → к специалисту, стек продукта (UI один файл, JSON без БД), термины латиницей, границы плана задачи, один шаг за раз |
| **Конфликт-вопрос** | «Шея болит — какую таблетку принять?» → отказ своими словами с цитатой `[INV-1]` и безопасной альтернативой; payload: «Валидатор: ✓ Конфликт распознан — отказ [INV-1]» |
| **Нейтральный вопрос** | обычный ответ про разминку; payload: «✓ Инварианты учтены» — блок в промпте не ломает поведение |
| **→ done без согласия** | confirm-отмена — статус-подсказка (без `consent` сервер вернёт 409, стейт цел) |
| **→ done с согласия** | confirm-подтверждение → `consent: true` → задача завершена, таймлайн зелёный |

## Выводы

Модель отвечает своими словами, ссылаясь на конкретные запреты. Но при этом может их озвучивать даже если напрямую вопрос не касается границ дозволенного. Думаю, это тоже регулируется правильным промптом и/или кодом для фильтрации.

## Что где реализовано

| Требование | Где |
|:-----------|:----|
| Инварианты хранятся отдельно от диалога | `server/src/services/agent/invariant-state.ts` — стор per-agent (`instanceId|agentId`), секция `invariantStates` в `var/agent-state.json` (per-key safeParse, уроки day12/13 воспроизведены); НЕ `MemoryStateStore` |
| Правила: архитектура / техрешения / стек / бизнес-правила | seed 6 правил в `invariant-state.ts`; CRUD: `GET/POST/PATCH/DELETE …/invariants` (кап 8; невалидный/пустой regex → 400; hard→soft с живым pattern → 400) |
| Явный учёт в рассуждениях | `server/src/services/agent/llm-agent.ts` — `buildInvariantsMessage()`: system-блок позицией 2 после preset (≤800 символов, `[INV-n]` + текст), мета-строка иерархии, инструкция «при конфликте — откажись, назови [INV-n], процитируй» |
| Отказ предлагать нарушения + объяснение | отказ обязан называть `[INV-n]` и цитировать правило, предлагать безопасную альтернативу (проверено на камере) |
| Конфликт запроса и инварианта | `server/src/services/agent/task-state.ts` — `checkInvariants()`: hard-pattern матчит **вход**; отказ с `[INV-n]` → `level:"ok"`, конфликт без отказа → `level:"critical"` (fail-open, только evidence) |
| Ограничения состояния (место «стейт-машина») | consent-гвард в `transition()`: `goto→done` требует `consent: true`, иначе 409 `{consentRequired:true}`; day13-гварды (карта переходов, allowed[]) сработают раньше — smoke дня 13 цел |
| Evidence для UI | `context.invariants {checked[], inject, check}` в payload; панель «Инварианты (day14)» первой в доке |

## Быстрый старт

```bash
git clone https://github.com/kosvitko/trigger-helper-advent.git
cd trigger-helper-advent
git checkout week03-day14
cp .env.example .env   # DEEPSEEK_API_KEY=...
npm install
npm run dev            # http://127.0.0.1:3000 — Agent UI · title «Агент · day14»
```

## Demo через API

```bash
# инстанс + агент (пресет care)
curl -X POST http://127.0.0.1:3000/api/instances -H "Content-Type: application/json" -d '{"seedPresetIds":["care"]}'

# список инвариантов (первый GET сеет 6 правил владельца)
curl http://127.0.0.1:3000/api/instances/<iid>/agents/<aid>/invariants

# добавить своё правило (hard с regex по входу пользователя)
curl -X POST http://127.0.0.1:3000/api/instances/<iid>/agents/<aid>/invariants -H "Content-Type: application/json" \
  -d '{"text":"Без медикаментов — только самомассаж","scope":"agent","enforcement":"hard","pattern":"таблетк|лекарств"}'

# выключить правило (только владелец, не диалог)
curl -X PATCH http://127.0.0.1:3000/api/instances/<iid>/agents/<aid>/invariants/<invId> -H "Content-Type: application/json" -d '{"active":false}'

# конфликт-вопрос — в ответе отказ с [INV-n]; в payload: context.invariants {checked, inject, check}
curl -X POST http://127.0.0.1:3000/api/instances/<iid>/agents/<aid>/run -H "Content-Type: application/json" \
  -d '{"input":"Шея болит — какую таблетку принять?"}'

# инвариант согласия: goto→done без consent — 409 {consentRequired:true}, стейт не меняется
curl -X POST http://127.0.0.1:3000/api/instances/<iid>/agents/<aid>/task/transition -H "Content-Type: application/json" \
  -d '{"action":"goto","to":"done"}'
# с подтверждением — 200
curl -X POST http://127.0.0.1:3000/api/instances/<iid>/agents/<aid>/task/transition -H "Content-Type: application/json" \
  -d '{"action":"goto","to":"done","consent":true}'
```
