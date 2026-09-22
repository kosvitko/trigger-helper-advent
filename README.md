# AI Advent Challenge #9 — Week 04, Day 16

**Задание:** установить MCP SDK / клиент (или поднять MCP-сервер, если используется локальный вариант). Минимальный код, который устанавливает MCP-соединение и получает от MCP список доступных инструментов. Проверить: соединение устанавливается, список корректно возвращается. Результат: код, который подключается к MCP и выводит список доступных инструментов. Сдача: видео + код. P.S. организатора: здесь пока с MCP работать не нужно — просто запросить `get_tools` у любого общедоступного MCP.

Trigger Helper (day16): MCP-клиент на официальном **`@modelcontextprotocol/sdk`** (TypeScript) по транспорту **Streamable HTTP** к публичному серверу **DeepWiki MCP** (`https://mcp.deepwiki.com/mcp` — без ключей и регистрации). Контракт клиента построен с прицелом на остальные дни недели: `withMcpConnection()` / `listMcpTools()` — раздельные шаги (initialize → notifications/initialized → tools/list), соединение живёт на один вызов (per-call lifecycle, никаких фоновых сессий), а в DTO инструмента сохраняется сырой `inputSchema` — он понадобится для `call_tool` и оркестрации в дни 17–20. Соединение с MCP не встроено в чат: инструменты — это **данные** (`GET /api/mcp/tools` + блок «MCP» в UI), а не промпт — по лекции схема тулов едет в каждый sampling call и является главным расходом токенов, поэтому решение «что попадает в контекст агента» остаётся оркестрации следующих дней. В мету ответа кладётся оценка размера схемы в токенах (`meta.tokensEstimate`) — заготовка для сравнения MCP vs skills. Роут отвечает в общем формате сервера: апстрим-сбой или таймаут (10s) → `502 {error, message}`, конфиг — один env `MCP_SERVER_URL` (дефолт — DeepWiki), секретов не нужно.

**Live demo:** http://91.188.212.10/ · **Tag:** [`week04-day16`](https://github.com/kosvitko/trigger-helper-advent/tree/week04-day16)

## Demo на видео (~22s)

Блок «MCP» — в правом доке, свёрнут; соединение устанавливается на каждый boot страницы:

| | |
|:--|:--|
| **Блок MCP раскрыт** | `MCP · DeepWiki · 3 инструмента` — URL сервера, транспорт `streamable-http`, список имён (`ask_wiki_question`, `read_wiki_contents`, `read_wiki_structure`), «схема тулов ≈ 266 ток.» |
| **F5** | страница перезагружена — соединение установлено заново, тот же список (per-call lifecycle) |
| **Сырой код** | `GET /api/mcp/tools` — полный JSON: `server`, `transport`, `serverInfo` (DeepWiki 2.14.3), `toolCount: 3`, tools[], `meta.tokensEstimate` |

## Выводы

подключили публичные mcp-серверы. первый же дает ответ. Вопрос - как доверять содержимому - открытый. С другой стороны - различные плагины тоже не проверишь, и, вроде бы количество пользователей mcp должно некоторым образом повышать гарантию безопасности, хотя это спорно.

## Что где реализовано

| Требование | Где |
|:-----------|:----|
| MCP SDK установлен | `@modelcontextprotocol/sdk` в `server/package.json` — `Client` + `StreamableHTTPClientTransport` |
| Установка MCP-соединения | `server/src/services/mcp-client.ts` — `withMcpConnection()`: initialize → notifications/initialized → готов; connect/close per-call, таймаут 10s |
| Список доступных инструментов | `listMcpTools()` → `tools/list`; DTO `{name, description, inputSchema}` (raw schema сохранён для дней 17–20) |
| Вывод списка (код) | `server/src/routes/mcp.ts` — `GET /api/mcp/tools` → `{server, transport, serverInfo, toolCount, tools[{name, description}], meta.tokensEstimate}`; сбой апстрима → 502 `{error, message}` |
| Конфиг без секретов | `MCP_SERVER_URL` в `server/src/config/env.ts` (default `https://mcp.deepwiki.com/mcp`); публичный read-only список — ключи не нужны |
| Вывод списка (UI) | `server/public/index.html` — details-блок «MCP» в доке: имя сервера, число инструментов, transport, имена; появляется только после ответа (пустой блок не показываем) |
| Задел на дни 17–20 | соединение/транспорт за модулем; `inputSchema` сохранён; `meta.tokensEstimate` — базовая линия для сравнения MCP vs skills; инжект инструментов в промпт агента — осознанно вне дня 16 |

## Быстрый старт

```bash
git clone https://github.com/kosvitko/trigger-helper-advent.git
cd trigger-helper-advent
git checkout week04-day16
cp .env.example .env   # DEEPSEEK_API_KEY=... (для boot сервера; MCP-ключей нет)
npm install
npm run dev            # http://127.0.0.1:3000 — Agent UI · title «Агент · day16»
```

## Demo через API

```bash
# соединение с публичным MCP + список инструментов (read-only)
curl http://127.0.0.1:3000/api/mcp/tools
# → {"server":"https://mcp.deepwiki.com/mcp","transport":"streamable-http",
#    "serverInfo":{"name":"DeepWiki","version":"2.14.3"},"toolCount":3,
#    "tools":[{"name":"ask_wiki_question",...},{"name":"read_wiki_contents",...},
#             {"name":"read_wiki_structure",...}],"meta":{"tokensEstimate":266}}

# другой публичный MCP — тем же кодом (Streamable HTTP, без ключей)
MCP_SERVER_URL=https://mcp.context7.com/mcp
```
