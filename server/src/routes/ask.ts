import {
  AskRequestSchema,
  OPEN_PRESET_L_QUESTION,
  OPEN_TASK_MODE,
  type AskFormat,
  type AskResponse,
  type AskScope,
  type AskTemperature,
  type Point,
  type ReasoningMode,
} from "@trigger-helper/shared";
import type { FastifyInstance } from "fastify";
import type { Env } from "../config/env.js";
import type { DeepSeekService } from "../services/deepseek.js";
import type { PointsService } from "../services/points.js";
import type { UsageLedgerService } from "../services/usage-ledger.js";
import {
  buildJsonSystemPrompt,
  buildMetaPromptWriterSystem,
  buildOpenMetaPromptWriterSystem,
  buildOpenReasoningSystemPrompt,
  buildReasoningSystemPrompt,
} from "../services/prompt.js";
import { mergeUsage } from "../services/usage.js";
import { isExpensiveModel } from "../services/model-cost-tier.js";

type AskRouteDeps = {
  pointsService: PointsService;
  deepSeekService: DeepSeekService;
  usageLedger: UsageLedgerService;
  env: Env;
};

/** Length control for format=json (Advent day02) — enough for one complete object. */
const JSON_MAX_TOKENS = 700;

/** Free/direct grounded — keep readable, but don't clip short tips. */
const FREE_MAX_TOKENS = 1_200;

/** Step / experts / meta answer — multi-role replies need room. */
const REASONING_MAX_TOKENS = 4_000;

/** Meta: model writes a prompt first — ceiling only, need not fill. */
const META_WRITER_MAX_TOKENS = 2_000;

/** Day05 open / preset L — long complete answers. */
const OPEN_MAX_TOKENS = 30_000;

type AskRunResult = {
  reply: string;
  metaPrompt?: string;
  usage: AskResponse["usage"];
  latency_ms: number;
};

async function runMetaAsk(
  deepSeek: DeepSeekService,
  scope: AskScope,
  point: Point | null,
  question: string,
  temperature: AskTemperature,
  model: string | undefined,
): Promise<AskRunResult> {
  const writerSystem =
    scope === "open"
      ? buildOpenMetaPromptWriterSystem()
      : buildMetaPromptWriterSystem(point!);

  const writer = await deepSeek.chat(
    [
      { role: "system", content: writerSystem },
      {
        role: "user",
        content: `Составь промпт для ответа на вопрос:\n${question}`,
      },
    ],
    { maxTokens: META_WRITER_MAX_TOKENS, temperature, model },
  );

  const metaPrompt = writer.reply.trim();
  const answer = await deepSeek.chat(
    [
      { role: "system", content: metaPrompt },
      { role: "user", content: question },
    ],
    {
      maxTokens: scope === "open" ? OPEN_MAX_TOKENS : REASONING_MAX_TOKENS,
      temperature,
      model,
    },
  );

  return {
    reply: answer.reply,
    metaPrompt,
    usage: mergeUsage([writer.usage, answer.usage]),
    latency_ms: writer.latency_ms + answer.latency_ms,
  };
}

async function runAsk(
  deepSeek: DeepSeekService,
  scope: AskScope,
  point: Point | null,
  question: string,
  mode: ReasoningMode,
  temperature: AskTemperature,
  model: string | undefined,
): Promise<AskRunResult> {
  if (mode === "meta") {
    return runMetaAsk(deepSeek, scope, point, question, temperature, model);
  }

  const system =
    scope === "open"
      ? buildOpenReasoningSystemPrompt(mode)
      : buildReasoningSystemPrompt(point!, mode);

  const maxTokens =
    scope === "open"
      ? OPEN_MAX_TOKENS
      : mode === "direct"
        ? FREE_MAX_TOKENS
        : REASONING_MAX_TOKENS;

  const result = await deepSeek.chat(
    [
      { role: "system", content: system },
      { role: "user", content: question },
    ],
    { maxTokens, temperature, model },
  );

  return {
    reply: result.reply,
    usage: result.usage,
    latency_ms: result.latency_ms,
  };
}

export async function registerAskRoutes(
  app: FastifyInstance,
  deps: AskRouteDeps,
): Promise<void> {
  app.get("/api/models", async () => {
    const models = deps.deepSeekService.getDemoModels();
    return {
      proxyapi: deps.deepSeekService.hasProxyApi(),
      open_task_mode: OPEN_TASK_MODE,
      open_task_locked: OPEN_TASK_MODE === "public",
      open_preset_l: OPEN_PRESET_L_QUESTION,
      models,
    };
  });

  app.post("/api/ask", async (request, reply) => {
    const parsed = AskRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Invalid request body",
        details: parsed.error.flatten(),
      });
    }

    const {
      scope,
      pointId,
      format,
      reasoningMode,
      temperature,
      model,
    } = parsed.data;
    let { question } = parsed.data;

    const freeCap = deps.env.FREE_DAILY_ASKS;
    const requestedModel = model ?? deps.env.DEEPSEEK_MODEL;
    const countExpensive = OPEN_TASK_MODE === "public";
    if (
      countExpensive &&
      freeCap > 0 &&
      isExpensiveModel(requestedModel)
    ) {
      const used = await deps.usageLedger.getExpensiveAsksToday();
      if (used >= freeCap) {
        return reply.status(429).send({
          error: "Ask limit reached",
          message: `Дневной лимит дорогих моделей: ${freeCap} (МСК). DeepSeek / flash-lite / mini — без лимита.`,
          limit: freeCap,
          used,
          model: requestedModel,
        });
      }
    }

    if (scope === "open" && OPEN_TASK_MODE === "public") {
      // Advent public L: server-owned text (ignore client edits).
      question = OPEN_PRESET_L_QUESTION;
    }

    let point: Point | null = null;
    if (scope === "grounded") {
      point = (await deps.pointsService.findById(pointId!)) ?? null;
      if (!point) {
        return reply.status(400).send({
          error: "Point not found",
          pointId,
        });
      }
    }

    try {
      if (format === "json" && scope === "grounded" && point) {
        const result = await deps.deepSeekService.chat(
          [
            { role: "system", content: buildJsonSystemPrompt(point) },
            { role: "user", content: question },
          ],
          {
            jsonMode: true,
            maxTokens: JSON_MAX_TOKENS,
            temperature,
            model,
          },
        );

        const body: AskResponse = {
          reply: result.reply,
          usage: result.usage,
          format: "json",
          scope,
          reasoningMode: "direct",
          temperature,
          model: result.usage.model,
          latency_ms: result.latency_ms,
          totals: await deps.usageLedger.record(result.usage, {
            countExpensive,
          }),
        };
        return body;
      }

      const result = await runAsk(
        deps.deepSeekService,
        scope,
        point,
        question,
        reasoningMode,
        temperature,
        model,
      );

      const body: AskResponse = {
        reply: result.reply,
        usage: result.usage,
        format: "free" satisfies AskFormat,
        scope,
        reasoningMode,
        temperature,
        model: result.usage.model,
        latency_ms: result.latency_ms,
        ...(result.metaPrompt ? { metaPrompt: result.metaPrompt } : {}),
        totals: await deps.usageLedger.record(result.usage, {
          countExpensive,
        }),
      };
      return body;
    } catch (error) {
      request.log.error(error);
      return reply.status(502).send({
        error: "LLM request failed",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });
}
