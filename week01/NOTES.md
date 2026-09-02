# Advent week01 — Day 01

**Tag:** `week01-day01`  
**Stack:** Fastify + DeepSeek, grounded ask по `pointId` из `data/points.json`

## Deploy (h3llo)

- **URL:** `http://91.188.212.10`
- **Health:** `GET /api/health`
- **Ask:** `POST /api/ask`

## Env (на VPS, `/home/user/trigger-helper/.env`)

```env
DEEPSEEK_API_KEY=sk-...
DEEPSEEK_MODEL=deepseek-chat
PORT=3000
NODE_ENV=production
```

## Запуск / рестарт (VPS)

```bash
sudo systemctl restart trigger-helper
sudo systemctl status trigger-helper
journalctl -u trigger-helper -f
```

## Demo (браузер — для скринкаста)

**URL:** http://91.188.212.10/

Чат-UI day01: зона → сообщение → «Отправить» → ответ в ленте (тот же `POST /api/ask`).

1. «Где болит?» — зона (голова / плечо / рука)
2. Ввести вопрос → «Отправить»
3. Ответ DeepSeek появится в чате

## Demo (PowerShell — альтернатива)

```powershell
Invoke-RestMethod -Uri "http://91.188.212.10/api/health"

Invoke-RestMethod -Uri "http://91.188.212.10/api/ask" `
  -Method Post `
  -ContentType "application/json" `
  -Body '{"pointId":"trapezius_upper","question":"Как понять, что давлю не слишком сильно?"}'
```

## Зоны day01 (UI → pointId)

| zone (UI) | pointId (API) |
|:----------|:--------------|
| `head` | `suboccipital` |
| `shoulder` | `trapezius_upper` |
| `arm` | `forearm_flexors` |

## Локальная разработка

```powershell
# из корня trigger-helper
Copy-Item .env.example .env   # заполнить DEEPSEEK_API_KEY
npm install
npm run dev
Invoke-RestMethod -Uri "http://127.0.0.1:3000/api/health"
```

## Скринкаст

### Авто (Playwright, браузер на VPS)

Один раз — Chromium для Playwright:

```powershell
npm install
npm run record:demo:install
```

Запись (по умолчанию VPS, чат-UI):

```powershell
.\scripts\record-advent-demo.ps1
# другая зона / mp4 для таблицы:
.\scripts\record-advent-demo.ps1 -Zone head -Mp4
```

Файл: `advent/week01/recordings/week01-day01.webm` (или `.mp4`). Залить на Я.Диск → ссылка в таблицу.

Локально (server должен быть запущен):

```powershell
.\scripts\record-advent-demo.ps1 -BaseUrl http://127.0.0.1:3000
```

### Вручную

1. Браузер: http://91.188.212.10/ → зона → сообщение → ответ в чате
2. Ключ в `.env` на server, не в коде
3. A1: зона мапится на pointId из JSON, LLM только объясняет карточку
