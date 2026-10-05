/**
 * Стор сессий: инстанты/агенты + активный агент.
 * Демо-дефолт — последний rag_chat-агент (D-2); композер управляет активным
 * агентом (run требует {instanceId, agentId}).
 */
import type { AgentInstance, Instance } from "@trigger-helper/shared";
import { api } from "../api";

/** Тост «закрыто · Вернуть»: живёт 5 с (как старый UI, UNDO_MS=5000). */
const UNDO_MS = 5000;

interface UndoState {
  text: string;
  restore: () => Promise<void>;
}

class SessionStore {
  instances = $state<Instance[]>([]);
  activeInstanceId = $state<string | null>(null);
  activeAgentId = $state<string | null>(null);
  error = $state("");
  /** Закрытие с возможностью «Вернуть» (Костя 04.10: «куда-то делось закрытие
   *  чата и инстанса» — паритет со старым UI: DELETE + снапшот + undo-тост). */
  undo = $state<UndoState | null>(null);
  private undoTimer: ReturnType<typeof setTimeout> | null = null;

  get activeInstance(): Instance | null {
    return this.instances.find((i) => i.id === this.activeInstanceId) ?? null;
  }

  get activeAgent(): AgentInstance | null {
    return this.activeInstance?.agents.find((a) => a.id === this.activeAgentId) ?? null;
  }

  get ragAgents(): AgentInstance[] {
    return this.activeInstance?.agents.filter((a) => a.presetId === "rag_chat") ?? [];
  }

