import {
  AddAgentRequestSchema,
  AgentRunRequestSchema,
  BranchCheckpointRequestSchema,
  BranchSwitchRequestSchema,
  CompressThreadRequestSchema,
  CreateInstanceRequestSchema,
  FACT_KEYS,
  MemoryFactCreateSchema,
  MemoryFactPatchSchema,
  OPEN_TASK_MODE,
  ProfileActivateSchema,
  RestoreAgentRequestSchema,
  RestoreInstanceRequestSchema,
  SpawnRequestSchema,
  TaskCreateSchema,
  TaskPatchSchema,
  TaskTransitionSchema,
  UserProfileCreateSchema,
  UserProfilePatchSchema,
  type AgentContextStrategy,
  type AgentRunContext,
  type AgentRunResponse,
  type AgentRunTokensDto,
  type CompressThreadResponse,
  type AgentMessage,
  type FactsMap,
  type TaskStage,
} from "@trigger-helper/shared";
import type { FastifyInstance } from "fastify";
import type { Env } from "../config/env.js";
import type { Day10StateStore } from "../services/agent/day10-state.js";
import type { MemoryStateStore } from "../services/agent/memory-state.js";
import type { ProfileStateStore } from "../services/agent/profile-state.js";
import { ALLOWED_TRANSITIONS, validateTaskReply } from "../services/agent/task-state.js";
import type { TaskStateStore } from "../services/agent/task-state.js";
import {
  AGENT_HISTORY_CAPS,
  AgentPolicyError,
  ContextLimitError,
  EXTRACT_HISTORY_TAIL,
  shouldAutoCompress,
  stickyFromClassifyItems,
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
  day10State: Day10StateStore;
  memoryState: MemoryStateStore;
  profileState: ProfileStateStore;
  taskStateStore: TaskStateStore;
};

