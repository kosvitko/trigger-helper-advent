/**
 * E2E-фикстуры (C+ CH-5b): локальные треды (ChatThreadRecord из
 * @trigger-helper/shared) для посева localStorage и payload-ответы
 * stateless-хода POST /api/chat (ChatResponse). Формы chat-ответов —
 * те же, что в src/test/fixtures.ts makeChatResponse (юнит-прогон через
 * safeParse контрактов). Модуль без зависимостей от playwright — только данные.
 */
import type { ChatDialogueMessage, ChatThreadRecord } from "@trigger-helper/shared";

/* — Локальные треды (состояние приложения теперь на устройстве) — */

export const THREAD_NECK = "th-neck";
export const THREAD_BACK = "th-back";
export const THREAD_CARE = "th-care";

export function turn(q: string, a: string): ChatDialogueMessage[] {
  return [
    { role: "user", content: q },
    { role: "assistant", content: a },
  ];
}

export interface ThreadSeed {
  id: string;
  title: string;
  preset?: "rag_chat" | "care";
  createdAt?: string;
  updatedAt?: string;
  summaries?: string[];
  dialogue?: ChatDialogueMessage[];
}

export function e2eThreadRecord(s: ThreadSeed): ChatThreadRecord {
  return {
    id: s.id,
    preset: s.preset ?? "rag_chat",
    title: s.title,
    createdAt: s.createdAt ?? "2026-10-01T09:00:00.000Z",
    updatedAt: s.updatedAt ?? s.createdAt ?? "2026-10-01T09:00:00.000Z",
    summaries: s.summaries ?? [],
    dialogue: s.dialogue ?? [],
  };
}

/** Тред «шея» — новее всех → активен по умолчанию на boot. */
export function e2eNeckThread(): ChatThreadRecord {
  return e2eThreadRecord({
    id: THREAD_NECK,
    title: "Демо · шея",
    createdAt: "2026-10-02T09:00:00.000Z",
    updatedAt: "2026-10-02T09:30:00.000Z",
    dialogue: turn(
      "a-q1: Болит шея справа после работы, что делать?",
      "a-ans1: Начните с верхней порции трапеции [travell-guide › Шея] и мягкого растяжения.",
    ),
  });
}

/** Тред «поясница» — старше: сосед в селекторе. */
export function e2eBackThread(): ChatThreadRecord {
  return e2eThreadRecord({
    id: THREAD_BACK,
    title: "Демо · поясница",
    createdAt: "2026-10-01T10:00:00.000Z",
    updatedAt: "2026-10-01T11:00:00.000Z",
    dialogue: turn(
      "b-q1: Болит поясница после приседов, как помочь?",
      "b-ans1: Проверьте квадратную мышцу поясницы [travell-guide › Поясница] и подвздошно-рёберное сочленение.",
    ),
  });
}

/** Care-тред (пресет care) — переключение между пресетами. */
export function e2eCareThread(): ChatThreadRecord {
  return e2eThreadRecord({
    id: THREAD_CARE,
    preset: "care",
    title: "Демо · забота",
    createdAt: "2026-09-30T08:00:00.000Z",
    updatedAt: "2026-09-30T09:00:00.000Z",
    dialogue: turn(
      "c-q1: Не могу расслабиться вечером, что делать?",
      "c-ans1: Дыхание 4-7-8 и разбор триггерных точек.",
    ),
  });
}

/* — Справочники (GET /api/models, /api/rag/stats, /api/agents) — */

/** День 26 (D-26-4): варианты local-секции /api/models. */
export type E2eLocalVariant = "available" | "down" | "disabled";

/** День 26: ответ валидируется СОВМЕСТНОЙ схемой (shared schemas/models.ts),
 * tier — значения из ASK_DEMO_MODEL_TIERS (enum weak/mid/strong): прежние
 * свободные строки «base»/«reasoner» парс бы не прошёл. Метки не тронуты —
 * существующие assert'ы настроек смотрят на них. */
