import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AgentMessageSchema,
  InstanceSchema,
  type AgentMessage,
  type Instance,
} from "@trigger-helper/shared";
import { z } from "zod";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

export const AGENT_STATE_VERSION = 1;

/** Day07 on-disk shape: registry + threads in one JSON snapshot. */
export type AgentStateSnapshot = {
  version: typeof AGENT_STATE_VERSION;
  saved_at: string;
  instance_seq: number;
  agent_seq: Record<string, number>;
  instances: Instance[];
  threads: Record<string, AgentMessage[]>;
};

const SnapshotSchema = z.object({
  version: z.number(),
  saved_at: z.string().optional(),
  instance_seq: z.number().int().nonnegative().catch(0),
  agent_seq: z.record(z.string(), z.number()).catch({}),
  instances: z.array(z.unknown()).catch([]),
  threads: z.record(z.string(), z.array(z.unknown())).catch({}),
});

const SAVE_DEBOUNCE_MS = 150;

function emptySnapshot(): AgentStateSnapshot {
  return {
    version: AGENT_STATE_VERSION,
    saved_at: new Date(0).toISOString(),
    instance_seq: 0,
    agent_seq: {},
    instances: [],
    threads: {},
  };
}

/**
 * Day07: agent context on disk (default <repo>/var/agent-state.json, gitignored).
 * Serialized atomic writes — same pattern as UsageLedgerService.
 * Missing/corrupt file → empty snapshot (fresh seed), server still boots.
 */
export class AgentStateStore {
  private chain: Promise<unknown> = Promise.resolve();
  private saveTimer: NodeJS.Timeout | null = null;
  private provider: (() => AgentStateSnapshot) | null = null;

  constructor(private readonly filePath: string) {}

  setSnapshotProvider(provider: () => AgentStateSnapshot): void {
    this.provider = provider;
  }

  /** Read + validate; per-item safeParse so one bad record drops, not the file. */
  async load(): Promise<AgentStateSnapshot> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return emptySnapshot();
      }
      throw error;
    }
    try {
      const parsed = SnapshotSchema.parse(JSON.parse(raw));
      const instances: Instance[] = [];
      for (const item of parsed.instances) {
        const checked = InstanceSchema.safeParse(item);
        if (checked.success) {
          instances.push(checked.data);
        }
      }
      const threads: Record<string, AgentMessage[]> = {};
      for (const [key, items] of Object.entries(parsed.threads)) {
        const messages: AgentMessage[] = [];
        for (const item of items) {
          const checked = AgentMessageSchema.safeParse(item);
          if (checked.success) {
            messages.push(checked.data);
          }
        }
        if (messages.length > 0) {
          threads[key] = messages;
        }
      }
      return {
        version: AGENT_STATE_VERSION,
        saved_at: parsed.saved_at ?? new Date(0).toISOString(),
        instance_seq: parsed.instance_seq,
        agent_seq: parsed.agent_seq,
        instances,
        threads,
      };
    } catch (error) {
      console.error(
        `agent-state: не удалось прочитать ${this.filePath} — старт с пустым состоянием`,
        error,
      );
      return emptySnapshot();
    }
  }

  /** Coalesced save: fires once shortly after the last mutation. */
  scheduleSave(delayMs = SAVE_DEBOUNCE_MS): void {
    this.clearSaveTimer();
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.saveNow();
    }, delayMs);
  }

  /** Force write now (also clears a pending debounce). */
  async saveNow(): Promise<void> {
    this.clearSaveTimer();
    await this.enqueue(() => this.writeProvider());
  }

  /** Exit hook: drop pending debounce, write the latest state. */
  async flush(): Promise<void> {
    this.clearSaveTimer();
    await this.enqueue(() => this.writeProvider());
  }

  private clearSaveTimer(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
  }

  private async writeProvider(): Promise<void> {
    const provider = this.provider;
    if (!provider) {
      return;
    }
    await this.write(provider());
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async write(snapshot: AgentStateSnapshot): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    await fs.rename(tmp, this.filePath);
  }
}

export function createAgentStateStore(customPath?: string): AgentStateStore {
  const filePath = customPath
    ? path.resolve(customPath)
    : path.join(repoRoot, "var", "agent-state.json");
  return new AgentStateStore(filePath);
}
