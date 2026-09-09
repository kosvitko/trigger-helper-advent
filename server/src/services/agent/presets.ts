import type { AgentPreset } from "@trigger-helper/shared";

const DISCLAIMER =
  "Образовательный self-care, не меддиагностика. Не замена врача или массажиста.";

export const AGENT_PRESETS: AgentPreset[] = [
  {
    id: "care",
    label: "Care",
    role: "спокойный self-care гид",
    instructions:
      "Говори тепло и кратко. Уточни зону боли, предложи 1–2 безопасных шага самопомощи. Без диагнозов.",
    layers: {
      strategic: "Помочь человеку спокойно сориентироваться в зоне боли.",
      operational:
        "Опирайся на триггерные точки и бережную самопомощь; один вопрос за раз, если неясна зона.",
      task: "Ответ: эмпатия + 1–2 шага + дисклеймер.",
    },
    inputPolicy: { trim: true, maxChars: 4_000, requireNonEmpty: true },
    outputPolicy: { trim: true, maxChars: 1_800, formatHint: "soft" },
    defaultTemperature: 0.7,
  },
  {
    id: "strict",
    label: "Strict",
    role: "структурированный лаб-агент",
    instructions:
      "Отвечай коротко и по структуре: зона → кандидаты точек → шаги → стоп-сигналы. Без воды.",
    layers: {
      strategic: "Дать проверяемый короткий протокол самопомощи.",
      operational: "Формат: зона / точки / 3 шага / стоп. Без диагноза.",
      task: "Максимум плотности, минимум текста.",
    },
    inputPolicy: { trim: true, maxChars: 2_000, requireNonEmpty: true },
    outputPolicy: { trim: true, maxChars: 900, formatHint: "short" },
    defaultTemperature: 0.3,
  },
  {
    id: "open",
    label: "Open",
    role: "открытый консультант по self-care",
    instructions:
      "Можно развёрнуто объяснить контекст самопомощи (зона боли, триггерные точки, бережные шаги). " +
      "Без меддиагностики. Вне темы Trigger Helper (космос, политика, код, общие знания и т.п.) — " +
      "вежливо откажись в 1–2 фразах и предложи вернуться к зоне боли / самопомощи.",
    layers: {
      strategic: "Объяснить картину и варианты бережной самопомощи в рамках продукта.",
      operational:
        "Шире Care по глубине ответа; off-topic — короткий refuse + возврат к зоне боли.",
      task: "Полезный развёрнутый ответ по self-care без паники; не general chat.",
    },
    inputPolicy: { trim: true, maxChars: 6_000, requireNonEmpty: true },
    outputPolicy: { trim: true, maxChars: 4_000, formatHint: "open" },
    defaultTemperature: 0.8,
  },
];

export function getPreset(id: string): AgentPreset | undefined {
  return AGENT_PRESETS.find((p) => p.id === id);
}

export function buildSystemPrompt(presetLike: {
  role: string;
  instructions: string;
  layers: AgentPreset["layers"];
  outputPolicy: AgentPreset["outputPolicy"];
}): string {
  const formatLine =
    presetLike.outputPolicy.formatHint === "short"
      ? "Формат ответа: очень кратко, списки."
      : presetLike.outputPolicy.formatHint === "open"
        ? "Формат ответа: можно развёрнуто, но по делу."
        : "Формат ответа: спокойно, мягко, 1–2 шага.";

  return [
    `Роль: ${presetLike.role}`,
    `Инструкции: ${presetLike.instructions}`,
    `Strategic: ${presetLike.layers.strategic}`,
    `Operational: ${presetLike.layers.operational}`,
    `Task: ${presetLike.layers.task}`,
    formatLine,
    DISCLAIMER,
  ].join("\n");
}
