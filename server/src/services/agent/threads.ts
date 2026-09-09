import type { AgentMessage } from "@trigger-helper/shared";
import { randomUUID } from "node:crypto";

function key(instanceId: string, agentId: string): string {
  return `${instanceId}|${agentId}`;
}

/** In-memory threads: F5 hydrate OK; Node restart wipes. */
export class ThreadStore {
  private readonly threads = new Map<string, AgentMessage[]>();

  list(instanceId: string, agentId: string): AgentMessage[] {
    return [...(this.threads.get(key(instanceId, agentId)) ?? [])];
  }

  append(instanceId: string, agentId: string, message: AgentMessage): void {
    const k = key(instanceId, agentId);
    const list = this.threads.get(k) ?? [];
    list.push(message);
    this.threads.set(k, list);
  }

  clearAgent(instanceId: string, agentId: string): void {
    this.threads.delete(key(instanceId, agentId));
  }

  /** Replace thread contents (undo restore). */
  replace(
    instanceId: string,
    agentId: string,
    messages: AgentMessage[],
  ): void {
    this.threads.set(key(instanceId, agentId), [...messages]);
  }

  clearInstance(instanceId: string, agentIds: string[]): void {
    for (const agentId of agentIds) {
      this.clearAgent(instanceId, agentId);
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
    };
  }
}

export function createThreadStore(): ThreadStore {
  return new ThreadStore();
}
