import {
  AddAgentRequestSchema,
  AgentRunRequestSchema,
  CompressThreadRequestSchema,
  CreateInstanceRequestSchema,
  OPEN_TASK_MODE,
  RestoreAgentRequestSchema,
  RestoreInstanceRequestSchema,
  SpawnRequestSchema,
  type AgentRunResponse,
  type AgentRunTokensDto,
   type CompressThreadResponse,
   type AgentMessage,
 } from "@trigger-helper/shared";
import type { FastifyInstance } from "fastify";
import type { Env } from "../config/env.js";
import {
  AGENT_HISTORY_CAPS,
  AgentPolicyError,
  ContextLimitError,
  shouldAutoCompress,
  type LlmAgent,
} from "../services/agent/llm-agent.js";
import {
  messageCostRub,
  sumThreadTokens,
} from "../services/agent/token-estimate.js";
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
    /** Day09: Lab placeholder default (0 = off). */
    autoCompress: { defaultEvery: deps.env.AGENT_COMPRESS_EVERY },
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

  /** Day08: token series for the whole thread (0 LLM calls). */
  app.get(
    "/api/instances/:id/agents/:agentId/tokens",
    async (request, reply) => {
      const { id, agentId } = request.params as {
        id: string;
        agentId: string;
      };
      const found = deps.registry.getAgent(id, agentId);
      if (!found) {
        return reply.status(404).send({ error: "Instance or agent not found" });
      }

      const messages = deps.threads.list(id, agentId);
      const model = found.agent.defaultModel ?? deps.env.DEEPSEEK_MODEL;

      let cumTokens = 0;
      let cumCostRub = 0;
      const series = messages.map((m) => {
        const costRub = messageCostRub(m);
        cumTokens += m.usage?.total_tokens ?? 0;
        cumCostRub += costRub;
        return {
          id: m.id,
          role: m.role,
          createdAt: m.createdAt,
          promptTokens: m.usage?.prompt_tokens ?? 0,
          completionTokens: m.usage?.completion_tokens ?? 0,
          costRub: Number(costRub.toFixed(4)),
          cumTokens,
          cumCostRub: Number(cumCostRub.toFixed(4)),
        };
      });

      return {
        instanceId: id,
        agentId,
        model,
        limit: deps.llmAgent.contextLimit(model),
        caps: AGENT_HISTORY_CAPS,
        thread: sumThreadTokens(messages),
        series,
      };
    },
  );

  /** Day08: compress the old thread into one system summary (cheap model). */
  app.post(
    "/api/instances/:id/agents/:agentId/compress",
    async (request, reply) => {
      const { id, agentId } = request.params as {
        id: string;
        agentId: string;
      };
      const parsed = CompressThreadRequestSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.status(400).send({
          error: "Invalid request body",
          details: parsed.error.flatten(),
        });
      }
      const found = deps.registry.getAgent(id, agentId);
      if (!found) {
        return reply.status(404).send({ error: "Instance or agent not found" });
      }

      try {
        // Day09: persist+billing moved into compressAndPersist() — same body,
        // same response shape (C-6: manual «Сжать» behavior unchanged).
        return await compressAndPersist(deps, {
          instanceId: id,
          agentId,
          label: found.agent.label,
          keepLast: parsed.data.keepLast,
          model: parsed.data.model,
        });
      } catch (error) {
        if (error instanceof ContextLimitError) {
          return sendContextLimit(reply, error);
        }
        if (error instanceof AgentPolicyError) {
          return reply.status(400).send({
            error: "Nothing to compress",
            message: error.message,
          });
        }
        request.log.error(error);
        return reply.status(502).send({
          error: "Compress failed",
          message: error instanceof Error ? error.message : "Unknown error",
        });
      }
    },
  );

  /** Day08+: idle economics probe — 4 real calls, thread NOT touched, replies discarded. */
  app.post(
    "/api/instances/:id/agents/:agentId/compress/probe",
    async (request, reply) => {
      const { id, agentId } = request.params as {
        id: string;
        agentId: string;
      };
      const parsed = CompressThreadRequestSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.status(400).send({
          error: "Invalid request body",
          details: parsed.error.flatten(),
        });
      }
      const found = deps.registry.getAgent(id, agentId);
      if (!found) {
        return reply.status(404).send({ error: "Instance or agent not found" });
      }

      const history = deps.threads.list(id, agentId);
      try {
        const probe = await deps.llmAgent.probeCompressEconomics({
          agent: found.agent,
          history,
          question: parsed.data.question,
          keepLast: parsed.data.keepLast,
          model: parsed.data.model,
        });
        // Idle calls are real spend: bill them; the thread stays untouched.
        const countExpensive = OPEN_TASK_MODE === "public";
        let totals = await deps.usageLedger.record(probe.full.usage, {
          countExpensive,
        });
        totals = await deps.usageLedger.record(probe.compress.usage, {
          countExpensive,
        });
        totals = await deps.usageLedger.record(probe.compressedCold.usage, {
          countExpensive,
        });
        totals = await deps.usageLedger.record(probe.compressedWarm.usage, {
          countExpensive,
        });
        return { ...probe, totals };
      } catch (error) {
        if (error instanceof ContextLimitError) {
          return sendContextLimit(reply, error);
        }
        if (error instanceof AgentPolicyError) {
          return reply.status(400).send({
            error: "Nothing to compress",
            message: error.message,
          });
        }
        request.log.error(error);
        return reply.status(502).send({
          error: "Probe failed",
          message: error instanceof Error ? error.message : "Unknown error",
        });
      }
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
      // Day09: synchronous auto-compress before the LLM call (C-3) — the
      // answer goes out on the compressed context. compressEvery=0 disables
      // entirely; failure is opportunistic (D-4): answer without compression.
      const compressEvery =
        overrides?.compressEvery ?? deps.env.AGENT_COMPRESS_EVERY;
      let autoCompression: AgentRunResponse["autoCompression"];
      let runHistory = history;
      if (compressEvery > 0 && shouldAutoCompress(history, compressEvery)) {
        try {
          const compressed = await compressAndPersist(deps, {
            instanceId,
            agentId,
            label: agent.label,
          });
          autoCompression = {
            summaryId: compressed.summary.id,
            before: compressed.before,
            after: compressed.after,
            compression: compressed.compression,
          };
          // Re-read the thread — the only source of truth after replace.
          runHistory = deps.threads.list(instanceId, agentId);
        } catch (error) {
          request.log.warn(
            { err: error, instanceId, agentId, compressEvery },
            "auto-compress failed; answering without compression",
          );
        }
      }

      const result = await deps.llmAgent.run(
        agent,
        input,
        runHistory,
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

      const tokens: AgentRunTokensDto = {
        ...result.tokens,
        thread: sumThreadTokens(deps.threads.list(instanceId, agentId)),
      };

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
        tokens,
        autoCompression,
        totals,
      };
      return body;
    } catch (error) {
      if (error instanceof ContextLimitError) {
        return sendContextLimit(reply, error);
      }
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

/**
 * Day09: compress the thread and persist + bill it — the shared path for the
 * manual compress handler and the auto-compress step of run (D-3). Error
 * mapping stays with the callers.
 */
async function compressAndPersist(
  deps: AgentRouteDeps,
  params: {
    instanceId: string;
    agentId: string;
    label: string;
    keepLast?: number;
    model?: string;
  },
): Promise<CompressThreadResponse> {
  const { instanceId, agentId } = params;
  const history = deps.threads.list(instanceId, agentId);
  const before = sumThreadTokens(history);

  const result = await deps.llmAgent.compress({
    history,
    keepLast: params.keepLast,
    model: params.model,
  });

  const draft = deps.threads.createMessage({
    role: "system",
    content: result.summary,
    agentId,
    label: params.label,
    model: result.model,
    latency_ms: result.latency_ms,
    usage: result.usage,
    cost_rub: result.cost_rub,
  });
  // Day08: estimate delta is the compression payoff, stored on the
  // summary so thread totals keep the saving after restarts.
  const savedTokens = Math.max(
    0,
    before.tokensEstimate -
      sumThreadTokens([draft, ...result.keptMessages]).tokensEstimate,
  );
  const summary: AgentMessage = { ...draft, saved_tokens: savedTokens };
  const thread = [summary, ...result.keptMessages];
  deps.threads.replace(instanceId, agentId, thread);
  const totals = await deps.usageLedger.record(result.usage, {
    countExpensive: OPEN_TASK_MODE === "public",
  });
  const after = sumThreadTokens(thread);

  return {
    summary,
    before: { count: before.count, tokensEstimate: before.tokensEstimate },
    after: { count: after.count, tokensEstimate: after.tokensEstimate },
    compression: {
      model: result.model,
      latency_ms: result.latency_ms,
      cost_rub: result.cost_rub,
      savedTokens: Math.max(
        0,
        before.tokensEstimate - after.tokensEstimate,
      ),
      summarizedMessages: result.summarizedCount,
      keptMessages: result.keptMessages.length,
      usage: result.usage,
    },
    thread,
    totals,
  };
}

function sendContextLimit(
  reply: {
    status: (code: number) => {
      send: (body: unknown) => unknown;
    };
  },
  error: ContextLimitError,
) {
  return reply.status(413).send({
    error: "Context limit exceeded",
    message: error.message,
    source: error.details.source,
    estimate: error.details.estimate,
    limit: error.details.limit,
    model: error.details.model,
    historyMode: error.details.historyMode,
    breakdown: error.details.breakdown,
    hint: "Сожмите историю (кнопка «Сжать») или верните режим tail.",
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
