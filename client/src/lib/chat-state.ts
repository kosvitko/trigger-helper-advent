/**
 * C+ (CH-5b, D-3/D-4): локальное состояние ходов — то, что раньше жилой
 * на сервере (тред + память + память задачи), теперь коллекции th-local.
 *
 * threads — диалог+сводки (ChatThreadRecord, CH-2);
 * threadState — per-тред память: факты+tombstones (merge memoryDelta,
 * Q-3), память задачи (day25) и, с закрытием UI-долга волны, задача-FSM
 * (день 13) + инварианты (день 14). Профиль (день 12) — глобальная
 * коллекция profile-state (один активный на пользователя, как был
 * instance-level router).
 */
import {
  applyTaskCommand,
  createTaskState,
  mergeChatTaskDelta,
  mergeFactDelta,
  shouldCompressChatTail,
  type ChatContextTail,
  type ChatResponse,
  type ChatThreadRecord,
  type FactRow,
  type FactTombstone,
  type InvariantRow,
  type TaskCommand,
  type TaskCommandResult,
  type TaskState,
} from "@trigger-helper/shared";
import { z } from "zod";
import {
  ChatTaskStateSchema,
  FactRowSchema,
  FactTombstoneSchema,
  InvariantRowSchema,
  TaskStateSchema,
} from "@trigger-helper/shared";
import { getActiveProfile } from "./profile-state";
import {
  LocalCollection,
  registerLocalCollection,
  threadsCollection,
} from "./storage/th-local";

export const INVARIANTS_MAX = 8;

export const ChatThreadStateRecordSchema = z.object({
  id: z.string().min(1).max(64),
  memory: z.object({
    facts: z.array(FactRowSchema).max(64),
    deleted: z.array(FactTombstoneSchema).max(64),
  }),
  chatTask: ChatTaskStateSchema,
  // C+ хвосты (день 13/14): поля обязательны — старые записи без них
  // дропаются per-record safeParse (решение Кости 07.10: совместимость
  // старых записей не поддерживаем, только новый формат).
  task: TaskStateSchema.nullable(),
  invariants: z.array(InvariantRowSchema).max(INVARIANTS_MAX),
});
export type ChatThreadStateRecord = z.infer<typeof ChatThreadStateRecordSchema>;

/** Память/память-задачи per-тред; ключ = id треда (одна запись на тред). */
export const threadStateCollection = new LocalCollection({
  name: "threadState",
  version: 1,
  schema: ChatThreadStateRecordSchema,
  maxRecords: 50,
});
registerLocalCollection(threadStateCollection); // export/import видит всё

export function getThread(threadId: string): ChatThreadRecord | undefined {
  return threadsCollection.get(threadId);
}

export function listThreads(): ChatThreadRecord[] {
  return threadsCollection.all();
}

export function getThreadState(threadId: string): ChatThreadStateRecord {
  return (
    threadStateCollection.get(threadId) ?? {
      id: threadId,
      memory: { facts: [], deleted: [] },
      chatTask: { goal: "", clarified: [], constraints_terms: [] },
      task: null,
      invariants: [],
    }
  );
}

export function createThread(
  threadId: string,
  preset: ChatThreadRecord["preset"],
  title: string,
): ChatThreadRecord {
  const now = new Date().toISOString();
  const record: ChatThreadRecord = {
    id: threadId,
    preset,
    title: title.trim().slice(0, 80),
    createdAt: now,
    updatedAt: now,
    summaries: [],
    dialogue: [],
  };
  threadsCollection.put(record);
  return record;
}

/**
 * Успешный ход → локальное состояние: пара Q/A в диалог, merge memoryDelta
 * (факты: historySeq = длина диалога ДО хода — как сервер брал runHistory),
 * память задачи, инлайн-сжатие (Q-2: сводка+keptTail заменяют префикс —
 * сводка одна, не стек). trace.contextTrimmed для UI-бейджа — на месте.
 */
export function applyTurnResult(
  threadId: string,
  preset: ChatThreadRecord["preset"],
  input: string,
  response: ChatResponse,
  now: () => string = () => new Date().toISOString(),
): { thread: ChatThreadRecord; state: ChatThreadStateRecord } {
  const thread =
    threadsCollection.get(threadId) ?? createThread(threadId, preset, input);
  const state = getThreadState(threadId);

  // historySeq — длина диалога ДО appending пары хода (семантика серверного
  // runHistory); на compress-ходу — посткомпрессная длина keptTail: сервер
  // классифицировал по перечитанному после сжатия треду (agents.ts re-read) —
  // ревью CH-5b, MINOR-2.
  const historySeq = response.compress
    ? response.compress.keptTail.length
    : thread.dialogue.length;
  const userTurn = { role: "user" as const, content: input };
  const assistantTurn = { role: "assistant" as const, content: response.reply };

  let dialogue = [...thread.dialogue, userTurn, assistantTurn];
  let summaries = [...thread.summaries];
  if (response.compress) {
    // Сжатие схлопнуло префикс (включая прошлые сводки) в одну сводку.
    summaries = [response.compress.summary];
    dialogue = [...response.compress.keptTail, userTurn, assistantTurn];
  }

  let facts: FactRow[] = state.memory.facts;
  let deleted: FactTombstone[] = state.memory.deleted;
  if (response.memoryDelta) {
    const merged = mergeFactDelta(
      facts,
      response.memoryDelta.facts,
      { historySeq, deleted },
      now,
    );
    facts = merged.facts;
    deleted = merged.deleted;
  }
  const chatTask = response.memoryDelta
    ? mergeChatTaskDelta(state.chatTask, response.memoryDelta.chatTask)
    : state.chatTask;

  const nextThread: ChatThreadRecord = {
    ...thread,
    title: thread.title || input.trim().slice(0, 80),
    updatedAt: now(),
    summaries,
    dialogue,
  };
  threadsCollection.put(nextThread);
  // Задача/инварианты — редакция владельца (не мержатся из ответа):
  // проносим как есть из прочитанного state.
  const nextState: ChatThreadStateRecord = {
    ...state,
    memory: { facts, deleted },
    chatTask,
  };
  threadStateCollection.put(nextState);
  return { thread: nextThread, state: nextState };
}

