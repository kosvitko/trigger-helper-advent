import type { FastifyInstance } from "fastify";
import type { SchedulerService } from "../services/scheduler.js";

/**
 * Day18: read-only scheduler state — jobs, counters, last summary.
 * Aggregates/metadata only: no abstracts, no prompts, no secrets
 * (the VPS is public — design §4.2/§4.3).
 */
export async function registerSchedulerRoutes(
  app: FastifyInstance,
  opts: { scheduler: SchedulerService },
): Promise<void> {
  app.get("/api/scheduler", async () => opts.scheduler.snapshot());
}
