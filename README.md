# AI Advent Challenge #9 — Week 07, Day 31

**Trigger Helper** — продуктовый SPA самопомощи по триггерным точкам (Svelte 5 + Fastify). День 31 — **кодинг-ассистент по репозиторию Trigger Helper**: RAG по README / STACK / схемам API, read-only repo-тулзы (git branch, list, read), команда `/help`. Демо снимается **локально** (нужно git-дерево); на проде ассистент выключен (`DEV_HELP_ENABLED=0`).

## Demo на видео

1. **«+ Ассистент»** → `/help` — возможности, корпус, тулзы.
2. **Вопрос про RAG и контракт `POST /api/chat`** — чип «Источники» (`project_search`) и `repo_*` в трейсе.
3. **Структура корня + git-ветка** → `repo_list_files` / `repo_git_branch`.
4. **Чтение `docs/STACK.md`** → `repo_read_file`.
5. **Отказ `.env`** — путь вне allowlist (секреты не читаются).
6. **RAG-чат (medical)** — только `rag_ask`, без project/repo тулзов.

## Выводы

RAG по коду помогает агенту легко ориентироваться в базе, не пропуская упоминания единиц кода в различных частях системы. Кроме того, разбор результата поиска (обычно) сильно дешевле разбора результата грепов. Единственное, для навигации именно по кодовой базе, вероятно, нужен немного адаптированный к структуре кода вариант разбиения на чанки.

## Что где реализовано

| Пункт задания | Где |
|:---|:---|
| RAG: README + docs (+ схемы) | корпус `project` → `data/project-rag/`; `npm run rag:index:project`; тулза `project_search` |
| MCP / доступ к проекту | in-process `repo_git_branch` / `repo_list_files` / `repo_read_file` (jail + deny `.env`) |
| `/help` | пресет `dev_help`; UI «+ Ассистент»; `/help` и `/help <вопрос>` в композере |
| Изоляция medical | `rag_chat`/`care` без project/repo; `DEV_HELP_ENABLED` fail-closed |

## Быстрый старт

```bash
npm install
npm run build

# индекс кодинг-ассистента (один раз / после смены корпуса)
npm run rag:index:project -w server

# DEV_HELP_ENABLED не задан = включён; на VPS ставьте 0
cd server && npm run dev   # API :3000 (+ SPA из dist)
```

В UI: **«+ Ассистент»** → `/help` или вопрос про структуру/`POST /api/chat`.
