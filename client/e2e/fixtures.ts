/**
 * E2E-фикстуры: payload-ответы для route-перехвата всех /api/* (ноль реальной
 * сети и LLM). Формы — те же контракты @trigger-helper/shared, что клиент
 * парсит в api.ts; реалистичность проверяется юнит-тестом
 * src/test/fixtures.test.ts (прогон через api-клиент = safeParse схем).
 * Модуль без зависимостей от playwright — только данные.
 */
import type { AgentMessage } from "@trigger-helper/shared";

export const INST_A_ID = "inst-a";
export const INST_B_ID = "inst-b";
/** Первый rag_chat-агент инстанса A (НЕ активный — активен последний). */
export const AGENT_A1 = "agent-a1";
/** Последний rag_chat-агент новейшего инстанса → демо-дефолт boot. */
export const AGENT_A2 = "agent-a2";
export const AGENT_B = "agent-b-rag";
/** care-агент сессии настроек (неактивный сосед RAG-чата, кнопка «открыть»). */
export const AGENT_CARE = "agent-care";
export const RUN_ANS_ID = "msg-run-ans1";
export const RUN_DONTKNOW_ID = "msg-run-dontknow";

function agent(id: string, label: string, defaultModel = "deepseek-chat") {
  return {
    id,
    presetId: "rag_chat",
    label,
    role: "Помощник по самопомощи",
    instructions: "Отвечай по базе знаний, приводи источники [source › section].",
    layers: {
      strategic: "Помогай найти триггерные точки и подобрать самопомощь.",
      operational: "Опирайся только на базу знаний; нет данных — скажи прямо.",
      task: "Текущая задача: разбор боли пользователя.",
    },
    inputPolicy: { trim: true, maxChars: 4000, requireNonEmpty: true },
    outputPolicy: { trim: true, maxChars: 4000, formatHint: "soft" },
    defaultModel,
    defaultTemperature: 0.3,
  };
}

function msg(id: string, role: "user" | "assistant", content: string): AgentMessage {
  return { id, role, content, createdAt: "2026-10-02T12:00:00.000Z" };
}

/** Два инстанса: B старше в массиве первым, A новее вторым — активен A/AGENT_A2. */
export function e2eInstances() {
  return {
    instances: [
      {
        id: INST_B_ID,
        label: "Демо · поясница",
        createdAt: "2026-10-01T10:00:00.000Z",
        agents: [agent(AGENT_B, "RAG-чат B")],
      },
      {
        id: INST_A_ID,
        label: "Демо · шея",
        createdAt: "2026-10-02T09:00:00.000Z",
        agents: [agent(AGENT_A1, "RAG-чат A1"), agent(AGENT_A2, "RAG-чат A2")],
      },
    ],
    caps: { maxInstances: 5, maxAgentsPerInstance: 6, usedInstances: 2 },
  };
}

export function e2eThread(
  instanceId: string,
  agentId: string,
  messages: AgentMessage[],
): Record<string, unknown> {
  return {
    instanceId,
    agentId,
    threadAgentId: agentId,
    messages,
    facts: {},
    branch: { forked: false, activeBranchId: null, checkpointCount: 0 },
    contextStrategy: "sliding",
  };
}

export function e2eThreadA(): Record<string, unknown> {
  return e2eThread(INST_A_ID, AGENT_A2, [
    msg("msg-a-q1", "user", "a-q1: Болит шея справа после работы, что делать?"),
    msg(
      "msg-a-ans1",
      "assistant",
      "a-ans1: Начните с верхней порции трапеции [travell-guide › Шея] и мягкого растяжения.",
    ),
  ]);
}

export function e2eThreadB(): Record<string, unknown> {
  return e2eThread(INST_B_ID, AGENT_B, [
    msg("msg-b-q1", "user", "b-q1: Болит поясница после приседов, как помочь?"),
    msg(
      "msg-b-ans1",
      "assistant",
      "b-ans1: Проверьте квадратную мышцу поясницы [travell-guide › Поясница] и подвздошно-рёберное сочленение.",
    ),
  ]);
}

export function e2eEmptyThread(instanceId: string, agentId: string): Record<string, unknown> {
  return e2eThread(instanceId, agentId, []);
}

/* — Обзор настроек: 1 сессия, rag_chat + care, треды с usage/cost на ответах — */

function assistantMsg(id: string, content: string, totalTokens: number, costRub: number): AgentMessage {
  return {
    id,
    role: "assistant",
    content,
    createdAt: "2026-10-02T12:01:00.000Z",
    model: "deepseek-chat",
    usage: {
      model: "deepseek-chat",
      prompt_tokens: 1100,
      completion_tokens: 360,
      total_tokens: totalTokens,
      prompt_cache_hit_tokens: 0,
      prompt_cache_miss_tokens: 1100,
      estimated_cost_usd: 0.0021,
      estimated_cost_rub: 0.2135,
    },
    cost_rub: costRub,
  };
}

/** Одна сессия, два агента: care (неактивный) + rag_chat (активный, последний). */
export function e2eSettingsInstances() {
  return {
    instances: [
      {
        id: INST_A_ID,
        label: "Демо · шея",
        createdAt: "2026-10-02T09:00:00.000Z",
        agents: [
          { ...agent(AGENT_CARE, "Care-чат"), presetId: "care", defaultModel: "deepseek-reasoner" },
          agent(AGENT_A2, "RAG-чат A2"),
        ],
      },
    ],
    caps: { maxInstances: 5, maxAgentsPerInstance: 6, usedInstances: 1 },
  };
}

