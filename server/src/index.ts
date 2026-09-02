import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "./config/env.js";
import { registerAskRoutes } from "./routes/ask.js";
import { registerCompareRoutes } from "./routes/compare.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerUsageRoutes } from "./routes/usage.js";
import { createDeepSeekService } from "./services/deepseek.js";
import { createPointsService } from "./services/points.js";
import { createUsageLedgerService } from "./services/usage-ledger.js";

const serverRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

async function main(): Promise<void> {
  const env = loadEnv();
  const app = Fastify({ logger: true });

  const pointsService = createPointsService(env.DATA_DIR);
  const deepSeekService = createDeepSeekService(env);
  const usageLedger = createUsageLedgerService(env.USAGE_FILE);

  await registerHealthRoutes(app);
  await registerUsageRoutes(app, usageLedger);
  await registerAskRoutes(app, { pointsService, deepSeekService, usageLedger });
  await registerCompareRoutes(app, { deepSeekService, usageLedger });

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
