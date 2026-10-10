/**
 * UNIT — HTTP/SSE-швы `POST /api/chat` (гейт 261009 Pick A, кусок 2).
 * Shared zod / normalize / resolveChatModel — в client chat.contract.test.ts;
 * здесь только серверный маппинг: 400 JSON, SSE error, happy-path с мок llmAgent.
 * DOM/бабл не ассертим (рельса AGENTS: UI → рендер-контракт клиента).
 */
import {
  ChatResponseSchema,
  ChatSseErrorEventSchema,
} from "@trigger-helper/shared";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { Env } from "../config/env.js";
import type { AgentRunOk, LlmAgent } from "../services/agent/llm-agent.js";
import type { DeepSeekService } from "../services/deepseek.js";
import type { Reranker } from "../services/rag/rerank.js";
import type { RagService } from "../services/rag/store.js";
import type { UsageLedgerService } from "../services/usage-ledger.js";
import { registerChatRoutes } from "./chat.js";

const zeroUsage = {
  model: "deepseek-chat",
  prompt_tokens: 10,
  completion_tokens: 5,
  total_tokens: 15,
  prompt_cache_hit_tokens: 0,
  prompt_cache_miss_tokens: 10,
  estimated_cost_usd: 0,
  estimated_cost_rub: 0,
};

function mockRunOk(reply = "мок-ответ"): AgentRunOk {
  return {
    reply,
    usage: zeroUsage,
    latency_ms: 1,
    model: "deepseek-chat",
    temperature: 0.7,
    cost_rub: 0,
    overridesApplied: { model: false, temperature: false },
    tokens: {
      estimate: {
        system: 0,
        history: 0,
        user: 0,
        total: 0,
        historyMessages: 0,
      },
      limit: 128_000,
      historyMode: "full",
      historySent: 0,
    },
    historyChat: [{ role: "user", content: "x" }],
  };
}

function testEnv(overrides: Partial<Env> = {}): Env {
  return {
    DEEPSEEK_API_KEY: "test-key",
    DEEPSEEK_MODEL: "deepseek-chat",
    PROXYAPI_BASE_URL: "https://openai.api.proxyapi.ru/v1",
    PORT: 3000,
    SCHEDULE_SUMMARY_MIN_SEC: 86_400,
    FREE_DAILY_ASKS: 20,
    MAX_INSTANCES: 8,
    MAX_AGENTS_PER_INSTANCE: 16,
    DEMO_CONTEXT_LIMIT: 0,
    AGENT_COMPRESS_EVERY: 10,
    RATE_LIMIT_MAX: 0,
    RATE_LIMIT_WINDOW_MS: 60_000,
    DAILY_BUDGET_RUB: 0,
    DAILY_BUDGET_EXPENSIVE_RUB: 0,
    BUDGET_DELAY_ALPHA: 2.5,
    BUDGET_DELAY_BETA: 2,
    BUDGET_DELAY_FILL_MS: 20_000,
    BUDGET_DELAY_PACE_MS: 60_000,
    BUDGET_DELAY_MAX_MS: 180_000,
    NODE_ENV: "test",
    ...overrides,
  } as Env;
}

function emptyTotals() {
  return {
    requests: 0,
    cost_usd: 0,
    cost_rub: 0,
    total_tokens: 0,
    cache_hit_tokens: 0,
    by_model: {},
    expensive_day: "2099-01-01",
    expensive_asks_today: 0,
    budget_day: "2099-01-01",
    cost_rub_today: 0,
    cost_rub_expensive_today: 0,
    updated_at: new Date(0).toISOString(),
  };
}

