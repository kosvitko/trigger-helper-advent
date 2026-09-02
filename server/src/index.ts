import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "./config/env.js";
import { registerAskRoutes } from "./routes/ask.js";
import { registerHealthRoutes } from "./routes/health.js";
import { createDeepSeekService } from "./services/deepseek.js";
import { createPointsService } from "./services/points.js";

const serverRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

async function main(): Promise<void> {
  const env = loadEnv();
  const app = Fastify({ logger: true });

  const pointsService = createPointsService(env.DATA_DIR);
  const deepSeekService = createDeepSeekService(env);

  await registerHealthRoutes(app);
  await registerAskRoutes(app, { pointsService, deepSeekService });

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
