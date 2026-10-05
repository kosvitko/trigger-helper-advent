import {
  AddAgentRequestSchema,
  AgentRunRequestSchema,
  ChatTaskStatePatchSchema,
  CreateInstanceRequestSchema,
  FACT_KEYS,
  OPEN_TASK_MODE,
  RestoreAgentRequestSchema,
  RestoreInstanceRequestSchema,
  type AgentRunContext,
  type AgentRunResponse,
  type AgentRunTokensDto,
  type ChatTaskState,
  type CompressThreadResponse,
  type AgentMessage,
  type FactsMap,
} from "@trigger-helper/shared";
import type { FastifyInstance } from "fastify";
import type { Env } from "../config/env.js";
import type { Day10StateStore } from "../services/agent/day10-state.js";
import type { MemoryStateStore } from "../services/agent/memory-state.js";
import type { ProfileStateStore } from "../services/agent/profile-state.js";
import {
  ALLOWED_TRANSITIONS,
  STAGE_GOTO_LABELS,
  STAGE_LABELS,
  validateTaskReply,
} from "../services/agent/task-state.js";
import type { TaskStateStore } from "../services/agent/task-state.js";
import type { InvariantStateStore } from "../services/agent/invariant-state.js";
import type { ChatTaskStateStore } from "../services/agent/chat-task-state.js";
import {
  AGENT_HISTORY_CAPS,
  AgentPolicyError,
  ContextLimitError,
  shouldAutoCompress,
   stickyFromClassifyItems,
   type LlmAgent,
 } from "../services/agent/llm-agent.js";
