import {
  ChatRequestSchema,
  OPEN_TASK_MODE,
  getChatPreset,
  normalizeContextTail,
  resolveChatModel,
  validateTaskReply,
  type AgentInstance,
  type AgentMessage,
  type ChatResponse,
  type ChatSseErrorCode,
  type ChatTrace,
} from "@trigger-helper/shared";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Env } from "../config/env.js";
import {
  AgentPolicyError,
  ContextLimitError,
  type LlmAgent,
} from "../services/agent/llm-agent.js";
import type { DeepSeekService } from "../services/deepseek.js";
import {
  chatLocalLlm,
  isLocalCatalogId,
  probeLocalLlm,
} from "../services/local-llm.js";
import { isExpensiveModel } from "../services/model-cost-tier.js";
import {
  applyCostAwareThrottle,
  getBudgetSnapshot,
} from "../services/cost-aware-throttle.js";
import type { UsageLedgerService } from "../services/usage-ledger.js";

/**
 * C+ (CH-3, дизайн 261005-cplus-architecture-consilium): stateless-ход
 * `POST /api/chat` — преемник записывающей ветки /api/agent/run (D-10).
 *
 * D-3: ход = текст + contextTail (клиент) → серверный пайплайн (рельсы,
 * RAG, верификация) → ответ; НИЧЕГО не записано, кроме обезличенного
 * usage-ledger (исключение 02-F8). Треды/память/память-задачи — на клиенте
 * (CH-2 storage); серверные сторы не читаются и не пишутся.
 *
 * Приёмка CH-3: SSE-набор выживания перенесён дословно (04-MIN-6) —
 * keepalive 15 с + окно try с первого шага после hijack + [DONE];
 * ошибки после hijack — по контракту 04-MAJ-2 {type:"error", code,
 * httpStatus, message}; 429 rate-limit до hijack — реальный HTTP
 * (ip-rate-limit path-list, 05-MINOR-4).
 *
 * Вне скоупа здесь (дизайн D-4/CH-5): клиентская миграция фич на th-local
 * + композер contextTail — CH-5b. CH-4 закрыл SEC-F1 (allow-list
 * fail-closed) и контракт токена (free-фолбэк, 04-MIN-10); CH-5a —
 * per-request проверки задачи/инвариантов + retry-once (день 13/14/15).
 */
type ChatRouteDeps = {
  llmAgent: LlmAgent;
  usageLedger: UsageLedgerService;
  deepSeekService: DeepSeekService;
  env: Env;
};

/** 04-MAJ-2: реальный HTTP-статус — только не-SSE вызовам; SSE-клиент
 * мапит коды. httpStatus — эхо «каким был бы ответ». */
function failPayload(code: ChatSseErrorCode, message: string) {
  return { error: code, code, message };
}

/** SEC-F6: clientTurnId из сырого тела — в лог отказов до/вне zod.
 * Ledger агрегатный (02-F8), пер-ходовых записей в нём нет — корреляция
 * ходов идёт по лог-полю clientTurnId (см. «chat: stateless turn»). */
function rawClientTurnId(body: unknown): string | undefined {
  if (body && typeof body === "object" && "clientTurnId" in body) {
    const v = (body as { clientTurnId?: unknown }).clientTurnId;
    if (typeof v === "string" && v.length >= 8) return v.slice(0, 64);
  }
  return undefined;
}

