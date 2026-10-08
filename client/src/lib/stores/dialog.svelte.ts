/**
 * Стор диалога: сообщения активного треда (upsert-by-id, F-2) + «Память задачи».
 * C+ CH-5b: ход — stateless POST /api/chat (api-chat.sendChat); персист —
 * локальный (chat-state: треды/память на устройстве). Серверные
 * listMessages/getChatTaskState/patchChatTaskState умерли вместе с STATEFUL API.
 * Эфемерный UI-стейт (скролл-якорь, коллапсы) живёт в компонентах.
 */
import { SvelteMap } from "svelte/reactivity";
import {
  CHAT_COMPRESS_EVERY_DEFAULT,
  type AgentMessage,
  type ChatTaskState,
  type ChatTaskStatePatch,
  type ChatThreadRecord,
  type InvariantRow,
  type TaskCommand,
  type TaskCommandResult,
  type TaskState,
} from "@trigger-helper/shared";
import { sendChat } from "../api-chat";
import {
  applyTurnResult,
  buildContextTail,
  createTask as createLocalTask,
  getThread,
  getThreadState,
  patchChatTask as patchLocalChatTask,
  patchTask as patchLocalTask,
  removeTask as removeLocalTask,
  sendTaskCommand as sendLocalTaskCommand,
  setInvariants as setLocalInvariants,
  shouldCompressNow,
} from "../chat-state";
import { uid } from "../uid";
import { session } from "./session.svelte";
import { settings } from "./settings.svelte";
import { trace } from "./trace.svelte";

/** Локальный тред → лента сообщений: id = `<threadId>:<index>` (серверного
 *  message.id в stateless-ходе нет); createdAt — updatedAt треда. */
function threadMessages(threadId: string, thread: ChatThreadRecord): AgentMessage[] {
  return thread.dialogue.map((m, i) => ({
    id: `${threadId}:${i}`,
    role: m.role,
    content: m.content,
    createdAt: thread.updatedAt,
  }));
}

class DialogStore {
  messages = new SvelteMap<string, AgentMessage>();
  typing = $state(false);
  error = $state("");
  chatTask = $state<ChatTaskState | null>(null);
  /** Задача-FSM активного треда (день 13; хранение — локальное, D-4). */
  task = $state<TaskState | null>(null);
  /** Инварианты активного треда (день 14: строки — клиент). */
  invariants = $state<InvariantRow[]>([]);
  /** Монотонный токен lifecycle: ответ старой сессии не попадает в ленту новой
   *  (гонка быстрых переключений / in-flight send — баг 2). */
  private loadEpoch = 0;

  /** Лента в хронологическом порядке. */
  get ordered(): AgentMessage[] {
    return [...this.messages.values()];
  }

  /** Merge = патч полей на месте / append; коллекцию не пересоздаём (F-2). */
  upsert(msg: AgentMessage): void {
    const existing = this.messages.get(msg.id);
    if (existing) Object.assign(existing, msg);
    else this.messages.set(msg.id, { ...msg });
  }

  reset(): void {
    this.messages.clear();
    this.chatTask = null;
    this.task = null;
    this.invariants = [];
    this.error = "";
    // In-flight run старой сессии не должен лочить композер новой (typing
    // сбрасываем; ответ всё равно будет отброшен по loadEpoch в send).
    this.typing = false;
  }

  /** Загрузка активного треда (лока только что стал локальным — мгновенно).
   *  Lifecycle: очистка ленты — ДО requireActiveThread, чтобы переключение
   *  без активного треда не оставляло чужие сообщения (баг 2). */
  async loadThread(): Promise<void> {
    const epoch = ++this.loadEpoch;
    this.reset();
    const { threadId } = session.requireActiveThread();
    const thread = getThread(threadId);
    if (!thread || epoch !== this.loadEpoch) return;
    const messages = threadMessages(threadId, thread);
    for (const m of messages) this.upsert(m);
    // QA 041003 (F1): ходы, которых нет в кэше трейса, добираем скелетами
    // из сообщений треда — свежий браузер видит полную историю ходов.
    trace.mergeThread(messages);
    const st = getThreadState(threadId);
    this.chatTask = st.chatTask;
    this.task = st.task;
    this.invariants = st.invariants;
  }

