/**
 * UNIT-фикстуры: валидные образцы живых контрактов @trigger-helper/shared
 * (C+ «только новое»: stateless-ход + локальные сущности) и форма
 * rag_ask-payload сервера (server/src/services/agent/rag-tool.ts,
 * RagToolPayload) — реалистичность проверяется fixtures.test.ts через
 * safeParse схем.
 */
import type {
  AgentInstance,
  AgentMessage,
  ChatMemoryDelta,
  ChatResponse,
  ChatTaskState,
  ContextTrimInfo,
  LlmUsage,
} from "@trigger-helper/shared";

let seq = 0;
export const uid = (prefix: string): string => `${prefix}-${(seq += 1)}`;

export function makeUsage(p: Partial<LlmUsage> = {}): LlmUsage {
  return {
    model: "deepseek-chat",
    prompt_tokens: 1100,
    completion_tokens: 360,
    total_tokens: 1460,
    prompt_cache_hit_tokens: 0,
    prompt_cache_miss_tokens: 1100,
    estimated_cost_usd: 0.0021,
    estimated_cost_rub: 0.2135,
    ...p,
  };
}

export function makeAgent(p: Partial<AgentInstance> = {}): AgentInstance {
  return {
    id: uid("agent"),
    presetId: "rag_chat",
    label: "RAG-чат",
    role: "Помощник по самопомощи",
    instructions: "Отвечай по базе знаний, приводи источники [source › section].",
    layers: {
      strategic: "Помогай найти триггерные точки и подобрать самопомощь.",
      operational: "Опирайся только на базу знаний; нет данных — скажи прямо.",
      task: "Текущая задача: разбор боли пользователя.",
    },
    inputPolicy: { trim: true, maxChars: 4000, requireNonEmpty: true },
    outputPolicy: { trim: true, maxChars: 4000, formatHint: "soft" },
    defaultModel: "deepseek-chat",
    defaultTemperature: 0.3,
    ...p,
  };
}

export function makeMessage(p: Partial<AgentMessage> = {}): AgentMessage {
  return {
    id: uid("msg"),
    role: "user",
    content: "вопрос-фикстура",
    createdAt: "2026-10-03T09:00:00.000Z",
    ...p,
  };
}

export function makeChatTask(p: Partial<ChatTaskState> = {}): ChatTaskState {
  return {
    goal: "Подобрать самопомощь при боли в шее",
    clarified: ["боль отдаёт в голову к вечеру"],
    constraints_terms: ["без задержки дыхания"],
    ...p,
  };
}

/** rag_ask-payload тулзы — форма server RagToolPayload (в shared её нет: unknown). */
export interface RagPayloadFixture {
  question: string;
  answer: string;
  quotes: { quote: string; chunk_id: string; source: string; section: string }[];
  sources: {
    chunk_id: string;
    score: number;
    source: string;
    file: string;
    title: string;
    section: string;
  }[];
  labels: string[];
  dontKnow: boolean;
  topCosine: number | null;
  threshold?: number | null;
  rewrite?: { variants: string[]; tokens: number; latencyMs: number; fallback: boolean } | null;
  poolRanked?: number | null;
  keptAfterFilter?: number | null;
  injectedCount?: number | null;
  quotesValid?: number | null;
  quotesSource?: "model" | "server_fallback" | null;
  usage?: unknown;
  latencyMs?: number;
  error?: string;
}

/** Раг-успех: 3 источника, 2 верифицированные цитаты. */
export function ragOkPayload(question: string): RagPayloadFixture {
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
    usage: makeUsage({
      prompt_tokens: 980,
      completion_tokens: 240,
      total_tokens: 640,
      estimated_cost_usd: 0.0009,
      estimated_cost_rub: 0.0206,
    }),
    latencyMs: 840,
  };
}

/** Раг-гейт: ничего релевантного, dontKnow=true, источников нет. */
export function ragDontKnowPayload(question: string): RagPayloadFixture {
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
    usage: makeUsage({
      prompt_tokens: 900,
      completion_tokens: 0,
      total_tokens: 900,
      estimated_cost_usd: 0.0008,
      estimated_cost_rub: 0.0181,
    }),
    latencyMs: 610,
  };
}

/** Ответ stateless-хода POST /api/chat (C+ CH-5b). rag=null — ход без тузы. */
export function makeChatResponse(
  p: {
    reply?: string;
    rag?: RagPayloadFixture | null;
    railViolated?: boolean;
    compress?: { summary: string; keptTail: { role: "user" | "assistant"; content: string }[] } | null;
    contextTrimmed?: ContextTrimInfo | null;
    memoryDelta?: ChatMemoryDelta | null;
  } = {},
): ChatResponse {
  const rag = p.rag === undefined ? ragOkPayload("как помочь при боли в шее?") : p.rag;
  const reply =
    p.reply ??
    (rag && !rag.dontKnow
      ? "Чтобы снять боль в шее, работайте с верхней порцией трапеции [travell-guide › Шея]."
      : "В базе нет релевантного материала по этому вопросу — не буду выдумывать.");
  const usage = makeUsage();
  return {
    reply,
    trace: {
      historyMessages: [{ role: "user", content: "вопрос" }],
      ...(rag
        ? {
            tool: {
              calls: [
                {
                  name: "rag_ask",
                  arguments: { question: rag.question },
                  ok: !rag.dontKnow,
                  latencyMs: rag.latencyMs ?? 800,
                  resultClip: `rag_ask · dontKnow=${rag.dontKnow} · topCosine=${rag.topCosine}`,
                  payload: rag,
                },
              ],
            },
          }
        : {}),
      ...(p.contextTrimmed ? { contextTrimmed: p.contextTrimmed } : {}),
    },
    usage,
    ...(p.memoryDelta === null
      ? {}
      : { memoryDelta: p.memoryDelta ?? { facts: [], chatTask: {} } }),
    ...(p.compress ? { compress: p.compress } : {}),
    ...(p.railViolated !== undefined ? { meta: { railViolated: p.railViolated } } : {}),
  };
}