/** Тред RAG-агента: 1 ход — 2 сообщ., 1460 ток («1.5k»), ₽0.02. */
export function e2eSettingsThreadRag(): Record<string, unknown> {
  return e2eThread(INST_A_ID, AGENT_A2, [
    msg("msg-s-q1", "user", "s-q1: Болит шея после сна, как размять?"),
    assistantMsg("msg-s-ans1", "s-ans1: Мягкое растяжение верхней порции трапеции.", 1460, 0.0154),
  ]);
}

/** Тред care-агента: 2 хода — 4 сообщ., 1940 ток («1.9k»), ₽0.04. */
export function e2eSettingsThreadCare(): Record<string, unknown> {
  return e2eThread(INST_A_ID, AGENT_CARE, [
    msg("msg-c-q1", "user", "c-q1: Не могу расслабиться вечером, что делать?"),
    assistantMsg("msg-c-ans1", "c-ans1: Дыхание 4-7-8 и разбор триггерных точек.", 970, 0.02),
    msg("msg-c-q2", "user", "c-q2: А если не помогает?"),
    assistantMsg("msg-c-ans2", "c-ans2: Тогда пересоберём стратегию самопомощи.", 970, 0.02),
  ]);
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

export function e2eModels() {
  return {
    models: [
      { tier: "base", label: "Chat", model: "deepseek-chat", via: "deepseek" },
      { tier: "reasoner", label: "Reasoner", model: "deepseek-reasoner", via: "deepseek" },
    ],
  };
}

export function e2eChatTask() {
  return {
    chatTaskState: {
      goal: "Подобрать самопомощь при боли в шее",
      clarified: ["боль отдаёт в голову к вечеру"],
      constraints_terms: ["без задержки дыхания"],
    },
  };
}

export function emptyChatTask() {
  return { chatTaskState: { goal: "", clarified: [], constraints_terms: [] } };
}

/* — run-ответы: числа подобраны детерминированно для assert'ов трейса — */

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

const DONTKNOW_REPLY =
  "По этому вопросу в базе нет релевантного материала — не буду выдумывать. Переформулируйте или опишите симптомы подробнее.";

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

function runAgentFrame() {
  return {
    id: AGENT_A2,
    label: "RAG-чат A2",
    presetId: "rag_chat",
    role: "Помощник по самопомощи",
    policies: {
      input: { trim: true, maxChars: 4000, requireNonEmpty: true },
      output: { trim: true, maxChars: 4000, formatHint: "soft" },
    },
    layers: {
      strategic: "Помогай найти триггерные точки и подобрать самопомощь.",
      operational: "Опирайся только на базу знаний; нет данных — скажи прямо.",
      task: "Текущая задача: разбор боли пользователя.",
    },
    model: "deepseek-chat",
    temperature: 0.3,
    overridesApplied: { model: false, temperature: false },
  };
}

/** Успешный rag-ход: 3 источника, 2/2 верифицированных цитат, заголовок хода «deepseek-chat · 2.1 s · 2.1k ток · ₽0.04». */
export function e2eRunRag(input: string) {
  return {
    reply: RAG_REPLY,
    message: {
      id: RUN_ANS_ID,
      role: "assistant",
      content: RAG_REPLY,
      agentId: AGENT_A2,
      model: "deepseek-chat",
      latency_ms: 2100,
      usage: LLM_USAGE,
      cost_rub: 0.0154,
      createdAt: "2026-10-03T09:30:00.000Z",
    },
    agent: runAgentFrame(),
    usage: LLM_USAGE,
    latency_ms: 2100,
    context: {
      historyMessages: [{ role: "user", content: input }],
      tool: {
        calls: [
          {
            name: "rag_ask",
            arguments: { question: input },
            ok: true,
            latencyMs: 840,
            resultClip: "rag_ask · dontKnow=false · topCosine=0.713",
            payload: ragOkPayload(input),
          },
        ],
      },
      chatTaskState: {
        goal: "Подобрать самопомощь при боли в шее",
        clarified: ["боль отдаёт в голову к вечеру"],
        constraints_terms: ["без задержки дыхания"],
      },
    },
    meta: { railViolated: false },
  };
}

/** dontKnow-ход: гейт «не знаю», без источников. */
export function e2eRunDontKnow(input: string) {
  return {
    reply: DONTKNOW_REPLY,
    message: {
      id: RUN_DONTKNOW_ID,
      role: "assistant",
      content: DONTKNOW_REPLY,
      agentId: AGENT_A2,
      model: "deepseek-chat",
      latency_ms: 1500,
      usage: LLM_USAGE,
      cost_rub: 0.0112,
      createdAt: "2026-10-03T09:35:00.000Z",
    },
    agent: runAgentFrame(),
    usage: LLM_USAGE,
    latency_ms: 1500,
    context: {
      historyMessages: [{ role: "user", content: input }],
      tool: {
        calls: [
          {
            name: "rag_ask",
            arguments: { question: input },
            ok: true,
            latencyMs: 610,
            resultClip: "rag_ask · dontKnow=true · topCosine=0.18",
            payload: ragDontKnowPayload(input),
          },
        ],
      },
    },
    meta: { railViolated: false },
  };
}
