import {
  AskRequestSchema,
  type AskFormat,
  type AskResponse,
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

/** Experts / step answers can be longer than a short tip. */
const REASONING_MAX_TOKENS = 1600;

async function runMetaAsk(
  deepSeek: DeepSeekService,
  point: Parameters<typeof buildMetaPromptWriterSystem>[0],
  question: string,
): Promise<{ reply: string; metaPrompt: string; usage: AskResponse["usage"] }> {
  const writer = await deepSeek.chat([
    { role: "system", content: buildMetaPromptWriterSystem(point) },
    {
      role: "user",
      content: `Составь промпт для ответа на вопрос:\n${question}`,
    },
  ]);

  const metaPrompt = writer.reply.trim();
  const answer = await deepSeek.chat(
    [
      { role: "system", content: metaPrompt },
      { role: "user", content: question },
    ],
    { maxTokens: REASONING_MAX_TOKENS },
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
): Promise<{ reply: string; metaPrompt?: string; usage: AskResponse["usage"] }> {
  if (mode === "meta") {
    return runMetaAsk(deepSeek, point, question);
  }

  const result = await deepSeek.chat(
    [
      { role: "system", content: buildReasoningSystemPrompt(point, mode) },
      { role: "user", content: question },
    ],
    mode === "direct" ? {} : { maxTokens: REASONING_MAX_TOKENS },
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

    const { pointId, question, format, reasoningMode } = parsed.data;
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
          },
        );

        const body: AskResponse = {
          reply: result.reply,
          usage: result.usage,
          format: "json",
          reasoningMode: "direct",
          totals: await deps.usageLedger.record(result.usage),
        };
        return body;
      }

      const result = await runReasoningAsk(
        deps.deepSeekService,
        point,
        question,
        reasoningMode,
      );

      const body: AskResponse = {
        reply: result.reply,
        usage: result.usage,
        format: "free" satisfies AskFormat,
        reasoningMode,
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
