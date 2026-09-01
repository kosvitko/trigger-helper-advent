# Trigger Helper — AI Advent Challenge #9

Учебный код сдачи заданий потока [AI Advent Challenge #9](https://docs.google.com/spreadsheets/d/1eFmeejRLXnT5fic3uxagtNgQBvv6uAKUG5McRlEo-eE/edit?usp=sharing).

Продукт **Trigger Helper** (MVP) — [trigger-helper](https://github.com/kosvitko/trigger-helper) (private).

## Структура

```
week01/ … week07/    — ответы на задания по неделям
requirements.txt     — зависимости Python-скриптов
.env.example         — имена переменных без значений
```

## Запуск (пример week01)

```powershell
$env:DEEPSEEK_API_KEY = "sk-..."
pip install -r requirements.txt
python week01/day01_llm_request.py
```

## Как обновляется

Код пишется в `C:\projects\trigger-helper\advent\`, перед сдачей копируется сюда (outbox).  
Правила: [docs/advent/GITHUB.md](https://github.com/kosvitko/trigger-helper/blob/main/docs/advent/GITHUB.md) (после первого push product-репы).
