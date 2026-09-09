import {
  AddAgentRequestSchema,
  AgentRunRequestSchema,
  CreateInstanceRequestSchema,
  OPEN_TASK_MODE,
  RestoreAgentRequestSchema,
  RestoreInstanceRequestSchema,
  SpawnRequestSchema,
  type AgentRunResponse,
} from "@trigger-helper/shared";
import type { FastifyInstance } from "fastify";
import type { Env } from "../config/env.js";
import {
  AgentPolicyError,
  type LlmAgent,
} from "../services/agent/llm-agent.js";
import {
  InstanceRegistryError,
  type InstanceRegistry,
} from "../services/agent/instance-registry.js";
import { AGENT_PRESETS } from "../services/agent/presets.js";
import type { ThreadStore } from "../services/agent/threads.js";
import { isExpensiveModel } from "../services/model-cost-tier.js";
import {
  applyCostAwareThrottle,
  getBudgetSnapshot,
} from "../services/cost-aware-throttle.js";
import type { UsageLedgerService } from "../services/usage-ledger.js";

type AgentRouteDeps = {
  registry: InstanceRegistry;
  threads: ThreadStore;
  llmAgent: LlmAgent;
  usageLedger: UsageLedgerService;
  env: Env;
};

export async function registerAgentRoutes(
  app: FastifyInstance,
  deps: AgentRouteDeps,
): Promise<void> {
  app.get("/api/agents", async () => ({
    presets: AGENT_PRESETS,
    caps: {
      maxInstances: deps.env.MAX_INSTANCES,
      maxAgentsPerInstance: deps.env.MAX_AGENTS_PER_INSTANCE,
    },
  }));

  app.get("/api/instances", async () => {
    const instances = deps.registry.list();
    return {
      instances,
      caps: {
        maxInstances: deps.env.MAX_INSTANCES,
        maxAgentsPerInstance: deps.env.MAX_AGENTS_PER_INSTANCE,
        usedInstances: instances.length,
      },
    };
  });

  app.post("/api/instances", async (request, reply) => {
    const parsed = CreateInstanceRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Invalid request body",
        details: parsed.error.flatten(),
      });
    }
    try {
      const instance = deps.registry.create(parsed.data);
      return reply.status(201).send({ instance });
    } catch (error) {
      return sendRegistryError(reply, error);
    }
  });

  app.post("/api/instances/:id/agents", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = AddAgentRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Invalid request body",
        details: parsed.error.flatten(),
      });
    }
    try {
      const agent = deps.registry.addAgent(
        id,
        parsed.data.presetId,
        parsed.data.label,
      );
      return reply.status(201).send({ agent });
    } catch (error) {
      return sendRegistryError(reply, error);
    }
  });

  app.delete("/api/instances/:id/agents/:agentId", async (request, reply) => {
    const { id, agentId } = request.params as { id: string; agentId: string };
    try {
      const messages = deps.threads.list(id, agentId);
      const agent = deps.registry.removeAgent(id, agentId);
      deps.threads.clearAgent(id, agentId);
      return { agent, messages };
    } catch (error) {
      return sendRegistryError(reply, error);
    }
  });

  app.post("/api/instances/:id/agents/restore", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = RestoreAgentRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Invalid request body",
        details: parsed.error.flatten(),
      });
    }
    try {
      const agent = deps.registry.restoreAgent(
        id,
        parsed.data.agent,
        parsed.data.index,
      );
      deps.threads.replace(id, agent.id, parsed.data.messages);
      return reply.status(201).send({ agent, messages: parsed.data.messages });
    } catch (error) {
      return sendRegistryError(reply, error);
    }
  });

  app.delete("/api/instances/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const instance = deps.registry.get(id);
      if (!instance) {
        return reply.status(404).send({ error: "Инстанс не найден" });
      }
      const threads: Record<string, ReturnType<ThreadStore["list"]>> = {};
      for (const agent of instance.agents) {
        threads[agent.id] = deps.threads.list(id, agent.id);
      }
      const removed = deps.registry.removeInstance(id);
      deps.threads.clearInstance(
        id,
        removed.agents.map((a) => a.id),
      );
      return { instance: removed, threads };
    } catch (error) {
      return sendRegistryError(reply, error);
    }
  });

  app.post("/api/instances/restore", async (request, reply) => {
    const parsed = RestoreInstanceRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Invalid request body",
        details: parsed.error.flatten(),
      });
    }
    try {
      const instance = deps.registry.restoreInstance(parsed.data.instance);
      for (const agent of instance.agents) {
        const msgs = parsed.data.threads[agent.id] ?? [];
        deps.threads.replace(instance.id, agent.id, msgs);
      }
      return reply.status(201).send({
        instance,
        threads: parsed.data.threads,
      });
    } catch (error) {
      return sendRegistryError(reply, error);
    }
  });

  app.post("/api/instances/:id/spawn", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = SpawnRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Invalid request body",
        details: parsed.error.flatten(),
      });
    }
    try {
      const result = deps.registry.spawn(parsed.data.kind, parsed.data.count, {
        instanceId: id,
        presetId: parsed.data.presetId,
      });
      return {
        ...result,
        note: "spawn без LLM-вызовов",
      };
    } catch (error) {
      return sendRegistryError(reply, error);
    }
  });

  app.post("/api/spawn/instances", async (request, reply) => {
    const parsed = SpawnRequestSchema.safeParse({
      ...(request.body as object),
      kind: "instances",
    });
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Invalid request body",
        details: parsed.error.flatten(),
      });
    }
    try {
      const result = deps.registry.spawn("instances", parsed.data.count, {
        presetId: parsed.data.presetId,
      });
      return { ...result, note: "spawn без LLM-вызовов" };
    } catch (error) {
      return sendRegistryError(reply, error);
    }
  });

  app.get(
    "/api/instances/:id/agents/:agentId/messages",
    async (request, reply) => {
      const { id, agentId } = request.params as {
        id: string;
        agentId: string;
      };
      const found = deps.registry.getAgent(id, agentId);
      if (!found) {
        return reply.status(404).send({ error: "Instance or agent not found" });
      }
      return {
        instanceId: id,
        agentId,
        messages: deps.threads.list(id, agentId),
      };
    },
  );

  app.post("/api/agent/run", async (request, reply) => {
    const parsed = AgentRunRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Invalid request body",
        details: parsed.error.flatten(),
      });
    }

    const { instanceId, agentId, input, overrides } = parsed.data;
    const found = deps.registry.getAgent(instanceId, agentId);
    if (!found) {
      return reply.status(404).send({ error: "Instance or agent not found" });
    }
    const { agent } = found;

    const requestedModel =
      overrides?.model ?? agent.defaultModel ?? deps.env.DEEPSEEK_MODEL;
    const countExpensive = OPEN_TASK_MODE === "public";
    const freeCap = deps.env.FREE_DAILY_ASKS;
    if (countExpensive && freeCap > 0 && isExpensiveModel(requestedModel)) {
      const used = await deps.usageLedger.getExpensiveAsksToday();
      if (used >= freeCap) {
        return reply.status(429).send({
          error: "Ask limit reached",
          message: `Дневной лимит дорогих моделей: ${freeCap} (МСК).`,
          limit: freeCap,
          used,
          model: requestedModel,
        });
      }
    }

    const budget = await getBudgetSnapshot(deps.usageLedger, deps.env);
    if ((await applyCostAwareThrottle(reply, budget)) === "rejected") {
      return;
    }

    const history = deps.threads.list(instanceId, agentId);

    try {
      const result = await deps.llmAgent.run(
        agent,
        input,
        history,
        overrides ?? {},
      );

      const userMsg = deps.threads.createMessage({
        role: "user",
        content: input.trim(),
        agentId: agent.id,
        label: agent.label,
      });
      deps.threads.append(instanceId, agentId, userMsg);

      const assistantMsg = deps.threads.createMessage({
        role: "assistant",
        content: result.reply,
        agentId: agent.id,
        label: agent.label,
        model: result.model,
        latency_ms: result.latency_ms,
        usage: result.usage,
        cost_rub: result.cost_rub,
      });
      deps.threads.append(instanceId, agentId, assistantMsg);

      const totals = await deps.usageLedger.record(result.usage, {
        countExpensive,
      });

      const body: AgentRunResponse = {
        reply: result.reply,
        message: assistantMsg,
        agent: {
          id: agent.id,
          label: agent.label,
          presetId: agent.presetId,
          role: agent.role,
          policies: {
            input: agent.inputPolicy,
            output: agent.outputPolicy,
          },
          layers: agent.layers,
          model: result.model,
          temperature: result.temperature,
          overridesApplied: result.overridesApplied,
        },
        usage: result.usage,
        latency_ms: result.latency_ms,
        totals,
      };
      return body;
    } catch (error) {
      if (error instanceof AgentPolicyError) {
        return reply.status(400).send({
          error: "Policy rejected input",
          message: error.message,
        });
      }
      request.log.error(error);
      return reply.status(502).send({
        error: "LLM request failed",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });
}

function sendRegistryError(
  reply: {
    status: (code: number) => {
      send: (body: unknown) => unknown;
    };
  },
  error: unknown,
) {
  if (error instanceof InstanceRegistryError) {
    return reply.status(error.statusCode).send({
      error: error.message,
    });
  }
  throw error;
}
