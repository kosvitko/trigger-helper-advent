import type { Point } from "@trigger-helper/shared";

const DISCLAIMER =
  "Это образовательный материал для self-care, не медицинский диагноз и не замена врача или массажиста.";

function pointCardBlock(point: Point): string {
  return [
    `Точка: ${point.name} (${point.id})`,
    `Зоны боли: ${point.pain_zones.join(", ")}`,
    `Техника: ${point.technique}`,
    `Предостережения: ${point.cautions}`,
  ].join("\n");
}

export function buildGroundedSystemPrompt(point: Point): string {
  return [
    "Ты помощник по self-care по триггерным точкам.",
    "Отвечай только в контексте карточки ниже.",
    "Не добавляй новые триггерные точки и не меняй технику карточки.",
    "Не ставь диагноз.",
    DISCLAIMER,
    "",
    pointCardBlock(point),
  ].join("\n");
}

/** Example object for DeepSeek JSON mode (must mention the word json). */
const JSON_EXAMPLE = `{
  "summary": "Краткий ответ по карточке точки",
  "steps": ["Шаг 1", "Шаг 2"],
  "duration_sec": 30,
  "cautions": ["Не давить через острую боль"],
  "grounded": true
}`;

/**
 * System prompt for format=json: always emit one complete JSON object
 * (schema + example below), for any user question.
 */
export function buildJsonSystemPrompt(point: Point): string {
  return [
    "Ты помощник по self-care по триггерным точкам.",
    "Отвечай только в контексте карточки ниже.",
    "Не добавляй новые триггерные точки и не меняй технику карточки.",
    "Не ставь диагноз.",
    DISCLAIMER,
    "",
    pointCardBlock(point),
    "",
    "OUTPUT FORMAT: reply with a single valid json object and nothing else.",
    "No markdown, no code fences, no text before or after the object.",
    "The response must end on the final closing brace }.",
    "Always fill every field, for any user question (including off-topic).",
    "Schema fields:",
    '- summary: string — direct answer (if off-topic: politely say you only help with this point)',
    "- steps: string[] — actionable steps from the card; use [] if none apply",
    "- duration_sec: number or null — suggested seconds; null if not applicable",
    "- cautions: string[] — safety notes from the card (always include at least the disclaimer if empty otherwise)",
    "- grounded: boolean — true only if the answer stays within the point card",
    "",
    "EXAMPLE JSON OUTPUT:",
    JSON_EXAMPLE,
  ].join("\n");
}
