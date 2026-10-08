/**
 * Стор сессий → C+ CH-5b: локальные треды (chat-state, localStorage) + активный
 * тред. Инстанты/агенты сервера умерли вместе с STATEFUL API: один уровень —
 * треды; «+RAG-чат» создаёт локальный rag_chat-тред. Активный тред
 * персистится в localStorage th.active.v1 (boot возвращается к нему).
 */
import { getChatPreset, type ChatThreadRecord } from "@trigger-helper/shared";
import {
  createThread,
  listThreads,
  threadStateCollection,
} from "../chat-state";
import { threadsCollection } from "../storage/th-local";
import { uid } from "../uid";

/** Тост «закрыто · Вернуть»: живёт 5 с (как старый UI, UNDO_MS=5000). */
const UNDO_MS = 5000;

/** Последний использованный тред (boot возвращается к нему). */
const ACTIVE_KEY = "th.active.v1";

function readActiveId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_KEY);
  } catch {
    return null;
  }
}

function persistActiveId(id: string | null): void {
  try {
    if (id === null) localStorage.removeItem(ACTIVE_KEY);
    else localStorage.setItem(ACTIVE_KEY, id);
  } catch {
    /* приватный режим — актив живёт до перезагрузки */
  }
}

interface UndoState {
  text: string;
  restore: () => void;
}

function threadTitle(t: ChatThreadRecord): string {
  return t.title || getChatPreset(t.preset)?.label || t.preset;
}

class SessionStore {
  threads = $state<ChatThreadRecord[]>([]);
  activeThreadId = $state<string | null>(null);
  error = $state("");
  /** Закрытие с возможностью «Вернуть» (паритет со старым UI: тост 5 с). */
  undo = $state<UndoState | null>(null);
  private undoTimer: ReturnType<typeof setTimeout> | null = null;

  get activeThread(): ChatThreadRecord | null {
    return this.threads.find((t) => t.id === this.activeThreadId) ?? null;
  }

  /** Свежий список из коллекции (boot/создание/закрытие/импорт); активный
   *  исчез (импорт «последний выигрывает») — переключаем на новейший. */
  reloadThreads(): void {
    this.threads = [...listThreads()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    if (this.activeThreadId !== null && !this.threads.some((t) => t.id === this.activeThreadId)) {
      this.setActive(this.threads[0]?.id ?? null);
    }
  }

  private setActive(id: string | null): void {
    this.activeThreadId = id;
    persistActiveId(id);
  }

  /** Boot: последний использованный тред → новейший → первый rag_chat. */
  ensureActive(): void {
    this.reloadThreads();
    if (this.activeThreadId !== null) return;
    const lastUsed = readActiveId();
    if (lastUsed !== null && this.threads.some((t) => t.id === lastUsed)) {
      this.setActive(lastUsed);
      return;
    }
    if (this.threads.length > 0) {
      this.setActive(this.threads[0].id); // список уже по updatedAt desc
      return;
    }
    this.createRagChat();
  }

  /** «Создать RAG-чат одним кликом» (шапка, D-2) — локальный тред. */
  createRagChat(): void {
    const thread = createThread(uid(), "rag_chat", "");
    this.reloadThreads();
    this.setActive(thread.id);
  }

  /** Выбор чата из шапки. */
  selectThread(id: string): void {
    if (!this.threads.some((t) => t.id === id)) return;
    this.setActive(id);
  }

  /** Идентификаторы для хода /api/chat; бросает, если активного треда нет. */
  requireActiveThread(): { threadId: string; preset: ChatThreadRecord["preset"] } {
    const t = this.activeThread;
    if (!t) throw new Error("Нет активного чата — создайте RAG-чат в шапке");
    return { threadId: t.id, preset: t.preset };
  }

  /* — Закрытие чата (локально, паритет UX со старым UI) — */

  get canCloseThread(): boolean {
    return this.threads.length > 1;
  }

    /** Тост + окно возврата; onExpire — колбэк по истечении окна без возврата. */
    private showUndo(text: string, restore: () => void, onExpire?: () => void): void {
      if (this.undoTimer !== null) clearTimeout(this.undoTimer);
      this.undo = { text, restore };
      this.undoTimer = setTimeout(() => {
        this.undo = null;
        this.undoTimer = null;
        onExpire?.();
      }, UNDO_MS);
    }

  /** Закрыть тред (по умолчанию активный); последний не закрываем. */
  async closeThread(threadId?: string): Promise<void> {
    const id = threadId ?? this.activeThreadId;
    if (!id) return;
    const thread = this.threads.find((t) => t.id === id);
    if (!thread) return;
    if (this.threads.length <= 1) {
      this.error = "Нельзя закрыть последний чат — создайте новый, прежде чем закрывать этот";
      return;
    }
    const index = this.threads.findIndex((t) => t.id === id);
    threadsCollection.delete(id);
    this.reloadThreads();
    if (this.activeThreadId === id || this.activeThreadId === null) {
      // Сосед, как в старом UI: предыдущий по списку, иначе первый.
      const next = this.threads[Math.max(0, index - 1)] ?? this.threads[0];
      this.setActive(next?.id ?? null);
    }
    this.showUndo(
      `Чат «${threadTitle(thread)}» закрыт.`,
      () => {
        // «Вернуть»: снапшот записи обратно в коллекцию + снова активен.
        threadsCollection.put(thread);
        this.reloadThreads();
        this.setActive(thread.id);
      },
      // Окно undo истекло без возврата — память треда больше не нужна:
      // без этого осиротевшая запись ездила бы в каждом export до выселения
      // по капу (ревью CH-5b, MINOR-5).
      () => threadStateCollection.delete(id),
    );
  }

  /** «Вернуть» из тоста. */
  async undoClose(): Promise<void> {
    const u = this.undo;
    if (!u) return;
    if (this.undoTimer !== null) {
      clearTimeout(this.undoTimer);
      this.undoTimer = null;
    }
    this.undo = null;
    try {
      u.restore();
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    }
  }
}

export const session = new SessionStore();
