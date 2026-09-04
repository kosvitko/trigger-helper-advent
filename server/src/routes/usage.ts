import type { FastifyInstance } from "fastify";
import type { Env } from "../config/env.js";
import type { UsageLedgerService } from "../services/usage-ledger.js";

export async function registerUsageRoutes(
  app: FastifyInstance,
  ledger: UsageLedgerService,
  env: Env,
): Promise<void> {
  app.get("/api/usage", async () => {
    const totals = await ledger.getTotals();
    const limit = env.FREE_DAILY_ASKS;
    const used = totals.expensive_asks_today ?? 0;
    return {
      ...totals,
      asks_limit: limit,
      asks_remaining: limit > 0 ? Math.max(0, limit - used) : null,
      asks_limit_scope: "expensive_daily_msk",
    };
  });
}
