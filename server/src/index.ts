import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "./config/env.js";
import { registerAgentRoutes } from "./routes/agents.js";
import { registerAskRoutes } from "./routes/ask.js";
import { registerCompareRoutes } from "./routes/compare.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerMcpRoutes } from "./routes/mcp.js";
import { registerUsageRoutes } from "./routes/usage.js";
import { registerIpRateLimit } from "./plugins/ip-rate-limit.js";
import { createInstanceRegistry } from "./services/agent/instance-registry.js";
import { createDay10StateStore } from "./services/agent/day10-state.js";
import { createMemoryStateStore } from "./services/agent/memory-state.js";
import { createProfileStateStore } from "./services/agent/profile-state.js";
import { createTaskStateStore } from "./services/agent/task-state.js";
import { createInvariantStateStore } from "./services/agent/invariant-state.js";
import { createLlmAgent } from "./services/agent/llm-agent.js";
import {
  AGENT_STATE_VERSION,
  createAgentStateStore,
  type AgentStateSnapshot,
} from "./services/agent/persistence.js";
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
  // Day07: persist agent context across Node restarts (var/agent-state.json)
  const agentState = createAgentStateStore(env.AGENT_STATE_FILE);
  const savedState = await agentState.load();
  const registry = createInstanceRegistry(
    {
      maxInstances: env.MAX_INSTANCES,
      maxAgentsPerInstance: env.MAX_AGENTS_PER_INSTANCE,
    },
    {
      seed: savedState.instances.length === 0,
      onChange: () => agentState.scheduleSave(),
    },
  );
  registry.loadState({
    instances: savedState.instances,
    instanceSeq: savedState.instance_seq,
    agentSeqByInstance: savedState.agent_seq,
  });
  const threads = createThreadStore({ onChange: () => agentState.scheduleSave() });
  threads.loadThreads(savedState.threads);
  const day10State = createDay10StateStore({
    onChange: () => agentState.scheduleSave(),
  });
  day10State.load({
    facts: savedState.facts,
    branching: savedState.branching,
    strategyByAgent: savedState.strategyByAgent,
  });
  const memoryState = createMemoryStateStore({
    onChange: () => agentState.scheduleSave(),
  });
  memoryState.load(savedState.memory);
  // Day12: instance-level personalization (profiles + active router).
  const profileState = createProfileStateStore({
    onChange: () => agentState.scheduleSave(),
  });
  profileState.load(savedState.profiles);
  // Day13: per-agent task state machine (stage/step/expected action).
  const taskStateStore = createTaskStateStore({
    onChange: () => agentState.scheduleSave(),
  });
  taskStateStore.load(savedState.taskStates);
  // Day14: per-agent invariants — owner rules the agent may not violate.
  const invariantStore = createInvariantStateStore({
    onChange: () => agentState.scheduleSave(),
  });
  invariantStore.load(savedState.invariantStates);
  const llmAgent = createLlmAgent(
    deepSeekService,
    env.DEEPSEEK_MODEL,
    env.DEMO_CONTEXT_LIMIT,
  );
  agentState.setSnapshotProvider((): AgentStateSnapshot => {
    const state = registry.snapshotState();
    const day10 = day10State.snapshot();
    return {
      version: AGENT_STATE_VERSION,
      saved_at: new Date().toISOString(),
      instance_seq: state.instanceSeq,
      agent_seq: state.agentSeqByInstance,
      instances: state.instances,
      threads: threads.snapshotThreads(),
      facts: day10.facts,
      branching: day10.branching,
      strategyByAgent: day10.strategyByAgent,
      memory: memoryState.snapshot(),
      profiles: profileState.snapshot(),
      taskStates: taskStateStore.snapshot(),
      invariantStates: invariantStore.snapshot(),
    };
  });

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
    day10State,
    memoryState,
    profileState,
    taskStateStore,
    invariantStore,
  });
  // Day16: MCP client — connect to the configured public MCP, list tools.
  await registerMcpRoutes(app, { env });

  await app.register(fastifyStatic, {
    root: path.join(serverRoot, "public"),
    prefix: "/",
  });

  await app.listen({ port: env.PORT, host: "0.0.0.0" });

  // Day07: flush agent state on shutdown (Ctrl+C / systemd stop keeps the dialog)
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void agentState
        .flush()
        .catch(() => undefined)
        .finally(() => {
          process.exit(0);
        });
    });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
