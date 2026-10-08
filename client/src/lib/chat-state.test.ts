/**
 * UNIT — локальное состояние ходов (C+ CH-5b + хвосты волны): applyTurnResult
 * (пара Q/A, merge memoryDelta, инлайн-сжатие заменяет префикс), композер
 * buildContextTail (включая блоки задача/инварианты/профиль — день 12–14),
 * локальный PATCH памяти задачи, триггер сжатия; export видит все коллекции
 * (threads + threadState + profiles).
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { ChatResponse, InvariantRow } from "@trigger-helper/shared";
import {
  buildExportFile,
  applyImportFile,
  threadsCollection,
} from "./storage/th-local";
import {
  applyTurnResult,
  buildContextTail,
  createTask,
  createThread,
  getThreadState,
  patchChatTask,
  sendTaskCommand,
  setInvariants,
  shouldCompressNow,
  threadStateCollection,
} from "./chat-state";
import {
  profilesCollection,
  getActiveProfile,
  setActiveProfile,
  upsertProfile,
} from "./profile-state";

const usage = {
  model: "deepseek-chat",
  prompt_tokens: 10,
  completion_tokens: 5,
  total_tokens: 15,
  prompt_cache_hit_tokens: 0,
  prompt_cache_miss_tokens: 10,
  estimated_cost_usd: 0.001,
  estimated_cost_rub: 0,
};

const ok = (reply: string, over: Partial<ChatResponse> = {}): ChatResponse => ({
  reply,
  trace: { historyMessages: [] },
  usage,
  ...over,
});

// Чистка через сами коллекции (replaceAll пишет пустой конверт в их
// localStorage-ключи): прямой доступ к глобалу localStorage в тестовом
// воркере нестабилен — коллекции ходят через тот же акцессор, что и прод.
beforeEach(() => {
  threadsCollection.replaceAll([]);
  threadStateCollection.replaceAll([]);
  profilesCollection.replaceAll([]);
});

describe("applyTurnResult — ход → локальное состояние", () => {
  it("пара Q/A пишется в диалог, title из первого ввода", () => {
    createThread("t1", "care", "");
    const { thread } = applyTurnResult(
      "t1",
      "care",
      "болит шея",
      ok("проверь мышцу"),
    );
    expect(thread.title).toBe("болит шея");
    expect(thread.dialogue).toEqual([
      { role: "user", content: "болит шея" },
      { role: "assistant", content: "проверь мышцу" },
    ]);
  });

  it("memoryDelta мержится: факты + память задачи (Q-3)", () => {
    createThread("t2", "rag_chat", "тред");
    const { state } = applyTurnResult(
      "t2",
      "rag_chat",
      "болит под лопаткой, хочу понять причину",
      ok("ищи ромбообразную", {
        memoryDelta: {
          facts: [{ text: "боль под лопаткой", suggestedLayer: "working" }],
          chatTask: { goal: "понять причину боли" },
        },
      }),
    );
    expect(state.memory.facts).toHaveLength(1);
    expect(state.chatTask.goal).toBe("понять причину боли");
    // и хвост это несёт: memory + chatTask в contextTail
    const tail = buildContextTail("t2");
    expect(tail.memory?.facts).toHaveLength(1);
    expect(tail.chatTask?.goal).toBe("понять причину боли");
  });

  it("compress: сводка одна (не стек), диалог = keptTail + пара хода (Q-2)", () => {
    createThread("t3", "care", "тред");
    // 6 сообщений до хода — чтобы было что сжимать
    for (let i = 0; i < 3; i++) {
      applyTurnResult("t3", "care", `вопрос ${i}`, ok(`ответ ${i}`));
    }
    const { thread } = applyTurnResult(
      "t3",
      "care",
      "итоговый вопрос",
      ok("итоговый ответ", {
        compress: {
          summary: "раньше обсуждали шею",
          keptTail: [{ role: "user", content: "вопрос 2" }],
        },
      }),
    );
    expect(thread.summaries).toEqual(["раньше обсуждали шею"]);
    expect(thread.dialogue).toEqual([
      { role: "user", content: "вопрос 2" },
      { role: "user", content: "итоговый вопрос" },
      { role: "assistant", content: "итоговый ответ" },
    ]);
  });

  it("триггер сжатия считает по локальному диалогу", () => {
    createThread("t4", "care", "тред");
    expect(shouldCompressNow("t4", 10)).toBe(false);
    for (let i = 0; i < 7; i++) {
      applyTurnResult("t4", "care", `в${i}`, ok(`о${i}`));
    }
    expect(shouldCompressNow("t4", 10)).toBe(true); // 14 - 4 = 10 ≥ 10
  });
});

describe("patchChatTask — локальная панель day25", () => {
  it("PATCH правит только указанные поля", () => {
    createThread("t5", "rag_chat", "тред");
    applyTurnResult(
      "t5",
      "rag_chat",
      "в",
      ok("о", {
        memoryDelta: { facts: [], chatTask: { goal: "старая цель" } },
      }),
    );
    patchChatTask("t5", { goal: "новая цель" });
    const state = getThreadState("t5");
    expect(state.chatTask.goal).toBe("новая цель");
  });
});

describe("export/import видит все коллекции", () => {
  it("buildExportFile несёт threads, threadState и profiles", () => {
    createThread("t6", "care", "тред");
    applyTurnResult(
      "t6",
      "care",
      "в",
      ok("о", {
        memoryDelta: {
          facts: [{ text: "факт", suggestedLayer: "short" }],
          chatTask: { goal: "цель" },
        },
      }),
    );
    const file = buildExportFile();
    expect(Object.keys(file.collections).sort()).toEqual([
      "profiles",
      "threadState",
      "threads",
    ]);
    expect(file.collections.threadState).toHaveLength(1);
    // round-trip: «чистое устройство» → импорт → состояние на месте
    threadsCollection.replaceAll([]);
    threadStateCollection.replaceAll([]);
    const result = applyImportFile(file);
    expect(result).toMatchObject({
      ok: true,
      imported: { threads: 1, threadState: 1 },
    });
    expect(buildContextTail("t6").memory?.facts).toHaveLength(1);
  });
});

describe("задача-FSM (день 13) — хранение + композер", () => {
  it("createTask → contextTail.task; ход не затирает задачу", () => {
    createThread("t7", "care", "тред");
    createTask("t7", {
      id: "task-1",
      title: "убрать боль в шее",
      plan: ["найти мышцу", "массаж", "проверить"],
    });
    expect(buildContextTail("t7").task?.title).toBe("убрать боль в шее");
    applyTurnResult("t7", "care", "в", ok("о"));
    expect(getThreadState("t7").task?.stage).toBe("planning");
  });

  it("команды: goto по карте, пауза морозит, done требует согласия", () => {
    createThread("t8", "care", "тред");
    createTask("t8", { id: "task-2", title: "т", plan: ["ш1", "ш2"] });
    // planning → execution — разрешено
    const gotoExec = sendTaskCommand("t8", { action: "goto", to: "execution" });
    expect(gotoExec.result?.kind).toBe("ok");
    expect(getThreadState("t8").task?.stage).toBe("execution");
    // шаг вперёд — execution-only
    const step = sendTaskCommand("t8", { action: "next_step" });
    expect(step.result?.kind).toBe("ok");
    expect(getThreadState("t8").task?.step).toBe(2);
    // пауза морозит переходы
    sendTaskCommand("t8", { action: "pause" });
    const frozen = sendTaskCommand("t8", { action: "goto", to: "validation" });
    expect(frozen.result).toMatchObject({ kind: "invalid" });
    sendTaskCommand("t8", { action: "resume" });
    // execution → done запрещён картой (только через validation)
    const badDone = sendTaskCommand("t8", { action: "goto", to: "done", consent: true });
    expect(badDone.result).toMatchObject({ kind: "invalid" });
    // validation → done без согласия — consentRequired
    sendTaskCommand("t8", { action: "goto", to: "validation" });
    const noConsent = sendTaskCommand("t8", { action: "goto", to: "done" });
    expect(noConsent.result).toMatchObject({ kind: "invalid", consentRequired: true });
    const consent = sendTaskCommand("t8", { action: "goto", to: "done", consent: true });
    expect(consent.result?.kind).toBe("ok");
    expect(getThreadState("t8").task?.stage).toBe("done");
  });
});

describe("инварианты (день 14) — в хвост идут только активные", () => {
  it("setInvariants фильтруется по active в композере", () => {
    createThread("t9", "care", "тред");
    const now = new Date().toISOString();
    const rows: InvariantRow[] = [
      { id: "i1", text: "не рекомендуй задержку дыхания", scope: "agent", enforcement: "hard", pattern: "задерж", active: true, createdAt: now, updatedAt: now },
      { id: "i2", text: "отвечай коротко", scope: "agent", enforcement: "soft", active: false, createdAt: now, updatedAt: now },
    ];
    setInvariants("t9", rows);
    const tail = buildContextTail("t9");
    expect(tail.invariants).toHaveLength(1);
    expect(tail.invariants[0]?.id).toBe("i1");
    // ход не затирает редакцию владельца
    applyTurnResult("t9", "care", "в", ok("о"));
    expect(getThreadState("t9").invariants).toHaveLength(2);
  });
});

describe("профиль (день 12) — глобальный активный в композере", () => {
  it("активный профиль едет в contextTail.profile; без него блока нет", () => {
    createThread("t10", "care", "тред");
    expect(buildContextTail("t10").profile).toBeUndefined();
    upsertProfile({
      id: "p1",
      label: "кратко",
      constraints: [],
      updatedAt: new Date().toISOString(),
    });
    setActiveProfile("p1");
    expect(getActiveProfile()?.id).toBe("p1");
    expect(buildContextTail("t10").profile?.label).toBe("кратко");
    setActiveProfile(null);
    expect(buildContextTail("t10").profile).toBeUndefined();
  });
});
