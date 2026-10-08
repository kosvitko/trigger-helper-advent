/**
 * UNIT 2 — dialog store (dialog.svelte.ts, C+ CH-5b):
 * ошибка без активного треда (без POST), съём {threadId, preset} в момент
 * клика, typing true/false, append user+assistant (+ локальный персист пары),
 * отбрасывание ответа после смены треда, сброс ленты без активного,
 * двойной клик = один POST, ошибка /api/chat → текст + откат бабла.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { ChatRequest } from "@trigger-helper/shared";
import { session } from "./session.svelte";
import { dialog } from "./dialog.svelte";
import { trace } from "./trace.svelte";
import { makeChatResponse } from "../../test/fixtures";
import { stubFetch, type FetchStub } from "../../test/http";
import {
  applyTurnResult,
  createThread,
  getThread,
  threadStateCollection,
} from "../chat-state";
import { threadsCollection } from "../storage/th-local";

const ACTIVE_KEY = "th.active.v1";

/** Активный rag_chat-тред th-1 (+ сосед th-2 для переключений). */
function activate(threadId = "th-1"): void {
  createThread("th-1", "rag_chat", "");
  createThread("th-2", "rag_chat", "");
  session.reloadThreads();
  session.selectThread(threadId);
}

/** Отложенный chat-ответ: резолвить вручную (проверки гонок/typing). */
function deferredChat(res: unknown): { stub: FetchStub; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const stub = stubFetch([
    { url: "/api/chat", method: "POST", respond: () => gate.then(() => ({ json: res })) },
  ]);
  return { stub, release };
}

beforeEach(() => {
  threadsCollection.replaceAll([]);
  threadStateCollection.replaceAll([]);
  localStorage.removeItem(ACTIVE_KEY);
  session.threads = [];
  session.activeThreadId = null;
  session.error = "";
  session.undo = null;
  trace.setScope("sweep");
  trace.setScope(null);
  dialog.reset();
  stubFetch([]); // любой незапланированный fetch — ошибка «нет маршрута»
});

