import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { LlmUsage, UsageModelBucket, UsageTotals } from "@trigger-helper/shared";
import { isExpensiveModel, todayMoscowDate } from "./model-cost-tier.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

function emptyBucket(): UsageModelBucket {
  return {
    requests: 0,
    cost_usd: 0,
    cost_rub: 0,
    total_tokens: 0,
    cache_hit_tokens: 0,
  };
}

function emptyTotals(): UsageTotals {
  return {
    requests: 0,
    cost_usd: 0,
    cost_rub: 0,
    total_tokens: 0,
    cache_hit_tokens: 0,
    by_model: {},
    expensive_day: todayMoscowDate(),
    expensive_asks_today: 0,
    updated_at: new Date(0).toISOString(),
  };
}

function parseBucket(raw: unknown): UsageModelBucket {
  if (!raw || typeof raw !== "object") return emptyBucket();
  const o = raw as Record<string, unknown>;
  return {
    requests: Number(o.requests) || 0,
    cost_usd: Number(o.cost_usd) || 0,
    cost_rub: Number(o.cost_rub) || 0,
    total_tokens: Number(o.total_tokens) || 0,
    cache_hit_tokens: Number(o.cache_hit_tokens) || 0,
  };
}

function withTodayExpensive(totals: UsageTotals): UsageTotals {
  const today = todayMoscowDate();
  if (totals.expensive_day === today) {
    return totals;
  }
  return {
    ...totals,
    expensive_day: today,
    expensive_asks_today: 0,
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
    return this.enqueue(async () => withTodayExpensive(await this.readUnlocked()));
  }

  /** Expensive asks used today (Moscow day), after rolling the day if needed. */
  async getExpensiveAsksToday(): Promise<number> {
    const totals = await this.getTotals();
    return totals.expensive_asks_today ?? 0;
  }

  async record(
    usage: LlmUsage,
    opts: { countExpensive?: boolean } = {},
  ): Promise<UsageTotals> {
    const countExpensive = opts.countExpensive !== false;
    return this.enqueue(async () => {
      const current = withTodayExpensive(await this.readUnlocked());
      const rub = usage.estimated_cost_rub ?? 0;
      const prev = current.by_model[usage.model] ?? emptyBucket();
      const nextBucket: UsageModelBucket = {
        requests: prev.requests + 1,
        cost_usd: Number((prev.cost_usd + usage.estimated_cost_usd).toFixed(6)),
        cost_rub: Number((prev.cost_rub + rub).toFixed(4)),
        total_tokens: prev.total_tokens + usage.total_tokens,
        cache_hit_tokens: prev.cache_hit_tokens + usage.prompt_cache_hit_tokens,
      };
      const expensiveBump =
        countExpensive && isExpensiveModel(usage.model) ? 1 : 0;
      const next: UsageTotals = {
        requests: current.requests + 1,
        cost_usd: Number(
          (current.cost_usd + usage.estimated_cost_usd).toFixed(6),
        ),
        cost_rub: Number((current.cost_rub + rub).toFixed(4)),
        total_tokens: current.total_tokens + usage.total_tokens,
        cache_hit_tokens:
          current.cache_hit_tokens + usage.prompt_cache_hit_tokens,
        by_model: { ...current.by_model, [usage.model]: nextBucket },
        expensive_day: current.expensive_day ?? todayMoscowDate(),
        expensive_asks_today:
          (current.expensive_asks_today ?? 0) + expensiveBump,
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
      const parsed = JSON.parse(raw) as Partial<UsageTotals> & {
        by_model?: Record<string, unknown>;
      };
      const by_model: Record<string, UsageModelBucket> = {};
      if (parsed.by_model && typeof parsed.by_model === "object") {
        for (const [key, value] of Object.entries(parsed.by_model)) {
          by_model[key] = parseBucket(value);
        }
      }
      const totals: UsageTotals = {
        requests: Number(parsed.requests) || 0,
        cost_usd: Number(parsed.cost_usd) || 0,
        cost_rub: Number(parsed.cost_rub) || 0,
        total_tokens: Number(parsed.total_tokens) || 0,
        cache_hit_tokens: Number(parsed.cache_hit_tokens) || 0,
        by_model,
        expensive_day:
          typeof parsed.expensive_day === "string"
            ? parsed.expensive_day
            : undefined,
        expensive_asks_today: Number(parsed.expensive_asks_today) || 0,
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
