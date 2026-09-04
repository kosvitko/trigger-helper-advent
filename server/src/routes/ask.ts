import {
  AskRequestSchema,
  type AskFormat,
  type AskResponse,
  type AskTemperature,
  type ReasoningMode,
} from "@trigger-helper/shared";
import type { FastifyInstance } from "fastify";
import type { DeepSeekService } from "../services/deepseek.js";
import type { PointsService } from "../services/points.js";
import type { UsageLedgerService } from "../services/usage-ledger.js";
import {
  buildJsonSystemPrompt,
  buildMetaPromptWriterSystem,
  buildReasoningSystemPrompt,
} from "../services/prompt.js";
import { mergeUsage } from "../services/usage.js";

type AskRouteDeps = {
  pointsService: PointsService;
  deepSeekService: DeepSeekService;
  usageLedger: UsageLedgerService;
};

/** Length control for format=json (Advent day02) — enough for one complete object. */
const JSON_MAX_TOKENS = 700;

/** Free/direct tip — keep answers short for demo cost and readability. */
const FREE_MAX_TOKENS = 450;

/** Step / experts / meta answer — roles need room, not an essay. */
const REASONING_MAX_TOKENS = 700;

/** Meta: model writes a prompt first — keep that short too. */
const META_WRITER_MAX_TOKENS = 280;

async function runMetaAsk(
  deepSeek: DeepSeekService,
  point: Parameters<typeof buildMetaPromptWriterSystem>[0],
  question: string,
  temperature: AskTemperature,
): Promise<{ reply: string; metaPrompt: string; usage: AskResponse["usage"] }> {
  const writer = await deepSeek.chat(
    [
      { role: "system", content: buildMetaPromptWriterSystem(point) },
      {
        role: "user",
        content: `Составь промпт для ответа на вопрос:\n${question}`,
      },
    ],
    { maxTokens: META_WRITER_MAX_TOKENS, temperature },
  );

  const metaPrompt = writer.reply.trim();
  const answer = await deepSeek.chat(
    [
      { role: "system", content: metaPrompt },
      { role: "user", content: question },
    ],
    { maxTokens: REASONING_MAX_TOKENS, temperature },
  );

  return {
    reply: answer.reply,
    metaPrompt,
    usage: mergeUsage([writer.usage, answer.usage]),
  };
}

async function runReasoningAsk(
  deepSeek: DeepSeekService,
  point: Parameters<typeof buildReasoningSystemPrompt>[0],
  question: string,
  mode: ReasoningMode,
  temperature: AskTemperature,
): Promise<{ reply: string; metaPrompt?: string; usage: AskResponse["usage"] }> {
  if (mode === "meta") {
    return runMetaAsk(deepSeek, point, question, temperature);
  }

  const result = await deepSeek.chat(
    [
      { role: "system", content: buildReasoningSystemPrompt(point, mode) },
      { role: "user", content: question },
    ],
    {
      maxTokens: mode === "direct" ? FREE_MAX_TOKENS : REASONING_MAX_TOKENS,
      temperature,
    },
  );

  return { reply: result.reply, usage: result.usage };
}

export async function registerAskRoutes(
  app: FastifyInstance,
  deps: AskRouteDeps,
): Promise<void> {
  app.post("/api/ask", async (request, reply) => {
    const parsed = AskRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Invalid request body",
        details: parsed.error.flatten(),
      });
    }

    const { pointId, question, format, reasoningMode, temperature } =
      parsed.data;
    const point = await deps.pointsService.findById(pointId);
    if (!point) {
      return reply.status(400).send({
        error: "Point not found",
        pointId,
      });
    }

    try {
      // Day02 path: JSON format control (reasoning modes stay on free).
      if (format === "json") {
        const result = await deps.deepSeekService.chat(
          [
            { role: "system", content: buildJsonSystemPrompt(point) },
            { role: "user", content: question },
          ],
          {
            jsonMode: true,
            maxTokens: JSON_MAX_TOKENS,
            temperature,
          },
        );

        const body: AskResponse = {
          reply: result.reply,
          usage: result.usage,
          format: "json",
          reasoningMode: "direct",
          temperature,
          totals: await deps.usageLedger.record(result.usage),
        };
        return body;
      }

      const result = await runReasoningAsk(
        deps.deepSeekService,
        point,
        question,
        reasoningMode,
        temperature,
      );

      const body: AskResponse = {
        reply: result.reply,
        usage: result.usage,
        format: "free" satisfies AskFormat,
        reasoningMode,
        temperature,
        ...(result.metaPrompt ? { metaPrompt: result.metaPrompt } : {}),
        totals: await deps.usageLedger.record(result.usage),
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