import { PIPELINE_STAGE_LABEL } from "../services/agent/llm-agent.js";
import { sumThreadTokens } from "../services/agent/token-estimate.js";
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
  invariantStore: InvariantStateStore;
  chatTaskStateStore: ChatTaskStateStore;
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
    /** Day15′ (260919): русские имена этапов/переходов — один источник для UI. */
    stageLabels: STAGE_LABELS,
    stageGotoLabels: STAGE_GOTO_LABELS,
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
      deps.invariantStore.clearAgent(id, agentId);
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
        deps.invariantStore.clearAgent(id, agent.id);
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

  app.post("/api/agent/run", async (request, reply) => {
    const parsed = AgentRunRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Invalid request body",
        details: parsed.error.flatten(),
      });
    }

    const { instanceId, agentId, input, overrides } = parsed.data;

    // Day25 UX SSE: если клиент просит event-stream — стримим шаги + финальный JSON.
    // Обычный JSON-путь не трогаем (старый UI, curl, eval — работают как раньше).
    const wantsSse = (request.headers.accept ?? "").includes("text/event-stream");
    const sseSend = wantsSse
      ? (data: unknown): void => {
          reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
        }
      : null;
    // QA 041003 (F2): после hijack() обычный reply.status().send() НЕ доходит
    // до клиента (заголовки 200 event-stream уже ушли) — поток висит вечно,
    // клиент показывает вечное «⏳ Выполняется…». Любой ранний отказ после
    // hijack обязан уйти SSE-ошибкой и закрыть поток.
    const sseFail = (message: string): void => {
      sseSend!({ type: "error", error: message });
      reply.raw.write("data: [DONE]\n\n");
      reply.raw.end();
    };
    if (wantsSse) {
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      });
      reply.hijack(); // Fastify: raw-сокет — обычный JSON-return выключен
      // 041005 (грабля таймлапса): nginx рвёт SSE при ~60 с тишины — длинные
      // ходи (нарратив на большом контексте > 60 с) умирали у клиента, хотя
      // сервер завершал их. Keepalive-комментарий каждые 15 с держит поток.
      const ka = setInterval(() => {
        try {
          reply.raw.write(": ping\n\n"); // SSE-комментарий: клиент игнорирует
        } catch {
          /* сокет уже закрыт — close-обработчик снимет интервал */
        }
      }, 15_000);
      reply.raw.on("close", () => clearInterval(ka));
    }
    const onProgress = sseSend
      ? (step: string, text: string): void => {
          sseSend({ type: "step", step, text });
        }
      : undefined;

    const found = deps.registry.getAgent(instanceId, agentId);
    if (!found) {
      if (wantsSse) {
        sseFail("Instance or agent not found");
        return reply;
      }
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
        const message = `Дневной лимит дорогих моделей: ${freeCap} (МСК).`;
        if (wantsSse) {
          sseFail(message);
          return reply;
        }
        return reply.status(429).send({
          error: "Ask limit reached",
          message,
          limit: freeCap,
          used,
          model: requestedModel,
        });
      }
    }

    const budget = await getBudgetSnapshot(deps.usageLedger, deps.env);
    // QA 041003 (F2): reject-ветка троттлинга после hijack ломала поток;
    // для SSE проверяем отказ по снапшоту сами — до applyCostAwareThrottle.
    if (wantsSse && budget.rejected) {
      sseFail(
        budget.reason === "daily_budget_expensive_rub"
          ? `Дневной бюджет дорогих моделей: ₽${budget.expensive_limit_rub} (МСК).`
          : `Дневной бюджет: ₽${budget.limit_rub} (МСК).`,
      );
      return reply;
    }
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
    // Day19 (фидбек Кости): стадии пайплайна — в живой ленте ЭТОГО треда
    // (не latestThread: вопрос ещё не записан в момент первой стадии).
    const onStage = (text: string) =>
      deps.threads.append(
        instanceId,
        threadAgentId,
        deps.threads.createMessage({
          role: "system",
          content: text,
          label: PIPELINE_STAGE_LABEL,
        }),
      );

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
      // Средняя стадия в живой трейс (Костя 041004): классификация — до рана
      onProgress?.(
        "memory_class",
        `факты из реплики → слои (LLM${classified.usage ? `, ${classified.usage.total_tokens} ток` : ""})`,
      );
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
      // Day14: active invariants (merged agent+task, D-5) — resolved server-side.
      const invariants = deps.invariantStore.getActive(
        instanceId,
        agentId,
        taskState ?? null,
      );

      const effectiveHistoryMode =
        strategy === "sliding" || strategy === "facts"
          ? "tail"
          : (overrides?.historyMode ?? "tail");

      // Day25 (04-F-9): effective ragTool — пресет-дефолт + точечный override
      // (паттерн effectiveHistoryMode); llm-agent пресет-агностичен.
      const effectiveRagTool =
        overrides?.ragTool ?? agent.presetId === "rag_chat";
      // Day25 (D-4): память задачи — ключ threadAgentId, тот же, что у треда.
      const chatTaskState = deps.chatTaskStateStore.get(
        instanceId,
        threadAgentId,
      );

      const runOverrides = {
        ...(overrides ?? {}),
        historyMode: effectiveHistoryMode,
        contextStrategy: strategy,
        memoryFacts: memorySlice.facts,
        activeProfile,
        taskState,
        invariants,
        ragTool: effectiveRagTool,
        chatTaskState,
        ...(strategy === "facts" ? { facts: factsForRun } : {}),
      };
      // Day20 cust-fix (Костя 25.09): вопрос пишется в тред ДО рана — тогда
      // стадии пайплайна (append во время рана) стоят ПОСЛЕ вопроса, а не
      // «посередине чата» до него (сортировка по createdAt). Если ран упадёт —
      // вопрос остаётся без ответа: честно, ошибка видна в статусе.
      // runHistory захвачен выше — вопрос в промпт не задваивается.
      deps.threads.append(
        instanceId,
        threadAgentId,
        deps.threads.createMessage({
          role: "user",
          content: input.trim(),
          agentId: agent.id,
          label: agent.label,
        }),
      );
      const firstResult = await deps.llmAgent.run(
        agent,
        input,
        runHistory,
        runOverrides,
        onStage,
        onProgress, // Day25 UX SSE: события шагов в реальном времени
      );

      // Day13 D-7 / Day15 D-2: fail-open checks — evidence only, taskState is
      // not mutated. Stage check now sees the input: a deterministic skip-demand
      // turns a stage miss into critical (red path).
      const checkTask = (reply: string) =>
        taskState && taskState.stage !== "done"
          ? validateTaskReply(taskState, reply, { input })
          : undefined;
      // Day14 D-7a: fail-open invariant check — independent of the task
      // (hard pattern rows vs user input); emitted only when pattern rows exist.
      const checkInvariants = (reply: string) => {
        const hasPatternRows = invariants.some(
          (row) => row.enforcement === "hard" && row.pattern,
        );
        return hasPatternRows
          ? validateTaskReply(taskState ?? null, reply, { invariants, input })
          : undefined;
      };

      // Day15 D-3: retry-once (слайд 31 Fail → retry) — триггер любой critical
      // (стадия при skip-запросе или инвариант). Повторный critical остаётся
      // critical (fail-open), retried лишь фиксирует попытку.
      const critical =
        checkTask(firstResult.reply)?.level === "critical" ||
        checkInvariants(firstResult.reply)?.level === "critical";
      const secondResult = critical
        ? await deps.llmAgent.run(
            agent,
            input,
            runHistory,
            {
              ...runOverrides,
              stageRetry: true,
            },
            onStage,
          )
        : null;

      const taskCheck = checkTask(
        secondResult ? secondResult.reply : firstResult.reply,
      );
      const invariantCheck = checkInvariants(
        secondResult ? secondResult.reply : firstResult.reply,
      );
      const retried = secondResult !== null;

      // День 15 D-3: тред получает только финальный ответ; usage/latency/₽ в
      // ответе — сумма обоих вызовов (ledger записывает каждый отдельно).
      const result = secondResult
        ? {
            ...secondResult,
            latency_ms: firstResult.latency_ms + secondResult.latency_ms,
            cost_rub: firstResult.cost_rub + secondResult.cost_rub,
            usage: {
              ...secondResult.usage,
              prompt_tokens:
                firstResult.usage.prompt_tokens + secondResult.usage.prompt_tokens,
              completion_tokens:
                firstResult.usage.completion_tokens +
                secondResult.usage.completion_tokens,
              total_tokens:
                firstResult.usage.total_tokens + secondResult.usage.total_tokens,
              prompt_cache_hit_tokens:
                firstResult.usage.prompt_cache_hit_tokens +
                secondResult.usage.prompt_cache_hit_tokens,
              prompt_cache_miss_tokens:
                firstResult.usage.prompt_cache_miss_tokens +
                secondResult.usage.prompt_cache_miss_tokens,
              estimated_cost_usd:
                firstResult.usage.estimated_cost_usd +
                secondResult.usage.estimated_cost_usd,
              estimated_cost_rub:
                firstResult.usage.estimated_cost_rub +
                secondResult.usage.estimated_cost_rub,
            },
          }
        : firstResult;

      // Рельса-чек — живой трейс (Костя 041004)
      onProgress?.(
        "rail",
        result.railViolated === true
          ? "рельса нарушена → был re-prompt"
          : "rag-вызов ✓ · метки источников ✓",
      );
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

      // Day15 D-3: ledger честен — при retry записаны оба вызова (₽-факт).
      if (retried) {
        await deps.usageLedger.record(firstResult.usage, {
          countExpensive,
        });
      }
      const totals = await deps.usageLedger.record(result.usage, {
        countExpensive,
      });

      // Day25 (D-4, 02-F-6): экстракт памяти задачи — in-request сразу после
      // run(), fail-open (состояние не меняется при ошибке). Только rag-ходы:
      // прочие пресеты не платят лишний вызов.
      let chatTaskEcho: ChatTaskState = chatTaskState;
      if (effectiveRagTool) {
        const extracted = await deps.llmAgent.classifyChatTaskState({
          userText: input,
          assistantReply: result.reply,
          historyTail: runHistory,
          model: deps.env.DEEPSEEK_MODEL,
          // 041005: экстрактор видит текущее состояние — не плодит парафразы
          current: chatTaskState,
        });
        chatTaskEcho = deps.chatTaskStateStore.upsertExtracted(
          instanceId,
          threadAgentId,
          extracted.extracted,
        );
        if (extracted.usage) {
          await deps.usageLedger.record(extracted.usage, { countExpensive });
        }
      }

      // Экстракт памяти задачи — живой трейс (Костя 041004)
      if (effectiveRagTool) {
        onProgress?.(
          "chattask",
          `уточн.: ${chatTaskEcho.clarified.length} · огранич.: ${chatTaskEcho.constraints_terms.length}`,
        );
      }

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
        // historyChat is the pre-loop history — historyToChat only ever
        // emits system/user/assistant ("tool" exists only inside run()).
        historyMessages: result.historyChat.map((m) => ({
          role: m.role as "user" | "assistant" | "system",
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
              ...(taskCheck
                ? { check: { ...taskCheck, ...(retried ? { retried: true } : {}) } }
                : {}),
            }
          : null,
        // Day14: explicit null (empty list); check = invariant conflict only.
        invariants: invariants.length
          ? {
              checked: invariants.map((row, i) => ({
                n: i + 1,
                id: row.id,
                scope: row.scope,
                enforcement: row.enforcement,
                text: row.text,
              })),
              inject: result.invariantsInject?.inject ?? "",
              ...(invariantCheck
                ? {
                    check: {
                      ...invariantCheck,
                      ...(retried ? { retried: true } : {}),
                    },
                  }
                : {}),
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
        // Day17: MCP tool-call frame — present only in tools-runs (calls is
        // always an array there; failure = rows with ok:false). Day25: rag-ходы
        // несут структурный payload в calls[].payload.
        ...(result.toolInject ? { tool: result.toolInject } : {}),
        // Day25: эхо памяти задачи после экстракта хода (панель обновляется).
        ...(effectiveRagTool ? { chatTaskState: chatTaskEcho } : {}),
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
        // Day25 (05-M-2): рельса «RAG каждый ход + источники» — только meta.
        ...(effectiveRagTool
          ? { meta: { railViolated: result.railViolated === true } }
          : {}),
        totals,
      };
      // Day25 UX SSE: отправляем финальный JSON последним событием и закрываем
      if (wantsSse) {
        sseSend!({ type: "done", result: body });
        reply.raw.write("data: [DONE]\n\n");
        reply.raw.end();
        return reply;
      }
      return body;
    } catch (error) {
      if (wantsSse) {
        // SSE-ошибка: отправляем событие ошибки и закрываем поток
        sseSend!({ type: "error", error: error instanceof Error ? error.message : String(error) });
        reply.raw.write("data: [DONE]\n\n");
        reply.raw.end();
        return reply;
      }
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

  // --- Day25 ChatTaskState endpoints (панель «Память задачи», 02b-F-1/04-F-6) ---

  /** threadAgentId — как в run: day10-strategy резолвит ветку (04-F-10:
   *  edge «Lab strategy ≠ последняя персистентная» принят и зафиксирован). */
  const chatTaskThreadAgentId = (
    id: string,
    agentId: string,
  ): string =>
    deps.day10State.resolveThreadAgentId(
      id,
      agentId,
      deps.day10State.getStrategy(id, agentId),
    );

  app.get(
    "/api/instances/:id/agents/:agentId/chat-task-state",
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
      return {
        chatTaskState: deps.chatTaskStateStore.get(
          id,
          chatTaskThreadAgentId(id, agentId),
        ),
      };
    },
  );

  app.patch(
    "/api/instances/:id/agents/:agentId/chat-task-state",
    async (request, reply) => {
      const { id, agentId } = request.params as {
        id: string;
        agentId: string;
      };
      const parsed = ChatTaskStatePatchSchema.safeParse(request.body ?? {});
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
      return {
        chatTaskState: deps.chatTaskStateStore.patch(
          id,
          chatTaskThreadAgentId(id, agentId),
          parsed.data,
        ),
      };
    },
  );
}

/**
 * Day09: compress the thread and persist + bill it — авто-сжатие хода
 * (run) единственный потребитель с 04.10 (ручной роут удалён — чистка
 * старого UI, гейт 261004 §7). Error mapping — на вызывающем.
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
