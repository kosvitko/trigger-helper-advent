import {
  AskRequestSchema,
  type AskFormat,
  type AskResponse,
} from "@trigger-helper/shared";
import type { FastifyInstance } from "fastify";
import type { DeepSeekService } from "../services/deepseek.js";
import type { PointsService } from "../services/points.js";
import {
  buildGroundedSystemPrompt,
  buildJsonSystemPrompt,
} from "../services/prompt.js";

type AskRouteDeps = {
  pointsService: PointsService;
  deepSeekService: DeepSeekService;
};

/** Length control for format=json (Advent day02) — enough for one complete object. */
const JSON_MAX_TOKENS = 700;

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

    const { pointId, question, format } = parsed.data;
    const point = await deps.pointsService.findById(pointId);
    if (!point) {
      return reply.status(400).send({
        error: "Point not found",
        pointId,
      });
    }

    try {
      if (format === "free") {
        const result = await deps.deepSeekService.chat([
          { role: "system", content: buildGroundedSystemPrompt(point) },
          { role: "user", content: question },
        ]);

        const body: AskResponse = {
          reply: result.reply,
          usage: result.usage,
          format: "free" satisfies AskFormat,
        };
        return body;
      }

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