/**
 * Композер contextTail (D-4: стратегии — клиент): первая ступень — весь
 * локальный хвост (сервер тримит по SEC-F4 сам, факт — в trace). Порядок
 * блоков — канонический CONTEXT_TAIL_BLOCK_ORDER (стабильный префикс,
 * 05-MINOR-6): summaries, dialogue, memory, profile, task, invariants,
 * chatTask. Профиль — глобальный активный; задача/инварианты — per-тред
 * (инварианты — только активные ряды).
 */
export function buildContextTail(threadId: string): ChatContextTail {
  const thread = getThread(threadId);
  const state = getThreadState(threadId);
  const profile = getActiveProfile();
  return {
    summaries: thread?.summaries ?? [],
    dialogue: thread?.dialogue ?? [],
    ...(state.memory.facts.length > 0
      ? { memory: { facts: state.memory.facts } }
      : {}),
    ...(profile ? { profile } : {}),
    ...(state.task ? { task: state.task } : {}),
    invariants: state.invariants.filter((row) => row.active),
    ...(state.chatTask.goal || state.chatTask.clarified.length > 0 || state.chatTask.constraints_terms.length > 0
      ? { chatTask: state.chatTask }
      : {}),
  };
}

/** Q-2: триггер инлайн-сжатия — клиентский (shouldAutoCompress день 09). */
export function shouldCompressNow(threadId: string, every: number): boolean {
  const thread = getThread(threadId);
  return shouldCompressChatTail(thread?.dialogue.length ?? 0, every);
}

/** Локальный PATCH памяти задачи (панель day25 → теперь локально). */
export function patchChatTask(
  threadId: string,
  patch: ChatTaskPatch,
): ChatThreadStateRecord {
  const state = getThreadState(threadId);
  const next: ChatThreadStateRecord = {
    ...state,
    chatTask: {
      goal: patch.goal !== undefined ? patch.goal.trim().slice(0, 300) : state.chatTask.goal,
      clarified:
        patch.clarified !== undefined
          ? patch.clarified.map((s) => s.trim()).filter(Boolean).slice(0, 8)
          : state.chatTask.clarified,
      constraints_terms:
        patch.constraints_terms !== undefined
          ? patch.constraints_terms.map((s) => s.trim()).filter(Boolean).slice(0, 8)
          : state.chatTask.constraints_terms,
    },
  };
  threadStateCollection.put(next);
  return next;
}

export type ChatTaskPatch = Partial<{
  goal: string;
  clarified: string[];
  constraints_terms: string[];
}>;

/** Редакция владельца в PATCH задачи (заморожены только stage/step). */
export type TaskPatch = Partial<
  Pick<TaskState, "title" | "expectedAction" | "lastStageNote" | "plan">
>;

/* — Задача-FSM (день 13, операции — shared task-fsm) — */

export function createTask(
  threadId: string,
  input: { id: string; title: string; plan: string[]; expectedAction?: string },
): ChatThreadStateRecord {
  const state = getThreadState(threadId);
  const next = { ...state, task: createTaskState(input) };
  threadStateCollection.put(next);
  return next;
}

/** PATCH при paused разрешён (заморожены только stage/step/переходы). */
export function patchTask(
  threadId: string,
  patch: TaskPatch,
): ChatThreadStateRecord {
  const state = getThreadState(threadId);
  if (!state.task) return state;
  const task = state.task;
  const plan = patch.plan !== undefined ? [...patch.plan] : task.plan;
  const next = {
    ...state,
    task: {
      ...task,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.expectedAction !== undefined ? { expectedAction: patch.expectedAction } : {}),
      ...(patch.lastStageNote !== undefined ? { lastStageNote: patch.lastStageNote } : {}),
      plan,
      // Clamp: после укорачивания плана шаг не указывает за пределы.
      step: Math.min(task.step, plan.length),
      updatedAt: new Date().toISOString(),
    } satisfies TaskState,
  };
  threadStateCollection.put(next);
  return next;
}

export function sendTaskCommand(
  threadId: string,
  command: TaskCommand,
): { state: ChatThreadStateRecord; result: TaskCommandResult | null } {
  const state = getThreadState(threadId);
  if (!state.task) return { state, result: null };
  const result = applyTaskCommand(state.task, command);
  if (result.kind !== "ok") return { state, result };
  const next = { ...state, task: result.task };
  threadStateCollection.put(next);
  return { state: next, result };
}

export function removeTask(threadId: string): ChatThreadStateRecord {
  const state = getThreadState(threadId);
  const next = { ...state, task: null };
  threadStateCollection.put(next);
  return next;
}

/* — Инварианты (день 14: строки — клиент, проверки — сервер per-request) — */

/** Полная замена набора рядов (панель владеет списком; кап 8 — как в схеме). */
export function setInvariants(
  threadId: string,
  rows: InvariantRow[],
): ChatThreadStateRecord {
  const state = getThreadState(threadId);
  const next = { ...state, invariants: [...rows].slice(0, INVARIANTS_MAX) };
  threadStateCollection.put(next);
  return next;
}
