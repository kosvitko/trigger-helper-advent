/**
 * Реалистичность фикстур: юнит-билдеры проходят safeParse схем
 * @trigger-helper/shared; e2e-payloadы проходят полный parse-путь
 * api-клиента (api.ts парсит ответы теми же схемами). Если тест падает —
 * фикстура разошлась с контрактом, а не продукт.
 */
import { describe, expect, it } from "vitest";
import {
  AgentInstanceSchema,
  AgentMessageSchema,
  AgentRunResponseSchema,
  ChatTaskStateSchema,
  InstanceSchema,
} from "@trigger-helper/shared";
import { api } from "../lib/api";
import {
  makeAgent,
  makeChatTask,
  makeInstance,
  makeMessage,
  makeRunResponse,
  ragDontKnowPayload,
  ragOkPayload,
} from "./fixtures";
import { stubFetch } from "./http";
import {
  AGENT_A2,
  AGENT_CARE,
  INST_A_ID,
  e2eChatTask,
  e2eEmptyThread,
  e2eInstances,
  e2eModels,
  e2eRagStats,
  e2eRunDontKnow,
  e2eRunRag,
  e2eSettingsInstances,
  e2eSettingsThreadCare,
  e2eSettingsThreadRag,
  e2eThreadA,
  e2eThreadB,
  emptyChatTask,
} from "../../e2e/fixtures";

describe("unit-фикстуры валидны по схемам shared", () => {
  it("makeRunResponse: rag-успех / dontKnow / ход без тулзов", () => {
    const variants = [
      makeRunResponse({ messageId: "m1", rag: ragOkPayload("q") }),
      makeRunResponse({ messageId: "m2", rag: ragDontKnowPayload("q") }),
      makeRunResponse({ messageId: "m3", rag: null }),
      makeRunResponse({ messageId: "m4", railViolated: true, chatTask: makeChatTask() }),
    ];
    for (const v of variants) {
      const r = AgentRunResponseSchema.safeParse(v);
      if (!r.success) console.error(r.error.issues);
      expect(r.success).toBe(true);
    }
  });

  it("makeInstance/makeAgent/makeMessage/makeChatTask", () => {
    expect(InstanceSchema.safeParse(makeInstance({ id: "i", agents: [makeAgent({ id: "a" })] })).success).toBe(true);
    expect(AgentInstanceSchema.safeParse(makeAgent({ id: "a" })).success).toBe(true);
    expect(AgentMessageSchema.safeParse(makeMessage({ id: "m" })).success).toBe(true);
    expect(ChatTaskStateSchema.safeParse(makeChatTask()).success).toBe(true);
  });
});

describe("e2e-фикстуры проходят parse-путь api-клиента", () => {
  it("инстансы, треды, модели, память задачи, оба run-ответа", async () => {
    const rag = e2eRunRag("Болит шея справа");
    const dontKnow = e2eRunDontKnow("Сколько весит лунный грунт?");
    stubFetch([
      { url: "/api/instances", method: "GET", json: e2eInstances() },
      { url: "/api/instances", method: "POST", json: { instance: e2eInstances().instances[1] } },
      { url: "/api/agent/run", method: "POST", json: rag },
      { url: `/api/instances/${INST_A_ID}/agents/${AGENT_A2}/messages`, json: e2eThreadA() },
      { url: "/models", json: e2eModels() },
      { url: "/chat-task-state", method: "GET", json: e2eChatTask() },
      { url: "/chat-task-state", method: "PATCH", json: emptyChatTask() },
    ]);
    // каждый вызов либо резолвится, либо это находка о расхождении фикстуры
    const inst = await api.listInstances();
    expect(inst.instances).toHaveLength(2);
    await expect(api.runAgent({ instanceId: INST_A_ID, agentId: AGENT_A2, input: "q" })).resolves.toMatchObject({ message: { id: rag.message.id } });
    await expect(api.listMessages(INST_A_ID, AGENT_A2)).resolves.toBeTruthy();
    await expect(api.getModels()).resolves.toBeTruthy();
    await expect(api.getChatTaskState(INST_A_ID, AGENT_A2)).resolves.toMatchObject({ goal: expect.any(String) });
    await expect(api.patchChatTaskState(INST_A_ID, AGENT_A2, { goal: "новая цель" })).resolves.toBeTruthy();

    // dontKnow-вариант — отдельным стабом
    stubFetch([{ url: "/api/agent/run", method: "POST", json: dontKnow }]);
    await expect(api.runAgent({ instanceId: INST_A_ID, agentId: AGENT_A2, input: "q2" })).resolves.toMatchObject({ message: { id: dontKnow.message.id } });

    // тред B и пустой тред — тоже валидны (точные URL — приоритет точного совпадения)
    stubFetch([{ url: "/api/instances/inst-b/agents/agent-b-rag/messages", json: e2eThreadB() }]);
    await expect(api.listMessages("inst-b", "agent-b-rag")).resolves.toBeTruthy();
    stubFetch([{ url: "/api/instances/x/agents/y/messages", json: e2eEmptyThread("x", "y") }]);
    await expect(api.listMessages("x", "y")).resolves.toBeTruthy();
  });

  it("фикстуры настроек: инстанс rag+care, треды с usage/cost, rag/stats прод-форма", async () => {
    stubFetch([
      { url: "/api/instances", json: e2eSettingsInstances() },
      { url: `/api/instances/${INST_A_ID}/agents/${AGENT_A2}/messages`, json: e2eSettingsThreadRag() },
      { url: `/api/instances/${INST_A_ID}/agents/${AGENT_CARE}/messages`, json: e2eSettingsThreadCare() },
      { url: "/api/rag/stats", json: e2eRagStats() },
    ]);
    const inst = await api.listInstances();
    expect(inst.instances).toHaveLength(1);
    expect(inst.instances[0]?.agents.map((a) => a.presetId)).toEqual(["care", "rag_chat"]);
    await expect(api.listMessages(INST_A_ID, AGENT_A2)).resolves.toBeTruthy();
    const care = await api.listMessages(INST_A_ID, AGENT_CARE);
    const assistants = care.messages.filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(2);
    expect(assistants.every((m) => m.usage && m.cost_rub !== undefined)).toBe(true);

    const stats = await api.ragStats(); // РЕАЛЬНАЯ прод-форма проходит схему
    expect(stats.indexes.map((i) => i.chunks)).toEqual([128, 220]);
    expect(stats.compare?.byStrategy.structured?.hitAt1).toBeCloseTo(0.6667, 4);
  });
});
