/**
 * UNIT — закрытие чата/сессии + «Вернуть» (session.svelte.ts):
 * гарды «последний агент/инстанс», DELETE-снапшот с правильным URL,
 * переключение на соседа, тост с автопогашением 5 с (UNDO_MS),
 * restore на прежний индекс, ошибка restore → баннер session.error.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { session } from "./session.svelte";
import { makeAgent, makeInstance, makeMessage } from "../../test/fixtures";
import { stubFetch } from "../../test/http";

beforeEach(() => {
  session.instances = [];
  session.activeInstanceId = null;
  session.activeAgentId = null;
  session.error = "";
  session.undo = null;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("session store · гарды закрытия", () => {
  it("canCloseAgent: один агент — false, два — true", () => {
    const single = makeInstance({ id: "i-1", agents: [makeAgent({ id: "a-1" })] });
    session.instances = [single];
    session.activeInstanceId = "i-1";
    session.activeAgentId = "a-1";
    expect(session.canCloseAgent).toBe(false);

    session.instances = [
      makeInstance({ id: "i-1", agents: [makeAgent({ id: "a-1" }), makeAgent({ id: "a-2" })] }),
    ];
    session.activeAgentId = "a-1";
    expect(session.canCloseAgent).toBe(true);
  });

  it("canCloseInstance: одна сессия — false, две — true", () => {
    session.instances = [makeInstance({ id: "i-1", agents: [makeAgent({ id: "a-1" })] })];
    session.activeInstanceId = "i-1";
    session.activeAgentId = "a-1";
    expect(session.canCloseInstance).toBe(false);

    session.instances = [
      makeInstance({ id: "i-1", agents: [makeAgent({ id: "a-1" })] }),
      makeInstance({ id: "i-2", agents: [makeAgent({ id: "b-1" })] }),
    ];
    expect(session.canCloseInstance).toBe(true);
  });

  it("последний агент не закрывается: DELETE не уходит, текст ошибки выставлен", async () => {
    const stub = stubFetch([]);
    session.instances = [makeInstance({ id: "i-1", agents: [makeAgent({ id: "a-1" })] })];
    session.activeInstanceId = "i-1";
    session.activeAgentId = "a-1";

    await session.closeActiveAgent();

    expect(session.error).toBe(
      "Нельзя закрыть последнего агента в сессии — закройте сессию целиком",
    );
    expect(session.activeAgentId).toBe("a-1"); // агент на месте
    expect(session.undo).toBeNull(); // тоста нет
    expect(stub.calls).toHaveLength(0); // ни одного сетевого вызова
  });

  it("последняя сессия не закрывается: DELETE не уходит, текст ошибки выставлен", async () => {
    const stub = stubFetch([]);
    session.instances = [makeInstance({ id: "i-1", agents: [makeAgent({ id: "a-1" })] })];
    session.activeInstanceId = "i-1";
    session.activeAgentId = "a-1";

    await session.closeActiveInstance();

    expect(session.error).toBe(
      "Нельзя закрыть последнюю сессию — создайте новую, прежде чем закрывать эту",
    );
    expect(session.activeInstanceId).toBe("i-1");
    expect(session.undo).toBeNull();
    expect(stub.calls).toHaveLength(0);
  });
});

describe("session store · закрытие чата (агента)", () => {
  it("closeActiveAgent: DELETE с правильным URL, агент удалён, активен предыдущий сосед, тост с меткой; через 5 с автопогашение", async () => {
    vi.useFakeTimers();
    const snapAgent = makeAgent({ id: "a-2", label: "Чат про шею" });
    const stub = stubFetch([
      {
        url: "/api/instances/i-1/agents/a-2",
        method: "DELETE",
        json: { agent: snapAgent, messages: [makeMessage({ id: "m-1" })] },
      },
    ]);
    const i1 = makeInstance({
      id: "i-1",
      agents: [makeAgent({ id: "a-1" }), snapAgent, makeAgent({ id: "a-3" })],
    });
    session.instances = [i1];
    session.activeInstanceId = "i-1";
    session.activeAgentId = "a-2";

    await session.closeActiveAgent();

    expect(stub.callsTo("/api/instances/i-1/agents/a-2", "DELETE")).toHaveLength(1);
    // $state проксирует присвоенное глубоко: состав читаем через стор, не сырой i1
    const ids = () => session.instances.find((i) => i.id === "i-1")!.agents.map((a) => a.id);
    expect(ids()).toEqual(["a-1", "a-3"]); // a-2 удалён
    expect(session.activeAgentId).toBe("a-1"); // сосед по индексу − 1
    expect(session.undo?.text).toBe("Чат «Чат про шею» закрыт.");

    vi.advanceTimersByTime(4999);
    expect(session.undo).not.toBeNull(); // ещё живёт
    vi.advanceTimersByTime(1);
    expect(session.undo).toBeNull(); // ровно 5 с — погашен
  });

  it("undoClose: POST restore с {agent, messages, index}; агент возвращён на прежний индекс и снова активен", async () => {
    const snapAgent = makeAgent({ id: "a-2", label: "Чат про шею" });
    const snapMessages = [makeMessage({ id: "m-1", role: "user", content: "вопрос" })];
    const stub = stubFetch([
      {
        url: "/api/instances/i-1/agents/a-2",
        method: "DELETE",
        json: { agent: snapAgent, messages: snapMessages },
      },
      {
        url: "/api/instances/i-1/agents/restore",
        method: "POST",
        status: 201,
        json: { agent: snapAgent, messages: snapMessages },
      },
    ]);
    const i1 = makeInstance({
      id: "i-1",
      agents: [makeAgent({ id: "a-1" }), snapAgent, makeAgent({ id: "a-3" })],
    });
    session.instances = [i1];
    session.activeInstanceId = "i-1";
    session.activeAgentId = "a-2";

    await session.closeActiveAgent();
    const ids = () => session.instances.find((i) => i.id === "i-1")!.agents.map((a) => a.id);
    expect(ids()).toEqual(["a-1", "a-3"]);
    expect(session.activeAgentId).toBe("a-1");

    await session.undoClose();

    const post = stub.callsTo("/api/instances/i-1/agents/restore", "POST")[0];
    expect(post.body).toEqual({ agent: snapAgent, messages: snapMessages, index: 1 });
    expect(ids()).toEqual(["a-1", "a-2", "a-3"]); // прежняя позиция
    expect(session.activeInstanceId).toBe("i-1");
    expect(session.activeAgentId).toBe("a-2"); // восстановленный снова активен
    expect(session.undo).toBeNull();
    expect(session.error).toBe("");
  });

  it("ошибка restore → баннер session.error, тост погашен, состав не изменился", async () => {
    const snapAgent = makeAgent({ id: "a-2" });
    const stub = stubFetch([
      {
        url: "/api/instances/i-1/agents/a-2",
        method: "DELETE",
        json: { agent: snapAgent, messages: [] },
      },
      {
        url: "/api/instances/i-1/agents/restore",
        method: "POST",
        status: 409,
        json: { error: "конфликт восстановления" },
      },
    ]);
    const i1 = makeInstance({ id: "i-1", agents: [makeAgent({ id: "a-1" }), snapAgent] });
    session.instances = [i1];
    session.activeInstanceId = "i-1";
    session.activeAgentId = "a-2";

    await session.closeActiveAgent();
    await session.undoClose();

    expect(stub.callsTo("/api/instances/i-1/agents/restore", "POST")).toHaveLength(1);
    expect(session.error).toBe("конфликт восстановления"); // баннер
    expect(session.undo).toBeNull();
    expect(session.instances.find((i) => i.id === "i-1")!.agents.map((a) => a.id)).toEqual([
      "a-1",
    ]); // агент не вернулся
  });
});

describe("session store · закрытие сессии (инстанса)", () => {
  it("closeActiveInstance: DELETE, активен сосед, тост; undoClose → POST /api/instances/restore, восстановлен и выбран (rag_chat предпочтён)", async () => {
    const instB = makeInstance({
      id: "i-b",
      label: "Сессия B",
      createdAt: "2026-10-01T10:00:00.000Z",
      agents: [makeAgent({ id: "b-rag", presetId: "rag_chat" })],
    });
    const instA = makeInstance({
      id: "i-a",
      label: "Сессия A",
      createdAt: "2026-10-02T09:00:00.000Z",
      agents: [makeAgent({ id: "a-care", presetId: "care" }), makeAgent({ id: "a-rag", presetId: "rag_chat" })],
    });
    const threads = { "a-rag": [makeMessage({ id: "t-1" })] };
    const stub = stubFetch([
      { url: "/api/instances/i-a", method: "DELETE", json: { instance: instA, threads } },
      {
        url: "/api/instances/restore",
        method: "POST",
        status: 201,
        json: { instance: instA, threads },
      },
    ]);
    session.instances = [instB, instA];
    session.activeInstanceId = "i-a";
    session.activeAgentId = "a-rag";

    await session.closeActiveInstance();

    expect(stub.callsTo("/api/instances/i-a", "DELETE")).toHaveLength(1);
    expect(session.instances.map((i) => i.id)).toEqual(["i-b"]); // удалена
    expect(session.activeInstanceId).toBe("i-b"); // сосед по индексу − 1
    expect(session.activeAgentId).toBe("b-rag");
    expect(session.undo?.text).toBe("Сессия «Сессия A» закрыта.");

    await session.undoClose();

    const post = stub.callsTo("/api/instances/restore", "POST")[0];
    expect(post.body).toMatchObject({ instance: { id: "i-a" } });
    expect((post.body as { threads: Record<string, unknown[]> }).threads["a-rag"]).toHaveLength(1);

    // возвращена на прежний индекс (после i-b) и выбрана
    expect(session.instances.map((i) => i.id)).toEqual(["i-b", "i-a"]);
    expect(session.activeInstanceId).toBe("i-a");
    expect(session.activeAgentId).toBe("a-rag"); // rag_chat предпочтён перед care
    expect(session.undo).toBeNull();
    expect(session.error).toBe("");
  });
});

describe("session store · закрытие НЕактивного агента по id (обзор «Агенты и сессии»)", () => {
  it("closeAgent(id): DELETE по этому id, активный не меняется, состав обновлён; undo возвращает на прежний индекс и выбирает восстановленного", async () => {
    const snapAgent = makeAgent({ id: "a-2", label: "Чат про поясницу", presetId: "care" });
    const stub = stubFetch([
      {
        url: "/api/instances/i-1/agents/a-2",
        method: "DELETE",
        json: { agent: snapAgent, messages: [] },
      },
      {
        url: "/api/instances/i-1/agents/restore",
        method: "POST",
        status: 201,
        json: { agent: snapAgent, messages: [] },
      },
    ]);
    session.instances = [
      makeInstance({
        id: "i-1",
        agents: [makeAgent({ id: "a-1" }), snapAgent, makeAgent({ id: "a-3" })],
      }),
    ];
    session.activeInstanceId = "i-1";
    session.activeAgentId = "a-1"; // активен ДРУГОЙ агент

    await session.closeAgent("a-2");

    expect(stub.callsTo("/api/instances/i-1/agents/a-2", "DELETE")).toHaveLength(1);
    const ids = () => session.instances.find((i) => i.id === "i-1")!.agents.map((a) => a.id);
    expect(ids()).toEqual(["a-1", "a-3"]); // a-2 удалён
    expect(session.activeAgentId).toBe("a-1"); // активного не тронуло
    expect(session.undo?.text).toBe("Чат «Чат про поясницу» закрыт.");

    await session.undoClose();

    const post = stub.callsTo("/api/instances/i-1/agents/restore", "POST")[0];
    expect(post.body).toMatchObject({ agent: { id: "a-2" }, index: 1 }); // прежний индекс
    expect(ids()).toEqual(["a-1", "a-2", "a-3"]); // вставлен на место
    expect(session.activeInstanceId).toBe("i-1");
    expect(session.activeAgentId).toBe("a-2"); // восстановленный выбран
    expect(session.undo).toBeNull();
    expect(session.error).toBe("");
  });

  it("closeActiveAgent делегирует в closeAgent: закрывается активный id, активен предыдущий сосед (регресс рефакторинга)", async () => {
    const snapAgent = makeAgent({ id: "a-2", label: "RAG-чат" });
    const stub = stubFetch([
      {
        url: "/api/instances/i-1/agents/a-2",
        method: "DELETE",
        json: { agent: snapAgent, messages: [] },
      },
    ]);
    session.instances = [
      makeInstance({ id: "i-1", agents: [makeAgent({ id: "a-1" }), snapAgent] }),
    ];
    session.activeInstanceId = "i-1";
    session.activeAgentId = "a-2";

    await session.closeActiveAgent();

    expect(stub.callsTo("/api/instances/i-1/agents/a-2", "DELETE")).toHaveLength(1);
    expect(session.instances.find((i) => i.id === "i-1")!.agents.map((a) => a.id)).toEqual([
      "a-1",
    ]);
    expect(session.activeAgentId).toBe("a-1"); // сосед
    expect(session.undo?.text).toBe("Чат «RAG-чат» закрыт.");
  });
});
