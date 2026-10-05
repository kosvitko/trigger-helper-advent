/**
 * Стор диалога: сообщения активного треда (upsert-by-id, F-2) + «Память задачи».
 * Эфемерный UI-стейт (скролл-якорь, коллапсы) живёт в компонентах.
 */
import { SvelteMap } from "svelte/reactivity";
import type { AgentMessage, AgentRunResponse, ChatTaskState, ChatTaskStatePatch } from "@trigger-helper/shared";
import { api } from "../api";
import { session } from "./session.svelte";
import { settings } from "./settings.svelte";
import { trace } from "./trace.svelte";

/** crypto.randomUUID существует только в secure context (https/localhost);
 *  на http://VPS его нет — синхронный throw убивал send до POST (грабля
 *  прод-смоука 03.10: локально всё зелёное, на проде — тишина).
 *  getRandomValues доступен и в insecure context — фолбэк через него. */
function uid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40; // версия 4
  b[8] = (b[8] & 0x3f) | 0x80; // вариант RFC 4122
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

class DialogStore {
  messages = new SvelteMap<string, AgentMessage>();
  typing = $state(false);
  error = $state("");
  chatTask = $state<ChatTaskState | null>(null);
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
    this.error = "";
    // In-flight run старой сессии не должен лочить композер новой (typing
    // сбрасываем; ответ всё равно будет отброшен по loadEpoch в send).
    this.typing = false;
  }

  /** Загрузка треда + памяти задачи активного агента (GET on load).
   *  Lifecycle: очистка ленты — ДО requireIds, чтобы переключение на сессию
   *  без агента не оставляло чужие сообщения (баг 2); гонки гасит loadEpoch. */
  async loadThread(): Promise<void> {
    const epoch = ++this.loadEpoch;
    this.reset();
    const { instanceId, agentId } = session.requireIds();
    const thread = await api.listMessages(instanceId, agentId);
    if (epoch !== this.loadEpoch) return; // сессия сменилась, пока грузился тред
    for (const m of thread.messages) this.upsert(m);
    // QA 041003 (F1): ходы, которых нет в кэше трейса, добираем скелетами
    // из сообщений треда — свежий браузер видит полную историю ходов.
    trace.mergeThread(thread.messages);
    this.chatTask = await api.getChatTaskState(instanceId, agentId);
    if (epoch !== this.loadEpoch) return;
  }

  /**
   * Один ход: optimistic user → POST run → assistant + трейс + эхо памяти.
   * Возвращает true, если ход прошёл (текст можно убрать из композера).
   * {instanceId, agentId} снимаются в момент клика; сессия сменилась в полёте —
   * ответ отбрасывается по loadEpoch, текст остаётся в композере (баги 3).
   */
  async send(text: string): Promise<boolean> {
    const input = text.trim();
    if (!input || this.typing) return false;
    const epoch = this.loadEpoch;
    this.typing = true;
    this.error = "";
    let userMsg: AgentMessage | null = null;
    try {
      const { instanceId, agentId } = session.requireIds();
      userMsg = {
        id: `local-${uid()}`,
        role: "user",
        content: input,
        createdAt: new Date().toISOString(),
      };
      this.upsert(userMsg);
      trace.beginPending(input);

      // Day25 UX SSE: fetch + getReader — шаги наполняются в реальном времени.
      // sendSse сам обрабатывает JSON-ответ (моки/старый сервер) без fallback.
      const res = await this.sendSse(input, instanceId, agentId);

      trace.cancelPending(); // заменяем SSE-ход реальным (с токенами/₽)
      if (epoch !== this.loadEpoch) return false;
      this.upsert(res.message);
      trace.addTurnFromRun(input, res);
      if (res.context?.chatTaskState) this.chatTask = res.context.chatTaskState;
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

  /** Day25 UX SSE: POST /api/agent/run с Accept: text/event-stream.
   *  Шаги приходят как {type:"step"}, финал — {type:"done", result}. */
  private async sendSse(
    input: string,
    instanceId: string,
    agentId: string,
  ): Promise<AgentRunResponse> {
    const response = await fetch("/api/agent/run", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
      },
      body: JSON.stringify({
        instanceId,
        agentId,
        input,
        overrides: settings.runOverrides(),
      }),
    });
    if (!response.ok) {
      const err = (await response.json().catch(() => ({}))) as { error?: string };
      throw new Error(err.error ?? `HTTP ${response.status}`);
    }

    // Если сервер вернул JSON (не SSE) — это обычный ответ, парсим напрямую.
    // Работает с моками и старым сервером без SSE-поддержки.
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/event-stream")) {
      return (await response.json()) as AgentRunResponse;
    }

    if (!response.body) throw new Error("SSE: нет потока");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let result: AgentRunResponse | null = null;
    let error: string | null = null;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        if (!part.startsWith("data: ")) continue;
        const jsonStr = part.slice(6);
        if (jsonStr === "[DONE]") continue;
        try {
          const data = JSON.parse(jsonStr) as {
            type: string;
            step?: string;
            text?: string;
            result?: AgentRunResponse;
            error?: string;
          };
          if (data.type === "step" && data.step && data.text) {
            trace.updatePendingStep(data.step, data.text);
          } else if (data.type === "done" && data.result) {
            result = data.result;
          } else if (data.type === "error" && data.error) {
            error = data.error;
          }
        } catch {
          /* невалидный JSON в SSE — пропускаем */
        }
      }
    }

    if (error) throw new Error(error);
    if (!result) throw new Error("SSE: поток закрылся без результата");
    return result;
  }

  /** PATCH «Памяти задачи» (blur полей); absent = keep (02b-F-1). */
  async patchChatTask(patch: ChatTaskStatePatch): Promise<void> {
    const { instanceId, agentId } = session.requireIds();
    this.chatTask = await api.patchChatTaskState(instanceId, agentId, patch);
  }
}

export const dialog = new DialogStore();
