/**
 * UNIT 5 — settings store (settings.svelte.ts, C+ CH-5b):
 * персист overrides в sessionStorage th.overrides.v1; model-override
 * попадает в тело POST /api/chat (через dialog.send) как overrides.model.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { ChatRequest } from "@trigger-helper/shared";
import { session } from "./session.svelte";
import { dialog } from "./dialog.svelte";
import { settings } from "./settings.svelte";
import { trace } from "./trace.svelte";
import { createThread, threadStateCollection } from "../chat-state";
import { threadsCollection } from "../storage/th-local";
import { makeChatResponse } from "../../test/fixtures";
import { stubFetch } from "../../test/http";

beforeEach(() => {
  settings.overrides = {};
  threadsCollection.replaceAll([]);
  threadStateCollection.replaceAll([]);
  localStorage.removeItem("th.active.v1");
  createThread("th-1", "rag_chat", "");
  session.reloadThreads();
  session.selectThread("th-1");
  trace.setScope("sweep");
  trace.setScope(null);
  dialog.reset();
});

describe("settings store", () => {
  it("setModel персистит overrides в sessionStorage th.overrides.v1", () => {
    settings.setModel("deepseek-reasoner");
    expect(sessionStorage.getItem("th.overrides.v1")).toBe(JSON.stringify({ model: "deepseek-reasoner" }));
    expect(settings.chatOverrides()).toEqual({ model: "deepseek-reasoner" });
  });

  it("сброс модели убирает override и из chat-тела", () => {
    settings.setModel("deepseek-reasoner");
    settings.setModel(undefined);
    expect(settings.chatOverrides()).toEqual({});
    expect(JSON.parse(sessionStorage.getItem("th.overrides.v1")!)).toEqual({});
  });

  it("model-override включается в overrides запроса /api/chat", async () => {
    settings.setModel("deepseek-reasoner");
    const stub = stubFetch([{ url: "/api/chat", method: "POST", json: makeChatResponse({ reply: "ок" }) }]);
    await dialog.send("вопрос с override");
    const call = stub.callsTo("/api/chat", "POST")[0];
    expect(call.body).toMatchObject({ overrides: { model: "deepseek-reasoner" } });
  });

  it("без override поле model отсутствует; контракт запроса (preset/contextTail/compress)", async () => {
    const stub = stubFetch([{ url: "/api/chat", method: "POST", json: makeChatResponse({ reply: "ок" }) }]);
    await dialog.send("вопрос без override");
    const body = stub.callsTo("/api/chat", "POST")[0].body as ChatRequest;
    expect(body.overrides?.model).toBeUndefined();
    expect(body.preset).toBe("rag_chat");
    expect(body.compress).toBe(false); // пустой диалог — триггер сжатия молчит
    expect(body.contextTail.dialogue).toEqual([]);
    expect(typeof body.clientTurnId).toBe("string");
  });
});
