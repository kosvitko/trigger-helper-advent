/**
 * UNIT — api-клиент, close/restore-роуты (api.ts):
 * методы/пути/тела DELETE-снапшотов и POST-restore (201 парсится),
 * не-2xx → ApiError с текстом сервера.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { ApiError, api } from "./api";
import { makeAgent, makeInstance, makeMessage } from "../test/fixtures";
import { stubFetch } from "../test/http";

beforeEach(() => {
  stubFetch([]);
});

describe("api client · close/restore", () => {
  it("closeAgent: DELETE /api/instances/:id/agents/:agentId → {agent, messages}", async () => {
    const agent = makeAgent({ id: "a 2" });
    const stub = stubFetch([
      { url: "/api/instances/i%201/agents/a%202", method: "DELETE", json: { agent, messages: [makeMessage()] } },
    ]);
    const r = await api.closeAgent("i 1", "a 2");
    expect(stub.calls[0].method).toBe("DELETE");
    expect(stub.calls[0].url).toBe("/api/instances/i%201/agents/a%202");
    expect(r.agent.id).toBe("a 2");
    expect(r.messages).toHaveLength(1);
  });

  it("restoreAgent: POST …/agents/restore с {agent, messages, index}; 201 парсится", async () => {
    const agent = makeAgent({ id: "a-2" });
    const messages = [makeMessage({ id: "m-1" })];
    const stub = stubFetch([
      {
        url: "/api/instances/i-1/agents/restore",
        method: "POST",
        status: 201,
        json: { agent, messages },
      },
    ]);
    const r = await api.restoreAgent("i-1", { agent, messages, index: 1 });
    const post = stub.callsTo("/api/instances/i-1/agents/restore", "POST")[0];
    expect(post.method).toBe("POST");
    expect(post.url).toBe("/api/instances/i-1/agents/restore");
    expect(post.body).toEqual({ agent, messages, index: 1 });
    expect(r.agent.id).toBe("a-2");
  });

  it("closeInstance: DELETE /api/instances/:id → {instance, threads}", async () => {
    const instance = makeInstance({ id: "i-a" });
    const stub = stubFetch([
      { url: "/api/instances/i-a", method: "DELETE", json: { instance, threads: { "a-1": [makeMessage()] } } },
    ]);
    const r = await api.closeInstance("i-a");
    expect(stub.calls[0].method).toBe("DELETE");
    expect(stub.calls[0].url).toBe("/api/instances/i-a");
    expect(r.instance.id).toBe("i-a");
    expect(Object.keys(r.threads)).toEqual(["a-1"]);
  });

  it("restoreInstance: POST /api/instances/restore с {instance, threads}", async () => {
    const instance = makeInstance({ id: "i-a" });
    const threads = { "a-1": [makeMessage({ id: "m-9" })] };
    const stub = stubFetch([
      { url: "/api/instances/restore", method: "POST", status: 201, json: { instance, threads } },
    ]);
    const r = await api.restoreInstance({ instance, threads });
    const post = stub.callsTo("/api/instances/restore", "POST")[0];
    expect(post.method).toBe("POST");
    expect(post.url).toBe("/api/instances/restore");
    expect(post.body).toEqual({ instance, threads });
    expect(r.instance.id).toBe("i-a");
  });

  it("не-2xx → ApiError с текстом сервера и статусом", async () => {
    stubFetch([
      { url: "/api/instances/i-1", method: "DELETE", status: 404, json: { error: "сессия не найдена" } },
    ]);
    const err = await api.closeInstance("i-1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toBe("сессия не найдена");
    expect((err as ApiError).status).toBe(404);
  });
});
