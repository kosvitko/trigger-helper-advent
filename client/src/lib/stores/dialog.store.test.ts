/**
 * UNIT 2 — dialog store (dialog.svelte.ts):
 * ошибка без активного агента (без POST), съём {instanceId,agentId} в момент
 * клика, typing true/false, append user+assistant, отбрасывание ответа после
 * смены сессии, сброс ленты на сессии без агентов, двойной клик = один POST.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { session } from "./session.svelte";
import { dialog } from "./dialog.svelte";
import { trace } from "./trace.svelte";
import { makeAgent, makeInstance, makeMessage, makeRunResponse } from "../../test/fixtures";
import { stubFetch, type FetchStub } from "../../test/http";

const inst1 = makeInstance({
  id: "inst-1",
  agents: [makeAgent({ id: "agent-1", presetId: "rag_chat" })],
});
const inst2 = makeInstance({
  id: "inst-2",
  agents: [makeAgent({ id: "agent-2", presetId: "rag_chat" })],
});

function activate(inst = inst1, agentId = "agent-1"): void {
  session.instances = [inst1, inst2];
  session.activeInstanceId = inst.id;
  session.activeAgentId = agentId;
}

/** Отложенный run-ответ: резолвить вручную (проверки гонок/typing). */
function deferredRun(res: unknown): { stub: FetchStub; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const stub = stubFetch([
    { url: "/api/agent/run", method: "POST", respond: () => gate.then(() => ({ json: res })) },
    {
      url: "/messages",
      json: {
        instanceId: inst2.id,
        agentId: "agent-2",
        threadAgentId: "agent-2",
        messages: [makeMessage({ id: "m-b1", content: "тред 2 · сообщение 1" }), makeMessage({ id: "m-b2", role: "assistant", content: "тред 2 · ответ 1" })],
        facts: {},
        branch: { forked: false, activeBranchId: null, checkpointCount: 0 },
        contextStrategy: null,
      },
    },
    { url: "/chat-task-state", json: { chatTaskState: { goal: "", clarified: [], constraints_terms: [] } } },
  ]);
  return { stub, release };
}

beforeEach(() => {
  session.instances = [];
  session.activeInstanceId = null;
  session.activeAgentId = null;
  session.error = "";
  trace.setScope("sweep");
  trace.setScope(null);
  dialog.reset();
});

describe("dialog store · send", () => {
  it("нет активного агента → видимая ошибка и НОЛЬ POST", async () => {
    const stub = stubFetch([]);
    session.instances = [inst1, inst2];
    session.activeInstanceId = inst1.id;
    session.activeAgentId = null; // инстант без агентов (баг 2)
    const ok = await dialog.send("вопрос");
    expect(ok).toBe(false);
    expect(dialog.error).toMatch(/Нет активной сессии/);
    expect(dialog.typing).toBe(false);
    expect(dialog.messages.size).toBe(0); // оптимистичный бабл не добавлялся
    expect(stub.calls).toHaveLength(0); // POST не стрелял
  });

  it("{instanceId, agentId} снимаются в момент клика, не в момент ответа", async () => {
    activate();
    const { stub, release } = deferredRun(makeRunResponse({ messageId: "m-click" }));
    const p = dialog.send("вопрос"); // клик: ids = inst-1/agent-1
    // в полёте активная сессия сменилась:
    session.activeInstanceId = "inst-2";
    session.activeAgentId = "agent-9";
    release();
    await expect(p).resolves.toBe(true);
    const run = stub.callsTo("/api/agent/run", "POST")[0];
    expect(run.body).toMatchObject({ instanceId: "inst-1", agentId: "agent-1", input: "вопрос" });
  });

  it("typing=true во время хода, false после ответа", async () => {
    activate();
    const { release } = deferredRun(makeRunResponse({ messageId: "m-typing" }));
    const p = dialog.send("вопрос");
    expect(dialog.typing).toBe(true);
    release();
    await p;
    expect(dialog.typing).toBe(false);
  });

  it("user + assistant добавляются из ответа run", async () => {
    activate();
    const res = makeRunResponse({ messageId: "m-ans" });
    const { release } = deferredRun(res);
    const p = dialog.send("вопрос про шею");
    release();
    await expect(p).resolves.toBe(true);
    const roles = dialog.ordered.map((m) => m.role);
    expect(roles).toEqual(["user", "assistant"]);
    expect(dialog.ordered[0].content).toBe("вопрос про шею");
    expect(dialog.ordered[1].id).toBe("m-ans");
    expect(dialog.ordered[1].content).toBe(res.message.content);
  });

  it("ответ, пришедший ПОСЛЕ смены сессии, отбрасывается", async () => {
    activate(); // send стартует на inst-1/agent-1
    const { release } = deferredRun(makeRunResponse({ messageId: "m-stale" }));
    const p = dialog.send("вопрос старой сессии");
    expect(dialog.typing).toBe(true);
    // смена сессии до ответа: loadThread новой сессии (epoch++)
    session.activeInstanceId = inst2.id;
    session.activeAgentId = "agent-2";
    await dialog.loadThread();
    release();
    await expect(p).resolves.toBe(false); // ход не «прошёл» для новой сессии
    const ids = dialog.ordered.map((m) => m.id);
    expect(ids).toEqual(["m-b1", "m-b2"]); // только тред новой сессии
    expect(dialog.typing).toBe(false); // композер новой сессии не залочен
  });

  it("переключение на сессию без агентов сбрасывает ленту (утечка сообщений)", async () => {
    dialog.upsert(makeMessage({ id: "m-old-1", content: "чужое сообщение" }));
    dialog.upsert(makeMessage({ id: "m-old-2", role: "assistant", content: "чужой ответ" }));
    const empty = makeInstance({ id: "inst-empty", agents: [] });
    session.instances = [inst1, empty];
    session.activeInstanceId = "inst-empty";
    session.activeAgentId = null;
    dialog.typing = true; // in-flight старой сессии не должен лочить новую
    await expect(dialog.loadThread()).rejects.toThrow(/Нет активной сессии/);
    expect(dialog.messages.size).toBe(0); // лента чиста — утечки нет
    expect(dialog.typing).toBe(false);
  });

  it("двойной клик подряд → ровно один POST (busy-guard)", async () => {
    activate();
    const { stub, release } = deferredRun(makeRunResponse({ messageId: "m-once" }));
    const first = dialog.send("первый вопрос");
    const secondOk = await dialog.send("второй вопрос"); // пока typing=true
    expect(secondOk).toBe(false);
    release();
    await expect(first).resolves.toBe(true);
    expect(stub.callsTo("/api/agent/run", "POST")).toHaveLength(1);
    // второй текст не попал в ленту
    expect(dialog.ordered.filter((m) => m.content === "второй вопрос")).toHaveLength(0);
  });
});
