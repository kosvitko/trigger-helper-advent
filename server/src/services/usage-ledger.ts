import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { LlmUsage, UsageTotals } from "@trigger-helper/shared";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

function emptyTotals(): UsageTotals {
  return {
    requests: 0,
    cost_usd: 0,
    total_tokens: 0,
    cache_hit_tokens: 0,
    updated_at: new Date(0).toISOString(),
  };
}

/**
 * Append-only style totals on disk (VPS). One JSON file, serialized writes.
 * Default path: <repo>/var/usage-totals.json (gitignored).
 */
export class UsageLedgerService {
  private chain: Promise<unknown> = Promise.resolve();
  private memory: UsageTotals | null = null;

  constructor(private readonly filePath: string) {}

  async getTotals(): Promise<UsageTotals> {
    return this.enqueue(async () => this.readUnlocked());
  }

  async record(usage: LlmUsage): Promise<UsageTotals> {
    return this.enqueue(async () => {
      const current = await this.readUnlocked();
      const next: UsageTotals = {
        requests: current.requests + 1,
        cost_usd: Number(
          (current.cost_usd + usage.estimated_cost_usd).toFixed(6),
        ),
        total_tokens: current.total_tokens + usage.total_tokens,
        cache_hit_tokens:
          current.cache_hit_tokens + usage.prompt_cache_hit_tokens,
        updated_at: new Date().toISOString(),
      };
      await this.writeUnlocked(next);
      this.memory = next;
      return next;
    });
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async readUnlocked(): Promise<UsageTotals> {
    if (this.memory) {
      return this.memory;
    }
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<UsageTotals>;
      const totals: UsageTotals = {
        requests: Number(parsed.requests) || 0,
        cost_usd: Number(parsed.cost_usd) || 0,
        total_tokens: Number(parsed.total_tokens) || 0,
        cache_hit_tokens: Number(parsed.cache_hit_tokens) || 0,
        updated_at:
          typeof parsed.updated_at === "string"
            ? parsed.updated_at
            : new Date(0).toISOString(),
      };
      this.memory = totals;
      return totals;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        const empty = emptyTotals();
        this.memory = empty;
        return empty;
      }
      throw error;
    }
  }

  private async writeUnlocked(totals: UsageTotals): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(totals, null, 2)}\n`, "utf8");
    await fs.rename(tmp, this.filePath);
  }
}

export function createUsageLedgerService(
  customPath?: string,
): UsageLedgerService {
  const filePath = customPath
    ? path.resolve(customPath)
    : path.join(repoRoot, "var", "usage-totals.json");
  return new UsageLedgerService(filePath);
}
