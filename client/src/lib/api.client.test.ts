/**
 * UNIT 4 — api-клиент (api.ts):
 * относительные /api-пути, таймаут-ошибка «Сервер не ответил…»,
 * невалидный JSON / провал схемы → управляемая ошибка без сырого throw.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { ApiError, api } from "./api";
import { stubFetch } from "../test/http";

beforeEach(() => {
  stubFetch([]);
});

describe("api client · пути", () => {
  it("запросы идут на относительные /api-пути (никаких абсолютных URL)", async () => {
    const stub = stubFetch([
      { url: "/api/instances", json: { instances: [], caps: { maxInstances: 5, maxAgentsPerInstance: 6 } } },
      { url: "/api/models", json: { models: [] } }, // контракт 04.10: только models[]
    ]);
    await api.listInstances();
    await api.getModels();
    expect(stub.calls[0].url).toBe("/api/instances");
    expect(stub.calls[1].url).toBe("/api/models");
    expect(stub.calls.every((c) => c.url.startsWith("/api/"))).toBe(true);
  });

  it("runAgent: POST /api/agent/run с телом запроса", async () => {
    const stub = stubFetch([{ url: "/api/agent/run", method: "POST", json: {} }]);
    await api.runAgent({ instanceId: "i", agentId: "a", input: "q" }).catch(() => undefined);
    const call = stub.callsTo("/api/agent/run", "POST")[0];
    expect(call.url).toBe("/api/agent/run");
    expect(call.body).toMatchObject({ instanceId: "i", agentId: "a", input: "q" });
  });

  it("идентификаторы в пути кодируются (encodeURIComponent), путь остаётся /api/*", async () => {
    const stub = stubFetch([{ url: "/api/instances/", json: { instanceId: "i 1", agentId: "a/2", threadAgentId: "a/2", messages: [], facts: {}, branch: { forked: false, activeBranchId: null, checkpointCount: 0 }, contextStrategy: null } }]);
    await api.listMessages("i 1", "a/2");
    expect(stub.calls[0].url).toBe("/api/instances/i%201/agents/a%2F2/messages");
  });
});

describe("api client · ошибки", () => {
  it("таймаут → ApiError «Сервер не ответил за N с»", async () => {
    stubFetch([
      {
        url: "/api/instances",
        respond: () => Promise.reject(new DOMException("aborted", "TimeoutError")),
      },
    ]);
    const err = await api.listInstances().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toMatch(/^Сервер не ответил за \d+ с$/);
  });

  it("сетевой сбой → ApiError «Сервер недоступен», не сырая TypeError", async () => {
    stubFetch([{ url: "/api/instances", respond: () => Promise.reject(new TypeError("fetch failed")) }]);
    const err = await api.listInstances().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toBe("Сервер недоступен");
  });

  it("200 с невалидным JSON → управляемая ошибка формата (не uncaught SyntaxError)", async () => {
    stubFetch([{ url: "/api/instances", text: "<html>gateway oops</html>" }]);
    const err = await api.listInstances().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toBe("Неожиданный формат ответа сервера");
  });

  it("200 с провалом схемы → та же управляемая ошибка (502-путь)", async () => {
    stubFetch([{ url: "/api/instances", json: { unexpected: true } }]);
    const err = await api.listInstances().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toBe("Неожиданный формат ответа сервера");
    expect((err as ApiError).status).toBe(502);
  });

  it("не-2xx с {error} → текст сервера и статус в ApiError", async () => {
    stubFetch([{ url: "/api/instances", method: "POST", status: 429, json: { error: "Достигнут лимит" } }]);
    const err = await api.createInstance({}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toBe("Достигнут лимит");
    expect((err as ApiError).status).toBe(429);
  });
});