async function buildChatTestApp(opts?: {
  run?: () => Promise<AgentRunOk>;
  env?: Partial<Env>;
}) {
  const run = opts?.run ?? (async () => mockRunOk());
  const llmAgent = {
    run: vi.fn(run),
    classifyMemoryFacts: vi.fn(async () => ({
      ok: false as const,
      items: [],
    })),
    classifyChatTaskState: vi.fn(async () => ({
      ok: false as const,
      extracted: {},
    })),
    compress: vi.fn(),
  } as unknown as LlmAgent;

  const usageLedger = {
    getTotals: vi.fn(async () => emptyTotals()),
    record: vi.fn(async () => emptyTotals()),
  } as unknown as UsageLedgerService;

  const deepSeekService = {
    getDemoModels: () => [] as { model: string }[],
  } as unknown as DeepSeekService;

  // День 28: rag/reranker нужны типу ChatRouteDeps; контракт-тесты не ходят
  // в локальную rag-ветку (модели не локальные) — инертные стабы.
  const rag = {} as RagService;
  const reranker = {} as Reranker;

  const app = Fastify({ logger: false });
  await registerChatRoutes(app, {
    llmAgent,
    usageLedger,
    deepSeekService,
    env: testEnv(opts?.env),
    rag,
    reranker,
  });
  await app.ready();
  return { app, llmAgent, usageLedger };
}

const validBody = {
  input: "болит шея сбоку",
  preset: "care",
  contextTail: { summaries: [], dialogue: [] },
};

function parseSseJsonEvents(payload: string): unknown[] {
  const events: unknown[] = [];
  for (const line of payload.split(/\r?\n/)) {
    if (!line.startsWith("data: ")) continue;
    const data = line.slice(6);
    if (data === "[DONE]") continue;
    if (data.startsWith(":")) continue;
    try {
      events.push(JSON.parse(data));
    } catch {
      /* ping / мусор — пропускаем */
    }
  }
  return events;
}

describe("POST /api/chat — серверный HTTP/SSE-контракт", () => {
  it("битое тело → 400 JSON schema_invalid", async () => {
    const { app } = await buildChatTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/chat",
      headers: { "content-type": "application/json" },
      payload: { input: "", preset: "care" },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.code).toBe("schema_invalid");
    expect(body.error).toBe("schema_invalid");
    await app.close();
  });

  it("битое тело + Accept SSE → событие type:error (04-MAJ-2)", async () => {
    const { app } = await buildChatTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/chat",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
      },
      payload: { input: "", preset: "care" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/event-stream/);
    const events = parseSseJsonEvents(res.body);
    const err = events.find(
      (e) =>
        e && typeof e === "object" && (e as { type?: string }).type === "error",
    );
    expect(err).toBeTruthy();
    const parsed = ChatSseErrorEventSchema.safeParse(err);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.code).toBe("schema_invalid");
      expect(parsed.data.httpStatus).toBe(400);
    }
    expect(res.body).toContain("data: [DONE]");
    await app.close();
  });

  it("валидный ход + мок llmAgent → 200 JSON ChatResponse", async () => {
    const { app, llmAgent, usageLedger } = await buildChatTestApp({
      run: async () => mockRunOk("серверный ответ"),
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/chat",
      headers: { "content-type": "application/json" },
      payload: validBody,
    });
    expect(res.statusCode).toBe(200);
    const parsed = ChatResponseSchema.safeParse(res.json());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.reply).toBe("серверный ответ");
      expect(parsed.data.usage.model).toBe("deepseek-chat");
    }
    expect(llmAgent.run).toHaveBeenCalledOnce();
    expect(usageLedger.record).toHaveBeenCalled();
    await app.close();
  });

  it("неизвестная модель → 400 schema_invalid (allow-list fail-closed)", async () => {
    const { app, llmAgent } = await buildChatTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/chat",
      headers: { "content-type": "application/json" },
      payload: {
        ...validBody,
        overrides: { model: "totally-unknown-model-xyz" },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("schema_invalid");
    expect(res.json().message).toMatch(/Неизвестная модель/);
    expect(llmAgent.run).not.toHaveBeenCalled();
    await app.close();
  });
});