export function e2eModels(local: E2eLocalVariant = "available") {
  const cloud = [
    { tier: "weak", label: "Chat", model: "deepseek-chat", via: "deepseek" },
    { tier: "strong", label: "Reasoner", model: "deepseek-reasoner", via: "deepseek" },
  ];
  // Прод-каталог D-26-4: 0.5b установлена и влезает в RAM; 1.5b влезает,
  // не установлена; 3b не влезает в RAM тестовой машины (7 ГБ порог).
  const entries = [
    { id: "qwen2.5:0.5b", label: "Qwen2.5 0.5B", sizeMb: 400, installed: true, fitsRam: true, available: true },
    { id: "qwen2.5:1.5b", label: "Qwen2.5 1.5B", sizeMb: 1000, installed: false, fitsRam: true, available: false },
    { id: "qwen2.5:3b", label: "Qwen2.5 3B", sizeMb: 1900, installed: false, fitsRam: false, available: false },
  ];
  // Рантайм лежит или kill-switch: сервер отдаёт каталог с installed=false
  // у всех записей (см. probeLocalLlm) — клиентская эвристика «рантайм ок».
  const down = entries.map((e) => ({ ...e, installed: false, available: false }));
  return {
    models: cloud,
    local:
      local === "available"
        ? { runtime: "ollama", enabled: true, entries }
        : local === "down"
          ? { runtime: "ollama", enabled: true, entries: down }
          : { runtime: "ollama", enabled: false, entries: down }, // kill-switch
  };
}

/** Мета-справочник пресетов: настройкам нужен дефолт автосжатия. */
export function e2eAgentsMeta() {
  return { autoCompress: { defaultEvery: 10 } };
}

/** РЕАЛЬНЫЙ прод-ответ GET /api/rag/stats (30.09.2026, h3llo) — дословно;
 *  экстра-поля dim/latencyMs/generatedAt — часть контракта «не ломать parse». */
export function e2eRagStats() {
  return {
    ok: true,
    indexes: [
      {
        strategy: "fixed",
        model: "Xenova/multilingual-e5-small",
        dim: 384,
        builtAt: "2026-09-30T08:41:44.756Z",
        chunks: 128,
        fileCount: 43,
      },
      {
        strategy: "structured",
        model: "Xenova/multilingual-e5-small",
        dim: 384,
        builtAt: "2026-09-30T08:41:44.756Z",
        chunks: 220,
        fileCount: 43,
      },
    ],
    compare: {
      generatedAt: "2026-09-30T08:42:10.123Z",
      byStrategy: {
        fixed: { hitAt1: 0.5, hitAt5: 0.9167, mrr: 0.6736 },
        structured: { hitAt1: 0.6667, hitAt5: 0.8333, mrr: 0.7619 },
      },
    },
    latencyMs: 1,
  };
}

/* — Память задачи (threadState-записи для посева) — */

export const TASK_GOAL = "Подобрать самопомощь при боли в шее";
export const TASK_GOAL_EDITED = "Новая цель: разминка шеи каждый час";

export function e2eThreadState(
  threadId: string,
  chatTask: { goal: string; clarified: string[]; constraints_terms: string[] },
) {
  return {
    id: threadId,
    memory: { facts: [], deleted: [] },
    chatTask,
    // C+ хвосты: полный формат записи (старые записи не поддерживаем —
    // поля обязательны, безопасный drop на safeParse).
    task: null,
    invariants: [],
  };
}

export function e2eNeckThreadState() {
  return e2eThreadState(THREAD_NECK, {
    goal: TASK_GOAL,
    clarified: ["боль отдаёт в голову к вечеру"],
    constraints_terms: ["без задержки дыхания"],
  });
}

/* — Ответы POST /api/chat: числа детерминированы для assert'ов трейса — */

const LLM_USAGE = {
  model: "deepseek-chat",
  prompt_tokens: 1100,
  completion_tokens: 360,
  total_tokens: 1460,
  prompt_cache_hit_tokens: 0,
  prompt_cache_miss_tokens: 1100,
  estimated_cost_usd: 0.0021,
  estimated_cost_rub: 0.2135,
};