const CONTEXT_STRATEGIES = ["sliding", "facts", "branching"] as const;

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
    /** Day10 Lab meta. */
    contextStrategies: [...CONTEXT_STRATEGIES],
    factKeys: [...FACT_KEYS],
    memoryLayers: ["short", "working", "long"],
    historyCaps: AGENT_HISTORY_CAPS,
    /** Day13: canonical transition map — UI generates goto-buttons from it. */
    taskTransitions: ALLOWED_TRANSITIONS,
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
      deps.threads.clearAgentTree(id, agentId);
      deps.day10State.clearAgent(id, agentId);
      deps.memoryState.clearAgent(id, agentId);
      deps.taskStateStore.clearAgent(id, agentId);
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
      for (const agent of removed.agents) {
        deps.day10State.clearAgent(id, agent.id);
        deps.memoryState.clearAgent(id, agent.id);
        deps.taskStateStore.clearAgent(id, agent.id);
      }
      // Day12: profiles are instance-level — one cleanup, outside the agent loop.
      deps.profileState.clearInstance(id);
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
      const contextStrategy = deps.day10State.getStrategy(id, agentId);
      const threadAgentId = deps.day10State.resolveThreadAgentId(
        id,
        agentId,
        contextStrategy,
      );
      const branchMeta = deps.day10State.getBranching(id, agentId);
      const facts = deps.day10State.getFacts(id, agentId);
      return {
        instanceId: id,
        agentId,
        threadAgentId,
        messages: deps.threads.list(id, threadAgentId),
        facts,
        branch: {
          forked: branchMeta?.forked ?? false,
          activeBranchId: branchMeta?.activeBranchId ?? null,
          checkpointCount: branchMeta?.checkpointCount ?? 0,
        },
        contextStrategy: contextStrategy ?? null,
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

      const strategy = deps.day10State.getStrategy(id, agentId);
      const threadAgentId = deps.day10State.resolveThreadAgentId(
        id,
        agentId,
        strategy,
      );
      const messages = deps.threads.list(id, threadAgentId);
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
        threadAgentId,
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

      const strategy = deps.day10State.getStrategy(id, agentId);
      const threadAgentId = deps.day10State.resolveThreadAgentId(
        id,
        agentId,
        strategy,
      );

      try {
        // Day09: persist+billing moved into compressAndPersist() — same body,
        // same response shape (C-6: manual «Сжать» behavior unchanged).
        return await compressAndPersist(deps, {
          instanceId: id,
          agentId: threadAgentId,
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

      const strategy = deps.day10State.getStrategy(id, agentId);
      const threadAgentId = deps.day10State.resolveThreadAgentId(
        id,
        agentId,
        strategy,
      );
      const history = deps.threads.list(id, threadAgentId);
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

    const strategy = overrides?.contextStrategy;
    if (strategy) {
      deps.day10State.setStrategy(instanceId, agentId, strategy);
    }
    const threadAgentId = deps.day10State.resolveThreadAgentId(
      instanceId,
      agentId,
      strategy,
    );
    const history = deps.threads.list(instanceId, threadAgentId);

    try {
      // Day09: synchronous auto-compress before the LLM call (C-3) — the
      // answer goes out on the compressed context. compressEvery=0 disables
      // entirely; failure is opportunistic (D-4): answer without compression.
      // Day10: compress the active thread key (branch after fork).
      const compressEvery =
        overrides?.compressEvery ?? deps.env.AGENT_COMPRESS_EVERY;
      let autoCompression: AgentRunResponse["autoCompression"];
      let runHistory = history;
      if (compressEvery > 0 && shouldAutoCompress(history, compressEvery)) {
        try {
          const compressed = await compressAndPersist(deps, {
            instanceId,
            agentId: threadAgentId,
            label: agent.label,
            // Day09: суммаризатор — той же моделью, что выбрана в комбобоксе
            // чата (иначе авто-сжатие ходит на серверный дефолт в обход выбора)
            model: overrides?.model,
          });
          autoCompression = {
            summaryId: compressed.summary.id,
            before: compressed.before,
            after: compressed.after,
            compression: compressed.compression,
          };
          // Re-read the thread — the only source of truth after replace.
          runHistory = deps.threads.list(instanceId, threadAgentId);
        } catch (error) {
          request.log.warn(
            { err: error, instanceId, agentId, threadAgentId, compressEvery },
            "auto-compress failed; answering without compression",
          );
        }
      }

      let extractInfo: AgentRunContext["extract"];
      let factsForRun: FactsMap | undefined;
      let classifyInfo: NonNullable<AgentRunContext["memory"]>["classify"];

      // Day11: one classify LLM call every user-turn (dual-consumer with day10 sticky).
      let classified: Awaited<
        ReturnType<LlmAgent["classifyMemoryFacts"]>
      >;
      try {
        classified = await deps.llmAgent.classifyMemoryFacts({
          userText: input,
          historyTail: runHistory,
          model: deps.env.DEEPSEEK_MODEL,
        });
      } catch (error) {
        request.log.warn(
          { err: error, instanceId, agentId },
          "memory classify threw; fail-open",
        );
        classified = { ok: false, items: [] };
      }
      classifyInfo = {
        ok: classified.ok,
        ...(classified.usage ? { usage: classified.usage } : {}),
        ...(classified.latency_ms !== undefined
          ? { latency_ms: classified.latency_ms }
          : {}),
      };
      if (classified.usage) {
        await deps.usageLedger.record(classified.usage, { countExpensive });
      }
      if (classified.items.length > 0) {
        deps.memoryState.upsertFromClassify(instanceId, agentId, classified.items, {
          historySeq: runHistory.length,
        });
      }

      if (strategy === "facts") {
        const existing = deps.day10State.getFacts(instanceId, agentId);
        if (classified.ok) {
          const merged = stickyFromClassifyItems(existing, classified.items);
          deps.day10State.setFacts(instanceId, agentId, merged);
        }
        extractInfo = {
          ok: classified.ok,
          ...(classified.usage ? { usage: classified.usage } : {}),
          ...(classified.latency_ms !== undefined
            ? { latency_ms: classified.latency_ms }
            : {}),
        };
        factsForRun = deps.day10State.getFacts(instanceId, agentId);
      }

      const memorySlice = deps.memoryState.get(instanceId, agentId);
      // Day12: instance-level router state — resolved here (server key), not client.
      const activeProfile = deps.profileState.getActiveProfile(instanceId);
      // Day13: per-agent task FSM — resolved here, injected into every run.
      const taskState = deps.taskStateStore.get(instanceId, agentId);

      const effectiveHistoryMode =
        strategy === "sliding" || strategy === "facts"
          ? "tail"
          : (overrides?.historyMode ?? "tail");

      const result = await deps.llmAgent.run(agent, input, runHistory, {
        ...(overrides ?? {}),
        historyMode: effectiveHistoryMode,
        contextStrategy: strategy,
        memoryFacts: memorySlice.facts,
        activeProfile,
        taskState,
        ...(strategy === "facts" ? { facts: factsForRun } : {}),
      });

      // Day13 D-7: fail-open stage check — evidence only, taskState is not mutated.
      const taskCheck =
        taskState && taskState.stage !== "done"
          ? validateTaskReply(taskState, result.reply)
          : undefined;

      const userMsg = deps.threads.createMessage({
        role: "user",
        content: input.trim(),
        agentId: agent.id,
        label: agent.label,
      });
      deps.threads.append(instanceId, threadAgentId, userMsg);

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
      deps.threads.append(instanceId, threadAgentId, assistantMsg);

      const totals = await deps.usageLedger.record(result.usage, {
        countExpensive,
      });

      const tokens: AgentRunTokensDto = {
        ...result.tokens,
        historyMode: effectiveHistoryMode,
        estimate: {
          ...result.tokens.estimate,
          ...(classifyInfo?.ok && classifyInfo.usage
            ? { extract: classifyInfo.usage.total_tokens }
            : {}),
        },
        thread: sumThreadTokens(
          deps.threads.list(instanceId, threadAgentId),
        ),
      };

      const context: AgentRunContext = {
        strategy,
        historyMessages: result.historyChat.map((m) => ({
          role: m.role,
          content: m.content,
        })),
        // Day12: explicit null (not omission) — schema allows both, design §3.4.
        profile: activeProfile
          ? {
              id: activeProfile.id,
              label: activeProfile.label,
              inject: result.profileInject?.inject ?? null,
            }
          : null,
        // Day13: explicit null (no task); in done inject=null and no check.
        task: taskState
          ? {
              id: taskState.id,
              title: taskState.title,
              stage: taskState.stage,
              step: taskState.step,
              total: taskState.plan.length,
              paused: taskState.paused,
              inject: result.taskInject?.inject ?? null,
              ...(taskCheck ? { check: taskCheck } : {}),
            }
          : null,
        memory: {
          facts: memorySlice.facts,
          inject: result.memoryInject ?? {
            long: [],
            working: [],
            short: [],
          },
          classify: classifyInfo,
        },
        ...(strategy === "facts"
          ? {
              facts: factsForRun ?? {},
              extract: extractInfo,
            }
          : {}),
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
        context,
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

  // --- Day11 memory endpoints ---

  app.get(
    "/api/instances/:id/agents/:agentId/memory",
    async (request, reply) => {
      const { id, agentId } = request.params as {
        id: string;
        agentId: string;
      };
      const instance = deps.registry.get(id);
      if (!instance) {
        return reply.status(404).send({ error: "Instance not found" });
      }
      if (!instance.agents.some((a) => a.id === agentId)) {
        return reply.status(404).send({ error: "Agent not found" });
      }
      return { memory: deps.memoryState.get(id, agentId) };
    },
  );

  app.patch(
    "/api/instances/:id/agents/:agentId/memory/facts/:factId",
    async (request, reply) => {
      const { id, agentId, factId } = request.params as {
        id: string;
        agentId: string;
        factId: string;
      };
      const parsed = MemoryFactPatchSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.status(400).send({
          error: "Invalid request body",
          details: parsed.error.flatten(),
        });
      }
      const instance = deps.registry.get(id);
      if (!instance) {
        return reply.status(404).send({ error: "Instance not found" });
      }
      if (!instance.agents.some((a) => a.id === agentId)) {
        return reply.status(404).send({ error: "Agent not found" });
      }
      const updated = deps.memoryState.setLayer(
        id,
        agentId,
        factId,
        parsed.data.layer,
      );
      if (!updated) {
        return reply.status(404).send({ error: "Fact not found" });
      }
      return {
        fact: updated,
        memory: deps.memoryState.get(id, agentId),
      };
    },
  );

  app.delete(
    "/api/instances/:id/agents/:agentId/memory/facts/:factId",
    async (request, reply) => {
      const { id, agentId, factId } = request.params as {
        id: string;
        agentId: string;
        factId: string;
      };
      const instance = deps.registry.get(id);
      if (!instance) {
        return reply.status(404).send({ error: "Instance not found" });
      }
      if (!instance.agents.some((a) => a.id === agentId)) {
        return reply.status(404).send({ error: "Agent not found" });
      }
      const threadAgentId = deps.day10State.resolveThreadAgentId(id, agentId);
      const historySeq = deps.threads.list(id, threadAgentId).length;
      const removed = deps.memoryState.removeFact(id, agentId, factId, {
        historySeq,
        windowSize: EXTRACT_HISTORY_TAIL,
      });
      if (!removed) {
        return reply.status(404).send({ error: "Fact not found" });
      }
      return { removed: true, memory: deps.memoryState.get(id, agentId) };
    },
  );

  app.post(
    "/api/instances/:id/agents/:agentId/memory/facts",
    async (request, reply) => {
      const { id, agentId } = request.params as {
        id: string;
        agentId: string;
      };
      const parsed = MemoryFactCreateSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.status(400).send({
          error: "Invalid request body",
          details: parsed.error.flatten(),
        });
      }
      const instance = deps.registry.get(id);
      if (!instance) {
        return reply.status(404).send({ error: "Instance not found" });
      }
      if (!instance.agents.some((a) => a.id === agentId)) {
        return reply.status(404).send({ error: "Agent not found" });
      }
      const fact = deps.memoryState.addManual(
        id,
        agentId,
        parsed.data.text,
        parsed.data.layer ?? "working",
      );
      return reply.status(201).send({
        fact,
        memory: deps.memoryState.get(id, agentId),
      });
    },
  );

  // --- Day12 profile endpoints (instance-level personalization) ---

  /** GET also seeds the two contrast profiles once for a fresh instance (D-2);
   *  an emptied record stays empty — the seed never resurrects deletions. */
  app.get("/api/instances/:id/profiles", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!deps.registry.get(id)) {
      return reply.status(404).send({ error: "Instance not found" });
    }
    const state = deps.profileState.ensureSeed(id);
    return state;
  });

  app.post("/api/instances/:id/profiles", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = UserProfileCreateSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Invalid request body",
        details: parsed.error.flatten(),
      });
    }
    if (!deps.registry.get(id)) {
      return reply.status(404).send({ error: "Instance not found" });
    }
    // No auto-activation: the router is strictly manual (design §3.4).
    const profile = deps.profileState.create(id, parsed.data);
    return reply
      .status(201)
      .send({ profile, activeProfileId: deps.profileState.get(id).activeProfileId });
  });

  app.patch(
    "/api/instances/:id/profiles/:profileId",
    async (request, reply) => {
      const { id, profileId } = request.params as {
        id: string;
        profileId: string;
      };
      const parsed = UserProfilePatchSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.status(400).send({
          error: "Invalid request body",
          details: parsed.error.flatten(),
        });
      }
      if (!deps.registry.get(id)) {
        return reply.status(404).send({ error: "Instance not found" });
      }
      const updated = deps.profileState.update(id, profileId, parsed.data);
      if (!updated) {
        return reply.status(404).send({ error: "Profile not found" });
      }
      return {
        profile: updated,
        activeProfileId: deps.profileState.get(id).activeProfileId,
      };
    },
  );

  app.delete(
    "/api/instances/:id/profiles/:profileId",
    async (request, reply) => {
      const { id, profileId } = request.params as {
        id: string;
        profileId: string;
      };
      if (!deps.registry.get(id)) {
        return reply.status(404).send({ error: "Instance not found" });
      }
      const removed = deps.profileState.remove(id, profileId);
      if (removed === "not_found") {
        return reply.status(404).send({ error: "Profile not found" });
      }
      if (removed === "active") {
        return reply.status(409).send({
          error: "Profile is active",
          message: "Сначала деактивируйте или переключите профиль",
        });
      }
      const state = deps.profileState.get(id);
      return { removed: true, profiles: state.profiles, activeProfileId: state.activeProfileId };
    },
  );

  /** Manual router: profileId=null = explicit deactivation (D-5). */
  app.post("/api/instances/:id/profiles/activate", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = ProfileActivateSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Invalid request body",
        details: parsed.error.flatten(),
      });
    }
    if (!deps.registry.get(id)) {
      return reply.status(404).send({ error: "Instance not found" });
    }
    const state = deps.profileState.activate(id, parsed.data.profileId);
    if (!state) {
      return reply.status(404).send({ error: "Profile not found" });
    }
    return { activeProfileId: state.activeProfileId };
  });

  // --- Day13 task FSM endpoints (0 LLM — not rate-limited) ---

  app.get(
    "/api/instances/:id/agents/:agentId/task",
    async (request, reply) => {
      const { id, agentId } = request.params as {
        id: string;
        agentId: string;
      };
      const instance = deps.registry.get(id);
      if (!instance) {
        return reply.status(404).send({ error: "Instance not found" });
      }
      if (!instance.agents.some((a) => a.id === agentId)) {
        return reply.status(404).send({ error: "Agent not found" });
      }
      return { task: deps.taskStateStore.get(id, agentId) };
    },
  );

  app.post(
    "/api/instances/:id/agents/:agentId/task",
    async (request, reply) => {
      const { id, agentId } = request.params as {
        id: string;
        agentId: string;
      };
      const parsed = TaskCreateSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.status(400).send({
          error: "Invalid request body",
          details: parsed.error.flatten(),
        });
      }
      const instance = deps.registry.get(id);
      if (!instance) {
        return reply.status(404).send({ error: "Instance not found" });
      }
      if (!instance.agents.some((a) => a.id === agentId)) {
        return reply.status(404).send({ error: "Agent not found" });
      }
      const created = deps.taskStateStore.create(id, agentId, parsed.data);
      if (created === "exists") {
        return reply.status(409).send({
          error: "Task already exists",
          message: "У агента уже есть задача — удалите её, чтобы начать новую",
        });
      }
      return reply.status(201).send({ task: created });
    },
  );

  app.post(
    "/api/instances/:id/agents/:agentId/task/transition",
    async (request, reply) => {
      const { id, agentId } = request.params as {
        id: string;
        agentId: string;
      };
      const parsed = TaskTransitionSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.status(400).send({
          error: "Invalid request body",
          details: parsed.error.flatten(),
        });
      }
      const instance = deps.registry.get(id);
      if (!instance) {
        return reply.status(404).send({ error: "Instance not found" });
      }
      if (!instance.agents.some((a) => a.id === agentId)) {
        return reply.status(404).send({ error: "Agent not found" });
      }
      const result = deps.taskStateStore.transition(id, agentId, parsed.data);
      if (result.kind === "ok") {
        return { task: result.state };
      }
      if (result.kind === "not_found") {
        return reply.status(404).send({ error: "Task not found" });
      }
      return reply.status(409).send({
        error: "Transition rejected",
        from: result.from,
        ...(result.to !== undefined ? { to: result.to } : {}),
        ...(result.allowed ? { allowed: result.allowed } : {}),
        message: result.message,
      });
    },
  );

  app.patch(
    "/api/instances/:id/agents/:agentId/task",
    async (request, reply) => {
      const { id, agentId } = request.params as {
        id: string;
        agentId: string;
      };
      const parsed = TaskPatchSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.status(400).send({
          error: "Invalid request body",
          details: parsed.error.flatten(),
        });
      }
      const instance = deps.registry.get(id);
      if (!instance) {
        return reply.status(404).send({ error: "Instance not found" });
      }
      if (!instance.agents.some((a) => a.id === agentId)) {
        return reply.status(404).send({ error: "Agent not found" });
      }
      const task = deps.taskStateStore.patch(id, agentId, parsed.data);
      if (!task) {
        return reply.status(404).send({ error: "Task not found" });
      }
      return { task };
    },
  );

  app.delete(
    "/api/instances/:id/agents/:agentId/task",
    async (request, reply) => {
      const { id, agentId } = request.params as {
        id: string;
        agentId: string;
      };
      const instance = deps.registry.get(id);
      if (!instance) {
        return reply.status(404).send({ error: "Instance not found" });
      }
      if (!instance.agents.some((a) => a.id === agentId)) {
        return reply.status(404).send({ error: "Agent not found" });
      }
      const removed = deps.taskStateStore.remove(id, agentId);
      if (!removed) {
        return reply.status(404).send({ error: "Task not found" });
      }
      return { removed: true };
    },
  );

  // --- Day10 branching endpoints ---

  app.get(
    "/api/instances/:id/agents/:agentId/branch",
    async (request, reply) => {
      const { id, agentId } = request.params as {
        id: string;
        agentId: string;
      };
      const found = deps.registry.getAgent(id, agentId);
      if (!found) {
        return reply.status(404).send({ error: "Instance or agent not found" });
      }
      const meta = deps.day10State.getBranching(id, agentId);
      const forked = meta?.forked ?? false;
      return {
        forked,
        activeBranchId: meta?.activeBranchId ?? null,
        branches: forked ? (["a", "b"] as const) : [],
        checkpointCount: meta?.checkpointCount ?? 0,
      };
    },
  );

  app.post(
    "/api/instances/:id/agents/:agentId/branch/checkpoint",
    async (request, reply) => {
      const { id, agentId } = request.params as {
        id: string;
        agentId: string;
      };
      const parsed = BranchCheckpointRequestSchema.safeParse(
        request.body ?? {},
      );
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

      const prev = deps.day10State.getBranching(id, agentId);
      const strategy: AgentContextStrategy =
        deps.day10State.getStrategy(id, agentId) ?? "branching";
      const threadAgentId = deps.day10State.resolveThreadAgentId(
        id,
        agentId,
        strategy,
      );
      const list = deps.threads.list(id, threadAgentId);
      let checkpointCount = list.length;
      if (parsed.data.messageId) {
        const idx = list.findIndex((m) => m.id === parsed.data.messageId);
        if (idx < 0) {
          return reply.status(400).send({
            error: "messageId not in thread",
            message: "Указанное сообщение не найдено в активном треде",
          });
        }
        checkpointCount = idx + 1;
      }

      deps.day10State.setStrategy(id, agentId, "branching");
      deps.day10State.setBranching(id, agentId, {
        forked: prev?.forked ?? false,
        activeBranchId: prev?.activeBranchId ?? null,
        checkpointCount,
      });

      return { agentId, checkpointCount };
    },
  );

  app.post(
    "/api/instances/:id/agents/:agentId/branch/fork",
    async (request, reply) => {
      const { id, agentId } = request.params as {
        id: string;
        agentId: string;
      };
      const found = deps.registry.getAgent(id, agentId);
      if (!found) {
        return reply.status(404).send({ error: "Instance or agent not found" });
      }

      const meta = deps.day10State.getBranching(id, agentId);
      const checkpointCount = meta?.checkpointCount ?? 0;
      if (!(checkpointCount > 0)) {
        return reply.status(400).send({
          error: "Checkpoint required",
          message: "Сначала сделайте checkpoint перед fork",
        });
      }

      // Prefix from base agent thread (archive) unless already forked — then active.
      const sourceId =
        meta?.forked && meta.activeBranchId
          ? `${agentId}#${meta.activeBranchId}`
          : agentId;
      const list = deps.threads.list(id, sourceId);
      const n = Math.min(checkpointCount, list.length);
      if (n <= 0) {
        return reply.status(400).send({
          error: "Empty prefix",
          message: "Нет сообщений для ветвления",
        });
      }
      const prefix = list.slice(0, n);
      deps.threads.replace(id, `${agentId}#a`, prefix);
      deps.threads.replace(id, `${agentId}#b`, prefix);
      deps.day10State.setStrategy(id, agentId, "branching");
      deps.day10State.setBranching(id, agentId, {
        forked: true,
        activeBranchId: "a",
        checkpointCount,
      });

      return {
        branches: ["a", "b"],
        activeBranchId: "a",
        prefixCount: n,
      };
    },
  );

  app.post(
    "/api/instances/:id/agents/:agentId/branch/switch",
    async (request, reply) => {
      const { id, agentId } = request.params as {
        id: string;
        agentId: string;
      };
      const parsed = BranchSwitchRequestSchema.safeParse(request.body ?? {});
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

      const meta = deps.day10State.getBranching(id, agentId);
      if (!meta?.forked) {
        return reply.status(400).send({
          error: "Not forked",
          message: "Сначала выполните fork",
        });
      }

      deps.day10State.setStrategy(id, agentId, "branching");
      deps.day10State.setBranching(id, agentId, {
        ...meta,
        activeBranchId: parsed.data.branchId,
      });

      return { activeBranchId: parsed.data.branchId };
    },
  );
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
