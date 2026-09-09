import type { FastifyReply } from "fastify";
import type { Env } from "../config/env.js";
import type { UsageLedgerService } from "./usage-ledger.js";
import { todayMoscowDate } from "./model-cost-tier.js";

const MSK_DAY_MS = 86_400_000;
const EPS_FRAC = 1 / 1_440; // ~1 minute

export type BudgetSnapshot = {
  day: string;
  used_rub: number;
  limit_rub: number;
  remaining_rub: number | null;
  expensive_used_rub: number;
  expensive_limit_rub: number;
  delay_ms: number;
  elapsed_frac: number;
  rejected: boolean;
  reason?: string;
};

function moscowElapsedFrac(now = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Moscow",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);
  const ms =
    ((get("hour") * 60 + get("minute")) * 60 + get("second")) * 1000;
  return Math.min(1, Math.max(0, ms / MSK_DAY_MS));
}

/** fill^α + ahead^β — see docs/reviews/260908-cost-aware-throttle.md */
export function computeDelayMs(
  spent: number,
  budget: number,
  elapsedFrac: number,
  env: Pick<
    Env,
    | "BUDGET_DELAY_ALPHA"
    | "BUDGET_DELAY_BETA"
    | "BUDGET_DELAY_FILL_MS"
    | "BUDGET_DELAY_PACE_MS"
    | "BUDGET_DELAY_MAX_MS"
  >,
): number {
  if (budget <= 0) return 0;
  const u = Math.min(1, Math.max(0, spent / budget));
  const e = Math.max(elapsedFrac, EPS_FRAC);
  const pace = u / e;
  const fill = u ** env.BUDGET_DELAY_ALPHA;
  const ahead = Math.max(0, pace - 1) ** env.BUDGET_DELAY_BETA;
  const raw =
    env.BUDGET_DELAY_FILL_MS * fill + env.BUDGET_DELAY_PACE_MS * ahead;
  return Math.min(env.BUDGET_DELAY_MAX_MS, Math.round(raw));
}

export async function getBudgetSnapshot(
  ledger: UsageLedgerService,
  env: Env,
  now = new Date(),
): Promise<BudgetSnapshot> {
  const totals = await ledger.getTotals();
  const day = totals.budget_day ?? totals.expensive_day ?? todayMoscowDate();
  const used = totals.cost_rub_today ?? 0;
  const expUsed = totals.cost_rub_expensive_today ?? 0;
  const limit = env.DAILY_BUDGET_RUB;
  const expLimit = env.DAILY_BUDGET_EXPENSIVE_RUB;
  const elapsed = moscowElapsedFrac(now);

  if (limit <= 0) {
    return {
      day,
      used_rub: used,
      limit_rub: 0,
      remaining_rub: null,
      expensive_used_rub: expUsed,
      expensive_limit_rub: expLimit,
      delay_ms: 0,
      elapsed_frac: elapsed,
      rejected: false,
    };
  }

  if (used >= limit) {
    return {
      day,
      used_rub: used,
      limit_rub: limit,
      remaining_rub: 0,
      expensive_used_rub: expUsed,
      expensive_limit_rub: expLimit,
      delay_ms: 0,
      elapsed_frac: elapsed,
      rejected: true,
      reason: "daily_budget_rub",
    };
  }

  if (expLimit > 0 && expUsed >= expLimit) {
    return {
      day,
      used_rub: used,
      limit_rub: limit,
      remaining_rub: Number((limit - used).toFixed(4)),
      expensive_used_rub: expUsed,
      expensive_limit_rub: expLimit,
      delay_ms: 0,
      elapsed_frac: elapsed,
      rejected: true,
      reason: "daily_budget_expensive_rub",
    };
  }

  const delayTotal = computeDelayMs(used, limit, elapsed, env);
  const delayExp =
    expLimit > 0 ? computeDelayMs(expUsed, expLimit, elapsed, env) : 0;
  const delay_ms = Math.max(delayTotal, delayExp);

  return {
    day,
    used_rub: used,
    limit_rub: limit,
    remaining_rub: Number((limit - used).toFixed(4)),
    expensive_used_rub: expUsed,
    expensive_limit_rub: expLimit,
    delay_ms,
    elapsed_frac: Number(elapsed.toFixed(4)),
    rejected: false,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Hard 429 at budget ceiling; else optional delay before LLM.
 * Sets x-budget-* headers when delay > 0 or rejected.
 */
export async function applyCostAwareThrottle(
  reply: FastifyReply,
  snapshot: BudgetSnapshot,
): Promise<"ok" | "rejected"> {
  reply.header("x-budget-used-rub", String(snapshot.used_rub));
  reply.header("x-budget-limit-rub", String(snapshot.limit_rub));
  reply.header("x-budget-delay-ms", String(snapshot.delay_ms));

  if (snapshot.rejected) {
    reply.status(429).send({
      error: "Budget limit reached",
      message:
        snapshot.reason === "daily_budget_expensive_rub"
          ? `Дневной бюджет дорогих моделей: ₽${snapshot.expensive_limit_rub} (МСК).`
          : `Дневной бюджет: ₽${snapshot.limit_rub} (МСК).`,
      budget: snapshot,
    });
    return "rejected";
  }

  if (snapshot.delay_ms > 0) {
    await sleep(snapshot.delay_ms);
  }
  return "ok";
}
