import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { LlmUsage, UsageModelBucket, UsageTotals } from "@trigger-helper/shared";
import { isExpensiveModel, todayMoscowDate } from "./model-cost-tier.js";
import { costRubFromUsage } from "./pricing.js";

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
  const day = todayMoscowDate();
  return {
    requests: 0,
    cost_usd: 0,
    cost_rub: 0,
    total_tokens: 0,
    cache_hit_tokens: 0,
    by_model: {},
    expensive_day: day,
    expensive_asks_today: 0,
    budget_day: day,
    cost_rub_today: 0,
    cost_rub_expensive_today: 0,
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

/** Roll Moscow-day counters (asks + ₽ budgets). */
function withTodayCounters(totals: UsageTotals): UsageTotals {
  const today = todayMoscowDate();
  const sameExp = totals.expensive_day === today;
  const sameBudget = totals.budget_day === today;
  if (sameExp && sameBudget) {
    return totals;
  }
  return {
    ...totals,
    expensive_day: today,
    expensive_asks_today: sameExp ? (totals.expensive_asks_today ?? 0) : 0,
    budget_day: today,
    cost_rub_today: sameBudget ? (totals.cost_rub_today ?? 0) : 0,
    cost_rub_expensive_today: sameBudget
      ? (totals.cost_rub_expensive_today ?? 0)
      : 0,
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
    return this.enqueue(async () => withTodayCounters(await this.readUnlocked()));
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
      const current = withTodayCounters(await this.readUnlocked());
      const providerRub = usage.estimated_cost_rub ?? 0;
      const billingRub = costRubFromUsage(usage);
      const prev = current.by_model[usage.model] ?? emptyBucket();
      const nextBucket: UsageModelBucket = {
        requests: prev.requests + 1,
        cost_usd: Number((prev.cost_usd + usage.estimated_cost_usd).toFixed(6)),
        cost_rub: Number((prev.cost_rub + providerRub).toFixed(4)),
        total_tokens: prev.total_tokens + usage.total_tokens,
        cache_hit_tokens: prev.cache_hit_tokens + usage.prompt_cache_hit_tokens,
      };
      const expensive = isExpensiveModel(usage.model);
      const expensiveBump = countExpensive && expensive ? 1 : 0;
      const next: UsageTotals = {
        requests: current.requests + 1,
        cost_usd: Number(
          (current.cost_usd + usage.estimated_cost_usd).toFixed(6),
        ),
        cost_rub: Number((current.cost_rub + providerRub).toFixed(4)),
        total_tokens: current.total_tokens + usage.total_tokens,
        cache_hit_tokens:
          current.cache_hit_tokens + usage.prompt_cache_hit_tokens,
        by_model: { ...current.by_model, [usage.model]: nextBucket },
        expensive_day: current.expensive_day ?? todayMoscowDate(),
        expensive_asks_today:
          (current.expensive_asks_today ?? 0) + expensiveBump,
        budget_day: current.budget_day ?? todayMoscowDate(),
        cost_rub_today: Number(
          ((current.cost_rub_today ?? 0) + billingRub).toFixed(4),
        ),
        cost_rub_expensive_today: Number(
          (
            (current.cost_rub_expensive_today ?? 0) +
            (expensive ? billingRub : 0)
          ).toFixed(4),
        ),
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
      return await this.parseFile(this.filePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        const restored = await this.tryRestoreFromBackup();
        if (restored) {
          return restored;
        }
        const empty = emptyTotals();
        this.memory = empty;
        return empty;
      }
      throw error;
    }
  }

  private async parseFile(filePath: string): Promise<UsageTotals> {
    const raw = await fs.readFile(filePath, "utf8");
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
      budget_day:
        typeof parsed.budget_day === "string" ? parsed.budget_day : undefined,
      cost_rub_today: Number(parsed.cost_rub_today) || 0,
      cost_rub_expensive_today: Number(parsed.cost_rub_expensive_today) || 0,
      updated_at:
        typeof parsed.updated_at === "string"
          ? parsed.updated_at
          : new Date(0).toISOString(),
    };
    this.memory = totals;
    return totals;
  }

  /** If live ledger missing, copy newest var/backups/usage-totals-*.json. */
  private async tryRestoreFromBackup(): Promise<UsageTotals | null> {
    const backupDir = path.join(path.dirname(this.filePath), "backups");
    let names: string[];
    try {
      names = await fs.readdir(backupDir);
    } catch {
      return null;
    }
    const candidates = names
      .filter((n) => /^usage-totals-.+\.json$/.test(n))
      .sort()
      .reverse();
    for (const name of candidates) {
      const bakPath = path.join(backupDir, name);
      try {
        const totals = await this.parseFile(bakPath);
        if ((totals.requests ?? 0) <= 0 && (totals.cost_rub ?? 0) <= 0) {
          continue;
        }
        await fs.mkdir(path.dirname(this.filePath), { recursive: true });
        await fs.copyFile(bakPath, this.filePath);
        return totals;
      } catch {
        // try older backup
      }
    }
    return null;
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
