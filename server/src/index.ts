import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "./config/env.js";
import { registerAgentRoutes } from "./routes/agents.js";
import { registerAskRoutes } from "./routes/ask.js";
import { registerCompareRoutes } from "./routes/compare.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerUsageRoutes } from "./routes/usage.js";
import { registerIpRateLimit } from "./plugins/ip-rate-limit.js";
import { createInstanceRegistry } from "./services/agent/instance-registry.js";
import { createLlmAgent } from "./services/agent/llm-agent.js";
import { createThreadStore } from "./services/agent/threads.js";
import { createDeepSeekService } from "./services/deepseek.js";
import { createPointsService } from "./services/points.js";
import { createUsageLedgerService } from "./services/usage-ledger.js";

const serverRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

async function main(): Promise<void> {
  const env = loadEnv();
  // trustProxy: nginx X-Forwarded-For → real client IP for rate limit
  const app = Fastify({ logger: true, trustProxy: true });

  const pointsService = createPointsService(env.DATA_DIR);
  const deepSeekService = createDeepSeekService(env);
  const usageLedger = createUsageLedgerService(env.USAGE_FILE);
  const registry = createInstanceRegistry({
    maxInstances: env.MAX_INSTANCES,
    maxAgentsPerInstance: env.MAX_AGENTS_PER_INSTANCE,
  });
  const threads = createThreadStore();
  const llmAgent = createLlmAgent(deepSeekService, env.DEEPSEEK_MODEL);

  await registerIpRateLimit(app, env);
  await registerHealthRoutes(app);
  await registerUsageRoutes(app, usageLedger, env);
  await registerAskRoutes(app, {
    pointsService,
    deepSeekService,
    usageLedger,
    env,
  });
  await registerCompareRoutes(app, { deepSeekService, usageLedger, env });
  await registerAgentRoutes(app, {
    registry,
    threads,
    llmAgent,
    usageLedger,
    env,
  });

  await app.register(fastifyStatic, {
    root: path.join(serverRoot, "public"),
    prefix: "/",
  });

  await app.listen({ port: env.PORT, host: "0.0.0.0" });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
