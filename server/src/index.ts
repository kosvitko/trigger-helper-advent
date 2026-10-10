import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "./config/env.js";
import { registerAgentRoutes } from "./routes/agents.js";
import { registerChatRoutes } from "./routes/chat.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerModelsRoutes } from "./routes/models.js";
import { registerRagRoutes } from "./routes/rag.js";
import { registerUsageRoutes } from "./routes/usage.js";
import { registerIpRateLimit } from "./plugins/ip-rate-limit.js";
import { createLlmAgent } from "./services/agent/llm-agent.js";
import { createDeepSeekService } from "./services/deepseek.js";
import { createUsageLedgerService } from "./services/usage-ledger.js";
import { registerOwnMcpRoute } from "./services/mcp-server.js";
import { createMcpRegistry } from "./services/mcp-registry.js";
import { createPipelinesService } from "./services/pipelines.js";
import { createRagAnswerService } from "./services/rag/answer.js";
import { createReranker } from "./services/rag/rerank.js";
import { createRewriteQueries } from "./services/rag/rewrite.js";
import { createRagService } from "./services/rag/store.js";
import { createSchedulerService } from "./services/scheduler.js";

const serverRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

async function main(): Promise<void> {
  const env = loadEnv();
  // trustProxy: nginx X-Forwarded-For → real client IP for rate limit
  const app = Fastify({ logger: true, trustProxy: true });

  const deepSeekService = createDeepSeekService(env);
  const usageLedger = createUsageLedgerService(env.USAGE_FILE);
  // Day18: background scheduler — PubMed digest jobs. C+ CH-6 (D-10/D-4):
  // серверных тредов больше нет — сводки не доставляются в личные чаты,
  // только публичный контент-трек (store + snapshot через MCP-атлас).
  const scheduler = createSchedulerService({
    env,
    deepSeek: deepSeekService,
    ledger: usageLedger,
  });
  await scheduler.load();
  // Day19: pipeline tools — search (PubMed) / summarize (nested LLM) /
  // saveToFile (first writing tool, var/pipelines/).
  const pipelines = createPipelinesService({
    env,
    deepSeek: deepSeekService,
    ledger: usageLedger,
  });
  // Day21: RAG index over docs/ (build artifact in data/rag/, see rag:index).
  // The service never touches the embeddings model at boot — lazy on search.
  const rag = createRagService(env);
  // Day23 (design F-04-1): cross-encoder reranker — hoisted (день 28: локальная
  // rag-ветка чата ходит тем же реранкером, что и ragAnswer).
  const reranker = createReranker(env);
  // Day22: RAG answer (question → chunks → LLM), two fair modes (design D-2).
  // Day23 (design F-04-1): + reranker (cross-encoder, tune-artifact threshold)
  // and rewriter (multi-query) — lazy init inside the services, boot untouched.
  const ragAnswer = createRagAnswerService({
    rag,
    deepSeek: deepSeekService,
    ledger: usageLedger,
    reranker,
    rewriter: createRewriteQueries(deepSeekService),
  });
  // Day20: MCP registry — own server (in-process specs) + optional externals
  // (MCP_SERVERS). Async boot (tools/list, ≤10 s/server) is awaited before
  // listen; external failures degrade instead of crashing (design §3.1/§3.3).
  const mcpRegistry = await createMcpRegistry({ port: env.PORT });
  const llmAgent = createLlmAgent(
    deepSeekService,
    env.DEEPSEEK_MODEL,
    env.DEMO_CONTEXT_LIMIT,
    // Day20: registry (own + injected externals) — enables overrides.tools.
    mcpRegistry,
    // Day25: конвейер дня 24 как библиотека для локальной тулзы rag_ask (D-2).
    ragAnswer,
  );

  await registerIpRateLimit(app, env);
  await registerHealthRoutes(app);
  await registerUsageRoutes(app, usageLedger, env);
  // Day05: /api/models (список тиров для SPA) — ask-роут снят 04.10
  // (гейт 261004 §7), остались только справочники.
  await registerModelsRoutes(app, { deepSeekService, env });
  // C+ CH-6 (D-10): из stateful-поверхности жив только справочник
  // пресетов GET /api/agents; ходы — stateless POST /api/chat ниже.
  await registerAgentRoutes(app, { env });
  // C+ CH-3: stateless-ход POST /api/chat — единственный чат-путь после
  // cutover (D-10). CH-4: allow-list моделей (SEC-F1) через справочник
  // /api/models + free-фолбэк дорогих. День 28: rag/reranker — детерминиро-
  // ванный retrieval локальной rag-ветки (proposals 261009 §3.1-1).
  await registerChatRoutes(app, {
    llmAgent,
    usageLedger,
    deepSeekService,
    env,
    rag,
    reranker,
  });
  // Day17: own MCP server (product atlas) on POST /mcp — tools/call target.
  // Day22: atlas tools read the point-cards corpus (data/points/*.md, D-12).
  await registerOwnMcpRoute(app, { scheduler, pipelines });
  // Day21: read-only RAG stats (GET — вне IP rate limit по дизайну).
  // 04.10 (гейт 261004 §7): search/ask/eval-роуты сняты со старым UI;
  // сервисы RAG живут — rag-tool агента (день 25) ходит напрямую.
  await registerRagRoutes(app, { rag });

  // Static 04.10 (старый UI снят — гейт 261004 §7, откат = revert деплоя):
  // SPA — на «/» и «/app» (записи, закладки): та же dist-сборка, ассеты —
  // с «/» (base "/"), обе точки входа работают одним билдом. Гард existsSync:
  // без client-сборки сервер грузится как API-only, статики нет вовсе.
  // Первая регистрация добавляет sendFile/download-декораторы, вторая —
  // decorateReply:false (в 8.3.0 нет decoratorName из design; реальный
  // механизм анти-краша — README плагина).
  const spaRoot = path.join(serverRoot, "..", "client", "dist");
  if (fs.existsSync(spaRoot)) {
    await app.register(fastifyStatic, {
      root: spaRoot,
      prefix: "/",
      wildcard: true,
    });
    await app.register(fastifyStatic, {
      root: spaRoot,
      prefix: "/app",
      wildcard: true,
      decorateReply: false,
    });
  }

  await app.listen({ port: env.PORT, host: env.HOST ?? "0.0.0.0" });

  // Day18: scheduler starts only after the server accepts traffic.
  scheduler.start();

  // C+ CH-6: серверного agent-state больше нет — на shutdown остаётся
  // остановка планировщика (persist-цепочка scheduler сама доехала или
  // доедет на следующем тике; usage-ledger пишет синхронно в запросе).
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      scheduler.stop();
      process.exit(0);
    });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