  /** Один ретрай: transient-сбой сети не должен оставлять «Сессий нет» (баг 1). */
  async load(): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        this.instances = (await api.listInstances()).instances;
        return;
      } catch (e) {
        lastError = e;
        if (attempt === 0) await new Promise((r) => setTimeout(r, 400));
      }
    }
    throw lastError;
  }

  /** Демо-дефолт: последний rag_chat-агент (по createdAt, не по порядку массива);
   *  нет ни одного — любой агент новейшего инстанса; совсем пусто — создать. */
  async ensureActive(): Promise<void> {
    await this.load();
    const byNewest = [...this.instances].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
    for (const inst of byNewest) {
      const rag = [...inst.agents].reverse().find((a) => a.presetId === "rag_chat");
      if (rag) {
        this.activeInstanceId = inst.id;
        this.activeAgentId = rag.id;
        return;
      }
    }
    // Фолбэк: лимит инстансов (429) не должен оставлять UI без активной сессии.
    const withAgents = byNewest.find((i) => i.agents.length > 0);
    if (withAgents) {
      this.selectInstance(withAgents.id);
      return;
    }
    await this.createRagChat();
  }

  /** «Создать RAG-чат одним кликом» (шапка, D-2). */
  async createRagChat(): Promise<void> {
    const { instance } = await api.createInstance({
      label: `Демо · ${new Date().toLocaleString("ru-RU")}`,
      seedPresetIds: ["rag_chat"],
    });
    // upsert-by-id: коллекцию не пересоздаём без нужды, но append нового инстанта
    this.instances = [...this.instances, instance];
    this.activeInstanceId = instance.id;
    this.activeAgentId = instance.agents.find((a) => a.presetId === "rag_chat")?.id ?? null;
  }

  /** Компактный переключатель сессий в шапке. */
  selectInstance(id: string): void {
    const inst = this.instances.find((i) => i.id === id);
    if (!inst) return;
    this.activeInstanceId = inst.id;
    this.activeAgentId =
      [...inst.agents].reverse().find((a) => a.presetId === "rag_chat")?.id ??
      inst.agents.at(-1)?.id ??
      null;
  }

  /** Выбор чата из шапки (решение Кости 04.10: сессии → чаты одним селектором):
   *  пара инстанс+агент активируется одним значением вида "<inst>:<agent>". */
  selectChat(instanceId: string, agentId: string): void {
    const inst = this.instances.find((i) => i.id === instanceId);
    if (!inst || !inst.agents.some((a) => a.id === agentId)) return;
    this.activeInstanceId = instanceId;
    this.activeAgentId = agentId;
  }

  /** Значение селектора шапки (инстанс:агент). */
  get activeChatValue(): string {
    return this.activeInstanceId && this.activeAgentId
      ? `${this.activeInstanceId}:${this.activeAgentId}`
      : "";
  }

  /** Идентификаторы для run/чата; бросает, если активной сессии нет. */
  requireIds(): { instanceId: string; agentId: string } {
    if (!this.activeInstanceId || !this.activeAgentId) {
      throw new Error("Нет активной сессии — создайте RAG-чат в шапке");
    }
    return { instanceId: this.activeInstanceId, agentId: this.activeAgentId };
  }

  /* — Закрытие чата/сессии (паритет со старым UI) — */

  get canCloseAgent(): boolean {
    return (this.activeInstance?.agents.length ?? 0) > 1;
  }

  get canCloseInstance(): boolean {
    return this.instances.length > 1;
  }

  private showUndo(text: string, restore: () => Promise<void>): void {
    if (this.undoTimer !== null) clearTimeout(this.undoTimer);
    this.undo = { text, restore };
    this.undoTimer = setTimeout(() => {
      this.undo = null;
      this.undoTimer = null;
    }, UNDO_MS);
  }

  /** Закрыть активный чат (агента); последнего агента не закрываем. */
  async closeActiveAgent(): Promise<void> {
    await this.closeAgent(this.activeAgentId ?? undefined);
  }

  /** Закрыть чат по id (обзор сессии в настройках); последнего агента не закрываем. */
  async closeAgent(agentId?: string): Promise<void> {
    const inst = this.activeInstance;
    if (!inst) return;
    const id = agentId ?? this.activeAgentId;
    if (!id) return;
    const agent = inst.agents.find((a) => a.id === id);
    if (!agent) return;
    if (inst.agents.length <= 1) {
      this.error = "Нельзя закрыть последнего агента в сессии — закройте сессию целиком";
      return;
    }
    const index = inst.agents.findIndex((a) => a.id === id);
    const wasActive = this.activeAgentId === id;
    const snap = await api.closeAgent(inst.id, id);
    inst.agents = inst.agents.filter((a) => a.id !== id);
    if (wasActive) {
      // Переключение на соседа — как в старом UI (предыдущий, иначе первый);
      // смена activeAgentId подхватится lifecycle-эффектом Shell (лента/трейс).
      const next = inst.agents[Math.max(0, index - 1)] ?? inst.agents[0];
      this.activeAgentId = next?.id ?? null;
    }
    this.showUndo(`Чат «${snap.agent.label}» закрыт.`, async () => {
      const r = await api.restoreAgent(inst.id, {
        agent: snap.agent,
        messages: snap.messages,
        index,
      });
      const target = this.instances.find((i) => i.id === inst.id);
      if (target) {
        const at = Math.min(index, target.agents.length);
        target.agents = [...target.agents.slice(0, at), r.agent, ...target.agents.slice(at)];
      }
      this.activeInstanceId = inst.id;
      this.activeAgentId = r.agent.id;
    });
  }

  /** Закрыть активную сессию (инстанс) целиком; последнюю не закрываем. */
  async closeActiveInstance(): Promise<void> {
    const inst = this.activeInstance;
    if (!inst) return;
    if (this.instances.length <= 1) {
      this.error = "Нельзя закрыть последнюю сессию — создайте новую, прежде чем закрывать эту";
      return;
    }
    const index = this.instances.findIndex((i) => i.id === inst.id);
    const snap = await api.closeInstance(inst.id);
    this.instances = this.instances.filter((i) => i.id !== inst.id);
    const next = this.instances[Math.max(0, index - 1)] ?? this.instances[0];
    if (next) this.selectInstance(next.id);
    this.showUndo(`Сессия «${snap.instance.label}» закрыта.`, async () => {
      const r = await api.restoreInstance({
        instance: snap.instance,
        threads: snap.threads,
      });
      const at = Math.min(index, this.instances.length);
      this.instances = [...this.instances.slice(0, at), r.instance, ...this.instances.slice(at)];
      this.selectInstance(r.instance.id);
    });
  }

  /** «Вернуть» из тоста; ошибку восстановления показываем баннером. */
  async undoClose(): Promise<void> {
    const u = this.undo;
    if (!u) return;
    if (this.undoTimer !== null) {
      clearTimeout(this.undoTimer);
      this.undoTimer = null;
    }
    this.undo = null;
    try {
      await u.restore();
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    }
  }
}

export const session = new SessionStore();