export const RAG_REPLY =
  "Чтобы снять боль в шее справа, работайте с верхней порцией трапеции [travell-guide › Шея] и проверьте верх грудного отдела [travell-guide › Верх спины].";

export const DONTKNOW_REPLY =
  "По этому вопросу в базе нет релевантного материала — не буду выдумывать. Переформулируйте или опишите симптомы подробнее.";

export const MEMORY_DELTA_GOAL = "Разобрать боль в шее и закрепить разминку";
export const COMPRESS_SUMMARY =
  "Сводка: пользователь разбирает боль в шее справа; дана схема работы с трапецией и мягким растяжением.";

function ragOkPayload(question: string) {
  return {
    question,
    answer:
      "Работайте с верхней порцией трапеции и грудино-ключично-сосцевидной мышцей: давление 6–8 с, потом мягкое растяжение.",
    quotes: [
      {
        quote: "Верхняя порция трапеции отдаёт боль в висок и за ухо с той же стороны.",
        chunk_id: "c-101",
        source: "travell-guide",
        section: "Шея",
      },
      {
        quote: "Грудной отдел: точки у грудино-рёберных сочленений отдают вверх в шею.",
        chunk_id: "c-102",
        source: "travell-guide",
        section: "Верх спины",
      },
    ],
    sources: [
      {
        chunk_id: "c-101",
        score: 0.713,
        source: "travell-guide",
        file: "travell-guide.pdf",
        title: "Триггерные точки",
        section: "Шея",
      },
      {
        chunk_id: "c-102",
        score: 0.688,
        source: "travell-guide",
        file: "travell-guide.pdf",
        title: "Триггерные точки",
        section: "Верх спины",
      },
      {
        chunk_id: "c-103",
        score: 0.641,
        source: "travell-guide",
        file: "travell-guide.pdf",
        title: "Триггерные точки",
        section: "Плечи",
      },
    ],
    labels: ["[travell-guide › Шея]", "[travell-guide › Верх спины]", "[travell-guide › Плечи]"],
    dontKnow: false,
    topCosine: 0.713,
    threshold: 0.8375,
    rewrite: {
      variants: [
        "как помочь при боли в шее самомассажем",
        "триггерные точки мышц шеи техника давления",
      ],
      tokens: 120,
      latencyMs: 900,
      fallback: false,
    },
    poolRanked: 40,
    keptAfterFilter: 12,
    injectedCount: 12,
    quotesValid: 2,
    quotesSource: "model",
    usage: {
      model: "deepseek-chat",
      prompt_tokens: 980,
      completion_tokens: 240,
      total_tokens: 640,
      prompt_cache_hit_tokens: 0,
      prompt_cache_miss_tokens: 980,
      estimated_cost_usd: 0.0009,
      estimated_cost_rub: 0.0206,
    },
    latencyMs: 840,
  };
}

function ragDontKnowPayload(question: string) {
  return {
    question,
    answer: "",
    quotes: [],
    sources: [],
    labels: [],
    dontKnow: true,
    topCosine: 0.18,
    threshold: 0.8375,
    rewrite: {
      variants: ["пересказ оффтопного вопроса"],
      tokens: 60,
      latencyMs: 500,
      fallback: true,
    },
    poolRanked: 40,
    keptAfterFilter: 0,
    injectedCount: 0,
    quotesValid: null,
    quotesSource: null,
    usage: {
      model: "deepseek-chat",
      prompt_tokens: 900,
      completion_tokens: 0,
      total_tokens: 900,
      prompt_cache_hit_tokens: 0,
      prompt_cache_miss_tokens: 900,
      estimated_cost_usd: 0.0008,
      estimated_cost_rub: 0.0181,
    },
    latencyMs: 610,
  };
}

