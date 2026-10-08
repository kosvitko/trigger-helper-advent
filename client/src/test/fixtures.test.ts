/**
 * Реалистичность фикстур: юнит-билдеры проходят safeParse схем
 * @trigger-helper/shared; e2e-payloadы проходят полный parse-путь
 * клиента (api-клиент / ChatResponseSchema — те же схемы, что в
 * api.ts/api-chat.ts). Если тест падает — фикстура разошлась с
 * контрактом, а не продукт.
 */
import { describe, expect, it } from "vitest";
import {
  AgentInstanceSchema,
  AgentMessageSchema,
  ChatResponseSchema,
  ChatTaskStateSchema,
  ChatThreadRecordSchema,
} from "@trigger-helper/shared";
import { api } from "../lib/api";
import { ChatThreadStateRecordSchema } from "../lib/chat-state";
import {
  makeAgent,
  makeChatTask,
  makeMessage,
  ragDontKnowPayload,
  ragOkPayload,
} from "./fixtures";
import { stubFetch } from "./http";
import {
  e2eAgentsMeta,
  e2eBackThread,
  e2eCareThread,
  e2eChatDontKnow,
  e2eChatRag,
  e2eModels,
  e2eNeckThread,
  e2eNeckThreadState,
  e2eRagStats,
  e2eThreadRecord,
} from "../../e2e/fixtures";

describe("unit-фикстуры валидны по схемам shared", () => {
  it("makeAgent/makeMessage/makeChatTask", () => {
    expect(AgentInstanceSchema.safeParse(makeAgent({ id: "a" })).success).toBe(true);
    expect(AgentMessageSchema.safeParse(makeMessage({ id: "m" })).success).toBe(true);
    expect(ChatTaskStateSchema.safeParse(makeChatTask()).success).toBe(true);
  });
});

describe("e2e-фикстуры проходят parse-путь клиента", () => {
  it("chat-ответы: rag / dontKnow / compress+contextTrimmed+memoryDelta", () => {
    // те же схемы, что api-chat.ts в не-SSE-ветке и на done-кадре
    const variants = [
      e2eChatRag("Болит шея справа"),
      e2eChatRag("Болит шея справа", { compress: true, contextTrimmed: true, memoryDelta: true }),
      e2eChatDontKnow("Сколько весит лунный грунт?"),
    ];
    for (const v of variants) {
      const r = ChatResponseSchema.safeParse(v);
      if (!r.success) console.error(r.error.issues);
      expect(r.success).toBe(true);
    }
  });

  it("локальные треды: записи threads/threadState валидны для th-local", () => {
    for (const t of [e2eNeckThread(), e2eBackThread(), e2eCareThread(), e2eThreadRecord({ id: "t-x", title: "X" })]) {
      const r = ChatThreadRecordSchema.safeParse(t);
      if (!r.success) console.error(r.error.issues);
      expect(r.success).toBe(true);
    }
    expect(ChatThreadStateRecordSchema.safeParse(e2eNeckThreadState()).success).toBe(true);
  });

  it("справочники: модели, мета пресетов, rag/stats прод-форма", async () => {
    stubFetch([
      { url: "/api/models", json: e2eModels() },
      { url: "/api/agents", json: e2eAgentsMeta() },
      { url: "/api/rag/stats", json: e2eRagStats() },
    ]);
    await expect(api.getModels()).resolves.toMatchObject({
      models: [{ model: "deepseek-chat" }, { model: "deepseek-reasoner" }],
    });
    await expect(api.agentsMeta()).resolves.toEqual({ autoCompress: { defaultEvery: 10 } });
    const stats = await api.ragStats(); // РЕАЛЬНАЯ прод-форма проходит схему
    expect(stats.indexes.map((i) => i.chunks)).toEqual([128, 220]);
    expect(stats.compare?.byStrategy.structured?.hitAt1).toBeCloseTo(0.6667, 4);
  });
});
