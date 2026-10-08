/**
 * UNIT — закрытие чата + «Вернуть» (session.svelte.ts, C+ локально):
 * гард «последний тред», удаление из threadsCollection, переключение на
 * соседа, тост с автопогашением 5 с (UNDO_MS), undo возвращает запись
 * и активность. Сети нет — семантики старых DELETE/restore, но локально.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { session } from "./session.svelte";
import { createThread, getThread, threadStateCollection } from "../chat-state";
import { threadsCollection } from "../storage/th-local";
import { stubFetch } from "../../test/http";

beforeEach(() => {
  threadsCollection.replaceAll([]);
  threadStateCollection.replaceAll([]);
  localStorage.removeItem("th.active.v1");
  session.threads = [];
  session.activeThreadId = null;
  session.error = "";
  session.undo = null;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("session store · гарды закрытия", () => {
  it("canCloseThread: один тред — false, два — true", () => {
    createThread("t1", "rag_chat", "");
    session.reloadThreads();
    session.selectThread("t1");
    expect(session.canCloseThread).toBe(false);

    createThread("t2", "rag_chat", "");
    session.reloadThreads();
    expect(session.canCloseThread).toBe(true);
  });

  it("последний тред не закрывается: ошибка выставлена, записи целы, тоста нет", async () => {
    const stub = stubFetch([]);
    createThread("t1", "rag_chat", "только чат");
    session.reloadThreads();
    session.selectThread("t1");

    await session.closeThread();

    expect(session.error).toBe(
      "Нельзя закрыть последний чат — создайте новый, прежде чем закрывать этот",
    );
    expect(session.activeThreadId).toBe("t1"); // тред на месте
    expect(getThread("t1")).toBeDefined(); // и в коллекции
    expect(session.undo).toBeNull(); // тоста нет
    expect(stub.calls).toHaveLength(0); // ни одного вызова
  });
});

describe("session store · закрытие чата (локально)", () => {
  it("closeThread: запись удалена, активен сосед, тост с названием; автопогашение ровно 5 с", async () => {
    vi.useFakeTimers();
    createThread("t1", "rag_chat", "Про шею");
    createThread("t2", "rag_chat", "Про спину");
    createThread("t3", "rag_chat", "Про плечо");
    session.reloadThreads();
    session.selectThread("t2");

    await session.closeThread();

    expect(session.threads.map((t) => t.id)).toEqual(["t1", "t3"]); // t2 удалён
    expect(getThread("t2")).toBeUndefined(); // и из коллекции
    expect(session.activeThreadId).toBe("t1"); // сосед по индексу − 1
    expect(session.undo?.text).toBe("Чат «Про спину» закрыт.");

    vi.advanceTimersByTime(4999);
    expect(session.undo).not.toBeNull(); // ещё живёт
    vi.advanceTimersByTime(1);
    expect(session.undo).toBeNull(); // ровно 5 с — погашен
  });

  it("undoClose: запись возвращена в коллекцию и снова активна", async () => {
    createThread("t1", "rag_chat", "Про шею");
    createThread("t2", "rag_chat", "Про спину");
    session.reloadThreads();
    session.selectThread("t2");

    await session.closeThread();
    expect(getThread("t2")).toBeUndefined();

    await session.undoClose();

    expect(getThread("t2")).toBeDefined(); // снапшот записи вернулся
    expect(session.threads.map((t) => t.id)).toContain("t2");
    expect(session.activeThreadId).toBe("t2"); // восстановленный снова активен
    expect(localStorage.getItem("th.active.v1")).toBe("t2");
    expect(session.undo).toBeNull();
    expect(session.error).toBe("");
  });

  it("тайтл пуст → в тосте метка пресета (RAG-чат)", async () => {
    createThread("t1", "rag_chat", "");
    createThread("t2", "rag_chat", "");
    session.reloadThreads();
    session.selectThread("t2");
    await session.closeThread();
    expect(session.undo?.text).toBe("Чат «RAG-чат» закрыт.");
  });

  it("закрытие НЕактивного по id: активный не меняется; undo выбирает закрытый", async () => {
    createThread("t1", "rag_chat", "первый");
    createThread("t2", "rag_chat", "второй");
    createThread("t3", "rag_chat", "третий");
    session.reloadThreads();
    session.selectThread("t1"); // активен ДРУГОЙ тред

    await session.closeThread("t2");

    expect(session.threads.map((t) => t.id)).toEqual(["t1", "t3"]); // t2 удалён
    expect(session.activeThreadId).toBe("t1"); // активного не тронуло
    expect(session.undo?.text).toBe("Чат «второй» закрыт.");

    await session.undoClose();

    expect(session.threads.map((t) => t.id)).toContain("t2");
    expect(session.activeThreadId).toBe("t2"); // восстановленный выбран
    expect(session.undo).toBeNull();
    expect(session.error).toBe("");
  });
});
