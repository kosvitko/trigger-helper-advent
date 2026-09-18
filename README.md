# AI Advent Challenge #9 — Week 03, Day 13

**Задание:** реализовать состояние задачи как конечный автомат: этап задачи, текущий шаг, ожидаемое действие. Пример состояний: `planning → execution → validation → done`. Проверить паузу на любом этапе и продолжение без повторных объяснений. Сдача: видео + код.

Trigger Helper (day13): состояние задачи — конечный автомат **на агенте** (`planning → execution → validation → done`, одна активная задача; `done` терминальная), и все три источника «долга» stateful-агента недели разведены по слоям: память (day11) — факты о пользователе, профиль (day12) — каким быть агенту, задача (day13) — что мы делаем сейчас. Ключевое правило лекции выполнено буквально: **переходы детерминированы кодом, а не текстом** — единственная точка мутации `transition()` с картой разрешённых переходов; запрещённый шаг даёт `409 {from, allowed[]}`, а не галлюцинацию. Пауза — операция, а не стадия (`paused` + `pausedFrom`, доступна на любом этапе кроме `done`); состояние задачи живёт в общем снапшоте, поэтому пауза переживает и F5, и рестарт сервера — «продолжение без повторных объяснений» получается из персиста, а не из вежливой памяти модели.

**Live demo:** http://91.188.212.10/ · **Tag:** [`week03-day13`](https://github.com/kosvitko/trigger-helper-advent/tree/week03-day13)

## Demo на видео (~55s)

Lab: `История = tail·10`, автосжатие выключено. Панель «Задача (day13)» — первая в правом доке: таймлайн четырёх стадий, шаг k/N, ожидаемое действие, план, кнопки разрешённых переходов:

| | |
|:--|:--|
| **Создание** | название + план (строка = шаг); таймлайн подсвечивает `planning`, шаг 1/3, ожидаемое действие = первый пункт плана |
| **planning** | вопрос агенту — ответ уточняет и планирует, не реализует; в payload виден inject-блок «## Текущая задача (стейт-машина)» и статус валидатора |
| **→ execution** | кнопка из карты переходов; ответ ведёт пользователя строго по текущему шагу |
| **✓ шаг → ⏸ пауза → F5** | шаг двигается (2/3, ожидаемое действие пересчитано из плана); после перезагрузки страницы панель восстанавливает этап/шаг/план из `agent-state.json` |
| **▶ resume → «Продолжай»** | агент продолжает разминку с того же шага, не переспрашивая выполненное; валидатор стадии — зелёный «✓ стадия соблюдена» |
| **→ validation → done** | приглашение оценить эффект; терминальная стадия — таймлайн зелёный, кнопки погашены |

## Выводы

Для получения ожидаемого результата в случае работы с LLM (и любыми нечеткими алгоритмами) необходимо ограничивать веер вероятностей. Оптимум — когда удается выявить все случаи жесткого ограничения так, чтобы не терять в гибкости.

Если процесс может быть формализован, лучше его формализовать и контролировать с помощью внешних контролеров: детерминированных алгоритмов, других моделей и т.п.

## Что где реализовано

| Требование | Где |
|:-----------|:----|
| Конечный автомат: этап/шаг/ожидаемое действие | `shared/src/schemas/agent.ts` — `TaskStage` (4 канонических), `TaskState {stage, step, plan[], expectedAction, paused, pausedFrom, lastStageNote}` |
| `planning → execution → validation → done` | `server/src/services/agent/task-state.ts` — `ALLOWED_TRANSITIONS` + `canTransition()` (точка подключения инвариантов day14); переходы — `goto/pause/resume/next_step` |
| Пауза на любом этапе | `pause/resume` как transition-действия; `pausedFrom` возвращает машину; 409-гварды (pause в done, resume без паузы, next_step вне execution) |
| Продолжение без повторных объяснений | `server/src/services/agent/llm-agent.ts` — `buildTaskStateMessage()`: последнее system-сообщение перед историей (≤800 символов: этап, шаг, ожидаемое действие, план, «Сделано», правило стадии); в `done` блока нет |
| Формализованное состояние видно | панель «Задача (day13)» (таймлайн, план ✓/→, кнопки из meta `taskTransitions`), `context.task` в payload + бейдж стадии в ленте |
| Отдельное хранение | секция `taskStates` в `var/agent-state.json` (per-key safeParse + warning, урок day11-tombstones не повторён) |
| Проверка паузы/резюма | пауза → перезагрузка страницы в кадре → панель восстановлена → «Продолжай» продолжает шаг |

## Быстрый старт

```bash
git clone https://github.com/kosvitko/trigger-helper-advent.git
cd trigger-helper-advent
git checkout week03-day13
cp .env.example .env   # DEEPSEEK_API_KEY=...
npm install
npm run dev            # http://127.0.0.1:3000 — Agent UI · title «Агент · day13»
```

## Demo через API

```bash
# инстанс + агент (пресет care)
curl -X POST http://127.0.0.1:3000/api/instances -H "Content-Type: application/json" -d '{"seedPresetIds":["care"]}'

# создать задачу (409, если у агента уже есть активная)
curl -X POST http://127.0.0.1:3000/api/instances/<iid>/agents/<aid>/task -H "Content-Type: application/json" \
  -d '{"title":"Проработка шеи","plan":["Найти причину дискомфорта","Техника: разминка трапеции 5 минут","Оценить эффект"]}'

# разрешённые переходы (карта приходит в GET /api/agents → taskTransitions)
curl -X POST http://127.0.0.1:3000/api/instances/<iid>/agents/<aid>/task/transition -H "Content-Type: application/json" \
  -d '{"action":"goto","to":"execution"}'
curl -X POST http://127.0.0.1:3000/api/instances/<iid>/agents/<aid>/task/transition -H "Content-Type: application/json" \
  -d '{"action":"next_step"}'

# пауза / продолжение — состояние переживает рестарт сервера
curl -X POST http://127.0.0.1:3000/api/instances/<iid>/agents/<aid>/task/transition -H "Content-Type: application/json" -d '{"action":"pause"}'
curl -X POST http://127.0.0.1:3000/api/instances/<iid>/agents/<aid>/task/transition -H "Content-Type: application/json" -d '{"action":"resume"}'

# ход агента — inject задачи и статус валидатора в ответе: context.task.{inject,check}
curl -X POST http://127.0.0.1:3000/api/instances/<iid>/agents/<aid>/run -H "Content-Type: application/json" \
  -d '{"input":"Продолжай"}'

# запрещённый переход — 409 с картой разрешённых
curl -X POST http://127.0.0.1:3000/api/instances/<iid>/agents/<aid>/task/transition -H "Content-Type: application/json" \
  -d '{"action":"goto","to":"done"}'
```
