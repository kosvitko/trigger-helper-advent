/**
 * UNIT 5 — settings store (settings.svelte.ts):
 * персист overrides в sessionStorage th.overrides.v1; model-override
 * попадает в тело POST /api/agent/run (через dialog.send).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { session } from "./session.svelte";
import { dialog } from "./dialog.svelte";
import { settings } from "./settings.svelte";
import { trace } from "./trace.svelte";
import { makeAgent, makeInstance, makeRunResponse } from "../../test/fixtures";
import { stubFetch } from "../../test/http";

beforeEach(() => {
  settings.overrides = {};
  session.instances = [
    makeInstance({ id: "inst-1", agents: [makeAgent({ id: "agent-1", presetId: "rag_chat" })] }),
  ];
  session.activeInstanceId = "inst-1";
  session.activeAgentId = "agent-1";
  trace.setScope("sweep");
  trace.setScope(null);
  dialog.reset();
});

describe("settings store", () => {
  it("setModel персистит overrides в sessionStorage th.overrides.v1", () => {
    settings.setModel("deepseek-reasoner");
    expect(sessionStorage.getItem("th.overrides.v1")).toBe(JSON.stringify({ model: "deepseek-reasoner" }));
    expect(settings.runOverrides()).toEqual({ model: "deepseek-reasoner" });
  });

  it("сброс модели убирает override и из run-тела", () => {
    settings.setModel("deepseek-reasoner");
    settings.setModel(undefined);
    expect(settings.runOverrides()).toEqual({});
    expect(JSON.parse(sessionStorage.getItem("th.overrides.v1")!)).toEqual({});
  });

  it("model-override включается в тело run-запроса", async () => {
    settings.setModel("deepseek-reasoner");
    const stub = stubFetch([{ url: "/api/agent/run", method: "POST", json: makeRunResponse({ messageId: "m-ovr" }) }]);
    await dialog.send("вопрос с override");
    const run = stub.callsTo("/api/agent/run", "POST")[0];
    expect(run.body).toMatchObject({ overrides: { model: "deepseek-reasoner" } });
  });

  it("без override поле model в overrides отсутствует", async () => {
    const stub = stubFetch([{ url: "/api/agent/run", method: "POST", json: makeRunResponse({ messageId: "m-noovr" }) }]);
    await dialog.send("вопрос без override");
    const run = stub.callsTo("/api/agent/run", "POST")[0];
    expect((run.body as { overrides?: { model?: string } }).overrides?.model).toBeUndefined();
  });
});