function ragToolCall(question: string, dontKnow: boolean) {
  const payload = dontKnow ? ragDontKnowPayload(question) : ragOkPayload(question);
  return {
    name: "rag_ask",
    arguments: { question },
    ok: !dontKnow,
    latencyMs: dontKnow ? 610 : 840,
    resultClip: `rag_ask · dontKnow=${dontKnow} · topCosine=${dontKnow ? "0.18" : "0.713"}`,
    payload,
  };
}

/** Варианты хода: сжатие префикса (Q-2), факт трима (SEC-F4), дельта памяти (Q-3),
 * кадры задачи/инвариантов в trace (C+ хвосты: fsm-шаги в трейсе). */
export interface ChatVariant {
  compress?: boolean;
  contextTrimmed?: boolean;
  memoryDelta?: boolean;
  fsmFrames?: boolean;
}

/**
 * Успешный rag-ход: 3 источника, 2/2 верифицированных цитат; заголовок хода
 * «deepseek-chat · 1460+640 = 2.1k ток · ₽0.23».
 */
export function e2eChatRag(input: string, o: ChatVariant = {}) {
  return {
    reply: RAG_REPLY,
    trace: {
      historyMessages: [{ role: "user", content: input }],
      tool: { calls: [ragToolCall(input, false)] },
      ...(o.fsmFrames
        ? {
            task: {
              id: "task-e2e",
              title: "убрать боль в шее",
              stage: "execution",
              step: 1,
              total: 3,
              paused: false,
              inject: "Стадия: Практика. Шаг: найти мышцу.",
              check: { ok: true, level: "ok", note: "Выполняется шаг 1/3" },
            },
            invariants: {
              checked: [
                {
                  n: 1,
                  id: "inv-e2e",
                  scope: "agent",
                  enforcement: "hard",
                  text: "не рекомендуй задержку дыхания",
                },
              ],
              inject: "Правила владельца: [INV-1] не рекомендуй задержку дыхания",
              check: { ok: true, level: "ok", note: "Инварианты учтены" },
            },
          }
        : {}),
      ...(o.contextTrimmed
        ? {
            contextTrimmed: {
              droppedDialogue: 2,
              droppedSummaries: 0,
              charsBefore: 70_000,
              charsAfter: 61_000,
            },
          }
        : {}),
    },
    usage: LLM_USAGE,
    ...(o.memoryDelta
      ? {
          memoryDelta: {
            facts: [
              {
                text: "боль в шее справа после работы",
                suggestedLayer: "working" as const,
              },
            ],
            chatTask: {
              goal: MEMORY_DELTA_GOAL,
              clarified: ["боль отдаёт в голову к вечеру"],
            },
          },
        }
      : {}),
    ...(o.compress ? { compress: { summary: COMPRESS_SUMMARY, keptTail: [] } } : {}),
    meta: { railViolated: false },
  };
}

/** dontKnow-ход: гейт «не знаю», без источников. */
export function e2eChatDontKnow(input: string) {
  return {
    reply: DONTKNOW_REPLY,
    trace: {
      historyMessages: [{ role: "user", content: input }],
      tool: { calls: [ragToolCall(input, true)] },
    },
    usage: LLM_USAGE,
    meta: { railViolated: false },
  };
}

/** День 26: локальный ход — одна ходка без RAG (D-26-2), usage с нулевой
 * стоимостью (D-26-5); минимальный trace — как в серверной локальной ветке. */
export const LOCAL_REPLY =
  "Сожмите плечи к ушам, удержите 5 секунд и медленно отпустите. Повторите 5 раз, дыша ровно.";

export function e2eChatLocal(input: string) {
  return {
    reply: LOCAL_REPLY,
    trace: { historyMessages: [{ role: "user", content: input }] },
    usage: {
      model: "qwen2.5:0.5b",
      prompt_tokens: 42,
      completion_tokens: 18,
      total_tokens: 60,
      prompt_cache_hit_tokens: 0,
      prompt_cache_miss_tokens: 42,
      estimated_cost_usd: 0,
      estimated_cost_rub: 0,
    },
    meta: { railViolated: false },
  };
}
