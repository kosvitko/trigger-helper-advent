/**
 * UNIT 1 — session store (session.svelte.ts):
 * boot-загрузка списка, ретрай-политика, демо-дефолт «последний rag_chat»,
 * фолбэк на любого агента, create-флоу, кап-лимит 429 без крушения.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { ApiError } from "../api";
import { session } from "./session.svelte";
import { makeAgent, makeInstance } from "../../test/fixtures";
import { stubFetch } from "../../test/http";

const okInstances = {
  instances: [makeInstance({ id: "i-1", agents: [makeAgent({ id: "a-1" })] })],
  caps: { maxInstances: 5, maxAgentsPerInstance: 6, usedInstances: 1 },
};

beforeEach(() => {
  session.instances = [];
  session.activeInstanceId = null;
  session.activeAgentId = null;
  session.error = "";
});

describe("session store · load", () => {
  it("boot load наполняет список инстантов", async () => {
    const stub = stubFetch([{ url: "/api/instances", json: okInstances }]);
    await session.load();
    expect(session.instances.map((i) => i.id)).toEqual(["i-1"]);
    expect(stub.calls).toHaveLength(1);
  });

  it("один ретрай: первый сбой → вторая попытка успешна", async () => {
    let attempt = 0;
    const stub = stubFetch([
      {
        url: "/api/instances",
        respond: () => {
          attempt += 1;
          return attempt === 1 ? Promise.reject(new TypeError("network down")) : { json: okInstances };
        },
      },
    ]);
    await session.load();
    expect(session.instances).toHaveLength(1);
    expect(stub.calls).toHaveLength(2); // ровно один ретрай
  });

  it("двойной сбой → ошибка всплывает, не «молча пусто»", async () => {
    const stub = stubFetch([
      { url: "/api/instances", respond: () => Promise.reject(new TypeError("network down")) },
    ]);
    await expect(session.load()).rejects.toBeInstanceOf(ApiError);
    expect(session.instances).toEqual([]);
    expect(stub.calls).toHaveLength(2); // 1 попытка + 1 ретрай, не бесконечно
  });

  it("ошибка сервера (500 {error}) доходит текстом", async () => {
    stubFetch([{ url: "/api/instances", status: 500, json: { error: "база недоступна" } }]);
    await expect(session.load()).rejects.toMatchObject({ message: "база недоступна" });
  });
});

describe("session store · активная сессия (демо-дефолт D-2)", () => {
  it("активен последний rag_chat новейшего инстанта (createdAt desc, не порядок массива)", async () => {
    const ragOld = makeAgent({ id: "rag-old", presetId: "rag_chat" });
    const ragLast = makeAgent({ id: "rag-last", presetId: "rag_chat" });
    const older = makeInstance({
      id: "i-old",
      createdAt: "2026-10-01T10:00:00.000Z",
      agents: [makeAgent({ id: "rag-in-old", presetId: "rag_chat" })],
    });
    // новейший стоит ПЕРВЫМ в массиве — сортировка по createdAt обязана это исправить
    const newer = makeInstance({
      id: "i-new",
      createdAt: "2026-10-03T10:00:00.000Z",
      agents: [ragOld, ragLast],
    });
    stubFetch([{ url: "/api/instances", json: { instances: [newer, older], caps: okInstances.caps } }]);
    await session.ensureActive();
    expect(session.activeInstanceId).toBe("i-new");
    expect(session.activeAgentId).toBe("rag-last"); // последний rag_chat, не первый
  });

  it("нет ни одного rag_chat → фолбэк на любого агента", async () => {
    const care = makeAgent({ id: "care-1", presetId: "care" });
    stubFetch([
      { url: "/api/instances", json: { instances: [makeInstance({ id: "i-1", agents: [care] })], caps: okInstances.caps } },
    ]);
    await session.ensureActive();
    expect(session.activeInstanceId).toBe("i-1");
    expect(session.activeAgentId).toBe("care-1");
  });
});

describe("session store · создание RAG-чата", () => {
  it("create flow (инстант+агент) делает его активным", async () => {
    const created = makeInstance({ id: "i-new", agents: [makeAgent({ id: "rag-new", presetId: "rag_chat" })] });
    const stub = stubFetch([
      { url: "/api/instances", method: "GET", json: { instances: [], caps: okInstances.caps } },
      { url: "/api/instances", method: "POST", json: { instance: created } },
    ]);
    await session.ensureActive(); // пусто → создаёт
    expect(session.activeInstanceId).toBe("i-new");
    expect(session.activeAgentId).toBe("rag-new");
    expect(session.instances.map((i) => i.id)).toContain("i-new");
    // тело POST: label + seedPresetIds=['rag_chat'] (создание одним кликом)
    const post = stub.callsTo("/api/instances", "POST")[0];
    expect(post.body).toMatchObject({ seedPresetIds: ["rag_chat"] });
    expect((post.body as { label?: string }).label).toMatch(/^Демо · /);
  });

  it("кап-лимит инстантов (HTTP 429) всплывает ошибкой и не рушит стор", async () => {
    const stub = stubFetch([
      { url: "/api/instances", method: "GET", json: { instances: [], caps: okInstances.caps } },
      { url: "/api/instances", method: "POST", status: 429, json: { error: "Достигнут лимит инстансов (макс. 2)" } },
    ]);
    // так делает Shell.boot: rejection → session.error (видимая ошибка)
    const err = await session.ensureActive().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toBe("Достигнут лимит инстансов (макс. 2)");
    expect((err as ApiError).status).toBe(429);
    // стор жив, без активной сессии, список не задет
    expect(session.activeInstanceId).toBeNull();
    expect(session.activeAgentId).toBeNull();
    expect(session.instances).toEqual([]);
    expect(stub.calls).toHaveLength(2);
  });
});

describe("session store · переключение", () => {
  it("selectInstance сбрасывает агента на rag_chat этого инстанта", () => {
    const ragB = makeAgent({ id: "rag-b", presetId: "rag_chat" });
    const instB = makeInstance({ id: "i-b", agents: [makeAgent({ id: "care-b", presetId: "care" }), ragB] });
    session.instances = [instB];
    session.selectInstance("i-b");
    expect(session.activeAgentId).toBe("rag-b");
  });

  it("requireIds бросает понятную ошибку без активной сессии", () => {
    expect(() => session.requireIds()).toThrow(/Нет активной сессии/);
  });
});
