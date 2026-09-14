import type { AgentMessage } from "@trigger-helper/shared";
import { randomUUID } from "node:crypto";

function key(instanceId: string, agentId: string): string {
  return `${instanceId}|${agentId}`;
}

/** Max messages per thread kept in the day07 state file. */
const PERSISTED_TAIL = 100;

export type ThreadStoreOptions = {
  /** Persist hook: called after every mutation (day07). */
  onChange?: () => void;
  /** Max messages per thread kept in the state file. */
  persistTail?: number;
};

export class ThreadStore {
  private readonly threads = new Map<string, AgentMessage[]>();
  private readonly onChange: (() => void) | undefined;
  private readonly persistTail: number;

  constructor(opts: ThreadStoreOptions = {}) {
    this.onChange = opts.onChange;
    this.persistTail = opts.persistTail ?? PERSISTED_TAIL;
  }

  list(instanceId: string, agentId: string): AgentMessage[] {
    return [...(this.threads.get(key(instanceId, agentId)) ?? [])];
  }

  append(instanceId: string, agentId: string, message: AgentMessage): void {
    const k = key(instanceId, agentId);
    const list = this.threads.get(k) ?? [];
    list.push(message);
    this.threads.set(k, list);
    this.onChange?.();
  }

  clearAgent(instanceId: string, agentId: string): void {
    this.threads.delete(key(instanceId, agentId));
    this.onChange?.();
  }

  /** Day10: purge base + `#a` / `#b` thread keys (M-2). */
  clearAgentTree(instanceId: string, agentId: string): void {
    this.threads.delete(key(instanceId, agentId));
    this.threads.delete(key(instanceId, `${agentId}#a`));
    this.threads.delete(key(instanceId, `${agentId}#b`));
    this.onChange?.();
  }

  /** Replace thread contents (undo restore). */
  replace(
    instanceId: string,
    agentId: string,
    messages: AgentMessage[],
  ): void {
    this.threads.set(key(instanceId, agentId), [...messages]);
    this.onChange?.();
  }

  clearInstance(instanceId: string, agentIds: string[]): void {
    for (const agentId of agentIds) {
      this.clearAgentTree(instanceId, agentId);
    }
  }

  /** All threads for the day07 state file (per-thread tail cap). */
  snapshotThreads(): Record<string, AgentMessage[]> {
    const out: Record<string, AgentMessage[]> = {};
    for (const [k, list] of this.threads) {
      out[k] = list.slice(-this.persistTail);
    }
    return out;
  }

  /** Restore from the state file (trusted, pre-validated). */
  loadThreads(threads: Record<string, AgentMessage[]>): void {
    for (const [k, messages] of Object.entries(threads)) {
      this.threads.set(k, [...messages]);
    }
  }

  createMessage(
    partial: Omit<AgentMessage, "id" | "createdAt"> & {
      id?: string;
      createdAt?: string;
    },
  ): AgentMessage {
    return {
      id: partial.id ?? randomUUID(),
      createdAt: partial.createdAt ?? new Date().toISOString(),
      role: partial.role,
      content: partial.content,
      ...(partial.agentId ? { agentId: partial.agentId } : {}),
      ...(partial.label ? { label: partial.label } : {}),
      ...(partial.model ? { model: partial.model } : {}),
      ...(partial.latency_ms !== undefined
        ? { latency_ms: partial.latency_ms }
        : {}),
      ...(partial.usage ? { usage: partial.usage } : {}),
      ...(partial.cost_rub !== undefined ? { cost_rub: partial.cost_rub } : {}),
      ...(partial.saved_tokens !== undefined
        ? { saved_tokens: partial.saved_tokens }
        : {}),
    };
  }
}

export function createThreadStore(opts: ThreadStoreOptions = {}): ThreadStore {
  return new ThreadStore(opts);
}