describe("dialog store · send (POST /api/chat)", () => {
  it("нет активного треда → видимая ошибка и НОЛЬ POST", async () => {
    const stub = stubFetch([]);
    const ok = await dialog.send("вопрос");
    expect(ok).toBe(false);
    expect(dialog.error).toMatch(/Нет активного чата/);
    expect(dialog.typing).toBe(false);
    expect(dialog.messages.size).toBe(0); // оптимистичный бабл не добавлялся
    expect(stub.calls).toHaveLength(0); // POST не стрелял
  });

  it("{threadId, preset} снимаются в момент клика, не в момент ответа", async () => {
    createThread("th-1", "rag_chat", "");
    createThread("th-2", "care", "");
    session.reloadThreads();
    session.selectThread("th-1");
    const { stub, release } = deferredChat(makeChatResponse({ reply: "ок" }));
    const p = dialog.send("вопрос"); // клик: th-1 / rag_chat
    // в полёте активный тред сменился:
    session.selectThread("th-2");
    release();
    await expect(p).resolves.toBe(true);
    const call = stub.callsTo("/api/chat", "POST")[0];
    const body = call.body as ChatRequest;
    expect(body.input).toBe("вопрос");
    expect(body.preset).toBe("rag_chat"); // пресет th-1, не th-2
    expect(typeof body.clientTurnId).toBe("string");
    expect(body.contextTail.dialogue).toEqual([]);
    expect(body.compress).toBe(false); // пустой диалог — триггер молчит
  });

  it("typing=true во время хода, false после ответа", async () => {
    activate();
    const { release } = deferredChat(makeChatResponse({ reply: "ок" }));
    const p = dialog.send("вопрос");
    expect(dialog.typing).toBe(true);
    release();
    await p;
    expect(dialog.typing).toBe(false);
  });

  it("user + assistant добавляются; пара персистится в локальный тред", async () => {
    activate();
    stubFetch([
      { url: "/api/chat", method: "POST", json: makeChatResponse({ reply: "ответ модели" }) },
    ]);
    const ok = await dialog.send("вопрос про шею");
    expect(ok).toBe(true);
    const roles = dialog.ordered.map((m) => m.role);
    expect(roles).toEqual(["user", "assistant"]);
    expect(dialog.ordered[0].content).toBe("вопрос про шею");
    expect(dialog.ordered[1].content).toBe("ответ модели");
    expect(dialog.ordered[1].id).toBe("th-1:1"); // клиентский id пары в треде
    expect(getThread("th-1")?.dialogue).toEqual([
      { role: "user", content: "вопрос про шею" },
      { role: "assistant", content: "ответ модели" },
    ]);
  });

  it("ход пишется в трейс под клиентским turnId (лента ↔ трейс связаны)", async () => {
    activate();
    stubFetch([
      { url: "/api/chat", method: "POST", json: makeChatResponse({ reply: "ответ" }) },
    ]);
    await dialog.send("вопрос");
    expect(trace.turnBy("th-1:1")).not.toBeNull();
    expect(trace.turnBy("th-1:1")?.userText).toBe("вопрос");
  });

  it("ответ, пришедший ПОСЛЕ смены треда, отбрасывается", async () => {
    activate(); // send стартует на th-1
    applyTurnResult("th-2", "rag_chat", "старый вопрос", makeChatResponse({ reply: "старый ответ" }));
    const { release } = deferredChat(makeChatResponse({ reply: "поздний ответ" }));
    const p = dialog.send("вопрос старого треда");
    expect(dialog.typing).toBe(true);
    // смена треда до ответа: loadThread нового треда (epoch++)
    session.selectThread("th-2");
    await dialog.loadThread();
    release();
    await expect(p).resolves.toBe(false); // ход не «прошёл» для нового треда
    const ids = dialog.ordered.map((m) => m.id);
    expect(ids).toEqual(["th-2:0", "th-2:1"]); // только диалог нового треда
    expect(dialog.typing).toBe(false); // композер нового треда не залочен
    expect(getThread("th-1")?.dialogue).toHaveLength(0); // персиста не было
  });

  it("переключение без активного треда сбрасывает ленту (утечка сообщений)", async () => {
    dialog.upsert({ id: "m-old-1", role: "user", content: "чужое сообщение", createdAt: "2026-10-05T10:00:00Z" });
    dialog.upsert({ id: "m-old-2", role: "assistant", content: "чужой ответ", createdAt: "2026-10-05T10:00:00Z" });
    session.threads = [];
    session.activeThreadId = null;
    dialog.typing = true; // in-flight старого треда не должен лочить новый
    await expect(dialog.loadThread()).rejects.toThrow(/Нет активного чата/);
    expect(dialog.messages.size).toBe(0); // лента чиста — утечки нет
    expect(dialog.typing).toBe(false);
  });

  it("двойной клик подряд → ровно один POST (busy-guard)", async () => {
    activate();
    const { stub, release } = deferredChat(makeChatResponse({ reply: "ок" }));
    const first = dialog.send("первый вопрос");
    const secondOk = await dialog.send("второй вопрос"); // пока typing=true
    expect(secondOk).toBe(false);
    release();
    await expect(first).resolves.toBe(true);
    expect(stub.callsTo("/api/chat", "POST")).toHaveLength(1);
    // второй текст не попал в ленту
    expect(dialog.ordered.filter((m) => m.content === "второй вопрос")).toHaveLength(0);
  });

  it("ошибка /api/chat: оптимистичный бабл убран, текст ошибки от сервера", async () => {
    activate();
    stubFetch([
      {
        url: "/api/chat",
        method: "POST",
        status: 429,
        json: { code: "rate_limited", message: "Слишком много ходов — подождите" },
      },
    ]);
    const ok = await dialog.send("вопрос");
    expect(ok).toBe(false);
    expect(dialog.error).toBe("Слишком много ходов — подождите");
    expect(dialog.messages.size).toBe(0); // бабл откачен
    expect(getThread("th-1")?.dialogue).toHaveLength(0); // персиста нет
    expect(dialog.typing).toBe(false);
  });
});

describe("dialog store · loadThread (локальный тред)", () => {
  it("лента наполняется из thread.dialogue; id = <threadId>:<index>", async () => {
    createThread("th-1", "rag_chat", "");
    applyTurnResult("th-1", "rag_chat", "вопрос один", makeChatResponse({ reply: "ответ один" }));
    session.reloadThreads();
    session.selectThread("th-1");
    await dialog.loadThread();
    const msgs = dialog.ordered;
    expect(msgs.map((m) => m.id)).toEqual(["th-1:0", "th-1:1"]);
    expect(msgs[0]).toMatchObject({ role: "user", content: "вопрос один" });
    expect(msgs[1]).toMatchObject({ role: "assistant", content: "ответ один" });
    // скелеты ходов для трейса — из сообщений треда (QA 041003 F1)
    expect(trace.turnBy("th-1:1")?.restored).toBe(true);
  });

  it("PATCH памяти задачи — локально, без сети", async () => {
    activate();
    await dialog.patchChatTask({ goal: "подобрать самопомощь", clarified: [], constraints_terms: [] });
    expect(dialog.chatTask?.goal).toBe("подобрать самопомощь");
    // значение доступно и после перечитывания состояния треда
    await dialog.loadThread();
    expect(dialog.chatTask?.goal).toBe("подобрать самопомощь");
  });
});
