/**
 * UNIT 1 — session store (session.svelte.ts, C+ CH-5b): треды локальные,
 * boot-дефолты (последний использованный th.active.v1 → новейший → первый
 * rag_chat), create-флоу без сети, переключение, requireActiveThread,
 * reloadThreads при исчезновении активного (импорт).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { session } from "./session.svelte";
import { createThread, getThread, threadStateCollection } from "../chat-state";
import { threadsCollection } from "../storage/th-local";
import { stubFetch } from "../../test/http";

const ACTIVE_KEY = "th.active.v1";

beforeEach(() => {
  threadsCollection.replaceAll([]);
  threadStateCollection.replaceAll([]);
  localStorage.removeItem(ACTIVE_KEY);
  session.threads = [];
  session.activeThreadId = null;
  session.error = "";
  session.undo = null;
});

describe("session store · boot (полностью локальный)", () => {
  it("пусто → создаётся первый rag_chat-тред, активен и персистится (th.active.v1)", () => {
    const stub = stubFetch([]); // любой fetch бросил бы «нет маршрута»
    expect(() => session.ensureActive()).not.toThrow();
    expect(session.threads).toHaveLength(1);
    expect(session.threads[0].preset).toBe("rag_chat");
    expect(session.activeThreadId).toBe(session.threads[0].id);
    expect(localStorage.getItem(ACTIVE_KEY)).toBe(session.threads[0].id);
    expect(stub.calls).toHaveLength(0); // boot не ходит в сеть
  });

  it("последний использованный тред (th.active.v1) выбирается на boot", () => {
    createThread("th-1", "rag_chat", "тред 1");
    createThread("th-2", "care", "тред 2");
    localStorage.setItem(ACTIVE_KEY, "th-2");
    session.ensureActive();
    expect(session.activeThreadId).toBe("th-2");
  });

  it("сохранённый id не существует → новейший тред (updatedAt desc)", () => {
    const old = createThread("th-old", "rag_chat", "");
    threadsCollection.put({ ...old, updatedAt: "2026-10-01T10:00:00.000Z" });
    const fresh = createThread("th-new", "care", "");
    threadsCollection.put({ ...fresh, updatedAt: "2026-10-05T10:00:00.000Z" });
    localStorage.setItem(ACTIVE_KEY, "ghost");
    session.ensureActive();
    expect(session.activeThreadId).toBe("th-new");
  });
});

describe("session store · создание RAG-чата", () => {
  it("createRagChat: локальный тред rag_chat становится активным (без сети)", () => {
    const stub = stubFetch([]);
    createThread("th-1", "care", "старый");
    session.reloadThreads();
    session.selectThread("th-1");
    session.createRagChat();
    expect(session.threads.map((t) => t.id)).toContain("th-1");
    expect(session.threads).toHaveLength(2);
    const created = session.threads.find((t) => t.id === session.activeThreadId)!;
    expect(created.preset).toBe("rag_chat");
    expect(created.title).toBe("");
    expect(getThread(created.id)?.preset).toBe("rag_chat"); // записан в коллекцию
    expect(localStorage.getItem(ACTIVE_KEY)).toBe(created.id);
    expect(stub.calls).toHaveLength(0);
  });
});

describe("session store · переключение", () => {
  it("selectThread активирует и персистит; неизвестный id — no-op", () => {
    createThread("th-1", "rag_chat", "");
    createThread("th-2", "rag_chat", "");
    session.reloadThreads();
    session.selectThread("th-2");
    expect(session.activeThreadId).toBe("th-2");
    expect(localStorage.getItem(ACTIVE_KEY)).toBe("th-2");
    session.selectThread("ghost");
    expect(session.activeThreadId).toBe("th-2"); // не изменился
  });

  it("requireActiveThread отдаёт {threadId, preset} активного треда", () => {
    createThread("th-care", "care", "");
    session.reloadThreads();
    session.selectThread("th-care");
    expect(session.requireActiveThread()).toEqual({ threadId: "th-care", preset: "care" });
  });

  it("requireActiveThread бросает понятную ошибку без активного треда", () => {
    expect(() => session.requireActiveThread()).toThrow(/Нет активного чата/);
  });
});

describe("session store · reloadThreads (импорт «последний выигрывает»)", () => {
  it("активный исчез из коллекции → переключение на новейший", () => {
    const a = createThread("th-a", "rag_chat", "");
    threadsCollection.put({ ...a, updatedAt: "2026-10-01T10:00:00.000Z" });
    const b = createThread("th-b", "rag_chat", "");
    threadsCollection.put({ ...b, updatedAt: "2026-10-05T10:00:00.000Z" });
    session.reloadThreads();
    session.selectThread("th-a");
    threadsCollection.delete("th-a");
    session.reloadThreads();
    expect(session.threads.map((t) => t.id)).toEqual(["th-b"]);
    expect(session.activeThreadId).toBe("th-b");
    expect(localStorage.getItem(ACTIVE_KEY)).toBe("th-b");
  });
});
