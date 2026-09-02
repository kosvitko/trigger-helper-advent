"""AI Advent Challenge #9 — День 1: первый запрос к LLM через API.

Запуск (PowerShell):
  $env:DEEPSEEK_API_KEY = "sk-..."
  python day01_llm_request.py

Нужен: pip install openai
"""
import os
from openai import OpenAI

client = OpenAI(
    api_key=os.environ["DEEPSEEK_API_KEY"],
    base_url="https://api.deepseek.com",
)

response = client.chat.completions.create(
    model="deepseek-v4-flash",
    messages=[
        {"role": "user", "content": "Скажи одним предложением, что такое LLM."},
    ],
)

print(response.choices[0].message.content)