  /**
   * Один ход: optimistic user → POST /api/chat → applyTurnResult (локальный
   * персист) + assistant-бабл + трейс. Возвращает true, если ход прошёл
   * (текст можно убрать из композера). {threadId, preset} снимаются в момент
   * клика; тред сменился в полёте — ответ отбрасывается по loadEpoch.
   */
  async send(text: string): Promise<boolean> {
    const input = text.trim();
    if (!input || this.typing) return false;
    const epoch = this.loadEpoch;
    this.typing = true;
    this.error = "";
    let userMsg: AgentMessage | null = null;
    try {
      const { threadId, preset } = session.requireActiveThread();
      userMsg = {
        id: `local-${uid()}`,
        role: "user",
        content: input,
        createdAt: new Date().toISOString(),
      };
      this.upsert(userMsg);
      trace.beginPending(input);

      const startedAt = performance.now();
      // SSE-шаги наполняют pending-ход трейса в реальном времени (Day25 UX);
      // ошибки (до/после hijack) — ChatApiError {code, httpStatus, message}.
      const res = await sendChat(
        {
          input,
          preset,
          contextTail: buildContextTail(threadId),
          overrides: settings.chatOverrides(),
          compress: shouldCompressNow(
            threadId,
            settings.overrides.compressEvery ?? CHAT_COMPRESS_EVERY_DEFAULT,
          ),
          clientTurnId: uid(),
        },
        { onStep: (step, text) => trace.updatePendingStep(step, text) },
      );

      trace.cancelPending(); // заменяем SSE-ход реальным (с токенами/₽)
      if (epoch !== this.loadEpoch) return false;
      const { thread } = applyTurnResult(threadId, preset, input, res);
      const turnId = `${threadId}:${thread.dialogue.length - 1}`;
      if (res.compress) {
        // Сжатие схлопнуло префикс треда: индексные id ленты разошлись бы с
        // тредом (коллизия перезаписала бы старый пузырь — ревью CH-5b,
        // MAJOR). Честный ребилд ленты из персистентного треда.
        await this.loadThread();
      } else {
        this.upsert({ id: turnId, role: "assistant", content: res.reply, createdAt: thread.updatedAt });
      }
      trace.addTurnFromChat(input, res, turnId, performance.now() - startedAt);
      const st = getThreadState(threadId);
      this.chatTask = st.chatTask;
      this.task = st.task;
      this.invariants = st.invariants;
      return true;
    } catch (e) {
      if (epoch === this.loadEpoch) {
        trace.cancelPending();
        if (userMsg) this.messages.delete(userMsg.id);
        this.error = e instanceof Error ? e.message : String(e);
      }
      return false;
    } finally {
      if (epoch === this.loadEpoch) this.typing = false;
    }
  }

  /** Локальный PATCH «Памяти задачи» (blur полей; C+: персист на устройстве). */
  async patchChatTask(patch: ChatTaskStatePatch): Promise<void> {
    const { threadId } = session.requireActiveThread();
    this.chatTask = patchLocalChatTask(threadId, patch).chatTask;
  }

  /** Задача-FSM: создание/патч/команда/снятие — локально (день 13, D-4). */
  createTask(input: { id: string; title: string; plan: string[]; expectedAction?: string }): void {
    const { threadId } = session.requireActiveThread();
    this.task = createLocalTask(threadId, input).task;
  }

  patchTask(patch: import("../chat-state").TaskPatch): void {
    const { threadId } = session.requireActiveThread();
    this.task = patchLocalTask(threadId, patch).task;
  }

  taskCommand(command: TaskCommand): TaskCommandResult | null {
    const { threadId } = session.requireActiveThread();
    const { state, result } = sendLocalTaskCommand(threadId, command);
    this.task = state.task;
    return result;
  }

  removeTask(): void {
    const { threadId } = session.requireActiveThread();
    this.task = removeLocalTask(threadId).task;
  }

  /** Инварианты: полная замена набора (панель владеет списком). */
  setInvariants(rows: InvariantRow[]): void {
    const { threadId } = session.requireActiveThread();
    this.invariants = setLocalInvariants(threadId, rows).invariants;
  }
}

export const dialog = new DialogStore();
