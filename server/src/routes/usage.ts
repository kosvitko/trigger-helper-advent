import type { FastifyInstance } from "fastify";
import type { UsageLedgerService } from "../services/usage-ledger.js";

export async function registerUsageRoutes(
  app: FastifyInstance,
  ledger: UsageLedgerService,
): Promise<void> {
  app.get("/api/usage", async () => ledger.getTotals());
}
