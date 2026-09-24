# AI Advent Challenge #9 — Week 04, Day 17

**Задание:** реализовать свой MCP-сервер вокруг любого API (например: Яндекс.Трекер, Git, CRM, mock API). Сделать: регистрацию инструмента; описание входных параметров; возврат результата. Подключить инструмент к своему агенту и: вызвать его из приложения; получить и использовать результат. Результат: агент делает вызов к MCP-инструменту и получает результат. Сдача: видео + код.

Trigger Helper (day17): собственный **MCP-сервер** вокруг данных продукта — атласа триггерных точек (11 точек, 3 зоны боли). Серверная сторона — тот же официальный **`@modelcontextprotocol/sdk`** (день 16 ставил SDK ради клиента, а в нём уже был сервер): `McpServer` + `StreamableHTTPServerTransport`, endpoint `POST /mcp` в том же процессе Fastify, stateless (свежая пара server+transport на каждый запрос, JSON-ответы, без SSE-ноги и сессий). Два инструмента: **`list_points(zone?)`** и **`get_point(id)`** — read-only обёртки `PointsService`, без LLM внутри; входные параметры описаны Zod-схемой (для `registerTool`) и зеркальной JSON Schema для LLM — рядом, в одном модуле. Агент вызывает инструменты через **`callTool`** day16-клиентом по loopback — и **использует результат**: в `LlmAgent.run()` один раунд tool-calling (модель вернула `tool_calls` → исполняем все через MCP → результаты назад сообщениями `role:"tool"` → второй вызов без tools даёт финальный текст). Схемы тулов по умолчанию **не** едут в каждый запрос: флаг `overrides.tools`, default `false` (UI-композер включает явно) — размер схем виден в preflight-оценке и в payload (`context.tool.calls`: имя, аргументы, ok, латентность, клип результата). Видимость в UI: бейдж `tool: list_points` в ленте ответов + след последнего вызова в блоке «MCP». Для проверки руками — `POST /api/mcp/call {name, arguments}`. Безопасность: тулзы только читают JSON-атлас, ключей не нужно; `/mcp` и `/api/mcp/call` под rate-limit, при этом собственные loopback-вызовы сервера исключены из бакета (иначе агент 429-ил бы сам себя посреди демо).

**Live demo:** http://91.188.212.10/ · **Tag:** [`week04-day17`](https://github.com/kosvitko/trigger-helper-advent/tree/week04-day17)

## Demo на видео (~36s)

| | |
|:--|:--|
| **Блок «MCP» раскрыт** | DeepWiki (day16) + **наш сервер** `http://127.0.0.1:3000/mcp · trigger-helper-atlas` — тулзы `list_points`, `get_point` (схемы — в tooltip) |
| **Вопрос агенту** | «Болит основание черепа и отдаёт в голову — какую триггерную точку поработать и как именно?» |
| **Ответ + след вызова** | бейдж `tool: list_points` в мете ответа; текст называет подзатылочные/ременную с техниками и предостережениями из атласа |
| **Клип вызова** | в блоке «MCP»: «последний вызов: list_points · ok · 27 ms» + клип JSON-результата |
| **Сырой код** | `POST /api/mcp/call {name:"list_points",arguments:{zone:"arm"}}` — полный результат: 3 точки, `isError:false`, латентность |

## Выводы

по вызову mcp особых выводов нет. только надо запомнить - схема передается в каждом последующем вызове. а нейронка может решить вызвать тул в любой момент. так что описание mcp в полной схеме - единственный вариант.

## Что где реализовано

| Требование | Где |
|:-----------|:----|
| Свой MCP-сервер | `server/src/services/mcp-server.ts` — `McpServer` + `StreamableHTTPServerTransport` (stateless, `enableJsonResponse`, POST-only; GET → 404) на `POST /mcp` |
| Регистрация инструмента | `registerTool("list_points"/"get_point")` — read-only обёртки `PointsService.loadAll/findById`, LLM внутри тулз нет |
| Описание входных параметров | Zod raw shapes для SDK + `OWN_MCP_TOOL_SCHEMAS` (JSON Schema для function calling) — рядом, один модуль |
| Возврат результата | один text-блок с JSON (`{count, points}` / `{point}` / `{error}`); неизвестный id → `isError:true` |
| Подключение к агенту | `server/src/services/mcp-client.ts` — `callMcpTool(serverUrl, name, args, timeout?)` на шве `withMcpConnection` (day16), loopback `http://127.0.0.1:PORT/mcp` |
| Вызов из приложения + использование результата | `server/src/services/agent/llm-agent.ts` — 1-раундовый цикл: `tool_calls` → MCP → `role:"tool"` → финальный ответ; `overrides.tools` (default false, UI-композер шлёт `true`); usage двух вызовов мержится |
| Видимость в UI | `server/public/index.html` — бейдж `tool:` в ленте (`context.tool` в payload), own-секция + «последний вызов» в блоке «MCP» |
| Проверка руками | `POST /api/mcp/call {name, arguments}` → `{name, content, isError, latencyMs}`; own-секция в `GET /api/mcp/tools` |
| Конфиг без секретов | ноль новых env — URL своего сервера собирается из `PORT`; тулзы читают только `data/points.json` |

## Быстрый старт

```bash
git clone https://github.com/kosvitko/trigger-helper-advent.git
cd trigger-helper-advent
git checkout week04-day17
cp .env.example .env   # DEEPSEEK_API_KEY=... (для ответов агента; MCP-ключей нет)
npm install
npm run dev            # http://127.0.0.1:3000 — Agent UI · title «Агент · day17»
```

## Demo через API

```bash
# сырой вызов тулзы своего MCP-сервера
curl -X POST http://127.0.0.1:3000/api/mcp/call \
  -H "content-type: application/json" \
  -d '{"name":"list_points","arguments":{"zone":"arm"}}'
# → {"name":"list_points","content":"{\"count\":3,\"points\":[...]}","isError":false,"latencyMs":26}

# tools/list своего сервера (own-секция) рядом с публичным DeepWiki
curl http://127.0.0.1:3000/api/mcp/tools | jq .own

# агент с инструментом: tool-calls → MCP → ответ, использующий результат
curl -X POST http://127.0.0.1:3000/api/agent/run -H "content-type: application/json" \
  -d '{"instanceId":"...","agentId":"...","input":"Болит основание черепа — что делать?","overrides":{"tools":true}}'
# → reply использует technique/cautions из атласа; context.tool.calls — след вызова
```
