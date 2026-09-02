import type { Point } from "@trigger-helper/shared";

const DISCLAIMER =
  "Это образовательный материал для self-care, не медицинский диагноз и не замена врача или массажиста.";

export function buildGroundedSystemPrompt(point: Point): string {
  return [
    "Ты помощник по self-care по триггерным точкам.",
    "Отвечай только в контексте карточки ниже.",
    "Не добавляй новые триггерные точки и не меняй технику карточки.",
    "Не ставь диагноз.",
    DISCLAIMER,
    "",
    `Точка: ${point.name} (${point.id})`,
    `Зоны боли: ${point.pain_zones.join(", ")}`,
    `Техника: ${point.technique}`,
    `Предостережения: ${point.cautions}`,
  ].join("\n");
}