export async function registerChatRoutes(
  app: FastifyInstance,
  deps: ChatRouteDeps,
): Promise<void> {
  app.post("/api/chat", async (request, reply) => {
    const wantsSse = (request.headers.accept ?? "").includes(
      "text/event-stream",
    );

    const sseSend = wantsSse
      ? (data: unknown): void => {
          reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
        }
      : undefined;
    const sseFail = (
      code: ChatSseErrorCode,
      httpStatus: number,
      message: string,
    ): void => {
      // Контракт капит сообщение 500 симв. (ChatSseErrorEventSchema) —
      // длинный текст без клипа молча падает в safeParse клиента (MINOR-3).
      const clipped =
        message.length > 500 ? `${message.slice(0, 497)}…` : message;
      sseSend!({ type: "error", code, httpStatus, message: clipped });
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
      // nginx рвал тихие длинные ходы (закрепление 051005): пинг каждые 15 с.
      const ka = setInterval(() => {
        try {
          reply.raw.write(": ping\n\n");
        } catch {
          /* сокет закрыт — clearInterval ниже по "close" */
        }
      }, 15_000);
      reply.raw.on("close", () => clearInterval(ka));
    }

    const onProgress = sseSend
      ? (step: string, text: string): void =>
          sseSend({ type: "step", step, text })
      : undefined;

    // Окно try — с первого шага после hijack (051005): ранний throw
    // больше не вешает поток.
    try {
      const parsed = ChatRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        const message = parsed.error.issues
          .map((i) => `${i.path.join(".") || "body"}: ${i.message}`)
          .join("; ");
        // SEC-F6: аномалии поимённо — schema_invalid в логе.
        request.log.warn(
          { code: "schema_invalid", clientTurnId: rawClientTurnId(request.body) },
          "chat: turn rejected (schema_invalid)",
        );
        if (wantsSse) {
          sseFail("schema_invalid", 400, message);
          return reply;
        }
        return reply.status(400).send(failPayload("schema_invalid", message));
      }
      const body = parsed.data;

      // Наблюдаемость без контента (D-6(7)/SEC-F6): clientTurnId в логе.
      request.log.info(
        {
          clientTurnId: body.clientTurnId,
          preset: body.preset,
          compress: body.compress === true,
          ragTool: body.overrides?.ragTool === true,
        },
        "chat: stateless turn",
      );

      const preset = getChatPreset(body.preset);
      if (!preset) {
        // Енум уже сужен — теоретическая ветка, fail-closed (SEC-F1-стиль)
        const message = `Неизвестный пресет: ${body.preset}`;
        request.log.warn(
          { code: "schema_invalid", preset: body.preset, clientTurnId: body.clientTurnId },
          "chat: turn rejected (schema_invalid)",
        );
        if (wantsSse) {
          sseFail("schema_invalid", 400, message);
          return reply;
        }
        return reply.status(400).send(failPayload("schema_invalid", message));
      }

      // День 26 (D-26-9): локальная модель — единая вставка ДО allow-list
      // (иначе локальный id был бы отклонён ниже как unknown_model). Ветка —
      // одна ходка без FSM/RAG/истории (D-26-2); allow-list, budget,
      // FREE_DAILY_ASKS и троттлинг пропускаются (D-26-5), IP rate-limit
      // остаётся (сработал выше, на входе). Kill-switch/недоступный рантайм /
      // не установленная модель / мало RAM — дуплексный отказ по образцу
      // schema_invalid (sseFail-событие для SSE, реальный 503 для JSON).
      const requested = body.overrides?.model;
      if (requested && isLocalCatalogId(requested)) {
        const probe = await probeLocalLlm(deps.env);
        const entry = probe.entries.find((e) => e.id === requested);
        const available =
          probe.runtimeOk && entry?.installed === true && entry.fitsRam;
        if (!available) {
          const reason = !probe.enabled
            ? "Локальная модель отключена на сервере (LOCAL_LLM_ENABLED)."
            : !probe.runtimeOk
              ? "Локальный рантайм Ollama недоступен — запустите: ollama serve"
              : entry && !entry.installed
                ? `Модель ${requested} не установлена — выполните: ollama pull ${requested}`
                : `Для модели ${requested} недостаточно RAM на этом сервере.`;
          request.log.warn(
            {
              code: "local_unavailable",
              model: requested,
              enabled: probe.enabled,
              runtimeOk: probe.runtimeOk,
              clientTurnId: body.clientTurnId,
            },
            "chat: local model unavailable — 503",
          );
          if (wantsSse) {
            sseFail("upstream_error", 503, reason);
            return reply;
          }
          return reply.status(503).send(failPayload("upstream_error", reason));
        }

        // Доступна — стрим одной ходки. Прогресс (D-26-3): существующие
        // step-события, ключ local-gen, тротл ~300 мс, N = число дельт.
        let replyText = "";
        let deltaCount = 0;
        let lastStepAt = 0;
        const localT0 = Date.now();
        const localResult = await chatLocalLlm(
          deps.env,
          { model: requested, q: body.input },
          (delta) => {
            replyText += delta;
            deltaCount += 1;
            const now = Date.now();
            if (onProgress && now - lastStepAt >= 300) {
              lastStepAt = now;
              const sec = ((now - localT0) / 1000).toFixed(1).replace(".", ",");
              onProgress("local-gen", `● ${deltaCount} ток · ${sec} с`);
            }
          },
        );
        // Падение рантайма посреди стрима ловит общий catch ниже —
        // существующий enum-код (новых кодов SSE не вводим).

        const usage: ChatResponse["usage"] = {
          model: requested,
          prompt_tokens: localResult.promptTokens,
          completion_tokens: localResult.completionTokens,
          total_tokens:
            localResult.promptTokens + localResult.completionTokens,
          prompt_cache_hit_tokens: 0,
          prompt_cache_miss_tokens: 0,
          // Локальный ответ бесплатен: оба нуля пишем явно — zod-дефолт
          // срабатывает только при parse, сервер строит полный литерал.
          estimated_cost_usd: 0,
          estimated_cost_rub: 0,
        };
        // D-26-5: usage в ledger с нулевой стоимостью, в дорогие не считается.
        await deps.usageLedger.record(usage, { countExpensive: false });

        const response: ChatResponse = {
          reply: replyText || localResult.reply,
          trace: { historyMessages: [] },
          usage,
        };
        if (wantsSse) {
          sseSend!({ type: "done", result: response });
          reply.raw.write("data: [DONE]\n\n");
          reply.raw.end();
          return reply;
        }
        return reply.send(response);
      }

      // SEC-F4: мягкий трим хвоста (жёсткие капы уже отработала zod-ветка).
      const { tail, trimmed } = normalizeContextTail(body.contextTail);
      // SEC-F6: trim-счётчики per preset — наблюдаемость обрезок хвоста.
      if (trimmed) {
        request.log.info(
          {
            preset: body.preset,
            droppedDialogue: trimmed.droppedDialogue,
            droppedSummaries: trimmed.droppedSummaries,
          },
          "chat: context trimmed (SEC-F4)",
        );
      }

      // Синтетический агент из shared-таблицы: уникальный id на ход —
      // traceProgress-Map в llm-agent ключуется agent.id, пересечения
      // состояний между ходами недопустимы (stateless).
      const agent: AgentInstance = {
        ...preset,
        id: `stateless:${randomUUID()}`,
        presetId: preset.id,
      };
      const now = new Date().toISOString();
      // historyToChat внутри run эмитит system-сводки первыми, диалог —
      // после (llm-agent.ts:366-389): собираем хвост в том же порядке.
      const history: AgentMessage[] = [
        ...tail.summaries.map((content, i) => ({
          id: `summary-${i}`,
          role: "system" as const,
          content,
          createdAt: now,
        })),
        ...tail.dialogue.map((m, i) => ({
          id: `msg-${i}`,
          role: m.role,
          content: m.content,
          createdAt: now,
        })),
      ];

      // Модель по тиру (CH-4, SEC-F1/D-5): allow-list сервера fail-closed —
      // неизвестный id → schema_invalid, не эвристика isExpensiveModel
      // (fail-open). Pro-токен: issuance пока нет (04-MIN-10 — с Pro), любой
      // токен → free-фолбэк; дорогая модель на free → фолбэк-модель (не отказ).
      const allowList = [
        deps.env.DEEPSEEK_MODEL,
        ...deps.deepSeekService.getDemoModels().map((m) => m.model),
      ];
      const requestedModel =
        body.overrides?.model ?? preset.defaultModel ?? deps.env.DEEPSEEK_MODEL;
      const proTokenValid = false; // 04-MIN-10: валидных токенов нет до Pro
      const resolution = resolveChatModel({
        requested: requestedModel,
        allowList,
        freeModel: deps.env.DEEPSEEK_MODEL,
        isExpensive: isExpensiveModel,
        proTokenValid,
      });
      if (resolution.status === "unknown_model") {
        const message = `Неизвестная модель: ${resolution.requested}`;
        request.log.warn(
          {
            code: "schema_invalid",
            requestedModel: resolution.requested,
            clientTurnId: body.clientTurnId,
          },
          "chat: turn rejected (schema_invalid)",
        );
        if (wantsSse) {
          sseFail("schema_invalid", 400, message);
          return reply;
        }
        return reply.status(400).send(failPayload("schema_invalid", message));
      }
      if (resolution.status === "downgraded_to_free") {
        request.log.warn(
          {
            requested: resolution.requested,
            downgradedTo: resolution.model,
            clientTurnId: body.clientTurnId,
          },
          "chat: expensive model without Pro token — free fallback (04-MIN-10)",
        );
      }
      // Оверрайд модели после тира: undefined на фолбэке — run возьмёт
      // серверный дефолт (free-модель); явно — только разрешённый id.
      const effectiveModelOverride =
        resolution.status === "ok" ? body.overrides?.model : undefined;
      const resolvedModel = resolution.model;
      const countExpensive =
        OPEN_TASK_MODE === "public" && isExpensiveModel(resolvedModel);

      const budget = await getBudgetSnapshot(deps.usageLedger, deps.env);
      // SSE-предчек до applyCostAwareThrottle (QA 041003 F2): после hijack
      // reply.status().send() не доходит.
      if (wantsSse && budget.rejected) {
        sseFail(
          "budget_exceeded",
          429,
          budget.reason === "daily_budget_expensive_rub"
            ? `Дневной бюджет дорогих моделей: ₽${budget.expensive_limit_rub} (МСК).`
            : `Дневной бюджет: ₽${budget.limit_rub} (МСК).`,
        );
        return reply;
      }
      if ((await applyCostAwareThrottle(reply, budget)) === "rejected") {
        return;
      }

      // SEC-F2 (рельса — только расширение): пресетная рельса rag_chat
      // не отключается клиентским override — семантика agents.ts:511.
      const effectiveRagTool =
        body.preset === "rag_chat" || body.overrides?.ragTool === true;

      const runOverrides = {
        model: effectiveModelOverride,
        temperature: body.overrides?.temperature,
        tools: body.overrides?.tools,
        ragTool: effectiveRagTool,
        // Контракт уже оконил диалог (soft-cap 100 == HISTORY_FULL_CAP);
        // "full" держит капы run и контракта согласованными.
        historyMode: "full" as const,
        memoryFacts: tail.memory?.facts,
        activeProfile: tail.profile ?? null,
        taskState: tail.task ?? null,
        invariants: tail.invariants,
        chatTaskState: tail.chatTask ?? null,
      };
      const firstResult = await deps.llmAgent.run(
        agent,
        body.input,
        history,
        runOverrides,
        undefined, // onStage писал бы строки стадий в серверный тред — stateless
        onProgress,
      );

      // CH-5a (день 14/15 → per-request, D-4): проверки-сервер — защита
      // владельца и гейт платного ретрая не могут жить на клиенте.
      // Fail-open: ответ не режется, только evidence в trace.
      const checkTask = (reply: string) =>
        tail.task && tail.task.stage !== "done"
          ? validateTaskReply(tail.task, reply, { input: body.input })
          : undefined;
      const checkInvariants = (reply: string) => {
        const hasPatternRows = tail.invariants.some(
          (row) => row.enforcement === "hard" && row.pattern,
        );
        return hasPatternRows
          ? validateTaskReply(tail.task ?? null, reply, {
              invariants: tail.invariants,
              input: body.input,
            })
          : undefined;
      };

      // День 15 D-3: retry-once — триггер любой critical (стадия при
      // skip-запросе или инвариант). Повторный critical остаётся critical
      // (fail-open), retried лишь фиксирует попытку.
      const critical =
        checkTask(firstResult.reply)?.level === "critical" ||
        checkInvariants(firstResult.reply)?.level === "critical";
      const secondResult = critical
        ? await deps.llmAgent.run(
            agent,
            body.input,
            history,
            { ...runOverrides, stageRetry: true },
            undefined,
            onProgress,
          )
        : null;

      const taskCheck = checkTask(
        secondResult ? secondResult.reply : firstResult.reply,
      );
      const invariantCheck = checkInvariants(
        secondResult ? secondResult.reply : firstResult.reply,
      );
      const retried = secondResult !== null;

      // День 15 D-3: клиент получает только финальный ответ; usage/₽ в ответе —
      // сумма обоих вызовов (ledger ниже записывает каждый отдельно).
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

      // Ledger честен — при retry записаны оба вызова (₽-факт, день 15 D-3).
      if (retried) {
        await deps.usageLedger.record(firstResult.usage, { countExpensive });
      }
      await deps.usageLedger.record(result.usage, { countExpensive });

      // Рельса-чек — живой трейс (паритет с лентой /api/agent/run)
      onProgress?.(
        "rail",
        result.railViolated === true
          ? "рельса нарушена → был re-prompt"
          : "rag-вызов ✓ · метки источников ✓",
      );

      // Q-3: memoryDelta — экстракция в рамках хода, только rag-ходы
      // (прочие пресеты не платят лишние вызовы); merge — на клиенте.
      let memoryDelta: ChatResponse["memoryDelta"];
      if (effectiveRagTool) {
        const classified = await deps.llmAgent
          .classifyMemoryFacts({
            userText: body.input,
            historyTail: history,
            model: deps.env.DEEPSEEK_MODEL,
          })
          .catch(() => ({ ok: false as const, items: [] }));
        if ("usage" in classified && classified.usage) {
          await deps.usageLedger.record(classified.usage, { countExpensive });
        }
        onProgress?.(
          "memory_class",
          `факты из реплики → слои${"usage" in classified && classified.usage ? ` (LLM, ${classified.usage.total_tokens} ток)` : ""}`,
        );

        const extracted = await deps.llmAgent
          .classifyChatTaskState({
            userText: body.input,
            assistantReply: result.reply,
            historyTail: history,
            model: deps.env.DEEPSEEK_MODEL,
            current: tail.chatTask ?? {
              goal: "",
              clarified: [],
              constraints_terms: [],
            },
          })
          .catch(() => ({
            ok: false as const,
            extracted: {} as Record<string, never>,
          }));
        if ("usage" in extracted && extracted.usage) {
          await deps.usageLedger.record(extracted.usage, { countExpensive });
        }

        memoryDelta = {
          facts: classified.items.slice(0, 16),
          chatTask: extracted.extracted,
        };
      }

      // Q-2: инлайн-сжатие stateless-LLM в этом же ходу — существующий
      // COMPRESS-путь без персиста; оппортунистично (day09 D-4): отказ
      // сжатия не валит ход — блока нет, клиент оставляет свой префикс.
      let compressDelta: ChatResponse["compress"];
      if (body.compress) {
        try {
          const compressed = await deps.llmAgent.compress({
            history,
            keepLast: 4,
            model: effectiveModelOverride,
          });
          await deps.usageLedger.record(compressed.usage, { countExpensive });
          compressDelta = {
            summary: compressed.summary,
            keptTail: compressed.keptMessages.map((m) => ({
              role: m.role as "user" | "assistant",
              content: m.content,
            })),
          };
        } catch (error) {
          request.log.warn(
            { err: error, clientTurnId: body.clientTurnId },
            "chat: compress failed; answering without compression",
          );
        }
      }

      // Кадр-evidence хода (что реально ушло в LLM) + SEC-F4-факт трима.
      // Проверки задачи/инвариантов (check/retry-once, день 13/15) — CH-5.
      const trace: ChatTrace = {
        historyMessages: result.historyChat.map((m) => ({
          role: m.role as "user" | "assistant" | "system",
          content: m.content,
        })),
        ...(trimmed ? { contextTrimmed: trimmed } : {}),
        profile: tail.profile
          ? {
              id: tail.profile.id,
              label: tail.profile.label,
              inject: result.profileInject?.inject ?? null,
            }
          : null,
        task: tail.task
          ? {
              id: tail.task.id,
              title: tail.task.title,
              stage: tail.task.stage,
              step: tail.task.step,
              total: tail.task.plan.length,
              paused: tail.task.paused,
              inject: result.taskInject?.inject ?? null,
              ...(taskCheck
                ? { check: { ...taskCheck, ...(retried ? { retried: true } : {}) } }
                : {}),
            }
          : null,
        invariants: tail.invariants.length
          ? {
              checked: tail.invariants.map((row, i) => ({
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
        ...(tail.memory
          ? {
              memory: {
                facts: tail.memory.facts,
                inject: result.memoryInject ?? {
                  long: [],
                  working: [],
                  short: [],
                },
              },
            }
          : {}),
        ...(result.toolInject ? { tool: result.toolInject } : {}),
      };

      const response: ChatResponse = {
        reply: result.reply,
        trace,
        usage: result.usage,
        ...(memoryDelta ? { memoryDelta } : {}),
        ...(compressDelta ? { compress: compressDelta } : {}),
        ...(effectiveRagTool
          ? { meta: { railViolated: result.railViolated === true } }
          : {}),
      };

      if (wantsSse) {
        sseSend!({ type: "done", result: response });
        reply.raw.write("data: [DONE]\n\n");
        reply.raw.end();
        return reply;
      }
      return reply.send(response);
    } catch (error) {
      const code: ChatSseErrorCode =
        error instanceof ContextLimitError
          ? "context_limit"
          : error instanceof AgentPolicyError
            ? "schema_invalid"
            : "upstream_error";
      const httpStatus =
        code === "context_limit" ? 413 : code === "schema_invalid" ? 400 : 502;
      const message =
        error instanceof Error ? error.message : String(error);
      request.log.error(
        { err: error, code },
        "chat: stateless turn failed",
      );
      if (wantsSse) {
        sseFail(code, httpStatus, message);
        return reply;
      }
      return reply.status(httpStatus).send(failPayload(code, message));
    }
  });
}
